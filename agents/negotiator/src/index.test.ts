import { describe, it, expect } from "vitest";
import { handler } from "./index";
import type { NegotiatorAgentInput, ServiceCandidateWithEvidence, Constraint, Violation } from "@sage/shared-types";

function candidate(overrides: Partial<ServiceCandidateWithEvidence>): ServiceCandidateWithEvidence {
  return {
    serviceId: "svc-1",
    name: "Service",
    description: "A service",
    price: 0.05,
    uptime: 99.5,
    endpoint: "https://example.com",
    evidence: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<NegotiatorAgentInput> = {}): NegotiatorAgentInput {
  return {
    requestId: "req-1",
    constraints: [],
    candidates: [],
    iteration: 1,
    ...overrides,
  };
}

describe("Negotiator Agent handler", () => {
  it("chooses the candidate with the best combined price/uptime score", async () => {
    const input = baseInput({
      candidates: [
        candidate({ serviceId: "cheap-low-uptime", price: 0.01, uptime: 95 }),
        candidate({ serviceId: "expensive-high-uptime", price: 0.5, uptime: 99.99 }),
        candidate({ serviceId: "balanced", price: 0.05, uptime: 99.5 }),
      ],
    });

    const result = await handler(input);

    expect(result.requestId).toBe("req-1");
    expect(result.chosen.service.serviceId).toBe("balanced");
    expect(result.alternatives).toHaveLength(2);
    expect(result.iteration).toBe(1);
  });

  it("produces identical output for identical input, with no side effects (deterministic, not an LLM call)", async () => {
    const input = baseInput({
      requestId: "req-determinism",
      candidates: [
        candidate({ serviceId: "a", price: 0.02, uptime: 98 }),
        candidate({ serviceId: "b", price: 0.03, uptime: 99 }),
      ],
    });

    const first = await handler(input);
    const second = await handler(input);

    expect(second).toEqual(first);
  });

  it("breaks ties deterministically by serviceId when scores are equal", async () => {
    const input = baseInput({
      requestId: "req-tie",
      candidates: [
        candidate({ serviceId: "z-service", price: 0.05, uptime: 99 }),
        candidate({ serviceId: "a-service", price: 0.05, uptime: 99 }),
      ],
    });

    const result = await handler(input);

    // Equal price/uptime -> equal score -> tie-break picks lexicographically smallest serviceId.
    expect(result.chosen.service.serviceId).toBe("a-service");
  });

  it("throws when given an empty candidate list", async () => {
    const input = baseInput({ requestId: "req-empty", candidates: [] });

    await expect(handler(input)).rejects.toThrow("no candidates to score");
  });

  it("excludes a candidate that fails a mandatory constraint, as a hard filter rather than a penalty", async () => {
    const constraints: Constraint[] = [{ field: "uptime", operator: "gte", value: 99, mandatory: true }];
    const input = baseInput({
      requestId: "req-mandatory",
      constraints,
      candidates: [
        candidate({ serviceId: "cheap-below-mandatory-uptime", price: 0.001, uptime: 97 }),
        candidate({ serviceId: "meets-mandatory-uptime", price: 0.05, uptime: 99.5 }),
      ],
    });

    const result = await handler(input);

    expect(result.chosen.service.serviceId).toBe("meets-mandatory-uptime");
    expect(result.alternatives).toHaveLength(0);
  });

  it("throws a descriptive error when no candidate satisfies the mandatory constraints", async () => {
    const constraints: Constraint[] = [{ field: "uptime", operator: "gte", value: 100, mandatory: true }];
    const input = baseInput({
      requestId: "req-no-valid-solution",
      constraints,
      candidates: [candidate({ serviceId: "svc-a", uptime: 99.99 }), candidate({ serviceId: "svc-b", uptime: 99.9 })],
    });

    await expect(handler(input)).rejects.toThrow("no candidate satisfies the mandatory constraints");
  });

  it("weights an optional preference by its priority, favoring a non-cheapest candidate on a heavily-weighted dimension", async () => {
    const constraints: Constraint[] = [{ field: "latencyMs", operator: "lte", value: 10000, mandatory: false, priority: 10 }];
    const input = baseInput({
      requestId: "req-weighted",
      constraints,
      candidates: [
        candidate({ serviceId: "cheap-slow", price: 0.005, uptime: 97.5, latencyMs: 650 }),
        candidate({ serviceId: "expensive-fast", price: 0.045, uptime: 99.7, latencyMs: 45 }),
      ],
    });

    const result = await handler(input);

    // A heavily-weighted latency preference should outweigh the large price gap.
    expect(result.chosen.service.serviceId).toBe("expensive-fast");
  });

  it("emits a full per-dimension ScoreBreakdown alongside the selection", async () => {
    const input = baseInput({
      requestId: "req-breakdown",
      candidates: [
        candidate({ serviceId: "a", price: 0.01, uptime: 98 }),
        candidate({ serviceId: "b", price: 0.03, uptime: 99.5 }),
      ],
    });

    const result = await handler(input);

    expect(result.scoreBreakdown.requestId).toBe("req-breakdown");
    expect(result.scoreBreakdown.candidateId).toBe(result.chosen.service.serviceId);
    expect(result.scoreBreakdown.dimensions.price).toBeGreaterThanOrEqual(0);
    expect(result.scoreBreakdown.dimensions.uptime).toBeGreaterThanOrEqual(0);
    expect(result.scoreBreakdown.constraintStatus).toBe("pass");
    expect(result.scoreBreakdown.totalScore).toBe(result.chosen.score);
  });

  it("excludes a candidate named in a prior iteration's Violation (re-negotiation)", async () => {
    const priorViolations: Violation[] = [
      {
        constraint: "uptime",
        actualValue: 97.5,
        requiredValue: 99,
        severity: "hard",
        affectedCandidate: "rejected-last-time",
        correctiveAction: "pick another candidate",
      },
    ];
    const input = baseInput({
      requestId: "req-renegotiate",
      iteration: 2,
      priorViolations,
      candidates: [
        candidate({ serviceId: "rejected-last-time", price: 0.001, uptime: 99.99 }), // would win on score alone
        candidate({ serviceId: "next-best", price: 0.05, uptime: 99.5 }),
      ],
    });

    const result = await handler(input);

    expect(result.chosen.service.serviceId).toBe("next-best");
    expect(result.iteration).toBe(2);
  });
});

describe("absolute scoring against catalogue references", () => {
  // Real image-resizing references from data/services.json: price 0.005 to 0.045,
  // uptime 97.5 to 99.9, latency 45 to 650 ms.
  const turbo = candidate({
    serviceId: "svc-turboresize",
    price: 0.045,
    uptime: 99.7,
    latencyMs: 45,
    similarityScore: 0.41,
    capability: "image-resizing",
  });
  const limits: Constraint[] = [
    { field: "price", operator: "lt", value: 0.05, mandatory: true },
    { field: "uptime", operator: "gte", value: 99.5, mandatory: true },
    { field: "latencyMs", operator: "lt", value: 100, mandatory: true },
  ];

  it("does not give a lone survivor a perfect score, and flags it as the sole survivor", async () => {
    const r = await handler(baseInput({ candidates: [turbo], constraints: limits, requiredCategory: "image-resizing" }));

    expect(r.scoreBreakdown.soleSurvivor).toBe(true);
    expect(r.scoreBreakdown.basis).toBe("catalogue-references");
    expect(r.chosen.score).toBeLessThan(1);
    // Headroom under each limit, relative to the best value in the category:
    // price (0.05 - 0.045) / (0.05 - 0.005) = 0.111; uptime (99.7 - 99.5) / (99.9 - 99.5) = 0.5;
    // latency (100 - 45) / (100 - 45) = 1; capability is the raw similarity.
    expect(r.scoreBreakdown.dimensions.price).toBeCloseTo(0.111, 3);
    expect(r.scoreBreakdown.dimensions.uptime).toBeCloseTo(0.5, 3);
    expect(r.scoreBreakdown.dimensions.latency).toBeCloseTo(1, 3);
    expect(r.scoreBreakdown.dimensions.capability).toBeCloseTo(0.41, 3);
  });

  it("gives a candidate the same score whether or not other candidates are present", async () => {
    const alone = await handler(baseInput({ candidates: [turbo], requiredCategory: "image-resizing" }));
    const crowd = await handler(
      baseInput({
        candidates: [
          turbo,
          candidate({ serviceId: "svc-fastresize", price: 0.02, uptime: 99.9, latencyMs: 180, similarityScore: 0.42, capability: "image-resizing" }),
        ],
        requiredCategory: "image-resizing",
      })
    );

    const turboInCrowd = [crowd.chosen, ...crowd.alternatives].find((c) => c.service.serviceId === "svc-turboresize");
    expect(turboInCrowd?.score).toBeCloseTo(alone.chosen.score, 10);
    expect(crowd.scoreBreakdown.soleSurvivor).toBe(false);
  });

  it("falls back to scoring relative to the candidates when the category has no references", async () => {
    const r = await handler(
      baseInput({ candidates: [candidate({ serviceId: "x", capability: "not-a-category" })], requiredCategory: "not-a-category" })
    );
    expect(r.scoreBreakdown.basis).toBe("relative-to-candidates");
  });
});

describe("rejected candidates", () => {
  it("lists every candidate that failed a hard filter, with the rule it failed", async () => {
    const r = await handler(
      baseInput({
        requiredCategory: "image-resizing",
        constraints: [
          { field: "uptime", operator: "gte", value: 99.5, mandatory: true },
          { field: "latencyMs", operator: "lt", value: 100, mandatory: true },
        ],
        candidates: [
          candidate({ serviceId: "svc-budget", name: "BudgetResize", price: 0.005, uptime: 97.5, latencyMs: 650, capability: "image-resizing" }),
          candidate({ serviceId: "svc-fast", name: "FastResize", price: 0.02, uptime: 99.9, latencyMs: 180, capability: "image-resizing" }),
          candidate({ serviceId: "svc-turbo", name: "TurboResize", price: 0.045, uptime: 99.7, latencyMs: 45, capability: "image-resizing" }),
          candidate({ serviceId: "svc-queue", name: "QueueRunner", price: 0.0007, uptime: 99.9, latencyMs: 15, capability: "message-queue" }),
        ],
      })
    );

    expect(r.chosen.service.serviceId).toBe("svc-turbo");
    expect(r.rejected).toEqual([
      { serviceId: "svc-budget", name: "BudgetResize", reason: "uptime 97.5% is not at least 99.5%" },
      { serviceId: "svc-fast", name: "FastResize", reason: "latency 180 ms is not below 100 ms" },
      { serviceId: "svc-queue", name: "QueueRunner", reason: "wrong category (message-queue, needed image-resizing)" },
    ]);
  });
});

describe("soft preferences", () => {
  it("weights a dimension by the request's soft preference", async () => {
    const candidates = [
      candidate({ serviceId: "cheap-slow", price: 0.005, uptime: 99.7, latencyMs: 650 }),
      candidate({ serviceId: "pricey-fast", price: 0.045, uptime: 97.5, latencyMs: 45 }),
    ];

    const neutral = await handler(baseInput({ candidates }));
    const wantsFast = await handler(baseInput({ candidates, preferences: { latencyMs: 3 } }));

    expect(neutral.chosen.service.serviceId).toBe("cheap-slow");
    expect(wantsFast.chosen.service.serviceId).toBe("pricey-fast");
    expect(wantsFast.scoreBreakdown.weights.latency).toBe(3);
  });
});

describe("Negotiator volume pricing and plan quotas (T4.1b)", () => {
  const volume = { amount: 100_000, unit: "emails" as const };
  const sendgrid = candidate({
    serviceId: "svc-sendgrid", name: "SendGrid", capability: "email", price: 19.95, uptime: 99.95,
    volumeBasis: "quota", includedUnits: { amount: 50_000, unit: "emails" }, otherPlans: true,
  });
  const ses = candidate({
    serviceId: "svc-ses", name: "SES", capability: "email", price: 10, uptime: 99.9,
    listPrice: 0.1, priceUnit: "per 1,000 emails", currency: "USD", priceBasis: "estimated USD/month at 100,000 emails/month",
  });

  it("rejects a plan whose quota is smaller than the stated volume, and says why", async () => {
    const r = await handler(baseInput({ candidates: [sendgrid, ses], volume }));
    expect(r.chosen.service.serviceId).toBe("svc-ses");
    expect(r.rejected).toContainEqual({ serviceId: "svc-sendgrid", name: "SendGrid", reason: "its plan covers 50,000 emails a month, 100,000 emails needed" });
  });

  it("keeps a plan whose quota covers the volume and notes it", async () => {
    const r = await handler(baseInput({ candidates: [sendgrid], volume: { amount: 40_000, unit: "emails" } }));
    expect(r.chosen.service.volumeNote).toBe("plan covers 50,000 emails a month, enough for 40,000 emails");
  });

  it("re-prices a metered service at the stated volume", async () => {
    const r = await handler(baseInput({ candidates: [ses], volume: { amount: 250_000, unit: "emails" } }));
    expect(r.chosen.service.price).toBe(25);
    expect(r.chosen.service.priceBasis).toBe("estimated USD/month at 250,000 emails/month");
  });

  it("treats a volume equal to the standard profile as used, with no note (live finding)", async () => {
    const r = await handler(baseInput({ candidates: [ses], volume }));
    expect(r.chosen.service.price).toBe(10);
    expect(r.chosen.service.volumeNote).toBeUndefined();
  });

  it("checks a per-unit price limit against the unit price", async () => {
    const perUnit: Constraint = { field: "price", operator: "lte", value: 0.00015, mandatory: true, per: "unit" };
    const r = await handler(baseInput({ candidates: [sendgrid, ses], constraints: [perUnit] }));
    // SES: $0.0001 an email passes; SendGrid: $19.95 / 50,000 = $0.000399 fails.
    expect(r.chosen.service.serviceId).toBe("svc-ses");
    expect(r.rejected?.[0].reason).toMatch(/^price per unit/);
  });
});

describe("Negotiator chain mode (T4.1b)", () => {
  const step = (capability: string, cands: ServiceCandidateWithEvidence[], dependsOn: number[] = []) => ({
    capability, candidates: cands, constraints: [] as Constraint[], dependsOn,
  });
  const ocrA = candidate({ serviceId: "ocr-a", price: 30, uptime: 99.9, latencyMs: 300 });
  const ocrB = candidate({ serviceId: "ocr-b", price: 5, uptime: 99.0, latencyMs: 800 });
  const trA = candidate({ serviceId: "tr-a", price: 20, uptime: 99.95, latencyMs: 200 });
  const trB = candidate({ serviceId: "tr-b", price: 4, uptime: 99.5, latencyMs: 400 });

  it("picks one service per step and reports chain totals", async () => {
    const r = await handler(baseInput({ steps: [step("ocr", [ocrA, ocrB]), step("translation", [trA, trB], [0])] }));
    expect(r.chain?.steps.map((s) => s.capability)).toEqual(["ocr", "translation"]);
    expect(r.chain?.steps[1].dependsOn).toEqual([0]);
    expect(r.chain?.combinationsCompared).toBe(4);
    const [a, b] = r.chain!.steps.map((s) => s.chosen.service);
    expect(r.chain?.totals.price).toBeCloseTo(a.price + b.price, 2);
    expect(r.chain?.totals.uptime).toBeCloseTo(a.uptime * b.uptime / 100, 3);
    expect(r.chain?.totals.latencyMs).toBe((a.latencyMs ?? 0) + (b.latencyMs ?? 0));
    expect(r.chosen.service.serviceId).toBe(a.serviceId);
  });

  it("applies chain-wide limits to the totals, not to each step", async () => {
    const budget: Constraint = { field: "price", operator: "lte", value: 12, mandatory: true };
    const r = await handler(baseInput({ constraints: [budget], steps: [step("ocr", [ocrA, ocrB]), step("translation", [trA, trB])] }));
    expect(r.chain?.steps.map((s) => s.chosen.service.serviceId)).toEqual(["ocr-b", "tr-b"]);
    expect(r.chain?.combinationsValid).toBe(1);
  });

  it("fails clearly when no combination fits the chain-wide limits", async () => {
    const budget: Constraint = { field: "price", operator: "lte", value: 1, mandatory: true };
    await expect(handler(baseInput({ constraints: [budget], steps: [step("ocr", [ocrA]), step("translation", [trA])] }))).rejects.toThrow(/none of the 1 combinations/);
  });

  it("names the step when one step has no eligible candidate", async () => {
    await expect(handler(baseInput({ steps: [step("ocr", [ocrA]), step("translation", [])] }))).rejects.toThrow(/step 2 \(translation\)/);
  });
});

describe("Negotiator converts a volume to the unit a service is priced in (L15, L16)", () => {
  const pages = { amount: 5000, unit: "pages" as const };
  const vision = candidate({
    serviceId: "svc-vision", name: "Vision", capability: "document-ocr", price: 15, uptime: 99.9,
    listPrice: 1.5, priceUnit: "per 1,000 images", currency: "USD",
  });
  const translate = candidate({
    serviceId: "svc-translate", name: "Translate", capability: "translation", price: 15, uptime: 99.9,
    listPrice: 15, priceUnit: "per 1,000,000 characters", currency: "USD",
  });

  it("L15: prices a per-image OCR service at the stated pages, and notes the conversion", async () => {
    const r = await handler(baseInput({ candidates: [vision], volume: pages }));
    expect(r.chosen.service.price).toBe(7.5);
    expect(r.chosen.service.volumeNote).toBe("5,000 pages counted as 5,000 images");
  });

  it("L16: prices a per-character service at the pages' characters, and notes the rate", async () => {
    const r = await handler(baseInput({ candidates: [translate], volume: pages }));
    expect(r.chosen.service.price).toBe(150);
    expect(r.chosen.service.volumeNote).toBe("5,000 pages counted as 10,000,000 characters, at about 2,000 characters a page");
  });
});
