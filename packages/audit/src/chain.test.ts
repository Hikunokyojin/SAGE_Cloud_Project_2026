import { describe, it, expect } from "vitest";
import { GENESIS, hashItem, verifyChain, type Item } from "./chain";

function chain(n: number): Item[] {
  const items: Item[] = [];
  let prev = GENESIS;
  for (let i = 0; i < n; i++) {
    const item: Item = {
      requestId: { S: "req-1" },
      timestamp: { S: `2026-11-07T00:00:0${i}.000Z` },
      agent: { S: `Agent${i}` },
      output: { S: JSON.stringify({ step: i }) },
      iteration: { N: String(i) },
      coldStart: { BOOL: false },
      prevHash: { S: prev },
    };
    item.hash = { S: hashItem(item) };
    prev = item.hash.S!;
    items.push(item);
  }
  return items;
}

describe("audit hash chain", () => {
  it("hashes the same content the same way whatever the attribute order", () => {
    const a: Item = { b: { S: "1" }, a: { N: "2" } };
    const b: Item = { a: { N: "2" }, b: { S: "1" } };
    expect(hashItem(a)).toBe(hashItem(b));
    expect(hashItem(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores the stored hash itself when hashing", () => {
    const [x] = chain(1);
    expect(hashItem(x)).toBe(x.hash!.S);
  });

  it("verifies an intact chain", () => {
    expect(verifyChain(chain(4))).toMatchObject({ ok: true, checked: 4 });
  });

  it("detects an edited field", () => {
    const items = chain(4);
    items[2].output = { S: JSON.stringify({ step: "tampered" }) };
    const r = verifyChain(items);
    expect(r.ok).toBe(false);
    expect(r.problem).toMatchObject({ index: 2, reason: expect.stringMatching(/content/) });
  });

  it("detects a deleted record in the middle", () => {
    const items = chain(4);
    items.splice(1, 1);
    const r = verifyChain(items);
    expect(r.ok).toBe(false);
    expect(r.problem).toMatchObject({ index: 1, reason: expect.stringMatching(/previous/) });
  });

  it("detects a record whose hash was recomputed after editing (the next link breaks)", () => {
    const items = chain(3);
    items[1].output = { S: "{}" };
    items[1].hash = { S: hashItem(items[1]) };
    const r = verifyChain(items);
    expect(r.ok).toBe(false);
    expect(r.problem?.index).toBe(2);
  });

  it("accepts records written before the chain existed, but only before the first chained one", () => {
    const legacy: Item = { requestId: { S: "req-1" }, timestamp: { S: "2026-11-01T00:00:00.000Z" }, agent: { S: "Old" } };
    expect(verifyChain([legacy, ...chain(2)])).toMatchObject({ ok: true, checked: 2, unchained: 1 });
    const items = chain(2);
    expect(verifyChain([...items, legacy]).ok).toBe(false);
  });

  it("detects a truncated chain start (first chained record must follow genesis or legacy records only)", () => {
    const items = chain(3).slice(1);
    expect(verifyChain(items).ok).toBe(false);
  });
});
