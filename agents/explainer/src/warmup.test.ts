import { describe, it, expect, vi } from "vitest";

const warmUpMock = vi.fn(async () => undefined);
const recordDecisionMock = vi.fn();
vi.mock("@sage/audit", () => ({ recordDecision: recordDecisionMock, warmUp: warmUpMock }));
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("keep-warm ping", () => {
  it("answers a warm-up ping without doing any work, after opening the audit connection", async () => {
    const mod: Record<string, unknown> = await import("./index");
    const handlers = Object.entries(mod).filter(([k, v]) => typeof v === "function" && ["handler", "escalateUnsatisfiable", "explainEscalation"].includes(k));
    expect(handlers.length).toBeGreaterThan(0);
    for (const [name, fn] of handlers) {
      const out = await (fn as (e: unknown) => Promise<unknown>)({ warmup: true });
      expect(out, name).toEqual({ warmed: true });
    }
    expect(warmUpMock).toHaveBeenCalled();
    expect(recordDecisionMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
