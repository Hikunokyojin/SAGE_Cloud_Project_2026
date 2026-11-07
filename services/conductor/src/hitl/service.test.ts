import { describe, it, expect, vi } from "vitest";
import { createReviewService } from "./service";
import { signReviewToken } from "./token";
import type { PausedRequest } from "./store";

const KEY = "unit-test-signing-key-0123456789";
const BASE = "https://api.example/prod/";

function pausedResult() {
  return {
    status: "paused_for_review" as const,
    requestId: "req-1",
    escalation: { requestId: "req-1", explanation: "Nothing fit.", attemptedOptions: [] },
    review: {
      reason: "no candidate satisfies the mandatory constraints",
      intent: { requestId: "req-1", capability: "resize", category: "image-resizing", constraints: [], rawInput: "r" },
      candidates: [
        {
          serviceId: "svc-a", name: "A", description: "d", price: 0.005, uptime: 99.9, latencyMs: 300,
          endpoint: "https://e", similarityScore: 0.7, evidence: [],
        },
      ],
      escalationDecisionId: "esc-1",
    },
  };
}

function setup(store = new Map<string, PausedRequest>()) {
  const deps = {
    signingKey: async () => KEY,
    dashboardUrl: BASE,
    save: vi.fn(async (p: PausedRequest) => void store.set(p.requestId, p)),
    get: vi.fn(async (id: string) => store.get(id)),
    markResolved: vi.fn(async (id: string, resolution: any, status: any) => {
      const p = store.get(id);
      if (!p || p.status !== "pending") return false;
      store.set(id, { ...p, status, resolution });
      return true;
    }),
    record: vi.fn(async () => undefined),
    rerun: vi.fn(async () => ({ status: "completed", requestId: "req-1" })),
    now: () => 1_000_000,
  };
  return { svc: createReviewService(deps as any), deps, store };
}

describe("review service", () => {
  it("builds a signed review link to the dashboard", async () => {
    const { svc } = setup();
    const url = await svc.reviewUrl("req-1");
    expect(url).toMatch(/^https:\/\/api\.example\/prod\/#review=req-1&token=\d+\.[A-Za-z0-9_-]+$/);
  });

  it("gives no link (and pauses still work) when the signing key is not configured", async () => {
    const { deps } = setup();
    const noKey = createReviewService({ ...deps, signingKey: async () => undefined } as any);
    expect(await noKey.reviewUrl("req-1")).toBeUndefined();
  });

  it("stores a paused result as a pending request with a slim list of offered services", async () => {
    const { svc, store } = setup();
    await svc.onPaused(pausedResult() as any);
    const p = store.get("req-1")!;
    expect(p.status).toBe("pending");
    expect(p.lastDecisionId).toBe("esc-1");
    expect(p.candidates).toEqual([{ serviceId: "svc-a", name: "A", price: 0.005, uptime: 99.9, latencyMs: 300 }]);
  });

  it("shows a paused request only with a valid token", async () => {
    const { svc } = setup();
    await svc.onPaused(pausedResult() as any);
    const token = signReviewToken("req-1", KEY, 1_000_000);
    expect((await svc.view("req-1", token)).requestId).toBe("req-1");
    await expect(svc.view("req-1", "1.bad")).rejects.toMatchObject({ httpStatus: 403 });
    await expect(svc.view("req-2", token)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it("resolves with a valid token and refuses without one", async () => {
    const { svc, deps } = setup();
    await svc.onPaused(pausedResult() as any);
    const token = signReviewToken("req-1", KEY, 1_000_000);
    await expect(svc.resolve("req-1", { token: "nope", action: "reject", reviewer: "x" } as any)).rejects.toMatchObject({ httpStatus: 403 });
    const out = await svc.resolve("req-1", { token, action: "approve", serviceId: "svc-a", reviewer: "Divik" } as any);
    expect(out.status).toBe("approved");
    expect(deps.record).toHaveBeenCalledTimes(1);
  });

  it("answers 503 for review routes when the signing key is missing", async () => {
    const { deps } = setup();
    const noKey = createReviewService({ ...deps, signingKey: async () => undefined } as any);
    await expect(noKey.view("req-1", "1.x")).rejects.toMatchObject({ httpStatus: 503 });
  });
});
