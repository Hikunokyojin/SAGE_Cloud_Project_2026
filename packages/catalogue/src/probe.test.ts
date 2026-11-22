import { describe, it, expect } from "vitest";
import { classifyProbe, summarise, blendQos, type ProbeSample } from "./probe";

const s = (id: string, at: string, ok: boolean, ms?: number): ProbeSample => ({ id, at, ok, ...(ms !== undefined ? { ms } : {}) });

describe("classifyProbe: what counts as the service being up", () => {
  it("any HTTP answer below 500 means the API is reachable (401/403/404 are normal for an unauthenticated probe)", () => {
    for (const status of [200, 204, 301, 401, 403, 404, 405, 429]) expect(classifyProbe({ status }), String(status)).toBe(true);
  });
  it("server errors, timeouts and network failures count as down", () => {
    for (const status of [500, 502, 503, 504]) expect(classifyProbe({ status }), String(status)).toBe(false);
    expect(classifyProbe({ error: "timeout" })).toBe(false);
    expect(classifyProbe({ error: "ENOTFOUND" })).toBe(false);
  });
});

describe("summarise: rolling window per service", () => {
  const now = new Date("2026-11-20T00:00:00Z");
  const hist = [
    s("svc-a", "2026-11-19T00:00:00Z", true, 100),
    s("svc-a", "2026-11-19T06:00:00Z", true, 300),
    s("svc-a", "2026-11-19T12:00:00Z", false),
    s("svc-a", "2026-11-19T18:00:00Z", true, 200),
    s("svc-a", "2026-09-01T00:00:00Z", false), // outside the 30-day window
    s("svc-b", "2026-11-19T00:00:00Z", true, 50),
  ];

  it("computes uptime %, median latency of successful probes, sample count and last date", () => {
    const m = summarise(hist, now, 30);
    expect(m.get("svc-a")).toEqual({ uptime: 75, latencyMs: 200, samples: 4, sampledAt: "2026-11-19" });
    expect(m.get("svc-b")).toEqual({ uptime: 100, latencyMs: 50, samples: 1, sampledAt: "2026-11-19" });
  });

  it("leaves latency out when every probe failed", () => {
    const m = summarise([s("svc-c", "2026-11-19T00:00:00Z", false)], now, 30);
    expect(m.get("svc-c")).toEqual({ uptime: 0, samples: 1, sampledAt: "2026-11-19" });
  });
});

describe("blendQos: measured evidence gradually outweighs the advertised claim", () => {
  it("no samples means advertised values unchanged", () => {
    expect(blendQos({ uptime: 99.9, latencyMs: 100 }, undefined)).toEqual({ uptime: 99.9, latencyMs: 100, basis: "advertised" });
  });
  it("weight grows with samples: 12 samples is half, many samples approach measured", () => {
    const adv = { uptime: 99.9 };
    const half = blendQos(adv, { uptime: 90, samples: 12, sampledAt: "2026-11-19" });
    expect(half.uptime).toBeCloseTo(94.95, 6);
    const many = blendQos(adv, { uptime: 90, samples: 120, sampledAt: "2026-11-19" });
    expect(many.uptime).toBeLessThan(91);
    expect(many.basis).toBe("blended");
  });
  it("uses measured latency directly when nothing was advertised", () => {
    expect(blendQos({ uptime: 99.9 }, { uptime: 100, latencyMs: 250, samples: 3, sampledAt: "2026-11-19" }).latencyMs).toBe(250);
  });
  it("RT6: a deliberate outage drops a service below a rival with the same advertised uptime", () => {
    const rival = blendQos({ uptime: 99.9 }, { uptime: 100, samples: 24, sampledAt: "2026-11-19" });
    const broken = blendQos({ uptime: 99.9 }, { uptime: 50, samples: 24, sampledAt: "2026-11-19" });
    expect(broken.uptime).toBeLessThan(rival.uptime);
  });
});
