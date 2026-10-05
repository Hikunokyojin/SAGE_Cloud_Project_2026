// D9: pure metric functions computed from a batch of RunResults. Kept dependency-free
// (no I/O) so they're trivially unit-testable (see metrics.test.ts) and reusable across
// both the D8 baseline comparison and the D9 ablation study.
//
// Honesty note (see also results/d8-d9-experimental-report.md "Methodology" and
// "Limitations"): a few of these metrics are automated proxies rather than a ground-truth
// oracle, because no such oracle exists for some of them (e.g. Explanation Consistency
// here only checks that an explanation was produced for every approved/escalated result,
// not that its content is semantically correct -- a full check would need a second
// LLM-as-judge pass, out of scope here).

import type { TestCase, ExpectedOutcome } from "./test-cases";

export type ActualOutcome = "approved" | "escalated" | "failed";

export interface RunResult {
  testCaseId: string;
  /** Denormalized from the TestCase this result came from, so a result is self-describing even without a testCases lookup. */
  expectedOutcome: ExpectedOutcome;
  expectedServiceId?: string;
  actualOutcome: ActualOutcome;
  actualServiceId?: string;
  /**
   * Independently checked against the real price/uptime/latencyMs values in
   * dataset/services.json (see baselines.ts's checkConstraintsSatisfied) -- undefined
   * when actualOutcome !== "approved" (nothing was actually selected to check).
   */
  constraintsSatisfied?: boolean;
  negotiationAttempts: number;
  hitlEscalated: boolean;
  latencyMs: number;
  llmCalls: number;
  /** Length of the decisionId/parentDecisionId provenance chain captured for this request; 0 for a condition/baseline that deliberately carries no provenance (ablation F, Baselines 1/2). */
  provenanceChainLength: number;
  hasExplanation: boolean;
  error?: string;
}

export interface MetricsSummary {
  conditionName: string;
  totalRequests: number;
  constraintSatisfactionRate: number;
  constraintViolationRate: number;
  selectionAccuracy: number;
  averageNegotiationAttempts: number;
  hitlEscalationRate: number;
  endToEndLatency: number;
  totalLlmCalls: number;
  averageLlmCallsPerRequest: number;
  auditCompleteness: number;
  explanationConsistency: number;
  errorRate: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Constraint Satisfaction Rate = fraction of ALL requests that were approved AND
 * independently verified (constraintsSatisfied === true) to actually satisfy the
 * request's constraints. EXACT/AUTOMATED given constraintsSatisfied (see baselines.ts).
 */
export function constraintSatisfactionRate(results: RunResult[]): number {
  if (results.length === 0) return 0;
  const satisfied = results.filter((r) => r.actualOutcome === "approved" && r.constraintsSatisfied === true);
  return satisfied.length / results.length;
}

/**
 * Constraint Violation Rate = fraction of ALL requests that were approved but
 * independently verified to violate the request's constraints (constraintsSatisfied
 * === false) -- the metric that would catch a real safety regression (e.g. a condition
 * approving something it shouldn't have). EXACT/AUTOMATED.
 */
export function constraintViolationRate(results: RunResult[]): number {
  if (results.length === 0) return 0;
  const violated = results.filter((r) => r.actualOutcome === "approved" && r.constraintsSatisfied === false);
  return violated.length / results.length;
}

/**
 * Selection Accuracy = fraction of results whose actualOutcome matches the ground-truth
 * expectedOutcome, and -- when the test case has an unambiguous expectedServiceId --
 * whose actualServiceId also matches it exactly. EXACT/AUTOMATED given the ground truth
 * carried on each TestCase (test-cases.ts).
 */
export function selectionAccuracy(results: RunResult[], testCases: TestCase[]): number {
  if (results.length === 0) return 0;
  const index = new Map(testCases.map((tc) => [tc.id, tc]));
  const correct = results.filter((r) => {
    const tc = index.get(r.testCaseId);
    const expectedOutcome = tc?.expectedOutcome ?? r.expectedOutcome;
    const expectedServiceId = tc?.expectedServiceId ?? r.expectedServiceId;
    if (r.actualOutcome !== expectedOutcome) return false;
    if (expectedServiceId && r.actualServiceId !== expectedServiceId) return false;
    return true;
  });
  return correct.length / results.length;
}

/** Mean number of Negotiator/Reviewer rounds actually executed. EXACT/AUTOMATED. */
export function averageNegotiationAttempts(results: RunResult[]): number {
  return mean(results.map((r) => r.negotiationAttempts));
}

/** Fraction of requests that ended in a Human-in-the-Loop escalation. EXACT/AUTOMATED. */
export function hitlEscalationRate(results: RunResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.hitlEscalated).length / results.length;
}

