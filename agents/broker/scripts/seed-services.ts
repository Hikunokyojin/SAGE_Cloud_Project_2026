// Loads the catalogue into MongoDB's sage.services collection. Run this before
// reembed-services.ts, which reads from this same collection to populate Qdrant.
// Deliberately does NOT load broker/.env, for the same reason as reembed-services.ts --
// this must always write to the real production database via the real SSM-stored secret,
// never a local dev override.
//
//   npm run seed-services                     data/services.json (the original 21, v1)
//   npm run seed-services -- --v2             data/services.v2.json, real services only, via toV1
//                                             (estimated USD/month prices, blended QoS)
//   npm run seed-services -- --v2 --prune     ...and delete every other document (the synthetic
//                                             ones), so live search sees only real services
//   add --dry-run to print what would change without writing
import * as fs from "fs";
import * as path from "path";
import { MongoClient } from "mongodb";
import { resolveSecret } from "@sage/secrets";
import { toV1, type CatalogueServiceV2 } from "../../../packages/catalogue/src";

const DATA = path.resolve(__dirname, "..", "..", "..", "data");

function load(v2: boolean): { serviceId: string; name: string }[] {
  if (!v2) return JSON.parse(fs.readFileSync(path.join(DATA, "services.json"), "utf8"));
  const all: CatalogueServiceV2[] = JSON.parse(fs.readFileSync(path.join(DATA, "services.v2.json"), "utf8"));
  return all.filter((s) => !s.synthetic).map(toV1);
}

async function main() {
  const args = process.argv.slice(2);
  const v2 = args.includes("--v2");
  const prune = args.includes("--prune");
  const dryRun = args.includes("--dry-run");
  if (prune && !v2) throw new Error("--prune is only allowed with --v2");

  const services = load(v2);
  console.log(`Loaded ${services.length} services (${v2 ? "v2, real only" : "v1"}).`);

  const mongoUri = await resolveSecret("MONGO_URI", "/sage/broker/MONGO_URI");
  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  const collection = mongo.db("sage").collection("services");

  const keep = new Set(services.map((s) => s.serviceId));
  const existing = (await collection.find({}, { projection: { serviceId: 1 } }).toArray()).map((d) => d.serviceId as string);
  const stale = existing.filter((id) => !keep.has(id));
  console.log(`Currently ${existing.length} documents; ${services.filter((s) => !existing.includes(s.serviceId)).length} new, ${stale.length} not in this catalogue${prune ? " (will be deleted)" : ""}.`);

  if (dryRun) {
    if (prune) console.log(`Would delete: ${stale.join(", ") || "none"}`);
    await mongo.close();
    return;
  }

  for (const service of services) {
    await collection.updateOne({ serviceId: service.serviceId }, { $set: service }, { upsert: true });
  }
  console.log(`Upserted ${services.length} services.`);

  if (prune && stale.length) {
    const r = await collection.deleteMany({ serviceId: { $in: stale } });
    console.log(`Deleted ${r.deletedCount} documents not in the catalogue: ${stale.join(", ")}`);
  }

  console.log(`Done. sage.services now has ${await collection.countDocuments()} documents.`);
  await mongo.close();
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
