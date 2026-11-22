import { describe, it, expect, vi } from "vitest";
import { resolvePaused, type ResolveDeps } from "./resolve";
import type { PausedRequest } from "./store";
import type { Intent } from "@sage/shared-types";

const intent: Intent = {
  requestId: "req-1",
  capability: "image resizing",
  category: "image-resizing",
  constraints: [{ field: "price", operator: "lte", value: 0.001, mandatory: true }],
  rawInput: "cheap resizer under 0.001",
};

function paused(over: Partial<PausedRequest> = {}): PausedRequest {
  return {
    requestId: "req-1",
    status: "pending",
    reason: "no candidate satisfies the mandatory constraints",
    intent,
    candidates: [{ serviceId: "svc-a", name: "A", price: 0.005, uptime: 99.9 }],
    escalation: { requestId: "req-1", explanation: "x", attemptedOptions: [] },
    createdAt: "2026-11-06T00:00:00.000Z",
    lastDecisionId: "dec-escalation",
    ...over,
  };
}

function deps(p: PausedRequest | undefined): ResolveDeps & { record: ReturnType<typeof vi.fn>; markResolved: ReturnType<typeof vi.fn>; rerun: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => p),
    markResolved: vi.fn(async () => true),
    record: vi.fn(async () => undefined),
    rerun: vi.fn(async () => ({ status: "completed", requestId: "req-1" }) as any),
    now: () => "2026-11-06T01:00:00.000Z",
  } as any;
}

describe("resolvePaused", () => {
  it("approves one of the offered services and records the human decision", async () => {
    const d = deps(paused());
    const out = await resolvePaused(d, "req-1", { action: "approve", serviceId: "svc-a", reviewer: "Divik", note: "ok for a demo" });
    expect(out.status).toBe("approved");
    expect(d.markResolved).toHaveBeenCalledWith("req-1", expect.objectContaining({ action: "approve", serviceId: "svc-a" }), "approved");
    const rec = d.record.mock.calls[0][0];
    expect(rec.agent).toBe("HumanInTheLoop");
    expect(rec.parentDecisionId).toBe("dec-escalation");
    expect(rec.output).toMatchObject({ action: "approve", serviceId: "svc-a", reviewer: "Divik" });
  });

  it("refuses to approve a service that was not offered", async () => {
    await expect(resolvePaused(deps(paused()), "req-1", { action: "approve", serviceId: "svc-zzz", reviewer: "x" })).rejects.toThrow(/not one of/);
  });

  it("rejects with a note", async () => {
    const d = deps(paused());
    const out = await resolvePaused(d, "req-1", { action: "reject", reviewer: "x", note: "not suitable" });
    expect(out.status).toBe("rejected");
    expect(d.rerun).not.toHaveBeenCalled();
  });

  it("relaxes a constraint and re-runs the pipeline from the edited intent", async () => {
    const d = deps(paused());
    const out = await resolvePaused(d, "req-1", {
      action: "relax",
      reviewer: "x",
      constraints: [{ field: "price", operator: "lte", value: 0.01, mandatory: true }],
    });
    expect(out.status).toBe("rerun");
    const [rerunIntent, parent] = d.rerun.mock.calls[0];
    expect(rerunIntent.constraints[0].value).toBe(0.01);
    expect(rerunIntent.category).toBe("image-resizing");
    expect(parent).toBe(d.record.mock.calls[0][0].decisionId);
    expect(out.result).toEqual({ status: "completed", requestId: "req-1" });
  });

  it("drops malformed relaxed constraints instead of trusting the browser", async () => {
    const d = deps(paused());
    await resolvePaused(d, "req-1", {
      action: "relax",
      reviewer: "x",
      constraints: [{ field: "price", operator: "lte", value: 0.02, mandatory: true }, { field: "evil", operator: "lte", value: 1 } as any, { field: "uptime", operator: "gte", value: "99" } as any],
    });
    expect(d.rerun.mock.calls[0][0].constraints).toEqual([{ field: "price", operator: "lte", value: 0.02, mandatory: true }]);
  });

  it("can only resolve a pending request once", async () => {
    await expect(resolvePaused(deps(paused({ status: "approved" })), "req-1", { action: "reject", reviewer: "x" })).rejects.toThrow(/already/);
    const d = deps(paused());
    d.markResolved.mockResolvedValue(false); // someone else resolved it in between
    await expect(resolvePaused(d, "req-1", { action: "reject", reviewer: "x" })).rejects.toThrow(/already/);
    expect(d.record).not.toHaveBeenCalled();
  });

  it("refuses an unknown request or action", async () => {
    await expect(resolvePaused(deps(undefined), "nope", { action: "reject", reviewer: "x" })).rejects.toThrow(/not found/);
    await expect(resolvePaused(deps(paused()), "req-1", { action: "delete" as any, reviewer: "x" })).rejects.toThrow(/action/);
  });
});
