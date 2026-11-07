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
  class QueryCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class ConditionalCheckFailedException extends Error {}
  return { DynamoDBClient, PutItemCommand, QueryCommand, ConditionalCheckFailedException };
});

// The writer first reads the request's latest hash (Query), then writes (PutItem).
function puts(): any[] {
  return sendMock.mock.calls.map((c) => c[0]).filter((cmd) => cmd.input && "Item" in cmd.input);
}

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

    expect(puts()).toHaveLength(1);
    const putCommand = puts()[0];
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
    expect(puts()[0].input.Item.reasoning).toEqual({ S: "Chosen because it fit best." });

    sendMock.mockClear();
    await recordDecision(record());
    expect(puts()[0].input.Item.reasoning).toBeUndefined();
  });

  it("writes decisionId/parentDecisionId/iteration/status/constraintStatus/score/evidence when provided ", async () => {
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

    const item = puts()[0].input.Item;
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

    const item = puts()[0].input.Item;
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

  it("writes LLM token usage and the step duration when provided", async () => {
    const { recordDecision } = await import("./index");

    await recordDecision({
      ...record(),
      decisionId: "d-1",
      iteration: 0,
      status: "success",
      usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 },
      durationMs: 1234,
    });

    const item = puts()[0].input.Item;
    expect(JSON.parse(item.usage.S)).toEqual({ promptTokens: 120, completionTokens: 80, totalTokens: 200 });
    expect(item.durationMs).toEqual({ N: "1234" });
  });

  it("marks the first record a process writes as a cold start and later ones as warm", async () => {
    vi.resetModules();
    const { recordDecision } = await import("./index");

    await recordDecision(record());
    await recordDecision(record());

    expect(puts()[0].input.Item.coldStart).toEqual({ BOOL: true });
    expect(puts()[1].input.Item.coldStart).toEqual({ BOOL: false });
  });
});

describe("tamper-evident chain", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.AUDIT_TABLE_NAME = "agent_decisions";
  });

  it("starts a request's chain at GENESIS and stores a hash that matches the stored item", async () => {
    sendMock.mockResolvedValue({});
    const { recordDecision } = await import("./index");
    const { hashItem } = await import("./chain");
    await recordDecision(record());
    const put = puts()[0].input;
    expect(put.Item.prevHash).toEqual({ S: "GENESIS" });
    expect(put.Item.hash.S).toBe(hashItem(put.Item));
  });

  it("links to the request's latest record and refuses to overwrite an existing one", async () => {
    sendMock.mockImplementation(async (cmd: any) =>
      cmd.input.KeyConditionExpression ? { Items: [{ hash: { S: "abc123" } }] } : {}
    );
    const { recordDecision } = await import("./index");
    await recordDecision(record());
    const query = sendMock.mock.calls[0][0].input;
    expect(query).toMatchObject({ ScanIndexForward: false, Limit: 1, ConsistentRead: true });
    const put = puts()[0].input;
    expect(put.Item.prevHash).toEqual({ S: "abc123" });
    expect(put.ConditionExpression).toBe("attribute_not_exists(requestId)");
  });
});

describe("warmUp", () => {
  it("opens the DynamoDB connection with one cheap read and never throws", async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValue(new Error("network"));
    process.env.AUDIT_TABLE_NAME = "agent_decisions";
    const { warmUp } = await import("./index");
    await expect(warmUp()).resolves.toBeUndefined();
    expect(sendMock.mock.calls[0][0].input).toMatchObject({ TableName: "agent_decisions", Limit: 1 });
  });
});
