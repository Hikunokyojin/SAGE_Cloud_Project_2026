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

describe("Reviewer independent price, quota and chain checks (T4.1c)", () => {
  const ses = { serviceId: "svc-ses", name: "SES", description: "", endpoint: "https://x", evidence: [], uptime: 99.9,
    capability: "email-delivery", listPrice: 0.1, priceUnit: "per 1,000 emails", currency: "USD" };
  const withService = (svc: object) => {
    const c = composition();
    c.chosen.service = { ...c.chosen.service, ...svc } as Composition["chosen"]["service"];
    return c;
  };
  const volume = { amount: 250_000, unit: "emails" as const };

  it("approves a price that matches the list price at the stated volume", async () => {
    const { handler } = await import("./index");
    const r = await handler({ requestId: "r", composition: withService({ ...ses, price: 25 }), constraints: [], volume });
    expect(r.violations).toEqual([]);
  });

  it("rejects a price that does not match the list price at the stated volume (L12)", async () => {
    const { handler } = await import("./index");
    const r = await handler({ requestId: "r", composition: withService({ ...ses, price: 10 }), constraints: [], volume });
    expect(r.violations[0]).toMatchObject({ constraint: "price", actualValue: 10, requiredValue: 25 });
  });

  it("checks a price limit against the recomputed price, not the stated one", async () => {
    const { handler } = await import("./index");
    const limit: Constraint = { field: "price", operator: "lte", value: 15, mandatory: true };
    const r = await handler({ requestId: "r", composition: withService({ ...ses, price: 10 }), constraints: [limit], volume });
    expect(r.violations.map((v) => v.constraint)).toEqual(["price", "price"]);
  });

  it("rejects a plan whose quota is below the stated volume", async () => {
    const { handler } = await import("./index");
    const svc = { serviceId: "svc-sg", price: 19.95, volumeBasis: "quota", includedUnits: { amount: 50_000, unit: "emails" } };
    const r = await handler({ requestId: "r", composition: withService(svc), constraints: [], volume });
    expect(r.violations[0]).toMatchObject({ constraint: "volume", actualValue: 50_000, requiredValue: 250_000 });
  });

  it("checks a per-unit limit against the unit price", async () => {
    const { handler } = await import("./index");
    const perUnit: Constraint = { field: "price", operator: "lte", value: 0.00005, mandatory: true, per: "unit" };
    const r = await handler({ requestId: "r", composition: withService({ ...ses, price: 10 }), constraints: [perUnit] });
    expect(r.violations[0]).toMatchObject({ constraint: "price per unit", actualValue: 0.0001 });
  });

  const chainComposition = (a: object, b: object) => {
    const c = composition();
    const choice = (svc: object) => ({ service: { ...c.chosen.service, ...svc } as Composition["chosen"]["service"], score: 0.8, reason: "" });
    c.chain = {
      steps: [
        { capability: "ocr", chosen: choice(a), dependsOn: [] },
        { capability: "translation", chosen: choice(b), dependsOn: [0] },
      ],
      totals: { price: 0, uptime: 0 },
      score: 0.8,
      combinationsCompared: 1,
      combinationsValid: 1,
    };
    return c;
  };
  const steps = [
    { capability: "ocr", constraints: [], dependsOn: [] },
    { capability: "translation", constraints: [], dependsOn: [0] },
  ];

  it("recomputes chain totals and names the costliest step when the budget fails", async () => {
    const { handler } = await import("./index");
    const budget: Constraint = { field: "price", operator: "lte", value: 20, mandatory: true };
    const r = await handler({
      requestId: "r", steps, constraints: [budget],
      composition: chainComposition({ serviceId: "ocr-a", price: 15, uptime: 99.9 }, { serviceId: "tr-a", price: 10, uptime: 99.5 }),
    });
    expect(r.violations).toEqual([expect.objectContaining({ constraint: "chain price", actualValue: 25, affectedCandidate: "ocr-a" })]);
  });

  it("checks combined uptime and names the least reliable step", async () => {
    const { handler } = await import("./index");
    const uptime: Constraint = { field: "uptime", operator: "gte", value: 99.5, mandatory: true };
    const r = await handler({
      requestId: "r", steps, constraints: [uptime],
      composition: chainComposition({ serviceId: "ocr-a", price: 1, uptime: 99.9 }, { serviceId: "tr-a", price: 1, uptime: 99.5 }),
    });
    expect(r.violations[0]).toMatchObject({ constraint: "chain uptime", actualValue: 99.4005, affectedCandidate: "tr-a" });
  });

  it("rejects a chain whose steps do not match the request", async () => {
    const { handler } = await import("./index");
    const r = await handler({
      requestId: "r", steps: [steps[1], steps[0]], constraints: [],
      composition: chainComposition({ serviceId: "ocr-a", price: 1 }, { serviceId: "tr-a", price: 1 }),
    });
    expect(r.violations[0].constraint).toBe("chain");
  });

  it("checks each step's own limits, labelled by step", async () => {
    const { handler } = await import("./index");
    const cap: Constraint = { field: "price", operator: "lte", value: 5, mandatory: true };
    const r = await handler({
      requestId: "r", constraints: [],
      steps: [steps[0], { ...steps[1], constraints: [cap] }],
      composition: chainComposition({ serviceId: "ocr-a", price: 1 }, { serviceId: "tr-a", price: 8 }),
    });
    expect(r.violations[0]).toMatchObject({ constraint: "step 2: price", affectedCandidate: "tr-a" });
  });
});
