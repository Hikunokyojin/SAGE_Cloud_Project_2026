// D8/D9 runnable script (npm run experiment --workspace=src/experiments/d8-d9).
//
// D8: runs {Baseline 1, Baseline 2, Baseline 3, Proposed/Full SAGE} against the
//     full test suite (test-cases.ts).
// D9: runs ablation conditions (A) Full SAGE, (B) without Reviewer, (C) without
//     re-negotiation, (D) LLM-based Negotiator, (E) without scoped payloads,
//     (F) without provenance -- against the same suite.
//
// Entirely in-process: real Groq calls (Intent/Explainer/baselines), real
// Qdrant/MongoDB reads via Broker's real retrieval -- no AWS Lambda invocation, no
// cdk deploy. No live DynamoDB write occurs: AUDIT_TABLE_NAME is intentionally left
// unset for this process, so every agent's own recordDecision() call throws
// internally and is caught by that agent's own pre-existing try/catch -- nothing in
// this package had to change to get that property.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv();

import { handler as inputGuardHandler } from "input-guard-agent";
import { handler as intentHandler } from "intent-agent";
// See baselines.ts's comment on this same import for why it's a relative require to
// Broker's own src rather than the "broker-agent" package specifier.
import type { BrokerAgentInput, ServiceCandidateWithEvidence as BrokerOutput } from "@sage/shared-types";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const brokerHandler: (input: BrokerAgentInput) => Promise<BrokerOutput[]> = require("../../../agents/broker/src/index").handler;
import { handler as negotiatorHandler } from "negotiator-agent";
import { escalateUnsatisfiable } from "reviewer-agent";
import { handler as explainerHandler, explainEscalation } from "explainer-agent";
import { runPipeline, type AgentInvoker, type PipelineResult } from "conductor/src/pipeline";

import { TEST_CASES, type TestCase } from "./test-cases";
import { summarize, formatSummaryTable, type RunResult, type MetricsSummary } from "./metrics";
import {
  baseline1LlmOnly,
  baseline2RetrievalPlusLlm,
  withoutReviewer,
  withoutRenegotiation,
  llmBasedNegotiator,
  withoutScopedPayloads,
  withoutProvenance,
  reviewIndependently,
} from "./baselines";

// ── Condition A / "proposed method": the real runPipeline(), unmodified, driven by
//    the real agent handlers (same wiring as
//    src/services/conductor/src/localInvoker.ts), except Reviewer is wrapped by
//    baselines.ts's reviewIndependently() so a missing SNS_TOPIC_ARN in this local
//    harness converts into the escalation it represents instead of crashing the run
//    (see baselines.ts's comment on reviewIndependently for the full rationale). ──
const fullSageInvoker: AgentInvoker = {
  inputGuard: inputGuardHandler,
  intent: intentHandler,
  broker: brokerHandler,
  negotiator: negotiatorHandler,
  reviewer: reviewIndependently,
  explainer: explainerHandler,
  explainEscalation: explainEscalation,
  escalateUnsatisfiable: escalateUnsatisfiable,
};

async function runFullPipeline(tc: TestCase): Promise<RunResult> {
  const start = Date.now();
  let llmCalls = 0;
  const countingInvoker: AgentInvoker = {
    ...fullSageInvoker,
    intent: async (i) => {
      llmCalls += 1;
      return fullSageInvoker.intent(i);
    },
    explainer: async (i) => {
      llmCalls += 1;
      return fullSageInvoker.explainer(i);
    },
    explainEscalation: async (i) => {
      llmCalls += 1;
      return fullSageInvoker.explainEscalation(i);
    },
  };

  const base = {
    testCaseId: tc.id,
    expectedOutcome: tc.expectedOutcome,
    expectedServiceId: tc.expectedServiceId,
    negotiationAttempts: 0,
    hitlEscalated: false,
    provenanceChainLength: 0,
    hasExplanation: false,
  };

  let pipelineResult: PipelineResult;
  try {
    pipelineResult = await runPipeline(tc.id, tc.rawInput, countingInvoker);
  } catch (err) {
    return { ...base, actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls, error: err instanceof Error ? err.message : String(err) };
  }

  const latencyMs = Date.now() - start;
  if (pipelineResult.status === "completed") {
    const chosen = pipelineResult.result.chosen.service;
    return {
      ...base,
      actualOutcome: "approved",
      actualServiceId: chosen.serviceId,
      constraintsSatisfied: !tc.expectedServiceId ? undefined : chosen.serviceId === tc.expectedServiceId,
      negotiationAttempts: pipelineResult.result.iteration,
      latencyMs,
      llmCalls,
      provenanceChainLength: 6, // InputGuard, Intent, Broker, Negotiator, Reviewer, Explainer
      hasExplanation: pipelineResult.result.explanation.length > 0,
    };
  }
  if (pipelineResult.status === "paused_for_review") {
    return {
      ...base,
      actualOutcome: "escalated",
      hitlEscalated: true,
      latencyMs,
      llmCalls,
      provenanceChainLength: 5,
      hasExplanation: pipelineResult.escalation.explanation.length > 0,
    };
  }
  return { ...base, actualOutcome: "failed", latencyMs, llmCalls, error: pipelineResult.error };
}

