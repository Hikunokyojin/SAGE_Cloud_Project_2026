// D8/D9: Baseline and ablation condition implementations. Every function here is a
// separately-invokable async function `(testCase) => RunResult`, using the REAL
// agent handler functions imported directly (same in-process pattern as
// src/services/conductor/src/localInvoker.ts) plus, where noted, a real Groq call.
// Nothing here deploys, invokes a Lambda, or writes to the live DynamoDB table
// (AUDIT_TABLE_NAME is left unset for this process, so every agent's own
// recordDecision() call throws internally and is swallowed by that agent's own
// try/catch -- no code in this package needed to change to get that property).
//
// Condition (A), full SAGE, is intentionally NOT reimplemented here -- see
// run-experiments.ts's runFullSage(), which drives the real runPipeline() from
// src/services/conductor/src/pipeline.ts against the real agent handlers,
// unmodified.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSecret } from "@sage/secrets";
import { handler as intentHandler } from "intent-agent";
// Imported via a relative path to Broker's own src (compiled live by tsx), not the
// "broker-agent" package specifier -- that package's package.json "main" points at
// dist/index.js, which copy-native-deps.js (see src/agents/broker/scripts) has
// overwritten with the Linux x64 onnxruntime-node binary for Lambda deployment, so
// requiring it on a non-Linux dev machine fails with MODULE_NOT_FOUND. Broker's own
// src, run through tsx directly, uses the platform-appropriate onnxruntime-node
// binary already present in the root node_modules install instead. This is purely
// an import-path workaround for local execution; Broker's actual logic is untouched.
import type { BrokerAgentInput, ServiceCandidateWithEvidence as BrokerOutput } from "@sage/shared-types";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const brokerHandler: (input: BrokerAgentInput) => Promise<BrokerOutput[]> = require("../../../agents/broker/src/index").handler;
import { handler as negotiatorHandler } from "negotiator-agent";
import { handler as reviewerHandler, escalateUnsatisfiable } from "reviewer-agent";
import { handler as explainerHandler, explainEscalation } from "explainer-agent";
import type {
  Constraint,
  ServiceCandidateWithEvidence,
  Composition,
  ReviewerResult,
  ReviewerAgentInput,
  ScoreBreakdown,
  NegotiationAttempt,
  Violation,
} from "@sage/shared-types";
import type { TestCase } from "./test-cases";
import { satisfiesRequest } from "./ground-truth";
import type { RunResult } from "./metrics";

// ── Shared plumbing ──────────────────────────────────────────────────────────

interface RawService {
  serviceId: string;
  name: string;
  description: string;
  capability: string;
  price: number;
  uptime: number;
  latencyMs?: number;
  endpoint: string;
}

const CATALOG: RawService[] = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "dataset", "services.json"), "utf-8")
);

