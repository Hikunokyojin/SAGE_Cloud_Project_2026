import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrokerAgentInput } from "@sage/shared-types";

const bedrockSendMock = vi.fn();
const qdrantSearchMock = vi.fn();
const mongoConnectMock = vi.fn();
const mongoFindToArrayMock = vi.fn();
const ssmSendMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient {
    send = bedrockSendMock;
  }
  class InvokeModelCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { BedrockRuntimeClient, InvokeModelCommand };
});

vi.mock("@qdrant/js-client-rest", () => {
  class QdrantClient {
    search = qdrantSearchMock;
  }
  return { QdrantClient };
});

vi.mock("mongodb", () => {
  class MongoClient {
    connect = mongoConnectMock;
    db() {
      return {
        collection() {
          return { find: () => ({ toArray: mongoFindToArrayMock }) };
        },
      };
    }
  }
  return { MongoClient };
});

vi.mock("@aws-sdk/client-ssm", () => {
  class SSMClient {
    send = ssmSendMock;
  }
  class GetParameterCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { SSMClient, GetParameterCommand };
});

function embeddingResponse(vector: number[]) {
  const body = JSON.stringify({ embedding: vector });
  return { body: new TextEncoder().encode(body) };
}

function ssmParameterResponse(value: string) {
  return { Parameter: { Value: value } };
}

const MONGO_DOC = (overrides: Partial<Record<string, unknown>> = {}) => ({
  serviceId: "svc-1",
  name: "FastResize",
  description: "Quick image resizer",
  price: 0.02,
  uptime: 99.9,
  endpoint: "https://api.example.com/resize",
  ...overrides,
});

