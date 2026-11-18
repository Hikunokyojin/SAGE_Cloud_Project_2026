// T4.7: grows the 21-service test catalogue to 100, 500 and 2,000 services with padding.
// Padding is SYNTHETIC and flagged (`synthetic: true`, id prefix "pad-"). Text is borrowed from the
// real v2 catalogue so it reads like real services. Padding inside one of the 21's categories is
// strictly worse than every original service there (higher price and latency, lower uptime), so
// the 27 test cases keep the same right answers at every size; padding elsewhere uses its own
// category. What changes with size is only how much the retriever and the LLM have to sift.
export interface ScaleService {
  serviceId: string;
  name: string;
  description: string;
  capability: string;
  price: number;
  uptime: number;
  latencyMs?: number;
  synthetic?: boolean;
}

interface Source { name: string; description: string; capability: string }

export function pad(base: ScaleService[], sources: Source[], size: number): ScaleService[] {
  if (size <= base.length) return base.slice(0, size);
  const worst = new Map<string, { price: number; uptime: number; latencyMs: number }>();
  for (const s of base) {
    const w = worst.get(s.capability) ?? { price: 0, uptime: 100, latencyMs: 0 };
    worst.set(s.capability, {
      price: Math.max(w.price, s.price),
      uptime: Math.min(w.uptime, s.uptime),
      latencyMs: Math.max(w.latencyMs, s.latencyMs ?? 0),
    });
  }
  const out = [...base];
  for (let i = 0; out.length < size; i++) {
    const src = sources[i % sources.length];
    const round = Math.floor(i / sources.length);
    const w = worst.get(src.capability);
    out.push({
      serviceId: `pad-${i}`,
      name: round === 0 ? src.name : `${src.name} (edition ${round + 1})`,
      description: src.description,
      capability: src.capability,
      // Dominated in the 21's categories; otherwise an ordinary-looking offer.
      price: w ? Math.round((w.price * 1.5 + 0.01 * (round + 1)) * 1000) / 1000 : 0.01 * ((i % 9) + 1),
      uptime: w ? Math.max(90, Math.round((w.uptime - 0.5 - 0.1 * round) * 100) / 100) : 99,
      latencyMs: w ? w.latencyMs + 100 * (round + 1) : 200,
      synthetic: true,
    });
  }
  return out;
}

/** The LLM-only baseline's prompt for one request (same shape as baselines.ts baseline1LlmOnly). */
export function llmOnlyPromptChars(catalogue: ScaleService[], request: string): number {
  return `Request: ${request}\n\nCatalog:\n${JSON.stringify(catalogue.map(({ synthetic, ...s }) => s))}`.length;
}