const GROQ_MODEL = "openai/gpt-oss-20b";
let cachedApiKey: string | null = null;
async function getGroqApiKey(): Promise<string> {
  if (!cachedApiKey) cachedApiKey = await resolveSecret("GROQ_API_KEY", "/sage/shared/GROQ_API_KEY");
  return cachedApiKey;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The free-tier Groq key used for this experiment run is rate-limited at 8000
// tokens/minute -- calling it ~10 conditions x 27 cases in a tight loop (some
// conditions dumping the full 21-service catalog into every prompt, e.g. baseline
// 1 and the without-scoped-payloads ablation) reliably exceeds that limit. Groq's
// 429 response includes the exact wait time in its error message; this honors it
// (plus a small safety margin) rather than silently failing the case, since a
// transient rate limit is not the same finding as an actual model/parsing failure.
// Retries a bounded number of times before giving up and letting the caller treat
// it as a real error -- documented in the report's "Limitations" section.
async function callGroqRaw(systemPrompt: string, userPrompt: string, maxTokens = 1024, attempt = 1): Promise<string> {
  const apiKey = await getGroqApiKey();
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      // Same settings as the deployed Intent/Explainer agents: gpt-oss-20b's hidden
      // reasoning tokens count against max_tokens, and small budgets at default effort
      // frequently produced empty output. Every condition uses identical LLM settings
      // so no baseline or ablation is handicapped relative to full SAGE.
      reasoning_effort: "low",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (response.status === 429 && attempt <= 5) {
    const text = await response.text();
    const match = text.match(/try again in ([\d.]+)s/i);
    const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 500 : 5000 * attempt;
    await sleep(waitMs);
    return callGroqRaw(systemPrompt, userPrompt, maxTokens, attempt + 1);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Groq API error (${response.status}): ${text}`);
  }
  const body = await response.json();
  return body.choices[0].message.content;
}

function baseResult(tc: TestCase): Omit<RunResult, "actualOutcome"> {
  return {
    testCaseId: tc.id,
    expectedOutcome: tc.expectedOutcome,
    expectedServiceId: tc.expectedServiceId,
    negotiationAttempts: 0,
    hitlEscalated: false,
    latencyMs: 0,
    llmCalls: 0,
    provenanceChainLength: 0,
    hasExplanation: false,
  };
}

// Independent, harness-side check of a chosen service against the request's real
// capability and mandatory constraints (ground-truth.ts), using catalog values --
// never a condition's self-report, so CSR/CVR mean the same thing for every
// condition. Whether the *best* valid service was picked is Selection Accuracy's job.
function checkConstraints(tc: TestCase, chosenServiceId: string | undefined): boolean {
  return satisfiesRequest(tc.id, chosenServiceId);
}

// Reviewer's real handler attempts a real SNS publish once an iteration's
// violations trip its MAX_RETRIES=3 circuit breaker. SNS publishing is not among
// the external calls the D8/D9 spec lists as fine to make live, and this harness
// never sets SNS_TOPIC_ARN, so that call throws. Caught here and converted into the
// escalation it represents -- the same outcome a real SNS failure or success both
// eventually produce from the caller's point of view. Documented as a deliberate
// approximation in the final report, not silently smoothed over.
export async function reviewIndependently(input: ReviewerAgentInput): Promise<ReviewerResult> {
  try {
    return await reviewerHandler(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("SNS_TOPIC_ARN")) {
      return {
        requestId: input.requestId,
        decisionId: input.decisionId ?? randomUUID(),
        approved: false,
        violations: [],
        iteration: input.composition.iteration,
        composition: input.composition,
        escalated: true,
      };
    }
    throw err;
  }
}

// ── Baseline 1: LLM-only decision-making ──────────────────────────────────────
// No retrieval, no Negotiator/Reviewer -- a single LLM call given the raw request
// and the full raw catalog, asked to pick one service directly. Deliberately
// violates the typed-payload discipline (raw JSON catalog dumped into the prompt),
// since that is exactly the point of this baseline.

const BASELINE1_SYSTEM = `You are a cloud service marketplace assistant. Given a user's request and a JSON
catalog of available services (id, name, description, capability, price, uptime percent, latencyMs),
pick exactly one service that best satisfies the request. Reply with ONLY a JSON object:
{"serviceId": "<id>", "reason": "<one sentence>"}
If no service in the catalog could reasonably satisfy the request's constraints, reply with:
{"serviceId": null, "reason": "<one sentence why nothing qualifies>"}`;

export async function baseline1LlmOnly(tc: TestCase): Promise<RunResult> {
  const start = Date.now();
  try {
    const userPrompt = `Request: ${tc.rawInput}\n\nCatalog:\n${JSON.stringify(CATALOG)}`;
    const raw = await callGroqRaw(BASELINE1_SYSTEM, userPrompt, 1024);
    const latencyMs = Date.now() - start;
    let parsed: { serviceId: string | null; reason?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...baseResult(tc), actualOutcome: "failed", latencyMs, llmCalls: 1, error: `non-JSON output: ${raw}` };
    }
    if (!parsed.serviceId) {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs, llmCalls: 1, hasExplanation: !!parsed.reason };
    }
    const service = CATALOG.find((s) => s.serviceId === parsed.serviceId);
    return {
      ...baseResult(tc),
      actualOutcome: "approved",
      actualServiceId: parsed.serviceId,
      constraintsSatisfied: checkConstraints(tc, parsed.serviceId) ?? service !== undefined,
      latencyMs,
      llmCalls: 1,
      hasExplanation: !!parsed.reason,
    };
  } catch (err) {
    return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls: 1, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Baseline 2: Retrieval + LLM decision-making ────────────────────────────────
// Broker's real retrieval step (real Qdrant/Mongo calls, no mocking), then one LLM
// call over the retrieved candidates to pick -- no deterministic Negotiator, no
// independent Reviewer.

const BASELINE2_SYSTEM = `You are a cloud service marketplace assistant. Given a user's request and a
shortlist of retrieved candidate services (already narrowed by semantic search), pick exactly one
that best satisfies the request. Reply with ONLY a JSON object:
{"serviceId": "<id>", "reason": "<one sentence>"}
If none of the candidates could reasonably satisfy the request's constraints, reply with:
{"serviceId": null, "reason": "<one sentence why nothing qualifies>"}`;

export async function baseline2RetrievalPlusLlm(tc: TestCase): Promise<RunResult> {
  const start = Date.now();
  let llmCalls = 0;
  try {
    const candidates = await brokerHandler({
      requestId: randomUUID(),
      capability: tc.rawInput,
      constraints: [],
    });
    if (candidates.length === 0) {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs: Date.now() - start, llmCalls };
    }
    const userPrompt = `Request: ${tc.rawInput}\n\nCandidates:\n${JSON.stringify(
      candidates.map((c) => ({ serviceId: c.serviceId, name: c.name, price: c.price, uptime: c.uptime, latencyMs: c.latencyMs }))
    )}`;
    const raw = await callGroqRaw(BASELINE2_SYSTEM, userPrompt, 1024);
    llmCalls += 1;
    const latencyMs = Date.now() - start;
    let parsed: { serviceId: string | null; reason?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...baseResult(tc), actualOutcome: "failed", latencyMs, llmCalls, error: `non-JSON output: ${raw}` };
    }
    if (!parsed.serviceId) {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs, llmCalls, hasExplanation: !!parsed.reason };
    }
    const chosen = candidates.find((c) => c.serviceId === parsed.serviceId);
    return {
      ...baseResult(tc),
      actualOutcome: "approved",
      actualServiceId: parsed.serviceId,
      constraintsSatisfied: checkConstraints(tc, parsed.serviceId) ?? chosen !== undefined,
      latencyMs,
      llmCalls,
      hasExplanation: !!parsed.reason,
    };
  } catch (err) {
    return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Real Intent + Broker helper shared by baseline 3 and ablations C/D/F ──────
// (Not baseline 1/2, which deliberately skip Intent's structured constraints.)

async function realIntentAndBroker(tc: TestCase, llmCallsRef: { count: number }) {
  const intent = await intentHandler({ requestId: randomUUID(), rawInput: tc.rawInput });
  llmCallsRef.count += 1;
  const candidates = await brokerHandler({ requestId: intent.requestId, capability: intent.capability, constraints: intent.constraints });
  return { intent, candidates };
}

// ── Baseline 3 / Ablation (B): SAGE without Reviewer ───────────────────────────
// Real Intent + Broker + deterministic Negotiator, but Negotiator's own
// self-reported constraintStatus is trusted directly instead of Reviewer
// independently re-deriving it -- Reviewer is never called at all.

export async function withoutReviewer(tc: TestCase): Promise<RunResult> {
  const start = Date.now();
  const llmCallsRef = { count: 0 };
  try {
    const { intent, candidates } = await realIntentAndBroker(tc, llmCallsRef);
    if (candidates.length === 0) {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count };
    }
    let composition: Composition;
    try {
      composition = await negotiatorHandler({ requestId: intent.requestId, candidates, constraints: intent.constraints, iteration: 1 });
    } catch {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count };
    }
    // Trust Negotiator's self-report directly -- this is the whole point of the
    // ablation: no independent re-derivation happens at all.
    const trusted = composition.scoreBreakdown.constraintStatus === "pass";
    const latencyMs = Date.now() - start;
    if (!trusted) {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs, llmCalls: llmCallsRef.count, negotiationAttempts: 1 };
    }
    const explained = await explainerHandler({ requestId: intent.requestId, composition });
    llmCallsRef.count += 1;
    return {
      ...baseResult(tc),
      actualOutcome: "approved",
      actualServiceId: composition.chosen.service.serviceId,
      // Independently re-checked by the harness (never trusting Negotiator's own
      // self-report) -- expected to sometimes disagree with `trusted` above,
      // producing a nonzero CVR for this condition.
      constraintsSatisfied: checkConstraints(tc, composition.chosen.service.serviceId),
      negotiationAttempts: 1,
      latencyMs,
      llmCalls: llmCallsRef.count,
      provenanceChainLength: 4, // Intent, Broker, Negotiator, Explainer -- no Reviewer link
      hasExplanation: explained.explanation.length > 0,
    };
  } catch (err) {
    return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Ablation (C): without re-negotiation ───────────────────────────────────────
// Full real pipeline (Intent, Broker, deterministic Negotiator, independent
// Reviewer) but Negotiator only ever gets one shot per request -- Reviewer's
// Violation[] is computed but never fed back as priorViolations, and a rejection
// escalates immediately instead of retrying.

export async function withoutRenegotiation(tc: TestCase): Promise<RunResult> {
  const start = Date.now();
  const llmCallsRef = { count: 0 };
  try {
    const { intent, candidates } = await realIntentAndBroker(tc, llmCallsRef);
    if (candidates.length === 0) {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count };
    }
    let composition: Composition;
    try {
      composition = await negotiatorHandler({ requestId: intent.requestId, candidates, constraints: intent.constraints, iteration: 1 });
    } catch {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count };
    }
    const review = await reviewIndependently({ requestId: intent.requestId, composition, constraints: intent.constraints });
    const latencyMs = Date.now() - start;
    if (!review.approved) {
      // No second attempt -- this condition's entire point.
      return { ...baseResult(tc), actualOutcome: "escalated", hitlEscalated: true, latencyMs, llmCalls: llmCallsRef.count, negotiationAttempts: 1, provenanceChainLength: 4 };
    }
    const explained = await explainerHandler({ requestId: intent.requestId, composition: review.composition });
    llmCallsRef.count += 1;
    return {
      ...baseResult(tc),
      actualOutcome: "approved",
      actualServiceId: composition.chosen.service.serviceId,
      constraintsSatisfied: checkConstraints(tc, composition.chosen.service.serviceId),
      negotiationAttempts: 1,
      latencyMs,
      llmCalls: llmCallsRef.count,
      provenanceChainLength: 5,
      hasExplanation: explained.explanation.length > 0,
    };
  } catch (err) {
    return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Ablation (D): LLM-based Negotiator ─────────────────────────────────────────
// Real Intent + Broker + independent Reviewer, but an LLM picks the candidate from
// Broker's retrieved set instead of the deterministic scoring algorithm.

const NEGOTIATOR_LLM_SYSTEM = `You are the Negotiator for a cloud service marketplace. Given a list of
candidate services (with price, uptime, latencyMs) and a list of constraints (field, operator, value,
mandatory), pick exactly one candidate that best satisfies the mandatory constraints and, among those,
best satisfies the optional preferences. Reply with ONLY JSON: {"serviceId": "<id>"}`;

function syntheticComposition(requestId: string, chosen: ServiceCandidateWithEvidence, all: ServiceCandidateWithEvidence[]): Composition {
  const scoreBreakdown: ScoreBreakdown = {
    requestId,
    candidateId: chosen.serviceId,
    dimensions: { price: 0, uptime: 0 },
    weights: { price: 1, uptime: 1 },
    totalScore: 0,
    constraintStatus: "pass", // LLM's self-report, un-validated by construction -- Reviewer re-derives independently regardless
    violatedConstraints: [],
  };
  return {
    requestId,
    chosen: { service: chosen, score: 0, reason: "selected by LLM-based Negotiator ablation" },
    alternatives: all.filter((c) => c.serviceId !== chosen.serviceId).map((c) => ({ service: c, score: 0, reason: "not selected" })),
    iteration: 1,
    scoreBreakdown,
  };
}

export async function llmBasedNegotiator(tc: TestCase): Promise<RunResult> {
  const start = Date.now();
  const llmCallsRef = { count: 0 };
  try {
    const { intent, candidates } = await realIntentAndBroker(tc, llmCallsRef);
    if (candidates.length === 0) {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count };
    }
    const userPrompt = `Candidates:\n${JSON.stringify(
      candidates.map((c) => ({ serviceId: c.serviceId, price: c.price, uptime: c.uptime, latencyMs: c.latencyMs }))
    )}\nConstraints:\n${JSON.stringify(intent.constraints)}`;
    const raw = await callGroqRaw(NEGOTIATOR_LLM_SYSTEM, userPrompt, 1024);
    llmCallsRef.count += 1;
    let parsed: { serviceId?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count, error: `non-JSON output: ${raw}` };
    }
    const chosenCandidate = candidates.find((c) => c.serviceId === parsed.serviceId);
    if (!chosenCandidate) {
      return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count, error: `LLM picked unknown serviceId ${parsed.serviceId}` };
    }
    const composition = syntheticComposition(intent.requestId, chosenCandidate, candidates);
    const review = await reviewIndependently({ requestId: intent.requestId, composition, constraints: intent.constraints });
    const latencyMs = Date.now() - start;
    if (!review.approved) {
      return { ...baseResult(tc), actualOutcome: "escalated", hitlEscalated: review.escalated, latencyMs, llmCalls: llmCallsRef.count, negotiationAttempts: 1, provenanceChainLength: 4 };
    }
    const explained = await explainerHandler({ requestId: intent.requestId, composition: review.composition });
    llmCallsRef.count += 1;
    return {
      ...baseResult(tc),
      actualOutcome: "approved",
      actualServiceId: chosenCandidate.serviceId,
      constraintsSatisfied: checkConstraints(tc, chosenCandidate.serviceId),
      negotiationAttempts: 1,
      latencyMs,
      llmCalls: llmCallsRef.count,
      provenanceChainLength: 5,
      hasExplanation: explained.explanation.length > 0,
    };
  } catch (err) {
    return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Ablation (E): without scoped payloads ──────────────────────────────────────
// Instead of the typed Intent -> Broker -> Negotiator -> Reviewer handoff, this
// condition concatenates the raw request into an unstructured context blob and
// asks a single LLM call to directly emit a decision, deliberately skipping the
// typed-payload discipline.

const UNSCOPED_SYSTEM = `You are a cloud service marketplace decision engine operating WITHOUT any typed
intermediate representation -- you receive the full raw conversational context and the full raw service
catalog dump, and must decide everything in one shot: what capability is needed, what constraints apply,
and which single service to choose. Reply with ONLY JSON:
{"serviceId": "<id or null>", "reason": "<one sentence>"}`;

export async function withoutScopedPayloads(tc: TestCase): Promise<RunResult> {
  const start = Date.now();
  try {
    const unscopedContext = [
      `--- conversation history (raw, unscoped) ---`,
      `user: ${tc.rawInput}`,
      `--- full service catalog (raw, unscoped) ---`,
      JSON.stringify(CATALOG),
    ].join("\n");
    const raw = await callGroqRaw(UNSCOPED_SYSTEM, unscopedContext, 1024);
    const latencyMs = Date.now() - start;
    let parsed: { serviceId: string | null; reason?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...baseResult(tc), actualOutcome: "failed", latencyMs, llmCalls: 1, error: `non-JSON output: ${raw}` };
    }
    if (!parsed.serviceId) {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs, llmCalls: 1, hasExplanation: !!parsed.reason };
    }
    const service = CATALOG.find((s) => s.serviceId === parsed.serviceId);
    return {
      ...baseResult(tc),
      actualOutcome: "approved",
      actualServiceId: parsed.serviceId,
      constraintsSatisfied: checkConstraints(tc, parsed.serviceId) ?? service !== undefined,
      latencyMs,
      llmCalls: 1,
      provenanceChainLength: 0, // no typed handoff chain exists in this condition by construction
      hasExplanation: !!parsed.reason,
    };
  } catch (err) {
    return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls: 1, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Ablation (F): without provenance ───────────────────────────────────────────
// Real full pipeline (Intent, Broker, Negotiator, Reviewer, Explainer, real
// re-negotiation loop), but no decisionId/parentDecisionId chain is threaded --
// every call omits decisionId/parentDecisionId entirely (both fields are optional
// on every agent input type, so this requires no agent code change, just not
// supplying them). Functionally identical to condition A other than provenance.

export async function withoutProvenance(tc: TestCase): Promise<RunResult> {
  const start = Date.now();
  const llmCallsRef = { count: 0 };
  try {
    const intent = await intentHandler({ requestId: randomUUID(), rawInput: tc.rawInput });
    llmCallsRef.count += 1;
    const candidates = await brokerHandler({ requestId: intent.requestId, capability: intent.capability, constraints: intent.constraints });
    if (candidates.length === 0) {
      return { ...baseResult(tc), actualOutcome: "escalated", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count };
    }

    const history: NegotiationAttempt[] = [];
    let priorViolations: Violation[] | undefined = undefined;
    let iteration = 1;
    const MAX = 5;
    while (iteration <= MAX) {
      let composition: Composition;
      try {
        composition = await negotiatorHandler({ requestId: intent.requestId, candidates, constraints: intent.constraints, iteration, priorViolations });
      } catch {
        return { ...baseResult(tc), actualOutcome: "escalated", hitlEscalated: true, latencyMs: Date.now() - start, llmCalls: llmCallsRef.count, negotiationAttempts: iteration, provenanceChainLength: 0 };
      }
      const review = await reviewIndependently({ requestId: intent.requestId, composition, constraints: intent.constraints });
      history.push({ iteration, composition, reviewerResult: review, timestamp: new Date().toISOString() });
      if (review.approved) {
        const explained = await explainerHandler({ requestId: intent.requestId, composition: review.composition, negotiationHistory: history });
        llmCallsRef.count += 1;
        return {
          ...baseResult(tc),
          actualOutcome: "approved",
          actualServiceId: composition.chosen.service.serviceId,
          constraintsSatisfied: checkConstraints(tc, composition.chosen.service.serviceId),
          negotiationAttempts: iteration,
          latencyMs: Date.now() - start,
          llmCalls: llmCallsRef.count,
          provenanceChainLength: 0, // by construction: no decisionId ever supplied
          hasExplanation: explained.explanation.length > 0,
        };
      }
      if (review.escalated) {
        return {
          ...baseResult(tc),
          actualOutcome: "escalated",
          hitlEscalated: true,
          negotiationAttempts: iteration,
          latencyMs: Date.now() - start,
          llmCalls: llmCallsRef.count,
          provenanceChainLength: 0,
        };
      }
      priorViolations = review.violations;
      iteration += 1;
    }
    return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count, error: "safety max attempts exceeded" };
  } catch (err) {
    return { ...baseResult(tc), actualOutcome: "failed", latencyMs: Date.now() - start, llmCalls: llmCallsRef.count, error: err instanceof Error ? err.message : String(err) };
  }
}
