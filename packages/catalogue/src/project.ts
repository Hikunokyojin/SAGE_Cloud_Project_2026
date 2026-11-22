// Projects a v2 record onto the flat shape the agents read today (MongoDB `services`
// documents), so the catalogue can move to v2 without changing any agent.
//  - Quality: measured probe results (T3.3) are blended with advertised values.
//  - Price (T3.4): for real services `price` is the ESTIMATED USD PER MONTH at the usage
//    profile in normalise.ts, so the Negotiator compares like with like across units; the
//    listed price, its unit and currency, and the assumption travel alongside for display.
//    Synthetic services keep their original per-request price (they are offline test data).
import type { CatalogueServiceV2 } from "./schema";
import { blendQos } from "./probe";
import { monthlyCost } from "./normalise";

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
  // Carried along for the dashboard, the Explainer and audits; ranking ignores them.
  provider: string;
  listPrice: number;
  priceUnit: string;
  currency: string;
  priceBasis: string;
  sourceUrl: string;
  retrievedAt: string;
  qosBasis: "blended" | "advertised";
  synthetic?: boolean;
  // T4.1 (L1): what a flat plan covers.
  volumeBasis?: "quota" | "unmetered" | "unknown";
  includedUnits?: { amount: number; unit: string };
  otherPlans?: boolean;
}

export function toV1(s: CatalogueServiceV2): ServiceV1 {
  const q = blendQos(s.advertised, s.measured);
  const latencyMs = q.latencyMs;
  const cost = s.synthetic ? undefined : monthlyCost(s.pricing);
  return {
    serviceId: s.serviceId,
    name: s.name,
    description: s.description,
    capability: s.capability,
    price: cost ? Math.round(cost.usd * 100) / 100 : s.pricing.amount,
    uptime: q.uptime,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    dependencies: [],
    constraints: [],
    endpoint: s.endpoint,
    provider: s.provider,
    listPrice: s.pricing.amount,
    priceUnit: s.pricing.unit,
    currency: s.pricing.currency,
    priceBasis: cost ? `estimated USD/month ${cost.assumption}` : `listed price ${s.pricing.unit}`,
    sourceUrl: s.source.url,
    retrievedAt: s.source.retrievedAt,
    qosBasis: q.basis,
    ...(s.synthetic ? { synthetic: true } : {}),
    ...(s.pricing.plan ? { volumeBasis: s.pricing.plan.volume } : {}),
    ...(s.pricing.plan?.included ? { includedUnits: s.pricing.plan.included } : {}),
    ...(s.pricing.plan?.otherPlans ? { otherPlans: true } : {}),
  };
}
