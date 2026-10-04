import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Composition } from "@sage/shared-types";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class { send = sendMock; },
  PublishCommand: class { constructor(public input: unknown) {} },
}));

function composition(capability: string | undefined): Composition {
  return {
    requestId: "r",
    chosen: {
      service: { serviceId: "svc-queue", name: "QueueRunner", description: "", price: 0.0007, uptime: 99.9, endpoint: "https://e", capability, evidence: [] },
      score: 1,
      reason: "",
    },
    alternatives: [],
    iteration: 1,
    scoreBreakdown: { requestId: "r", candidateId: "svc-queue", dimensions: { price: 1, uptime: 1 }, weights: { price: 1, uptime: 1 }, totalScore: 1, constraintStatus: "pass", violatedConstraints: [] },
  };
}

describe("Reviewer category check", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.SNS_TOPIC_ARN = "arn:aws:sns:ap-south-1:123456789012:sage-hitl";
  });

  it("rejects a choice from the wrong category with a capability Violation", async () => {
    const { handler } = await import("./index");
    const result = await handler({ requestId: "r", composition: composition("message-queue"), constraints: [], requiredCategory: "email-delivery" });
    expect(result.approved).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ constraint: "capability", actualValue: "message-queue", requiredValue: "email-delivery", severity: "hard" }),
    ]);
  });

  it("approves a choice in the required category", async () => {
    const { handler } = await import("./index");
    const result = await handler({ requestId: "r", composition: composition("email-delivery"), constraints: [], requiredCategory: "email-delivery" });
    expect(result.approved).toBe(true);
  });

  it("does not check category when none is required", async () => {
    const { handler } = await import("./index");
    const result = await handler({ requestId: "r", composition: composition(undefined), constraints: [] });
    expect(result.approved).toBe(true);
  });
});
