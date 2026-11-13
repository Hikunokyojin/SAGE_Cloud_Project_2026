import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExplainerAgentInput,
  Composition,
  EscalationExplainerInput,
  NegotiationAttempt,
  Constraint,
} from "@sage/shared-types";

const resolveSecretMock = vi.fn();
const fetchMock = vi.fn();
const recordDecisionMock = vi.fn();

vi.mock("@sage/secrets", () => ({
  resolveSecret: resolveSecretMock,
}));

vi.mock("@sage/audit", () => ({
  recordDecision: recordDecisionMock,
}));

vi.stubGlobal("fetch", fetchMock);

function groqResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 300, completion_tokens: 90, total_tokens: 390 },
    }),
  };
}

function composition(): Composition {
  return {
    requestId: "req-1",
    chosen: {
      service: {
        serviceId: "svc-1",
        name: "FastResize",
        description: "Quick image resizer",
        price: 0.02,
        uptime: 99.9,
        endpoint: "https://api.example.com/resize",
        evidence: [],
      },
      score: 0.87,
      reason: "price=0.02, uptime=99.9%",
    },
    alternatives: [
      {
        service: {
          serviceId: "svc-2",
          name: "SlowResize",
          description: "Cheaper but less reliable",
          price: 0.01,
          uptime: 97,
          endpoint: "https://api.example.com/resize2",
          evidence: [],
        },
        score: 0.6,
        reason: "price=0.01, uptime=97%",
      },
    ],
    iteration: 1,
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

describe("monthly price wording (WP3.5 L9)", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

  it("states an estimated monthly price in plain words with cents", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const c = composition();
    c.chosen.service = { ...c.chosen.service, price: 7.5, priceBasis: "estimated USD/month on its flat monthly plan" };
    const { handler } = await import("./index");
    const result = await handler({ requestId: "req-1", composition: c });
    expect(result.explanation).toContain("about $7.50 a month, on its flat monthly plan");
    expect(result.explanation).not.toContain("USD/month");
  });
});

describe("Explainer Agent handler", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

  it("returns the original composition plus a plain-language explanation", async () => {
    fetchMock.mockResolvedValue(
      groqResponse("FastResize was chosen for its high uptime and reasonable price versus the alternative.")
    );

    const input: ExplainerAgentInput = { requestId: "req-1", composition: composition() };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result.requestId).toBe("req-1");
    expect(result.chosen.service.serviceId).toBe("svc-1");
    expect(result.alternatives).toHaveLength(1);
    expect(result.iteration).toBe(1);
    expect(result.explanation).toBe(
      "FastResize was chosen for its high uptime and reasonable price versus the alternative."
    );
  });

  it("calls Groq's chat completions endpoint with the resolved API key", async () => {
    fetchMock.mockResolvedValue(groqResponse("Explanation text."));

    const { handler } = await import("./index");
    await handler({ requestId: "req-1", composition: composition() });

    expect(resolveSecretMock).toHaveBeenCalledWith("GROQ_API_KEY", "/sage/shared/GROQ_API_KEY");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer test-groq-key");
  });

  it("includes the chosen and alternative service names in the prompt", async () => {
    fetchMock.mockResolvedValue(groqResponse("Explanation text."));

    const { handler } = await import("./index");
    await handler({ requestId: "req-1", composition: composition() });

    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body);
    const userMessage: string = requestBody.messages[1].content;

    expect(userMessage).toContain("FastResize");
    expect(userMessage).toContain("SlowResize");
  });

  it("handles a composition with no alternatives", async () => {
    fetchMock.mockResolvedValue(groqResponse("Only one option was available."));

    const noAlternatives: Composition = { ...composition(), alternatives: [] };

    const { handler } = await import("./index");
    await handler({ requestId: "req-1", composition: noAlternatives });

    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body);
    const userMessage: string = requestBody.messages[1].content;

    expect(userMessage).toContain("FastResize was selected");
    expect(userMessage).not.toContain("ahead of");
  });

  it("mentions a prior rejected attempt when negotiationHistory has more than one entry", async () => {
    fetchMock.mockResolvedValue(groqResponse("Explanation referencing the prior attempt."));

    const negotiationHistory: NegotiationAttempt[] = [
      {
        iteration: 1,
        composition: { ...composition(), chosen: { ...composition().chosen, service: { ...composition().chosen.service, serviceId: "svc-rejected", name: "BudgetResize" } } },
        reviewerResult: {
          requestId: "req-1",
          decisionId: "d1",
          approved: false,
          violations: [
            {
              constraint: "uptime",
              actualValue: 97.5,
              requiredValue: 99,
              severity: "hard",
              affectedCandidate: "svc-rejected",
              correctiveAction: "pick a higher-uptime service",
            },
          ],
          iteration: 1,
          composition: composition(),
          escalated: false,
        },
        timestamp: new Date().toISOString(),
      },
      {
        iteration: 2,
        composition: composition(),
        reviewerResult: {
          requestId: "req-1",
          decisionId: "d2",
          approved: true,
          violations: [],
          iteration: 2,
          composition: composition(),
          escalated: false,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { handler } = await import("./index");
    await handler({ requestId: "req-1", composition: composition(), negotiationHistory });

    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body);
    const userMessage: string = requestBody.messages[1].content;

    expect(userMessage).toContain("BudgetResize");
    expect(userMessage).toContain("BudgetResize was rejected on attempt 1");
    expect(userMessage).toContain("uptime was 97.5, required 99");
  });

  it("uses the deterministic fact sheet when no language model answers (T2.7), instead of failing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "server error" });

    const { handler } = await import("./index");
    const out = await handler({ requestId: "req-1", composition: composition() });
    expect(out.explanationSource).toBe("facts");
    expect(out.explanation.length).toBeGreaterThan(0);
  });
});

