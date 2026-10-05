import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReviewerAgentInput, Composition, Constraint } from "@sage/shared-types";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-sns", () => {
  class SNSClient {
    send = sendMock;
  }
  class PublishCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { SNSClient, PublishCommand };
});

function composition(overrides: { price?: number; uptime?: number; iteration?: number } = {}): Composition {
  const price = overrides.price ?? 0.02;
  const uptime = overrides.uptime ?? 99.9;
  return {
    requestId: "req-1",
    chosen: {
      service: {
        serviceId: "svc-1",
        name: "FastResize",
        description: "Quick image resizer",
        price,
        uptime,
        endpoint: "https://api.example.com/resize",
        evidence: [],
      },
      score: 0.87,
      reason: `price=${price}, uptime=${uptime}%`,
    },
    alternatives: [],
    iteration: overrides.iteration ?? 1,
    scoreBreakdown: {
      requestId: "req-1",
      candidateId: "svc-1",
      dimensions: { price: 1, uptime: 1, capability: 1 },
      weights: { price: 1, uptime: 1, capability: 0.5 },
      totalScore: 0.87,
      constraintStatus: "pass",
      violatedConstraints: [],
    },
  };
}

const CONSTRAINTS: Constraint[] = [
  { field: "price", operator: "lte", value: 0.05, mandatory: true },
  { field: "uptime", operator: "gte", value: 95, mandatory: true },
];

describe("Reviewer Agent handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.SNS_TOPIC_ARN = "arn:aws:sns:ap-south-1:123456789012:sage-hitl";
  });

  it("independently approves a composition that satisfies every mandatory constraint, without contacting SNS", async () => {
    const input: ReviewerAgentInput = {
      requestId: "req-1",
      composition: composition({ price: 0.02, uptime: 99.9 }),
      constraints: CONSTRAINTS,
    };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.escalated).toBe(false);
    expect(result.decisionId).toEqual(expect.any(String));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects a composition with a structured Violation when a mandatory constraint fails, without escalating below the retry limit", async () => {
    const input: ReviewerAgentInput = {
      requestId: "req-2",
      composition: composition({ price: 0.5, uptime: 99.9, iteration: 1 }), // over price constraint
      constraints: CONSTRAINTS,
    };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result.approved).toBe(false);
    expect(result.escalated).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      constraint: "price",
      actualValue: 0.5,
      requiredValue: 0.05,
      severity: "hard",
      affectedCandidate: "svc-1",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not trust the Negotiator's self-reported constraintStatus -- re-derives pass/fail independently from the raw price/uptime", async () => {
    const input: ReviewerAgentInput = {
      requestId: "req-2b",
      composition: composition({ price: 0.5, uptime: 99.9 }), // Negotiator's own scoreBreakdown says "pass"
      constraints: CONSTRAINTS,
    };

    const { handler } = await import("./index");
    const result = await handler(input);

    // Reviewer must reject this despite the input composition's scoreBreakdown.constraintStatus === "pass".
    expect(input.composition.scoreBreakdown.constraintStatus).toBe("pass");
    expect(result.approved).toBe(false);
  });

  it("trips the circuit breaker and escalates to SNS once the retry limit (3) is reached", async () => {
    const input: ReviewerAgentInput = {
      requestId: "req-3",
      composition: composition({ price: 0.5, uptime: 99.9, iteration: 3 }), // still violates constraints
      constraints: CONSTRAINTS,
    };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result.approved).toBe(false);
    expect(result.escalated).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const publishedCommand = sendMock.mock.calls[0][0];
    expect(publishedCommand.input.TopicArn).toBe("arn:aws:sns:ap-south-1:123456789012:sage-hitl");
    expect(publishedCommand.input.Message).toContain("req-3");
  });

  it("throws instead of silently succeeding when SNS_TOPIC_ARN is not configured at escalation time", async () => {
    delete process.env.SNS_TOPIC_ARN;

    const input: ReviewerAgentInput = {
      requestId: "req-4",
      composition: composition({ price: 0.5, uptime: 99.9, iteration: 3 }),
      constraints: CONSTRAINTS,
    };

    const { handler } = await import("./index");
    await expect(handler(input)).rejects.toThrow("SNS_TOPIC_ARN is not set");
  });
});
