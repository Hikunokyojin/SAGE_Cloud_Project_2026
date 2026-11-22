import { describe, it, expect, vi } from "vitest";

const warmUpMock = vi.fn(async () => undefined);
const recordDecisionMock = vi.fn();
vi.mock("@sage/audit", () => ({ recordDecision: recordDecisionMock, warmUp: warmUpMock }));
const searchMock = vi.fn();
vi.mock("@qdrant/js-client-rest", () => ({ QdrantClient: class { search = searchMock; } }));
const connectMock = vi.fn(async () => undefined);
vi.mock("mongodb", () => ({ MongoClient: class { connect = connectMock; } }));
vi.mock("@sage/secrets", () => ({ resolveSecret: vi.fn(async () => "x") }));
const embed = vi.fn(async () => ({ data: Float32Array.from([0.1]) }));
const pipelineMock = vi.fn(async () => embed);
vi.mock("@huggingface/transformers", () => ({ pipeline: pipelineMock, env: {} }));

describe("Broker keep-warm ping", () => {
  it("loads the embedding model and opens the database connections, but searches nothing", async () => {
    const { handler } = await import("./index");
    const out = await handler({ warmup: true } as never);
    expect(out).toEqual({ warmed: true });
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(1); // one tiny embedding runs the model once
    expect(connectMock).toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).not.toHaveBeenCalled();
  });
});