describe("Broker Agent handler", () => {
  beforeEach(() => {
    vi.resetModules();
    bedrockSendMock.mockReset();
    qdrantSearchMock.mockReset();
    mongoConnectMock.mockReset();
    mongoFindToArrayMock.mockReset();
    ssmSendMock.mockReset();

    process.env.MONGO_URI = "mongodb://localhost:27017/test";
    process.env.QDRANT_URL = "http://localhost:6333";
    process.env.QDRANT_API_KEY = "test-key";

    bedrockSendMock.mockResolvedValue(embeddingResponse([0.1, 0.2, 0.3]));
    mongoConnectMock.mockResolvedValue(undefined);
  });

  it("returns candidates that pass hard constraints, enriched with metadata from Mongo", async () => {
    qdrantSearchMock.mockResolvedValue([{ id: "svc-1", score: 0.92 }]);
    mongoFindToArrayMock.mockResolvedValue([MONGO_DOC()]);

    const input: BrokerAgentInput = {
      requestId: "req-1",
      capability: "fast image resizing service",
      constraints: { maxBudget: 0.05, minUptime: 99 },
    };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result).toEqual([
      {
        serviceId: "svc-1",
        name: "FastResize",
        description: "Quick image resizer",
        price: 0.02,
        uptime: 99.9,
        endpoint: "https://api.example.com/resize",
        similarityScore: 0.92,
      },
    ]);
    expect(ssmSendMock).not.toHaveBeenCalled();
  });

  it("filters out candidates that violate maxBudget or minUptime hard constraints", async () => {
    qdrantSearchMock.mockResolvedValue([
      { id: "cheap-reliable", score: 0.9 },
      { id: "over-budget", score: 0.95 },
      { id: "low-uptime", score: 0.85 },
    ]);
    mongoFindToArrayMock.mockResolvedValue([
      MONGO_DOC({ serviceId: "cheap-reliable", price: 0.02, uptime: 99.9 }),
      MONGO_DOC({ serviceId: "over-budget", price: 0.5, uptime: 99.9 }),
      MONGO_DOC({ serviceId: "low-uptime", price: 0.02, uptime: 90 }),
    ]);

    const input: BrokerAgentInput = {
      requestId: "req-2",
      capability: "anything",
      constraints: { maxBudget: 0.05, minUptime: 95 },
    };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result.map((c) => c.serviceId)).toEqual(["cheap-reliable"]);
  });

  it("skips Qdrant hits that have no matching Mongo metadata document", async () => {
    qdrantSearchMock.mockResolvedValue([{ id: "svc-missing", score: 0.9 }]);
    mongoFindToArrayMock.mockResolvedValue([]); // no metadata found

    const input: BrokerAgentInput = { requestId: "req-3", capability: "anything", constraints: {} };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result).toEqual([]);
  });

  it("limits results to the top 5 candidates", async () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({ id: `svc-${i}`, score: 0.9 - i * 0.01 }));
    const docs = hits.map((h) => MONGO_DOC({ serviceId: h.id }));

    qdrantSearchMock.mockResolvedValue(hits);
    mongoFindToArrayMock.mockResolvedValue(docs);

    const input: BrokerAgentInput = { requestId: "req-4", capability: "anything", constraints: {} };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result).toHaveLength(5);
  });

  describe("when the environment variables are not set (deployed Lambda scenario)", () => {
    beforeEach(() => {
      delete process.env.MONGO_URI;
      delete process.env.QDRANT_URL;
      delete process.env.QDRANT_API_KEY;
    });

    it("fetches Mongo/Qdrant secrets from SSM Parameter Store instead", async () => {
      ssmSendMock.mockImplementation((command: { input: { Name: string } }) => {
        const values: Record<string, string> = {
          "/sage/broker/MONGO_URI": "mongodb+srv://real-cluster/test",
          "/sage/broker/QDRANT_URL": "https://real-cluster.qdrant.io",
          "/sage/broker/QDRANT_API_KEY": "real-secret-key",
        };
        return Promise.resolve(ssmParameterResponse(values[command.input.Name]));
      });
      qdrantSearchMock.mockResolvedValue([{ id: "svc-1", score: 0.92 }]);
      mongoFindToArrayMock.mockResolvedValue([MONGO_DOC()]);

      const input: BrokerAgentInput = { requestId: "req-5", capability: "anything", constraints: {} };

      const { handler } = await import("./index");
      const result = await handler(input);

      expect(result).toHaveLength(1);
      expect(ssmSendMock).toHaveBeenCalledTimes(3);
      const requestedNames = ssmSendMock.mock.calls.map((call) => call[0].input.Name).sort();
      expect(requestedNames).toEqual([
        "/sage/broker/MONGO_URI",
        "/sage/broker/QDRANT_API_KEY",
        "/sage/broker/QDRANT_URL",
      ]);
      expect(ssmSendMock.mock.calls.every((call) => call[0].input.WithDecryption === true)).toBe(true);
    });

    it("only fetches each SSM secret once across multiple invocations (cached after cold start)", async () => {
      ssmSendMock.mockImplementation((command: { input: { Name: string } }) => {
        const values: Record<string, string> = {
          "/sage/broker/MONGO_URI": "mongodb+srv://real-cluster/test",
          "/sage/broker/QDRANT_URL": "https://real-cluster.qdrant.io",
          "/sage/broker/QDRANT_API_KEY": "real-secret-key",
        };
        return Promise.resolve(ssmParameterResponse(values[command.input.Name]));
      });
      qdrantSearchMock.mockResolvedValue([]);
      mongoFindToArrayMock.mockResolvedValue([]);

      const { handler } = await import("./index");
      await handler({ requestId: "req-6", capability: "a", constraints: {} });
      await handler({ requestId: "req-7", capability: "b", constraints: {} });

      expect(ssmSendMock).toHaveBeenCalledTimes(3);
    });

    it("throws a descriptive error when an SSM parameter is missing", async () => {
      ssmSendMock.mockResolvedValue({ Parameter: undefined });

      const { handler } = await import("./index");
      await expect(handler({ requestId: "req-8", capability: "anything", constraints: {} })).rejects.toThrow(
        /SSM parameter .* not found/
      );
    });
  });
});
