import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentAgentInput } from "@sage/shared-types";

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

describe("Intent Agent handler", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveSecretMock.mockReset();
    fetchMock.mockReset();
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
      "Intent Agent: model returned non-JSON output"
    );
  });

  it("throws when Groq's API returns a non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "invalid api key" });

    const { handler } = await import("./index");
    await expect(handler({ requestId: "req-4", rawInput: "anything" })).rejects.toThrow(/Groq API error/);
  });
});
