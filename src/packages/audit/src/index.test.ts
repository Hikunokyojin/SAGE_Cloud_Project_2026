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

  it("writes decisionId/parentDecisionId/iteration/status/constraintStatus/score/evidence when provided (D6.1)", async () => {
    const { recordDecision } = await import("./index");

    await recordDecision(
      record({
        decisionId: "dec-2",
        parentDecisionId: "dec-1",
        iteration: 1,
        status: "success",
        constraintStatus: "pass",
        score: {
          requestId: "req-1",
          candidateId: "svc-1",
          dimensions: { price: 0.8, uptime: 0.9 },
          weights: { price: 1, uptime: 1 },
          totalScore: 0.85,
          constraintStatus: "pass",
          violatedConstraints: [],
        },
        evidence: [{ source: "semantic-search", similarityScore: 0.9, retrievedAt: "2026-09-15T00:00:00.000Z" }],
      } as Partial<AuditRecord>)
    );

    const item = sendMock.mock.calls[0][0].input.Item;
    expect(item.decisionId).toEqual({ S: "dec-2" });
    expect(item.parentDecisionId).toEqual({ S: "dec-1" });
    expect(item.iteration).toEqual({ N: "1" });
    expect(item.status).toEqual({ S: "success" });
    expect(item.constraintStatus).toEqual({ S: "pass" });
    expect(JSON.parse(item.score.S)).toEqual(
      expect.objectContaining({ candidateId: "svc-1", totalScore: 0.85 })
    );
    expect(JSON.parse(item.evidence.S)).toEqual([
      expect.objectContaining({ source: "semantic-search", similarityScore: 0.9 }),
    ]);
  });

  it("omits decisionId/parentDecisionId/iteration/status/constraintStatus/score/evidence when absent", async () => {
    const { recordDecision } = await import("./index");

    await recordDecision(record());

    const item = sendMock.mock.calls[0][0].input.Item;
    expect(item.decisionId).toBeUndefined();
    expect(item.parentDecisionId).toBeUndefined();
    expect(item.iteration).toBeUndefined();
    expect(item.status).toBeUndefined();
    expect(item.constraintStatus).toBeUndefined();
    expect(item.score).toBeUndefined();
    expect(item.evidence).toBeUndefined();
  });

  it("throws instead of silently succeeding when AUDIT_TABLE_NAME is not configured", async () => {
    delete process.env.AUDIT_TABLE_NAME;
    const { recordDecision } = await import("./index");

    await expect(recordDecision(record())).rejects.toThrow("AUDIT_TABLE_NAME is not set");
    expect(sendMock).not.toHaveBeenCalled();
  });
});
