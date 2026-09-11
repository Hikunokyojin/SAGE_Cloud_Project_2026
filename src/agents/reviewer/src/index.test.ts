import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReviewerAgentInput, CompositionBlueprint } from "@sage/shared-types";

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

function blueprint(overrides: { price?: number; uptime?: number } = {}): CompositionBlueprint {
  return {
    requestId: "req-1",
    chosen: {
      service: {
        serviceId: "svc-1",
        name: "FastResize",
        description: "Quick image resizer",
        price: overrides.price ?? 0.02,
        uptime: overrides.uptime ?? 99.9,
        endpoint: "https://api.example.com/resize",
      },
      score: 0.87,
      reason: "price=0.02, uptime=99.9%",
    },
    alternatives: [],
  };
}

describe("Reviewer Agent handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.SNS_TOPIC_ARN = "arn:aws:sns:ap-south-1:123456789012:sage-hitl";
  });

  it("approves a composition that satisfies the constraints, without contacting SNS", async () => {
    const input: ReviewerAgentInput = {
      requestId: "req-1",
      blueprint: blueprint({ price: 0.02, uptime: 99.9 }),
      constraints: { maxBudget: 0.05, minUptime: 95 },
      attempt: 1,
    };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result.approved).toBe(true);
    expect(result.escalated).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects a composition that violates constraints but has not hit the retry limit, without escalating", async () => {
    const input: ReviewerAgentInput = {
      requestId: "req-2",
      blueprint: blueprint({ price: 0.5, uptime: 99.9 }), // over maxBudget
      constraints: { maxBudget: 0.05, minUptime: 95 },
      attempt: 1,
    };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result.approved).toBe(false);
    expect(result.escalated).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("trips the circuit breaker and escalates to SNS once the retry limit (3) is reached", async () => {
    const input: ReviewerAgentInput = {
      requestId: "req-3",
      blueprint: blueprint({ price: 0.5, uptime: 99.9 }), // still violates constraints
      constraints: { maxBudget: 0.05, minUptime: 95 },
      attempt: 3, // MAX_RETRIES
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
      blueprint: blueprint({ price: 0.5, uptime: 99.9 }),
      constraints: { maxBudget: 0.05, minUptime: 95 },
      attempt: 3,
    };

    const { handler } = await import("./index");
    await expect(handler(input)).rejects.toThrow("SNS_TOPIC_ARN is not set");
  });
});
