import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrokerAgentInput } from "@sage/shared-types";

const qdrantSearchMock = vi.fn();
const mongoConnectMock = vi.fn();
const mongoFindToArrayMock = vi.fn();
const resolveSecretMock = vi.fn();
const embedderMock = vi.fn();
const pipelineFactoryMock = vi.fn();

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

vi.mock("@sage/secrets", () => ({
  resolveSecret: resolveSecretMock,
}));

vi.mock("@huggingface/transformers", () => ({
  pipeline: pipelineFactoryMock,
  env: { allowRemoteModels: true },
}));

function embeddingOutput(vector: number[]) {
  return { data: Float32Array.from(vector) };
}

// Qdrant point IDs must be an unsigned integer or a UUID -- a human-readable serviceId
// like "svc-1" is rejected (ApiError 400 "not a valid point ID"), confirmed against the
// real Qdrant Cloud instance while re-seeding actual data. The point ID here is just a
// standin UUID; the serviceId that actually joins against Mongo lives in the payload.
function qdrantHit(pointId: string, serviceId: string, score: number) {
  return { id: pointId, score, payload: { serviceId } };
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
    qdrantSearchMock.mockReset();
    mongoConnectMock.mockReset();
    mongoFindToArrayMock.mockReset();
    resolveSecretMock.mockReset();
    embedderMock.mockReset();
    pipelineFactoryMock.mockReset();

    resolveSecretMock.mockImplementation(async (envVar: string) => {
      const values: Record<string, string> = {
        MONGO_URI: "mongodb://localhost:27017/test",
        QDRANT_URL: "http://localhost:6333",
        QDRANT_API_KEY: "test-key",
      };
      return values[envVar];
    });

    embedderMock.mockResolvedValue(embeddingOutput([0.1, 0.2, 0.3]));
    pipelineFactoryMock.mockResolvedValue(embedderMock);
    mongoConnectMock.mockResolvedValue(undefined);
  });

  it("returns candidates that pass hard constraints, enriched with metadata from Mongo", async () => {
    qdrantSearchMock.mockResolvedValue([qdrantHit("11111111-1111-1111-1111-111111111111", "svc-1", 0.92)]);
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
  });

  it("requests payloads from Qdrant, since serviceId lives there, not in the point ID", async () => {
    qdrantSearchMock.mockResolvedValue([]);
    mongoFindToArrayMock.mockResolvedValue([]);

    const { handler } = await import("./index");
    await handler({ requestId: "req-payload", capability: "anything", constraints: {} });

    const searchCall = qdrantSearchMock.mock.calls[0][1];
    expect(searchCall.with_payload).toBe(true);
  });

  it("embeds the capability text locally, via the loaded feature-extraction pipeline", async () => {
    qdrantSearchMock.mockResolvedValue([]);
    mongoFindToArrayMock.mockResolvedValue([]);

    const input: BrokerAgentInput = { requestId: "req-embed", capability: "fast image resizing", constraints: {} };

    const { handler } = await import("./index");
    await handler(input);

    expect(pipelineFactoryMock).toHaveBeenCalledWith("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    expect(embedderMock).toHaveBeenCalledWith("fast image resizing", { pooling: "mean", normalize: true });
    const searchCall = qdrantSearchMock.mock.calls[0][1];
    // Float32Array -> number[] introduces float32 rounding (e.g. 0.1 -> 0.10000000149...),
    // so compare with tolerance rather than exact equality.
    searchCall.vector.forEach((value: number, i: number) => {
      expect(value).toBeCloseTo([0.1, 0.2, 0.3][i], 5);
    });
  });

  it("only loads the embedding pipeline once across multiple invocations (cached after cold start)", async () => {
    qdrantSearchMock.mockResolvedValue([]);
    mongoFindToArrayMock.mockResolvedValue([]);

    const { handler } = await import("./index");
    await handler({ requestId: "req-a", capability: "a", constraints: {} });
    await handler({ requestId: "req-b", capability: "b", constraints: {} });

    expect(pipelineFactoryMock).toHaveBeenCalledTimes(1);
  });

  it("filters out candidates that violate maxBudget or minUptime hard constraints", async () => {
    qdrantSearchMock.mockResolvedValue([
      qdrantHit("11111111-1111-1111-1111-111111111111", "cheap-reliable", 0.9),
      qdrantHit("22222222-2222-2222-2222-222222222222", "over-budget", 0.95),
      qdrantHit("33333333-3333-3333-3333-333333333333", "low-uptime", 0.85),
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
    qdrantSearchMock.mockResolvedValue([qdrantHit("11111111-1111-1111-1111-111111111111", "svc-missing", 0.9)]);
    mongoFindToArrayMock.mockResolvedValue([]); // no metadata found

    const input: BrokerAgentInput = { requestId: "req-3", capability: "anything", constraints: {} };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result).toEqual([]);
  });

  it("limits results to the top 5 candidates", async () => {
    const hits = Array.from({ length: 8 }, (_, i) =>
      qdrantHit(`00000000-0000-0000-0000-00000000000${i}`, `svc-${i}`, 0.9 - i * 0.01)
    );
    const docs = hits.map((h) => MONGO_DOC({ serviceId: h.payload.serviceId }));

    qdrantSearchMock.mockResolvedValue(hits);
    mongoFindToArrayMock.mockResolvedValue(docs);

    const input: BrokerAgentInput = { requestId: "req-4", capability: "anything", constraints: {} };

    const { handler } = await import("./index");
    const result = await handler(input);

    expect(result).toHaveLength(5);
  });

  it("resolves Mongo/Qdrant secrets via @sage/secrets (env locally, SSM once deployed)", async () => {
    qdrantSearchMock.mockResolvedValue([]);
    mongoFindToArrayMock.mockResolvedValue([]);

    const { handler } = await import("./index");
    await handler({ requestId: "req-5", capability: "anything", constraints: {} });

    expect(resolveSecretMock).toHaveBeenCalledWith("MONGO_URI", "/sage/broker/MONGO_URI");
    expect(resolveSecretMock).toHaveBeenCalledWith("QDRANT_URL", "/sage/broker/QDRANT_URL");
    expect(resolveSecretMock).toHaveBeenCalledWith("QDRANT_API_KEY", "/sage/broker/QDRANT_API_KEY");
  });
});
