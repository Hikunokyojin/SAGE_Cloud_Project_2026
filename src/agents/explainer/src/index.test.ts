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

vi.mock("@sage/secrets", () => ({
  resolveSecret: resolveSecretMock,
}));

vi.stubGlobal("fetch", fetchMock);

function groqResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
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

    expect(userMessage).toContain("Alternatives considered: none");
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
    expect(userMessage).toContain("Prior rejected attempts");
  });

  it("throws when Groq's API returns a non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "server error" });

    const { handler } = await import("./index");
    await expect(handler({ requestId: "req-1", composition: composition() })).rejects.toThrow(/Groq API error/);
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
});
