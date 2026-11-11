// Projects a v2 record onto the flat shape the agents read today (MongoDB `services`
// documents), so the catalogue can move to v2 without changing any agent. Measured values
// (T3.3 probes) take precedence over advertised ones.
import type { CatalogueServiceV2 } from "./schema";

export interface ServiceV1 {
  serviceId: string;
  name: string;
  description: string;
  capability: string;
  price: number;
  uptime: number;
  latencyMs?: number;
  dependencies: string[];
  constraints: string[];
  endpoint: string;
  // Carried along for the dashboard and audits; agents ignore them.
  provider: string;
  priceUnit: string;
  currency: string;
  sourceUrl: string;
  retrievedAt: string;
  qosBasis: "measured" | "advertised";
  synthetic?: boolean;
}

export function toV1(s: CatalogueServiceV2): ServiceV1 {
  const m = s.measured;
  const latencyMs = m?.latencyMs ?? s.advertised.latencyMs;
  return {
    serviceId: s.serviceId,
    name: s.name,
    description: s.description,
    capability: s.capability,
    price: s.pricing.amount,
    uptime: m?.uptime ?? s.advertised.uptime,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    dependencies: [],
    constraints: [],
    endpoint: s.endpoint,
    provider: s.provider,
    priceUnit: s.pricing.unit,
    currency: s.pricing.currency,
    sourceUrl: s.source.url,
    retrievedAt: s.source.retrievedAt,
    qosBasis: m ? "measured" : "advertised",
    ...(s.synthetic ? { synthetic: true } : {}),
  };
}
