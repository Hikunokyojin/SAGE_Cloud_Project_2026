// Fetches today's list prices for every pick in packages/catalogue/src/importers/picks.ts from
// the providers' official public feeds and writes data/sources/cloud-prices.json (T3.2).
//
//   npm run catalogue:import
//   npm run catalogue:ingest -- data/sources/cloud-prices.json
//
// No keys are needed for AWS or Azure. A pick the feed no longer contains is listed as MISSING
// and the exit code is 1, so a renamed meter is noticed instead of silently dropped.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PICKS, awsUnitPrice, azureUnitPrice, gcpUnitPrice, buildRecord, type PricePick, type UnitPrice } from "../packages/catalogue/src/importers";
import type { CatalogueServiceV2 } from "../packages/catalogue/src";

const OUT_DIR = join(__dirname, "..", "data", "sources");
const today = new Date().toISOString().slice(0, 10);

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": "sage-catalogue-import" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.replace(/key=[^&]+/, "key=REDACTED")}`);
  return res.json();
}

const awsOffers = new Map<string, Promise<any>>();
function awsOfferUrl(offer: string, region = "us-east-1") {
  return `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${offer}/current/${region}/index.json`;
}

async function priceFor(pick: PricePick): Promise<{ price?: UnitPrice; url: string }> {
  const m: any = pick.match;
  if (pick.provider === "aws") {
    const url = awsOfferUrl(m.offer, m.region);
    if (!awsOffers.has(url)) awsOffers.set(url, getJson(url));
    return { price: awsUnitPrice(await awsOffers.get(url), m.usagetype), url };
  }
  if (pick.provider === "azure") {
    const filter = Object.entries(m).map(([k, v]) => `${k} eq '${String(v).replace(/'/g, "''")}'`).join(" and ");
    const url = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`;
    const items: any[] = [];
    for (let next: string | null = url; next; ) {
      const page = await getJson(next);
      items.push(...page.Items);
      next = page.NextPageLink;
    }
    return { price: azureUnitPrice(items, m), url };
  }
  // GCP: the key stays in the environment and never in the recorded source URL.
  const key = process.env.GCP_API_KEY;
  if (!key) throw new Error("GCP_API_KEY is not set (Google Cloud picks skipped)");
  const url = `https://cloudbilling.googleapis.com/v1/services/${m.gcpService}/skus?currencyCode=USD`;
  if (!gcpSkus.has(url)) {
    gcpSkus.set(url, (async () => {
      const skus: any[] = [];
      for (let token = ""; ; ) {
        const page = await getJson(`${url}&pageSize=5000&key=${encodeURIComponent(key)}${token ? `&pageToken=${token}` : ""}`);
        skus.push(...(page.skus ?? []));
        if (!page.nextPageToken) return skus;
        token = page.nextPageToken;
      }
    })());
  }
  return { price: gcpUnitPrice(await gcpSkus.get(url)!, m.skuDescription), url };
}
const gcpSkus = new Map<string, Promise<any[]>>();

async function main() {
  const records: CatalogueServiceV2[] = [];
  const missing: string[] = [];
  for (const pick of PICKS) {
    try {
      const { price, url } = await priceFor(pick);
      if (!price) {
        missing.push(`${pick.serviceId}: no price for ${JSON.stringify(pick.match)}`);
        continue;
      }
      const r = buildRecord(pick, price, url, today);
      records.push(r);
      console.log(`  ${r.serviceId.padEnd(34)} $${r.pricing.amount} ${r.pricing.unit}`);
    } catch (e) {
      missing.push(`${pick.serviceId}: ${(e as Error).message}`);
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, "cloud-prices.json");
  writeFileSync(out, JSON.stringify(records, null, 2) + "\n");
  console.log(`Wrote ${records.length} of ${PICKS.length} services to ${out}.`);
  for (const m of missing) console.log(`  MISSING ${m}`);
  process.exit(missing.length ? 1 : 0);
}

main();
