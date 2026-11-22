import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () {
    return { send: sendMock };
  }),
  GetItemCommand: vi.fn(function (input: unknown) {
    return { kind: "get", input };
  }),
  PutItemCommand: vi.fn(function (input: unknown) {
    return { kind: "put", input };
  }),
}));

describe("sharedCache", () => {
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    process.env.INTENT_CACHE_TABLE_NAME = "intent_cache";
  });

  it("keys differ by version so a prompt change never serves an old parse", async () => {
    const { cacheKey } = await import("./sharedCache");
    expect(cacheKey("send emails", "v1")).not.toBe(cacheKey("send emails", "v2"));
    expect(cacheKey("send emails", "v1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes the parse with an expiry and reads it back", async () => {
    const { getShared, putShared } = await import("./sharedCache");
    await putShared("k", { capability: "x" });
    const put = sendMock.mock.calls[0][0].input;
    expect(put.TableName).toBe("intent_cache");
    expect(Number(put.Item.expiresAt.N)).toBeGreaterThan(Date.now() / 1000);

    sendMock.mockResolvedValueOnce({ Item: put.Item });
    expect(await getShared("k")).toEqual({ capability: "x" });
  });

  it("ignores an expired item", async () => {
    const { getShared } = await import("./sharedCache");
    sendMock.mockResolvedValueOnce({ Item: { parse: { S: "{}" }, expiresAt: { N: "1" } } });
    expect(await getShared("k")).toBeUndefined();
  });

  it("never throws and does nothing when the table is not configured or fails", async () => {
    delete process.env.INTENT_CACHE_TABLE_NAME;
    let mod = await import("./sharedCache");
    expect(await mod.getShared("k")).toBeUndefined();
    await mod.putShared("k", {});
    expect(sendMock).not.toHaveBeenCalled();

    process.env.INTENT_CACHE_TABLE_NAME = "intent_cache";
    vi.resetModules();
    mod = await import("./sharedCache");
    sendMock.mockRejectedValue(new Error("throttled"));
    expect(await mod.getShared("k")).toBeUndefined();
    await expect(mod.putShared("k", {})).resolves.toBeUndefined();
  });
});