/** Mean end-to-end wall-clock latency, local in-process (no Lambda cold start, no API Gateway hop -- see report "Methodology"). EXACT/AUTOMATED. */
export function endToEndLatency(results: RunResult[]): number {
  return mean(results.map((r) => r.latencyMs));
}

/** Total real LLM (Groq) API calls made across the batch. EXACT/AUTOMATED (counted at the call site in baselines.ts). */
export function totalLlmCalls(results: RunResult[]): number {
  return results.reduce((sum, r) => sum + r.llmCalls, 0);
}

/** Mean real LLM (Groq) API calls per request. EXACT/AUTOMATED. */
export function averageLlmCallsPerRequest(results: RunResult[]): number {
  if (results.length === 0) return 0;
  return totalLlmCalls(results) / results.length;
}

/**
 * Audit Completeness = fraction of requests with a nonzero provenance chain length.
 * EXACT/AUTOMATED as a per-result flag, but note: this measures presence of a
 * decisionId-based chain the harness captured, not a full DynamoDB-side audit of every
 * intermediate agent's AuditRecord -- in this local run every agent's own
 * recordDecision() write to DynamoDB is expected to fail (no live AWS credentials/table
 * access in this sandboxed run) and is caught and logged by each agent internally, not
 * thrown, so this metric cannot and does not claim to verify actual DynamoDB
 * persistence. See report "Limitations".
 */
export function auditCompleteness(results: RunResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.provenanceChainLength > 0).length / results.length;
}

/**
 * Explanation Consistency = fraction of approved/escalated results that produced a
 * non-empty natural-language explanation at all. HEURISTIC PROXY for "an explanation
 * exists and was recorded", not a semantic/factual-consistency check against the actual
 * decision -- that would need a second LLM-as-judge pass, out of scope here. Failed
 * results are excluded (nothing to explain).
 */
export function explanationConsistency(results: RunResult[]): number {
  const considered = results.filter((r) => r.actualOutcome === "approved" || r.actualOutcome === "escalated");
  if (considered.length === 0) return 0;
  return considered.filter((r) => r.hasExplanation).length / considered.length;
}

/** Fraction of requests that failed with a recorded error (e.g. a missing GROQ_API_KEY, a Qdrant/MongoDB network failure). EXACT/AUTOMATED. */
export function errorRate(results: RunResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.actualOutcome === "failed" && r.error !== undefined).length / results.length;
}

export function summarize(conditionName: string, results: RunResult[], testCases: TestCase[]): MetricsSummary {
  return {
    conditionName,
    totalRequests: results.length,
    constraintSatisfactionRate: constraintSatisfactionRate(results),
    constraintViolationRate: constraintViolationRate(results),
    selectionAccuracy: selectionAccuracy(results, testCases),
    averageNegotiationAttempts: averageNegotiationAttempts(results),
    hitlEscalationRate: hitlEscalationRate(results),
    endToEndLatency: endToEndLatency(results),
    totalLlmCalls: totalLlmCalls(results),
    averageLlmCallsPerRequest: averageLlmCallsPerRequest(results),
    auditCompleteness: auditCompleteness(results),
    explanationConsistency: explanationConsistency(results),
    errorRate: errorRate(results),
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Renders a fixed-width plain-text table of MetricsSummary rows for console output. */
export function formatSummaryTable(summaries: MetricsSummary[]): string {
  const headers = ["Condition", "N", "CSR", "CVR", "SelAcc", "AvgAttempts", "HITL%", "AvgLatMs", "LLMcalls", "Audit%", "ExplCons%", "Err%"];
  const rows = summaries.map((s) => [
    s.conditionName,
    String(s.totalRequests),
    pct(s.constraintSatisfactionRate),
    pct(s.constraintViolationRate),
    pct(s.selectionAccuracy),
    s.averageNegotiationAttempts.toFixed(2),
    pct(s.hitlEscalationRate),
    s.endToEndLatency.toFixed(0),
    `${s.totalLlmCalls} (avg ${s.averageLlmCallsPerRequest.toFixed(2)})`,
    pct(s.auditCompleteness),
    pct(s.explanationConsistency),
    pct(s.errorRate),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(" | ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("-|-"), ...rows.map(line)].join("\n");
}
