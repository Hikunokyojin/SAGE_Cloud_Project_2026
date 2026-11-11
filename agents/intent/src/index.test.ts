import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentAgentInput } from "@sage/shared-types";

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

// The shared DynamoDB cache: a plain Map stands in for the table.
const sharedStore = new Map<string, unknown>();
vi.mock("./sharedCache", () => ({
  cacheKey: (req: string, version: string) => `${version}|${req}`,
  getShared: vi.fn(async (k: string) => sharedStore.get(k)),
  putShared: vi.fn(async (k: string, v: unknown) => {
    sharedStore.set(k, v);
  }),
}));

function groqResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    }),
  };
}

describe("Intent Agent handler", () => {
  beforeEach(() => {
    vi.resetModules();
    sharedStore.clear();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
    recordDecisionMock.mockReset();
    recordDecisionMock.mockResolvedValue(undefined);
    resolveSecretMock.mockResolvedValue("test-groq-key");
  });

  it("converts a natural-language request into a structured Intent with Constraint[]", async () => {
    fetchMock.mockResolvedValue(
      groqResponse(
        JSON.stringify({
          capability: "fast image resizing service",
          constraints: [
            { field: "price", operator: "lte", value: 0.05, mandatory: true },
            { field: "uptime", operator: "gte", value: 99, mandatory: true },
          ],
        })
      )
    );

    const input: IntentAgentInput = { requestId: "req-1", rawInput: "I need a cheap, reliable image resizer" };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result).toEqual({
      requestId: "req-1",
      capability: "fast image resizing service",
      constraints: [
        { field: "price", operator: "lte", value: 0.05, mandatory: true },
        { field: "uptime", operator: "gte", value: 99, mandatory: true },
      ],
      preferences: { price: 2, uptime: 2 },
      rawInput: "I need a cheap, reliable image resizer",
    });
  });

  it("defaults an omitted priority to 5 on an optional (non-mandatory) constraint", async () => {
    fetchMock.mockResolvedValue(
      groqResponse(
        JSON.stringify({
          capability: "image resizing",
          constraints: [{ field: "price", operator: "lte", value: 0.1, mandatory: false }],
        })
      )
    );

    const { handler } = await import("./index");
    const result = await handler({ requestId: "req-1a", rawInput: "prefer cheap resizing" });

    expect(result.constraints).toEqual([
      { field: "price", operator: "lte", value: 0.1, mandatory: false, priority: 5 },
    ]);
  });

  it("drops a malformed constraint entry (bad field, bad operator, or non-numeric value) rather than propagating it", async () => {
    fetchMock.mockResolvedValue(
      groqResponse(
        JSON.stringify({
          capability: "image resizing",
          constraints: [
            { field: "price", operator: "lte", value: 0.05, mandatory: true },
            { field: "notARealField", operator: "lte", value: 1, mandatory: true },
            { field: "uptime", operator: "notARealOperator", value: 99, mandatory: true },
            { field: "uptime", operator: "gte", value: "not-a-number", mandatory: true },
          ],
        })
      )
    );

    const { handler } = await import("./index");
    const result = await handler({ requestId: "req-1b", rawInput: "anything" });

    expect(result.constraints).toEqual([{ field: "price", operator: "lte", value: 0.05, mandatory: true }]);
  });

  it("calls Groq's chat completions endpoint with the resolved API key", async () => {
    fetchMock.mockResolvedValue(groqResponse(JSON.stringify({ capability: "video transcoding" })));

    const { handler } = await import("./index");
    await handler({ requestId: "req-2", rawInput: "transcode my videos" });

    expect(resolveSecretMock).toHaveBeenCalledWith("GROQ_API_KEY", "/sage/shared/GROQ_API_KEY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer test-groq-key");
    const body = JSON.parse(options.body);
    expect(body.messages[1].content).toBe("transcode my videos");
  });

  it("defaults constraints to an empty array when the model omits them", async () => {
    fetchMock.mockResolvedValue(groqResponse(JSON.stringify({ capability: "video transcoding" })));

    const { handler } = await import("./index");
    const result = await handler({ requestId: "req-2", rawInput: "transcode my videos" });

    expect(result.constraints).toEqual([]);
  });

  it("throws a descriptive error when the model returns non-JSON output", async () => {
    fetchMock.mockResolvedValue(groqResponse("Sure! Here's what you need: a resizer."));

    const { handler } = await import("./index");
    await expect(handler({ requestId: "req-3", rawInput: "anything" })).rejects.toThrow(
      "returned non-JSON output"
    );
  });

  it("throws when Groq's API returns a non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "invalid api key" });

    const { handler } = await import("./index");
    await expect(handler({ requestId: "req-4", rawInput: "anything" })).rejects.toThrow(/Groq API error/);
  });

  it("records the token usage Groq reports and how long the step took", async () => {
    fetchMock.mockResolvedValue(groqResponse(JSON.stringify({ capability: "video transcoding", category: "video-transcoding" })));
    const { handler } = await import("./index");

    await handler({ requestId: "req-1", rawInput: "I need video transcoding" } as IntentAgentInput);

    const recorded = recordDecisionMock.mock.calls[0][0];
    expect(recorded.usage).toEqual({ promptTokens: 120, completionTokens: 80, totalTokens: 200 });
    expect(recorded.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("extractPreferences", () => {
  it("turns soft words into preference weights", async () => {
    const { extractPreferences } = await import("./index");
    expect(extractPreferences("I need a fast image resizing service")).toEqual({ latencyMs: 2 });
    expect(extractPreferences("the cheapest available email delivery service")).toEqual({ price: 3 });
    expect(extractPreferences("a highly reliable database")).toEqual({ uptime: 3 });
    expect(extractPreferences("cheap and reliable storage")).toEqual({ price: 2, uptime: 2 });
  });

  it("lowers the weight when the user says a dimension does not matter", async () => {
    const { extractPreferences } = await import("./index");
    expect(extractPreferences("the cheapest email service, reliability is not a concern")).toEqual({ price: 3, uptime: 0.5 });
  });

  it("does not read a stated budget limit as a wish for the cheapest option", async () => {
    const { extractPreferences } = await import("./index");
    expect(extractPreferences("I need video transcoding, budget under 2 dollars")).toEqual({});
  });
});

describe("Intent preferences in the handler output", () => {
  it("adds the extracted preferences to the Intent", async () => {
    resolveSecretMock.mockResolvedValue("test-groq-key");
    fetchMock.mockResolvedValue(groqResponse(JSON.stringify({ capability: "image resizing", category: "image-resizing", constraints: [] })));
    const { handler } = await import("./index");

    const out = await handler({ requestId: "r", rawInput: "I need a fast image resizer" } as IntentAgentInput);

    expect(out.preferences).toEqual({ latencyMs: 2 });
  });
});

describe("Intent reproducibility", () => {
  beforeEach(() => {
    vi.resetModules();
    sharedStore.clear();
    fetchMock.mockReset();
    recordDecisionMock.mockReset();
    recordDecisionMock.mockResolvedValue(undefined);
    resolveSecretMock.mockResolvedValue("test-groq-key");
    fetchMock.mockResolvedValue(groqResponse(JSON.stringify({ capability: "email delivery", category: "email-delivery", constraints: [] })));
  });

  it("asks the model for deterministic, schema-constrained output", async () => {
    const { handler } = await import("./index");
    await handler({ requestId: "r1", rawInput: "send emails" } as IntentAgentInput);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
    expect(typeof body.seed).toBe("number");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema.required).toEqual(["capability", "category", "constraints"]);
  });

  it("reuses the parse for the same request, ignoring case and spacing", async () => {
    const { handler } = await import("./index");
    const a = await handler({ requestId: "r1", rawInput: "Send  emails" } as IntentAgentInput);
    const b = await handler({ requestId: "r2", rawInput: " send emails " } as IntentAgentInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b.requestId).toBe("r2");
    expect(b.rawInput).toBe(" send emails ");
    expect(b.capability).toBe(a.capability);
    expect(recordDecisionMock.mock.calls[1][0].reasoning).toMatch(/cache/i);
  });

  it("calls the model again for a different request", async () => {
    const { handler } = await import("./index");
    await handler({ requestId: "r1", rawInput: "send emails" } as IntentAgentInput);
    await handler({ requestId: "r2", rawInput: "resize images" } as IntentAgentInput);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("shared Intent cache", () => {
  beforeEach(() => {
    vi.resetModules();
    sharedStore.clear();
    fetchMock.mockReset();
    recordDecisionMock.mockReset();
    recordDecisionMock.mockResolvedValue(undefined);
    resolveSecretMock.mockResolvedValue("test-groq-key");
    fetchMock.mockResolvedValue(groqResponse(JSON.stringify({ capability: "email delivery", category: "email-delivery", constraints: [] })));
  });

  it("a fresh instance reuses a parse another instance stored", async () => {
    const first = await import("./index");
    await first.handler({ requestId: "r1", rawInput: "send emails" } as IntentAgentInput);
    expect(sharedStore.size).toBe(1);

    vi.resetModules(); // a new Lambda instance: empty memory cache, same table
    const second = await import("./index");
    const out = await second.handler({ requestId: "r2", rawInput: "Send emails" } as IntentAgentInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.capability).toBe("email delivery");
    expect(recordDecisionMock.mock.calls[1][0].reasoning).toMatch(/shared cache/);
  });
});

describe("stub mode never touches the shared Intent cache", () => {
  it("neither reads nor writes the cache when LLM_MODE=stub", async () => {
    vi.resetModules();
    sharedStore.clear();
    fetchMock.mockReset();
    recordDecisionMock.mockResolvedValue(undefined);
    process.env.LLM_MODE = "stub";
    sharedStore.set("anything", { capability: "poisoned", constraints: [] });
    const { handler } = await import("./index");
    const cache = await import("./sharedCache");
    vi.mocked(cache.getShared).mockClear();
    const out = await handler({ requestId: "r", rawInput: "send emails" } as IntentAgentInput);
    expect(out.category).toBe("email-delivery");
    expect(sharedStore.size).toBe(1); // nothing written
    const { getShared } = await import("./sharedCache");
    expect(getShared).not.toHaveBeenCalled();
    delete process.env.LLM_MODE;
  });
});