// ── Runner ──────────────────────────────────────────────────────────────────────

type ConditionFn = (tc: TestCase) => Promise<RunResult>;

// Pacing delay between cases, sized against the free-tier Groq key's 8000
// tokens/minute limit: each case makes 1-3 Groq calls (Intent/Explainer inside the
// real pipeline or ablations, or a single call in the LLM-only baselines) at
// roughly 1500-2000 tokens apiece, so ~15s of headroom per case keeps sustained
// throughput under the limit even without perfect batching.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CASE_PACING_MS = 15000;

// A live 429 still slips through occasionally (e.g. right after a burst of
// same-case retries within the pipeline itself). Real retry-with-backoff, not
// just a longer fixed delay: parses Groq's own "try again in Xs" hint when
// present, otherwise backs off 20s, up to 3 attempts before giving up on that case.
function parseRetryAfterSeconds(message: string): number | undefined {
  const match = message.match(/try again in ([\d.]+)s/i);
  return match ? Math.ceil(parseFloat(match[1])) : undefined;
}

function isRateLimitMessage(message: string | undefined): boolean {
  if (!message) return false;
  return message.includes("429") || message.toLowerCase().includes("rate_limit");
}

// Every condition function (baselines.ts, run-experiments.ts's own runFullPipeline)
// catches its own errors internally and returns a RunResult with `error` set rather
// than throwing -- so retrying on a rate limit means inspecting the *returned*
// result, not catching a rejected promise.
async function withRateLimitRetry(fn: () => Promise<RunResult>, maxAttempts = 3): Promise<RunResult> {
  let result: RunResult = await fn();
  for (let attempt = 2; attempt <= maxAttempts && isRateLimitMessage(result.error); attempt++) {
    const waitSeconds = parseRetryAfterSeconds(result.error!) ?? 20;
    console.log(`    (rate-limited, attempt ${attempt}/${maxAttempts}, waiting ${waitSeconds}s)`);
    await sleep(waitSeconds * 1000);
    result = await fn();
  }
  return result;
}

