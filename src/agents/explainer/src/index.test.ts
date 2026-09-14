import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExplainerAgentInput, CompositionBlueprint, EscalationExplainerInput } from "@sage/shared-types";

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

function blueprint(): CompositionBlueprint {
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
        },
        score: 0.6,
        reason: "price=0.01, uptime=97%",
      },
    ],
  };
}

describe("Explainer Agent handler", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

  it("returns the original blueprint plus a plain-language explanation", async () => {
    fetchMock.mockResolvedValue(
      groqResponse("FastResize was chosen for its high uptime and reasonable price versus the alternative.")
    );

    const input: ExplainerAgentInput = { requestId: "req-1", blueprint: blueprint() };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result.requestId).toBe("req-1");
    expect(result.chosen.service.serviceId).toBe("svc-1");
    expect(result.alternatives).toHaveLength(1);
    expect(result.explanation).toBe(
      "FastResize was chosen for its high uptime and reasonable price versus the alternative."
    );
  });

  it("calls Groq's chat completions endpoint with the resolved API key", async () => {
    fetchMock.mockResolvedValue(groqResponse("Explanation text."));

    const { handler } = await import("./index");
    await handler({ requestId: "req-1", blueprint: blueprint() });

    expect(resolveSecretMock).toHaveBeenCalledWith("GROQ_API_KEY", "/sage/shared/GROQ_API_KEY");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer test-groq-key");
  });

  it("includes the chosen and alternative service names in the prompt", async () => {
    fetchMock.mockResolvedValue(groqResponse("Explanation text."));

    const { handler } = await import("./index");
    await handler({ requestId: "req-1", blueprint: blueprint() });

    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body);
    const userMessage: string = requestBody.messages[1].content;

    expect(userMessage).toContain("FastResize");
    expect(userMessage).toContain("SlowResize");
  });

  it("handles a blueprint with no alternatives", async () => {
    fetchMock.mockResolvedValue(groqResponse("Only one option was available."));

    const noAlternatives: CompositionBlueprint = { ...blueprint(), alternatives: [] };

    const { handler } = await import("./index");
    await handler({ requestId: "req-1", blueprint: noAlternatives });

    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body);
    const userMessage: string = requestBody.messages[1].content;

    expect(userMessage).toContain("Alternatives considered: none");
  });

  it("throws when Groq's API returns a non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "server error" });

    const { handler } = await import("./index");
    await expect(handler({ requestId: "req-1", blueprint: blueprint() })).rejects.toThrow(/Groq API error/);
  });
});

describe("Explainer Agent explainEscalation", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

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
      constraints: { maxBudget: 0.05, minUptime: 95 },
      attempts: [
        {
          candidate: {
            serviceId: "svc-1",
            name: "FastResize",
            description: "Quick image resizer",
            price: 0.08,
            uptime: 99.9,
            endpoint: "https://api.example.com/resize",
          },
          violatedConstraints: ["maxBudget"],
        },
        {
          candidate: {
            serviceId: "svc-2",
            name: "SlowResize",
            description: "Cheaper but less reliable",
            price: 0.03,
            uptime: 92,
            endpoint: "https://api.example.com/resize2",
          },
          violatedConstraints: ["minUptime"],
        },
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
      constraints: { maxBudget: 0.05, minUptime: 95 },
      attempts: [
        {
          candidate: {
            serviceId: "svc-1",
            name: "FastResize",
            description: "Quick image resizer",
            price: 0.08,
            uptime: 99.9,
            endpoint: "https://api.example.com/resize",
          },
          violatedConstraints: ["maxBudget"],
        },
      ],
    };

    const { explainEscalation } = await import("./index");
    await explainEscalation(input);

    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body);
    const userMessage: string = requestBody.messages[1].content;

    expect(userMessage).toContain("FastResize");
    expect(userMessage).toContain("maxBudget");
    expect(userMessage).toContain("0.08");
  });
});
