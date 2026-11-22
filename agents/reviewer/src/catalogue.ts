// L22: the Reviewer reads each chosen service from the catalogue itself, so a figure changed
// on the way (a stale uptime, a list price changed together with the price) is caught instead
// of being re-checked against itself.
import { MongoClient } from "mongodb";
import { resolveSecret } from "@sage/secrets";

// The catalogue fields the Reviewer checks against. Anything else on the service is not used.
export interface CatalogueRecord {
  serviceId: string;
  name?: string;
  price?: number;
  uptime?: number;
  latencyMs?: number;
  capability?: string;
  listPrice?: number;
  priceUnit?: string;
  currency?: string;
  volumeBasis?: "quota" | "unmetered" | "unknown";
  includedUnits?: { amount: number; unit: string };
}

export type CatalogueLookup = (serviceIds: string[]) => Promise<Map<string, CatalogueRecord>>;

let client: MongoClient | null = null;

async function mongoLookup(serviceIds: string[]): Promise<Map<string, CatalogueRecord>> {
  if (!client) client = new MongoClient(await resolveSecret("MONGO_URI", "/sage/broker/MONGO_URI"), { serverSelectionTimeoutMS: 4000 });
  try {
    await client.connect();
  } catch (err) {
    // Drop the failed client so a retry starts a fresh connection.
    const failed = client;
    client = null;
    await failed.close().catch(() => undefined);
    throw err;
  }
  const docs = await client
    .db("sage")
    .collection("services")
    .find({ serviceId: { $in: serviceIds } }, { projection: { _id: 0, embedding: 0 } })
    .toArray();
  return new Map(docs.map((d) => [String(d.serviceId), d as unknown as CatalogueRecord]));
}

let override: CatalogueLookup | null = null;

// Tests (and the fault-injection study) supply their own catalogue.
export function _setCatalogueLookup(fn: CatalogueLookup | null): void {
  override = fn;
}

// The deployed Reviewer sets CATALOGUE_CHECK=mongo. Without it (local runs, unit tests with no
// lookup set) there is no catalogue to read and the check is skipped.
export function catalogueLookup(): CatalogueLookup | null {
  if (override) return override;
  return process.env.CATALOGUE_CHECK === "mongo" ? mongoLookup : null;
}
