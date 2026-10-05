import { describe, it, expect } from "vitest";
import {
  constraintSatisfactionRate,
  constraintViolationRate,
  selectionAccuracy,
  averageNegotiationAttempts,
  hitlEscalationRate,
  endToEndLatency,
  totalLlmCalls,
  averageLlmCallsPerRequest,
  auditCompleteness,
  explanationConsistency,
  errorRate,
  summarize,
  type RunResult,
} from "./metrics";
import type { TestCase } from "./test-cases";

function result(overrides: Partial<RunResult>): RunResult {
  return {
    testCaseId: "tc-1",
    expectedOutcome: "approved",
    actualOutcome: "approved",
    negotiationAttempts: 1,
    hitlEscalated: false,
    latencyMs: 100,
    llmCalls: 1,
    provenanceChainLength: 3,
    hasExplanation: true,
    ...overrides,
  };
}

function testCase(overrides: Partial<TestCase>): TestCase {
  return {
    id: "tc-1",
    category: "simple-selection",
    rawInput: "test",
    expectedOutcome: "approved",
    notes: "",
    ...overrides,
  } as TestCase;
}

describe("constraintSatisfactionRate", () => {
  it("counts only approved+satisfied results as valid", () => {
    const results = [
      result({ actualOutcome: "approved", constraintsSatisfied: true }),
      result({ actualOutcome: "approved", constraintsSatisfied: false }),
      result({ actualOutcome: "escalated", constraintsSatisfied: undefined }),
    ];
    expect(constraintSatisfactionRate(results)).toBeCloseTo(1 / 3);
  });

  it("returns 0 for an empty batch", () => {
    expect(constraintSatisfactionRate([])).toBe(0);
  });
});

describe("constraintViolationRate", () => {
  it("counts approved-but-invalid results", () => {
    const results = [
      result({ actualOutcome: "approved", constraintsSatisfied: true }),
      result({ actualOutcome: "approved", constraintsSatisfied: false }),
      result({ actualOutcome: "approved", constraintsSatisfied: false }),
    ];
    expect(constraintViolationRate(results)).toBeCloseTo(2 / 3);
  });

  it("is the complement of CSR only among approved results, not the whole batch", () => {
    const results = [
      result({ actualOutcome: "approved", constraintsSatisfied: true }),
      result({ actualOutcome: "escalated" }),
    ];
    expect(constraintSatisfactionRate(results)).toBeCloseTo(0.5);
    expect(constraintViolationRate(results)).toBe(0);
  });
});

describe("selectionAccuracy", () => {
  it("requires both outcome and serviceId to match when expectedServiceId is set", () => {
    const cases = [testCase({ id: "a", expectedOutcome: "approved", expectedServiceId: "svc-x" })];
    const correct = [result({ testCaseId: "a", actualOutcome: "approved", actualServiceId: "svc-x" })];
    const wrongService = [result({ testCaseId: "a", actualOutcome: "approved", actualServiceId: "svc-y" })];
    expect(selectionAccuracy(correct, cases)).toBe(1);
    expect(selectionAccuracy(wrongService, cases)).toBe(0);
  });

  it("only requires outcome match when expectedServiceId is unset", () => {
    const cases = [testCase({ id: "a", expectedOutcome: "escalated" })];
    const matches = [result({ testCaseId: "a", actualOutcome: "escalated" })];
    expect(selectionAccuracy(matches, cases)).toBe(1);
  });
});

describe("averageNegotiationAttempts / hitlEscalationRate / endToEndLatency", () => {
  it("computes simple averages/rates", () => {
    const results = [
      result({ negotiationAttempts: 1, hitlEscalated: false, latencyMs: 100 }),
      result({ negotiationAttempts: 3, hitlEscalated: true, latencyMs: 300 }),
    ];
    expect(averageNegotiationAttempts(results)).toBe(2);
    expect(hitlEscalationRate(results)).toBe(0.5);
    expect(endToEndLatency(results)).toBe(200);
  });
});

describe("totalLlmCalls / averageLlmCallsPerRequest", () => {
  it("sums and averages llmCalls", () => {
    const results = [result({ llmCalls: 1 }), result({ llmCalls: 3 })];
    expect(totalLlmCalls(results)).toBe(4);
    expect(averageLlmCallsPerRequest(results)).toBe(2);
  });
});

describe("auditCompleteness", () => {
  it("is the fraction of runs with a nonzero provenance chain", () => {
    const results = [result({ provenanceChainLength: 5 }), result({ provenanceChainLength: 0 })];
    expect(auditCompleteness(results)).toBe(0.5);
  });
});

describe("explanationConsistency", () => {
  it("only considers approved/escalated results, ignores failed", () => {
    const results = [
      result({ actualOutcome: "approved", hasExplanation: true }),
      result({ actualOutcome: "escalated", hasExplanation: false }),
      result({ actualOutcome: "failed", hasExplanation: false }),
    ];
    expect(explanationConsistency(results)).toBe(0.5);
  });
});

describe("errorRate", () => {
  it("counts only failed results carrying an error message", () => {
    const results = [result({ actualOutcome: "failed", error: "boom" }), result({ actualOutcome: "approved" })];
    expect(errorRate(results)).toBe(0.5);
  });
});

describe("summarize", () => {
  it("produces a MetricsSummary with the condition name and totals intact", () => {
    const cases = [testCase({ id: "a", expectedOutcome: "approved", expectedServiceId: "svc-x" })];
    const results = [result({ testCaseId: "a", actualOutcome: "approved", actualServiceId: "svc-x", constraintsSatisfied: true })];
    const summary = summarize("test-condition", results, cases);
    expect(summary.conditionName).toBe("test-condition");
    expect(summary.totalRequests).toBe(1);
    expect(summary.selectionAccuracy).toBe(1);
    expect(summary.constraintSatisfactionRate).toBe(1);
  });
});
