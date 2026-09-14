import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuditRecord } from "@sage/shared-types";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => {
  class DynamoDBClient {
    send = sendMock;
  }
  class PutItemCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { DynamoDBClient, PutItemCommand };
});

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    requestId: "req-1",
    agent: "IntentAgent",
    timestamp: "2026-09-15T00:00:00.000Z",
    input: { rawInput: "I need a cheap image resizer" },
    output: { capability: "image resizing", constraints: {} },
    ...overrides,
  };
}

describe("recordDecision", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.AUDIT_TABLE_NAME = "agent_decisions";
  });

  it("writes a PutItem with requestId/timestamp/agent and JSON-stringified input/output", async () => {
    const { recordDecision } = await import("./index");

    await recordDecision(record());

    expect(sendMock).toHaveBeenCalledTimes(1);
    const putCommand = sendMock.mock.calls[0][0];
    expect(putCommand.input.TableName).toBe("agent_decisions");
    expect(putCommand.input.Item.requestId).toEqual({ S: "req-1" });
    expect(putCommand.input.Item.timestamp).toEqual({ S: "2026-09-15T00:00:00.000Z" });
    expect(putCommand.input.Item.agent).toEqual({ S: "IntentAgent" });
    expect(JSON.parse(putCommand.input.Item.input.S)).toEqual({ rawInput: "I need a cheap image resizer" });
    expect(JSON.parse(putCommand.input.Item.output.S)).toEqual({ capability: "image resizing", constraints: {} });
  });

  it("includes reasoning as an S attribute when provided, and omits it entirely when absent", async () => {
    const { recordDecision } = await import("./index");

    await recordDecision(record({ reasoning: "Chosen because it fit best." }));
    expect(sendMock.mock.calls[0][0].input.Item.reasoning).toEqual({ S: "Chosen because it fit best." });

    sendMock.mockClear();
    await recordDecision(record());
    expect(sendMock.mock.calls[0][0].input.Item.reasoning).toBeUndefined();
  });

  it("throws instead of silently succeeding when AUDIT_TABLE_NAME is not configured", async () => {
    delete process.env.AUDIT_TABLE_NAME;
    const { recordDecision } = await import("./index");

    await expect(recordDecision(record())).rejects.toThrow("AUDIT_TABLE_NAME is not set");
    expect(sendMock).not.toHaveBeenCalled();
  });
});