describe("Explainer Agent explainEscalation", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

  const CONSTRAINTS: Constraint[] = [
    { field: "price", operator: "lte", value: 0.05, mandatory: true },
    { field: "uptime", operator: "gte", value: 95, mandatory: true },
  ];

  function attempt(overrides: {
    iteration: number;
    serviceId: string;
    name: string;
    price: number;
    uptime: number;
    violations: EscalationExplainerInput["attempts"][number]["reviewerResult"]["violations"];
  }): NegotiationAttempt {
    return {
      iteration: overrides.iteration,
      composition: {
        requestId: "req-esc",
        chosen: {
          service: {
            serviceId: overrides.serviceId,
            name: overrides.name,
            description: "A service",
            price: overrides.price,
            uptime: overrides.uptime,
            endpoint: "https://api.example.com",
            evidence: [],
          },
          score: 0.5,
          reason: "n/a",
        },
        alternatives: [],
        iteration: overrides.iteration,
        scoreBreakdown: {
          requestId: "req-esc",
          candidateId: overrides.serviceId,
          dimensions: { price: 1, uptime: 1, capability: 1 },
          weights: { price: 1, uptime: 1, capability: 0.5 },
          totalScore: 0.5,
          constraintStatus: "pass",
          violatedConstraints: [],
        },
      },
      reviewerResult: {
        requestId: "req-esc",
        decisionId: `d-${overrides.iteration}`,
        approved: false,
        violations: overrides.violations,
        iteration: overrides.iteration,
        composition: {} as Composition, // not read by explainEscalation
        escalated: overrides.iteration >= 3,
      },
      timestamp: new Date().toISOString(),
    };
  }

  it("returns a layman explanation plus the list of attempted options", async () => {
    fetchMock.mockResolvedValue(
      groqResponse(
        "We tried 2 options but none fit your budget of $0.05. FastResize costs $0.08 (too expensive) and " +
          "SlowResize has 92% uptime (below your 95% minimum). Consider raising your budget to $0.08 or " +
          "lowering your minimum uptime to 92%."
      )
    );

    const input: EscalationExplainerInput = {
      requestId: "req-esc-1",
      constraints: CONSTRAINTS,
      attempts: [
        attempt({
          iteration: 1,
          serviceId: "svc-1",
          name: "FastResize",
          price: 0.08,
          uptime: 99.9,
          violations: [
            {
              constraint: "price",
              actualValue: 0.08,
              requiredValue: 0.05,
              severity: "hard",
              affectedCandidate: "svc-1",
              correctiveAction: "raise the budget",
            },
          ],
        }),
        attempt({
          iteration: 2,
          serviceId: "svc-2",
          name: "SlowResize",
          price: 0.03,
          uptime: 92,
          violations: [
            {
              constraint: "uptime",
              actualValue: 92,
              requiredValue: 95,
              severity: "hard",
              affectedCandidate: "svc-2",
              correctiveAction: "lower the minimum uptime",
            },
          ],
        }),
      ],
    };

    const { explainEscalation } = await import("./index");
    const result = await explainEscalation(input);

    expect(result.requestId).toBe("req-esc-1");
    expect(result.explanation).toContain("Consider raising your budget");
    expect(result.attemptedOptions.map((o) => o.serviceId)).toEqual(["svc-1", "svc-2"]);
  });

  it("tells Groq exactly which constraint each attempted option violated", async () => {
    fetchMock.mockResolvedValue(groqResponse("Explanation."));

    const input: EscalationExplainerInput = {
      requestId: "req-esc-2",
      constraints: CONSTRAINTS,
      attempts: [
        attempt({
          iteration: 1,
          serviceId: "svc-1",
          name: "FastResize",
          price: 0.08,
          uptime: 99.9,
          violations: [
            {
              constraint: "price",
              actualValue: 0.08,
              requiredValue: 0.05,
              severity: "hard",
              affectedCandidate: "svc-1",
              correctiveAction: "raise the budget",
            },
          ],
        }),
      ],
    };

    const { explainEscalation } = await import("./index");
    await explainEscalation(input);

    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body);
    const userMessage: string = requestBody.messages[1].content;

    expect(userMessage).toContain("FastResize");
    expect(userMessage).toContain("price");
    expect(userMessage).toContain("0.08");
  });

  it("records the token usage Groq reports and how long the step took", async () => {
    recordDecisionMock.mockReset();
    recordDecisionMock.mockResolvedValue(undefined);
    resolveSecretMock.mockResolvedValue("test-groq-key");
    fetchMock.mockResolvedValue(groqResponse("FastResize was chosen because it is cheapest."));
    const { handler } = await import("./index");

    await handler({ requestId: "req-1", composition: composition() } as ExplainerAgentInput);

    const recorded = recordDecisionMock.mock.calls[0][0];
    expect(recorded.usage).toEqual({ promptTokens: 300, completionTokens: 90, totalTokens: 390 });
    expect(recorded.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("faithful explanations", () => {
  function compositionWithRejections(): Composition {
    return {
      ...composition(),
      alternatives: [],
      rejected: [
        { serviceId: "svc-budget", name: "BudgetResize", reason: "uptime 97.5% is not at least 99.5%" },
        { serviceId: "svc-slow", name: "SlowResize", reason: "latency 180 ms is not below 100 ms" },
      ],
      scoreBreakdown: { ...composition().scoreBreakdown, soleSurvivor: true },
    };
  }

  beforeEach(() => {
    recordDecisionMock.mockReset();
    recordDecisionMock.mockResolvedValue(undefined);
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

  it("uses the model's wording when it keeps every fact", async () => {
    const faithful =
      "FastResize was picked: it costs $0.02 with 99.9% uptime, and it was the only option meeting every requirement. " +
      "BudgetResize was ruled out because its uptime of 97.5% is below 99.5%, and SlowResize because 180 ms is above 100 ms.";
    fetchMock.mockResolvedValue(groqResponse(faithful));
    const { handler } = await import("./index");

    const out = await handler({ requestId: "req-1", composition: compositionWithRejections() } as ExplainerAgentInput);

    expect(out.explanation).toBe(faithful);
  });

  it("falls back to the plain facts when the model invents a number", async () => {
    fetchMock.mockResolvedValue(groqResponse("FastResize costs only $0.01 and has 99.99% uptime. BudgetResize and SlowResize failed."));
    const { handler } = await import("./index");

    const out = await handler({ requestId: "req-1", composition: compositionWithRejections() } as ExplainerAgentInput);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.explanation).toContain("BudgetResize (uptime 97.5% is not at least 99.5%)");
    expect(out.explanation).toContain("SlowResize (latency 180 ms is not below 100 ms)");
    expect(out.explanation).not.toContain("0.01");
  });

  it("falls back when the model leaves out a rejected candidate or claims there were no alternatives", async () => {
    fetchMock.mockResolvedValue(groqResponse("FastResize was chosen because there were no other alternatives."));
    const { handler } = await import("./index");

    const out = await handler({ requestId: "req-1", composition: compositionWithRejections() } as ExplainerAgentInput);

    expect(out.explanation).toContain("Not chosen:");
    expect(out.explanation).not.toContain("no other alternatives");
  });
});

describe("checkClaims", () => {
  it("accepts text whose numbers and names all come from the facts", async () => {
    const { checkClaims } = await import("./claimCheck");
    const facts = { text: "A costs $0.02 with 99.9% uptime. Not chosen: B (uptime 97.5% is not at least 99.5%).", chosenName: "A", rejectedNames: ["B"] };
    expect(checkClaims("A ($0.02, 99.9% uptime) beat B, whose 97.5% uptime missed the 99.5% minimum.", facts)).toEqual([]);
  });

  it("reports invented numbers, missing names and a false no-alternatives claim", async () => {
    const { checkClaims } = await import("./claimCheck");
    const facts = { text: "A costs $0.02. Not chosen: B (uptime 97.5% is not at least 99.5%).", chosenName: "A", rejectedNames: ["B"] };
    const problems = checkClaims("A costs $0.03 and there were no other alternatives.", facts);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("0.03"),
        expect.stringContaining("B"),
        expect.stringContaining("alternatives"),
      ])
    );
  });
});

describe("cheaper-plan wording (T4.1, L1)", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

  it("says what the plan includes and that it is the cheaper of the provider's plans", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const c = composition();
    c.chosen.service = {
      ...c.chosen.service,
      name: "SendGrid Email API",
      price: 19.95,
      priceBasis: "estimated USD/month on its flat monthly plan",
      volumeBasis: "quota",
      includedUnits: { amount: 50000, unit: "emails" },
      otherPlans: true,
    };
    const { handler } = await import("./index");
    const { explanation } = await handler({ requestId: "req-1", composition: c });
    expect(explanation).toContain("The plan includes 50,000 emails a month.");
    expect(explanation).toContain("This is the cheaper plan; SendGrid Email API also offers other plans for other usage levels.");
  });

  it("adds the cheaper-plan sentence back when the model's wording leaves it out (T4.1b)", async () => {
    const c = composition();
    c.chosen.service = { ...c.chosen.service, otherPlans: true };
    const name = c.chosen.service.name;
    const alts = c.alternatives.map((a) => a.service.name).join(" and ");
    fetchMock.mockResolvedValue(groqResponse(`We picked ${name}. ${alts} were also considered.`));
    const { handler } = await import("./index");
    const out = await handler({ requestId: "req-1", composition: c });
    expect(out.explanationSource).toBe("model");
    expect(out.explanation).toBe(`We picked ${name}. ${alts} were also considered. This is the cheaper plan; ${name} also offers other plans for other usage levels.`);
  });

  it("says nothing extra for a service without plan details", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const { handler } = await import("./index");
    const { explanation } = await handler({ requestId: "req-1", composition: composition() });
    expect(explanation).not.toContain("cheaper plan");
  });
});

