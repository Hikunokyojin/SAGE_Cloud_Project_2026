// T4.7 scale study. Skipped unless SCALE_RUN is set (it downloads and runs the embedding model):
//   npm run scale -w @sage/evaluation
// Retrieval-first SAGE: local MiniLM embeddings with the Broker's category filter, every category match up to 100 and 0.38
// cut-off (query: the request text, standing in for Intent's capability phrase), then the real Negotiator handler with the ground-truth constraints. Intent is held at
// the ground truth: it never sees the catalogue, so its accuracy does not change with size.
// LLM-only: the whole catalogue goes in the prompt; its size is counted, not sent.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Constraint, ServiceCandidateWithEvidence } from "@sage/shared-types";
import { SERVICE_CATEGORIES } from "@sage/shared-types";
import { TEST_CASES } from "../src/test-cases";
import { GROUND_TRUTH, satisfiesRequest } from "../src/ground-truth";
import { cosine } from "../src/retrieval/calibration";
import { pad, llmOnlyPromptChars, type ScaleService } from "./pad";

vi.mock("@sage/audit", () => ({ recordDecision: vi.fn(async () => undefined), warmUp: vi.fn() }));

const ROOT = join(__dirname, "..", "..");
const SIZES = [21, 100, 500, 2000];
const TOP = 100; // Broker: CATEGORY_LIMIT (category known)
const MIN_SIMILARITY = 0.38;
// Measured: mean tokens per LLM call over 169 live audit records (2026-11-19); SAGE makes 1.74 calls a request (D8).
const SAGE_TOKENS_PER_REQUEST = Math.round(793 * 1.74);
const CHARS_PER_TOKEN = 4; // approximation for JSON text, flagged in the report
const FREE_TIER_TPM = 8000; // Groq free tier, tokens a minute
const CONTEXT = 131072; // gpt-oss-20b context window

describe.skipIf(!process.env.SCALE_RUN)("T4.7 scale study", () => {
  it("runs", async () => {
    const base: ScaleService[] = JSON.parse(readFileSync(join(ROOT, "data", "services.json"), "utf-8"));
    const v2 = JSON.parse(readFileSync(join(ROOT, "data", "services.v2.json"), "utf-8"));
    const sources = (Array.isArray(v2) ? v2 : v2.services).filter((s: { synthetic?: boolean }) => !s.synthetic);
    const full = pad(base, sources, Math.max(...SIZES));

    const make = pipeline as (task: string, model: string) => Promise<FeatureExtractionPipeline>;
    const extractor = await make("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    const embed = async (t: string) => Array.from((await extractor(t, { pooling: "mean", normalize: true })).data as Float32Array);
    const vectors: number[][] = [];
    for (const s of full) vectors.push(await embed(`${s.name}: ${s.description}`));

    const { handler } = await import("@sage/agent-negotiator/src/index");
    // Intent's soft preferences are deterministic word rules, so the real function is used.
    const { extractPreferences } = await import("@sage/agent-intent/src/index");
    const rows = [];
    const misses: { size: number; case: string; outcome: string; chosen: string | null }[] = [];
    for (const size of SIZES) {
      const catalogue = full.slice(0, size);
      let ansOk = 0, ans = 0, escOk = 0, unans = 0, recallHit = 0, recallN = 0, promptChars = 0;
      for (const tc of TEST_CASES) {
        const truth = GROUND_TRUTH[tc.id];
        promptChars += llmOnlyPromptChars(catalogue, tc.rawInput);
        let outcome: "approved" | "escalated" = "escalated";
        let chosen: string | undefined;
        if ((SERVICE_CATEGORIES as readonly string[]).includes(truth.capability)) {
          const q = await embed(tc.rawInput);
          const hits = catalogue
            .map((s, i) => ({ s, score: cosine(q, vectors[i]) }))
            .filter((h) => h.s.capability === truth.capability && h.score >= MIN_SIMILARITY)
            .sort((a, b) => b.score - a.score)
            .slice(0, TOP);
          if (tc.expectedServiceId) {
            recallN++;
            if (hits.some((h) => h.s.serviceId === tc.expectedServiceId)) recallHit++;
          }
          if (hits.length > 0) {
            const candidates = hits.map((h) => ({
              serviceId: h.s.serviceId, name: h.s.name, description: h.s.description, capability: h.s.capability,
              price: h.s.price, uptime: h.s.uptime, latencyMs: h.s.latencyMs, endpoint: "https://example.invalid",
              similarityScore: h.score, evidence: [],
            })) as unknown as ServiceCandidateWithEvidence[];
            const constraints = truth.constraints.map(([field, operator, value]) => ({ field, operator, value, mandatory: true }) as Constraint);
            try {
              const c = await handler({ requestId: tc.id, candidates, constraints, iteration: 1, requiredCategory: truth.capability, preferences: extractPreferences(tc.rawInput) });
              outcome = "approved";
              chosen = c.chosen.service.serviceId;
            } catch {
              outcome = "escalated";
            }
          }
        }
        if (tc.expectedOutcome === "approved") {
          ans++;
          if (outcome === "approved" && satisfiesRequest(tc.id, chosen)) ansOk++;
          else misses.push({ size, case: tc.id, outcome, chosen: chosen ?? null });
        } else {
          unans++;
          if (outcome === "escalated") escOk++;
        }
      }
      const llmTokens = Math.round(promptChars / TEST_CASES.length / CHARS_PER_TOKEN);
      rows.push({
        size,
        padded: size - base.length,
        sage: { answerableCsr: ansOk / ans, escalationRecall: escOk / unans, bestServiceRetrieved: recallHit / recallN, tokensPerRequest: SAGE_TOKENS_PER_REQUEST },
        llmOnly: { promptTokensPerRequest: llmTokens, fitsFreeTierMinute: llmTokens <= FREE_TIER_TPM, fitsContext: llmTokens <= CONTEXT, tokenRatioVsSage: llmTokens / SAGE_TOKENS_PER_REQUEST },
      });
    }
    writeFileSync(
      join(ROOT, "evaluation", "results", "t47-scale.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), note: "Padding is synthetic (flagged). LLM-only tokens are prompt chars / 4, not a tokenizer count. SAGE tokens are the live mean per call x 1.74 calls.", rows, misses }, null, 1) + "\n"
    );
    expect(rows).toHaveLength(SIZES.length);
  }, 600000);
});
