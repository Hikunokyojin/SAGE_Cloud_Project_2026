import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentAgentInput } from "@sage/shared-types";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient {
    send = sendMock;
  }
  class InvokeModelCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { BedrockRuntimeClient, InvokeModelCommand };
});

function bedrockResponse(modelText: string) {
  const body = JSON.stringify({ content: [{ text: modelText }] });
  return { body: new TextEncoder().encode(body) };
}

describe("Intent Agent handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("converts a natural-language request into a structured Intent", async () => {
    sendMock.mockResolvedValue(
      bedrockResponse(
        JSON.stringify({
          capability: "fast image resizing service",
          constraints: { maxBudget: 0.05, minUptime: 99 },
        })
      )
    );

    const input: IntentAgentInput = { requestId: "req-1", rawInput: "I need a cheap, reliable image resizer" };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result).toEqual({
      requestId: "req-1",
      capability: "fast image resizing service",
      constraints: { maxBudget: 0.05, minUptime: 99 },
      rawInput: "I need a cheap, reliable image resizer",
    });
  });

  it("defaults constraints to an empty object when the model omits them", async () => {
    sendMock.mockResolvedValue(bedrockResponse(JSON.stringify({ capability: "video transcoding" })));

    const { handler } = await import("./index");
    const result = await handler({ requestId: "req-2", rawInput: "transcode my videos" });

    expect(result.constraints).toEqual({});
  });

  it("throws a descriptive error when the model returns non-JSON output", async () => {
    sendMock.mockResolvedValue(bedrockResponse("Sure! Here's what you need: a resizer."));

    const { handler } = await import("./index");
    await expect(handler({ requestId: "req-3", rawInput: "anything" })).rejects.toThrow(
      "Intent Agent: model returned non-JSON output"
    );
  });
});