describe("chain explanations and volume notes (T4.1e)", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

  const svc = (serviceId: string, name: string, price: number, uptime: number, latencyMs: number, extra: object = {}) => ({
    serviceId, name, description: "", endpoint: "https://x", evidence: [], price, uptime, latencyMs,
    priceBasis: "estimated USD/month at 5,000 pages/month", ...extra,
  });
  function chainComposition(): Composition {
    const c = composition();
    const ocr = { service: svc("svc-vision", "Vision OCR", 7.5, 99.9, 900, { volumeNote: "5,000 pages counted as 5,000 images" }), score: 0.8, reason: "" };
    const tr = { service: svc("svc-translate", "Translate", 150, 99.95, 648, {
      volumeNote: "5,000 pages counted as 10,000,000 characters, at about 2,000 characters a page", otherPlans: true }), score: 0.7, reason: "" };
    c.chosen = ocr;
    c.alternatives = [];
    c.rejected = [{ serviceId: "svc-veryfi", name: "Veryfi", reason: "step 1: over the budget" }];
    c.chain = {
      steps: [
        { capability: "extract text from scanned invoices", chosen: ocr, dependsOn: [] },
        { capability: "translate the text into Spanish", chosen: tr, dependsOn: [0] },
      ],
      totals: { price: 157.5, uptime: 99.85, latencyMs: 1548 },
      score: 0.75,
      combinationsCompared: 5,
      combinationsValid: 3,
      edges: [{ from: "svc-vision", to: "svc-translate" }],
    };
    return c;
  }

  it("states a single service's volume note (L13, L15, L16)", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const c = composition();
    c.chosen.service = { ...c.chosen.service, volumeNote: "plan quota is in requests, so 5,000 emails could not be checked" };
    const { handler } = await import("./index");
    const { explanation } = await handler({ requestId: "req-1", composition: c });
    expect(explanation).toContain("Volume: plan quota is in requests, so 5,000 emails could not be checked.");
  });

  it("describes every step, its volume note, the totals and the comparison", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const { handler } = await import("./index");
    const { explanation } = await handler({ requestId: "req-1", composition: chainComposition() });
    expect(explanation).toContain("This request is a chain of 2 steps.");
    expect(explanation).toContain("Step 1 (extract text from scanned invoices): Vision OCR, about $7.50 a month at 5,000 pages/month, uptime 99.9%, latency 900 ms; 5,000 pages counted as 5,000 images.");
    expect(explanation).toContain("Step 2 (translate the text into Spanish, using the output of step 1): Translate, about $150.00 a month");
    expect(explanation).toContain("at about 2,000 characters a page.");
    expect(explanation).toContain("Together: about $157.50 a month, combined uptime 99.85%, total latency 1548 ms.");
    expect(explanation).toContain("5 combinations of services were compared and 3 met every limit.");
    expect(explanation).toContain("Not chosen: Veryfi (step 1: over the budget).");
    expect(explanation).toContain("This is the cheaper plan; Translate also offers other plans for other usage levels.");
  });

  it("rejects model wording that leaves out a step's service", async () => {
    fetchMock.mockResolvedValue(groqResponse("Vision OCR was chosen, and Veryfi was not."));
    const { handler } = await import("./index");
    const out = await handler({ requestId: "req-1", composition: chainComposition() });
    expect(out.explanationSource).toBe("facts");
  });
});

describe("volume notes survive the model's wording (L17)", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

  it("adds back a volume note the wording left out, and keeps one it included", async () => {
    const c = composition();
    c.chosen.service = { ...c.chosen.service, volumeNote: "5,000 pages counted as 5,000 images" };
    fetchMock.mockResolvedValue(groqResponse("We picked FastResize over SlowResize."));
    const { handler } = await import("./index");
    const out = await handler({ requestId: "req-1", composition: c });
    expect(out.explanationSource).toBe("model");
    expect(out.explanation).toBe("We picked FastResize over SlowResize. Volume: 5,000 pages counted as 5,000 images.");

    vi.resetModules();
    fetchMock.mockResolvedValue(groqResponse("We picked FastResize over SlowResize; 5,000 pages counted as 5,000 images."));
    const again = await (await import("./index")).handler({ requestId: "req-1", composition: c });
    expect(again.explanation).toBe("We picked FastResize over SlowResize; 5,000 pages counted as 5,000 images.");
  });
});