async function runCondition(label: string, fn: ConditionFn, cases: TestCase[]): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const tc of cases) {
    process.stdout.write(`  [${label}] ${tc.id} (${tc.category}) ... `);
    await sleep(CASE_PACING_MS);
    try {
      const result = await withRateLimitRetry(() => fn(tc));
      results.push(result);
      console.log(`${result.actualOutcome}${result.actualServiceId ? ` -> ${result.actualServiceId}` : ""}${result.error ? ` (${result.error})` : ""}`);
    } catch (err) {
      console.log(`UNCAUGHT ERROR: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        testCaseId: tc.id,
        expectedOutcome: tc.expectedOutcome,
        expectedServiceId: tc.expectedServiceId,
        actualOutcome: "failed",
        negotiationAttempts: 0,
        hitlEscalated: false,
        latencyMs: 0,
        llmCalls: 0,
        provenanceChainLength: 0,
        hasExplanation: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// Unique underlying condition functions. "Proposed-FullSAGE" (D8) and "A-FullSAGE"
// (D9) are the same function, as are "Baseline3-NoReviewer" (D8) and
// "B-WithoutReviewer" (D9) -- run each unique function exactly once and reuse the
// result for both its D8 and D9 label(s), instead of paying for it twice.
const UNIQUE_CONDITIONS: { label: string; fn: ConditionFn }[] = [
  { label: "Baseline1-LLMOnly", fn: baseline1LlmOnly },
  { label: "Baseline2-Retrieval+LLM", fn: baseline2RetrievalPlusLlm },
  { label: "FullSAGE", fn: runFullPipeline },
  { label: "WithoutReviewer", fn: withoutReviewer },
  { label: "WithoutRenegotiation", fn: withoutRenegotiation },
  { label: "LLMBasedNegotiator", fn: llmBasedNegotiator },
  { label: "WithoutScopedPayloads", fn: withoutScopedPayloads },
  { label: "WithoutProvenance", fn: withoutProvenance },
];

const D8_LABELS: [string, string][] = [
  ["Baseline1-LLMOnly", "Baseline1-LLMOnly"],
  ["Baseline2-Retrieval+LLM", "Baseline2-Retrieval+LLM"],
  ["WithoutReviewer", "Baseline3-NoReviewer"],
  ["FullSAGE", "Proposed-FullSAGE"],
];
const D9_LABELS: [string, string][] = [
  ["FullSAGE", "A-FullSAGE"],
  ["WithoutReviewer", "B-WithoutReviewer"],
  ["WithoutRenegotiation", "C-WithoutRenegotiation"],
  ["LLMBasedNegotiator", "D-LLMBasedNegotiator"],
  ["WithoutScopedPayloads", "E-WithoutScopedPayloads"],
  ["WithoutProvenance", "F-WithoutProvenance"],
];

const resultsDir = join(__dirname, "..", "..", "..", "..", "results");
const rawResultsPath = join(resultsDir, "d8-d9-raw-results.json");

function loadExistingRaw(): { generatedAt: string; testCaseCount: number; conditions: Record<string, RunResult[]> } {
  try {
    const raw = JSON.parse(require("node:fs").readFileSync(rawResultsPath, "utf-8"));
    if (raw.conditions) return raw;
  } catch {
    // no prior run yet -- start fresh
  }
  return { generatedAt: new Date().toISOString(), testCaseCount: TEST_CASES.length, conditions: {} };
}

// Which unique conditions to (re-)run in THIS process invocation. Defaults to all
// 8; set ONLY_CONDITIONS to a comma-separated subset of UNIQUE_CONDITIONS' labels
// to run this experiment incrementally across several shorter invocations (needed
// in practice: 8 conditions x 27 cases x ~15s Groq-rate-limit pacing is too long
// for a single bounded run) -- results merge into the existing raw-results file
// rather than overwriting conditions that were already run.
async function main() {
  const onlyLabels = process.env.ONLY_CONDITIONS?.split(",").map((s) => s.trim()).filter(Boolean);
  const toRun = onlyLabels ? UNIQUE_CONDITIONS.filter((c) => onlyLabels.includes(c.label)) : UNIQUE_CONDITIONS;

  console.log(`SAGE D8/D9 experiment run -- ${TEST_CASES.length} test cases, ${new Date().toISOString()}`);
  console.log(`Running conditions: ${toRun.map((c) => c.label).join(", ")}\n`);

  const existing = loadExistingRaw();
  mkdirSync(resultsDir, { recursive: true });
  for (const c of toRun) {
    console.log(`\n-- ${c.label} --`);
    existing.conditions[c.label] = await runCondition(c.label, c.fn, TEST_CASES);
    // Checkpoint after every condition: a full run takes about an hour, and an
    // interrupted run should only lose the condition in progress.
    existing.generatedAt = new Date().toISOString();
    writeFileSync(rawResultsPath, JSON.stringify(existing, null, 2));
  }
  console.log(`\nWrote ${rawResultsPath} (conditions so far: ${Object.keys(existing.conditions).join(", ")})`);

  const stillMissing = UNIQUE_CONDITIONS.filter((c) => !existing.conditions[c.label]);
  if (stillMissing.length > 0) {
    console.log(`\nNot all conditions have results yet -- still missing: ${stillMissing.map((c) => c.label).join(", ")}.`);
    console.log(`Run again with ONLY_CONDITIONS=${stillMissing.map((c) => c.label).join(",")} to continue, or with no filter to redo everything.`);
    return;
  }

  const d8Results: Record<string, RunResult[]> = {};
  for (const [uniqueLabel, displayLabel] of D8_LABELS) d8Results[displayLabel] = existing.conditions[uniqueLabel];
  const d9Results: Record<string, RunResult[]> = {};
  for (const [uniqueLabel, displayLabel] of D9_LABELS) d9Results[displayLabel] = existing.conditions[uniqueLabel];

  const d8Summaries: MetricsSummary[] = D8_LABELS.map(([, displayLabel]) => summarize(displayLabel, d8Results[displayLabel], TEST_CASES));
  const d9Summaries: MetricsSummary[] = D9_LABELS.map(([, displayLabel]) => summarize(displayLabel, d9Results[displayLabel], TEST_CASES));

  console.log("\n\n=== D8 Summary: Baselines vs. Proposed Method ===");
  console.log(formatSummaryTable(d8Summaries));
  console.log("\n\n=== D9 Summary: Ablation Study ===");
  console.log(formatSummaryTable(d9Summaries));

  writeFileSync(
    join(resultsDir, "d8-d9-metrics-summary.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), d8: d8Summaries, d9: d9Summaries }, null, 2)
  );

  console.log(`\nWrote ${join(resultsDir, "d8-d9-raw-results.json")}`);
  console.log(`Wrote ${join(resultsDir, "d8-d9-metrics-summary.json")}`);
}

main().catch((err) => {
  console.error("Experiment run failed:", err);
  process.exitCode = 1;
});
