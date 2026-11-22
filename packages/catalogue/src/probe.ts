// Measured QoS (T3.3). A scheduled job sends one lightweight unauthenticated request to each
// real service's endpoint, appends the outcome to the probe history, and summarises a rolling
// window into each record's `measured` block. Scoring then blends measured with advertised
// values, so evidence gradually outweighs a provider's claim.

export interface ProbeSample {
  id: string;
  // ISO timestamp of the probe.
  at: string;
  ok: boolean;
  // Round-trip time in milliseconds, for successful probes.
  ms?: number;
}

export interface Measured {
  uptime: number;
  latencyMs?: number;
  samples: number;
  sampledAt: string;
}

// An unauthenticated probe usually gets 401/403/404/405 from a healthy API; that still proves
// the service is reachable and answering. Only server errors and no answer count as down.
export function classifyProbe(r: { status?: number; error?: string }): boolean {
  return r.error === undefined && typeof r.status === "number" && r.status < 500;
}

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};

export function summarise(history: ProbeSample[], now: Date, windowDays: number): Map<string, Measured> {
  const from = now.getTime() - windowDays * 86_400_000;
  const byId = new Map<string, ProbeSample[]>();
  for (const s of history) {
    if (Date.parse(s.at) < from) continue;
    (byId.get(s.id) ?? byId.set(s.id, []).get(s.id)!).push(s);
  }
  const out = new Map<string, Measured>();
  for (const [id, xs] of byId) {
    const ok = xs.filter((x) => x.ok);
    const times = ok.map((x) => x.ms).filter((x): x is number => typeof x === "number");
    out.set(id, {
      uptime: Math.round((ok.length / xs.length) * 100_000) / 1000,
      ...(times.length ? { latencyMs: median(times) } : {}),
      samples: xs.length,
      sampledAt: xs.map((x) => x.at).sort().at(-1)!.slice(0, 10),
    });
  }
  return out;
}

// Samples at which measured and advertised carry equal weight (3 days of 6-hourly probes).
export const HALF_WEIGHT_SAMPLES = 12;

export function blendQos(
  advertised: { uptime: number; latencyMs?: number },
  measured: Measured | undefined
): { uptime: number; latencyMs?: number; basis: "advertised" | "blended" } {
  if (!measured || measured.samples <= 0) return { ...advertised, basis: "advertised" };
  const w = measured.samples / (measured.samples + HALF_WEIGHT_SAMPLES);
  const mix = (a: number, m: number) => Math.round((w * m + (1 - w) * a) * 1000) / 1000;
  const a = advertised.latencyMs, m = measured.latencyMs;
  const latencyMs = a !== undefined && m !== undefined ? Math.round(mix(a, m)) : m ?? a;
  return { uptime: mix(advertised.uptime, measured.uptime), ...(latencyMs !== undefined ? { latencyMs } : {}), basis: "blended" };
}
