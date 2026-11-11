// Ingests curated services into the v2 catalogue (T3.1).
//
//   npm run catalogue:ingest -- data/sources/email.csv        merge a curation sheet
//   npm run catalogue:ingest -- --from-v1                       migrate data/services.json
//
// Every record is sanitised (provider-written text cannot carry instructions, markup or
// hidden characters), validated, and merged into data/services.v2.json by serviceId (a new
// record replaces an older one with the same id). The report lists everything that was
// cleaned or refused; the exit code is 1 if any record was refused, so CI can gate on it.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ingest, parseCsv, rowToService, type CatalogueServiceV2 } from "../packages/catalogue/src";

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "data", "services.v2.json");

function fromV1(): CatalogueServiceV2[] {
  const v1 = JSON.parse(readFileSync(join(ROOT, "data", "services.json"), "utf-8")) as any[];
  const today = new Date().toISOString().slice(0, 10);
  return v1.map((s) => ({
    serviceId: s.serviceId,
    name: s.name,
    provider: "Synthetic (project-original)",
    description: s.description,
    capability: s.capability,
    endpoint: s.endpoint,
    pricing: { amount: s.price, unit: "per request", currency: "USD", notes: "synthetic value" },
    advertised: { uptime: s.uptime, ...(typeof s.latencyMs === "number" ? { latencyMs: s.latencyMs } : {}) },
    source: {
      url: "https://github.com/Hikunokyojin/SAGE_Cloud_Project_2026/blob/main/data/services.json",
      retrievedAt: today,
      terms: "project-original synthetic data; endpoints are fictitious example.com addresses",
    },
    synthetic: true,
  }));
}

function load(arg: string): CatalogueServiceV2[] {
  const path = resolve(arg);
  const text = readFileSync(path, "utf-8");
  if (path.endsWith(".csv")) return parseCsv(text).map(rowToService);
  if (path.endsWith(".json")) return JSON.parse(text);
  throw new Error(`Unsupported file type: ${arg} (use .csv or .json)`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: npm run catalogue:ingest -- <sheet.csv|records.json> ... | --from-v1");
    process.exit(2);
  }
  const incoming = args.flatMap((a) => (a === "--from-v1" ? fromV1() : load(a)));
  const report = ingest(incoming);

  const existing: CatalogueServiceV2[] = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf-8")) : [];
  const byId = new Map(existing.map((s) => [s.serviceId, s]));
  for (const s of report.accepted) byId.set(s.serviceId, s);
  const merged = [...byId.values()].sort((a, b) => a.capability.localeCompare(b.capability) || a.serviceId.localeCompare(b.serviceId));
  writeFileSync(OUT, JSON.stringify(merged, null, 2) + "\n");

  console.log(`Read ${incoming.length}; accepted ${report.accepted.length}; refused ${report.rejected.length}.`);
  console.log(`Catalogue now has ${merged.length} services (${merged.filter((s) => !s.synthetic).length} real) in ${OUT}.`);
  for (const c of report.cleaned) console.log(`  cleaned ${c.serviceId}.${c.field}: ${c.changes.join(", ")}`);
  for (const r of report.rejected) console.log(`  REFUSED ${r.serviceId}: ${r.problems.join("; ")}`);
  process.exit(report.rejected.length ? 1 : 0);
}

main();
