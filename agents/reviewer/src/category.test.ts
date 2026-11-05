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

  it("explains a no-match escalation plainly when the request had no constraints", async () => {
    const { escalateUnsatisfiable } = await import("./index");
    const out = await escalateUnsatisfiable({ requestId: "r", constraints: [], reason: "no matching services were found" });
    expect(out.explanation).toContain("No service in the catalog matches this request");
    expect(out.explanation).not.toContain("constraints requested were");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("explains a capability_not_in_catalogue escalation as a kind of service the marketplace does not offer", async () => {
    const { escalateUnsatisfiable } = await import("./index");
    const out = await escalateUnsatisfiable({
      requestId: "r",
      constraints: [{ field: "uptime", operator: "gte", value: 99.5, mandatory: true }],
      reason: 'capability_not_in_catalogue: "highly reliable database service" does not match any service category in the catalogue',
      kind: "capability_not_in_catalogue",
    });
    expect(out.explanation).toContain("does not offer this kind of service");
    expect(out.explanation).not.toContain("Consider relaxing");
    expect(sendMock.mock.calls[0][0].input.Subject).toContain("not in the catalogue");
  });

  it("keeps every SNS subject within SNS's 100-character limit for a real UUID request id", async () => {
    const { escalateUnsatisfiable } = await import("./index");
    const requestId = "2d3556f1-8f3a-49e4-b494-ab4360024daa";
    for (const kind of ["capability_not_in_catalogue", undefined] as const) {
      sendMock.mockClear();
      await escalateUnsatisfiable({ requestId, constraints: [], reason: "x", kind });
      const subject = sendMock.mock.calls[0][0].input.Subject as string;
      expect(subject.length).toBeLessThanOrEqual(100);
      expect(subject).toContain(requestId);
    }
  });

  it("lists the constraints when an escalation had some", async () => {
    const { escalateUnsatisfiable } = await import("./index");
    const out = await escalateUnsatisfiable({
      requestId: "r",
      constraints: [{ field: "uptime", operator: "gte", value: 100, mandatory: true }],
      reason: "no candidate satisfies the mandatory constraints",
    });
    expect(out.explanation).toContain("uptime is at least 100");
  });

  it("does not check category when none is required", async () => {
    const { handler } = await import("./index");
    const result = await handler({ requestId: "r", composition: composition(undefined), constraints: [] });
    expect(result.approved).toBe(true);
  });
});
