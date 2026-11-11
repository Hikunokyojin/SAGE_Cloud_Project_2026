// Real prices from the providers' official, public price feeds (T3.2, DP4 "public sources only"):
//   AWS   Price List bulk offer files   https://pricing.us-east-1.amazonaws.com  (no key)
//   Azure Retail Prices API             https://prices.azure.com/api/retail/prices (no key)
//   GCP   Cloud Billing Catalog API     https://cloudbilling.googleapis.com (free API key, optional)
// These functions are pure: they read an already-fetched response. Fetching lives in
// scripts/catalogue-import.ts so everything here is testable offline.
import type { CatalogueServiceV2 } from "../schema";
export { PICKS } from "./picks";

export interface UnitPrice {
  // US dollars per one unit of `unit`, as the feed states it.
  usd: number;
  unit: string;
  description: string;
}

export type PickMatch =
  | { offer: string; usagetype: string; region?: string }
  | { serviceName: string; productName?: string; skuName?: string; meterName: string; armRegionName: string }
  | { gcpService: string; skuDescription: string };

export interface PricePick {
  provider: "aws" | "azure" | "gcp";
  serviceId: string;
  name: string;
  description: string;
  capability: string;
  endpoint: string;
  // Catalogue unit after scaling, for example "per 1,000,000 requests".
  unit: string;
  // Feed units per catalogue unit (1,000,000 when the feed prices one request).
  scale: number;
  // From the provider's SLA page (slaUrl); the feeds do not carry SLAs.
  uptime: number;
  slaUrl: string;
  match: PickMatch;
}

// ── AWS ──────────────────────────────────────────────────────────────────────
// First paid tier (lowest beginRange with a non-zero price) of the on-demand price for the
// exact usage type; the cheapest such price when several products share the usage type.
export function awsUnitPrice(offer: any, usagetype: string): UnitPrice | undefined {
  let best: UnitPrice | undefined;
  for (const [sku, product] of Object.entries<any>(offer?.products ?? {})) {
    if (product?.attributes?.usagetype !== usagetype) continue;
    for (const term of Object.values<any>(offer?.terms?.OnDemand?.[sku] ?? {})) {
      const paid = Object.values<any>(term.priceDimensions ?? {})
        .map((d) => ({ d, usd: Number(d.pricePerUnit?.USD) }))
        .filter((x) => x.usd > 0)
        .sort((a, b) => Number(a.d.beginRange ?? 0) - Number(b.d.beginRange ?? 0))[0];
      if (paid && (!best || paid.usd < best.usd)) best = { usd: paid.usd, unit: paid.d.unit, description: paid.d.description ?? "" };
    }
  }
  return best;
}

// ── Azure ────────────────────────────────────────────────────────────────────
// "1M" → 1,000,000, "10K" → 10,000, "1 GB/Month" → 1, "100 Hours" → 100.
export function parseAzureQuantity(unitOfMeasure: string): number {
  const m = /^\s*([\d.]+)\s*([KM])?/i.exec(unitOfMeasure ?? "");
  if (!m) return 1;
  const mult = m[2]?.toUpperCase() === "M" ? 1_000_000 : m[2]?.toUpperCase() === "K" ? 1_000 : 1;
  return Number(m[1]) * mult;
}

export function azureUnitPrice(items: any[], match: Record<string, string>): UnitPrice | undefined {
  const hits = items
    .filter((i) => i.type === "Consumption" && i.retailPrice > 0 && (i.currencyCode ?? "USD") === "USD")
    .filter((i) => Object.entries(match).every(([k, v]) => i[k] === v))
    .sort((a, b) => (a.tierMinimumUnits ?? 0) - (b.tierMinimumUnits ?? 0) || a.retailPrice - b.retailPrice);
  const i = hits[0];
  if (!i) return undefined;
  const qty = parseAzureQuantity(i.unitOfMeasure);
  return { usd: i.retailPrice / qty, unit: i.unitOfMeasure, description: `${i.productName} ${i.skuName} ${i.meterName}: $${i.retailPrice} per ${i.unitOfMeasure}` };
}

// ── GCP ──────────────────────────────────────────────────────────────────────
export function gcpUnitPrice(skus: any[], skuDescription: string): UnitPrice | undefined {
  for (const s of skus) {
    if (s.description !== skuDescription) continue;
    const expr = s.pricingInfo?.[0]?.pricingExpression;
    const rate = (expr?.tieredRates ?? [])
      .map((r: any) => ({ r, usd: Number(r.unitPrice?.units ?? 0) + Number(r.unitPrice?.nanos ?? 0) / 1e9 }))
      .filter((x: any) => x.usd > 0)
      .sort((a: any, b: any) => a.r.startUsageAmount - b.r.startUsageAmount)[0];
    if (rate) return { usd: rate.usd, unit: expr.usageUnit, description: `${s.description}: $${rate.usd} per ${expr.usageUnit}` };
  }
  return undefined;
}

// ── Record ───────────────────────────────────────────────────────────────────
const round = (n: number) => Number(n.toPrecision(6));

export function buildRecord(pick: PricePick, price: UnitPrice, sourceUrl: string, retrievedAt: string): CatalogueServiceV2 {
  const provider = { aws: "Amazon Web Services", azure: "Microsoft Azure", gcp: "Google Cloud" }[pick.provider];
  return {
    serviceId: pick.serviceId,
    name: pick.name,
    provider,
    description: pick.description,
    capability: pick.capability,
    endpoint: pick.endpoint,
    pricing: {
      amount: round(price.usd * pick.scale),
      unit: pick.unit,
      currency: "USD",
      notes: `list price, first paid tier; feed says: ${price.description}`.slice(0, 200),
    },
    advertised: { uptime: pick.uptime },
    source: {
      url: sourceUrl,
      retrievedAt,
      terms: `official public price feed; uptime from ${pick.slaUrl}`,
    },
  };
}
