// One-time seed: loads dataset/services.json into MongoDB's sage.services collection.
// Run this before reembed-services.ts, which reads from this same collection to populate
// Qdrant. Deliberately does NOT load broker/.env, for the same reason as
// reembed-services.ts -- this must always write to the real production database via the
// real SSM-stored secret, never a local dev override.
import * as fs from "fs";
import * as path from "path";
import { MongoClient } from "mongodb";
import { resolveSecret } from "@sage/secrets";

interface ServiceSeed {
  serviceId: string;
  name: string;
  description: string;
  capability: string;
  price: number;
  uptime: number;
  latencyMs: number;
  dependencies: string[];
  constraints: string[];
  endpoint: string;
}

async function main() {
  const datasetPath = path.resolve(__dirname, "..", "..", "..", "..", "dataset", "services.json");
  const services: ServiceSeed[] = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  console.log(`Loaded ${services.length} services from ${datasetPath}`);

  const mongoUri = await resolveSecret("MONGO_URI", "/sage/broker/MONGO_URI");
  const mongo = new MongoClient(mongoUri);
  await mongo.connect();

  const collection = mongo.db("sage").collection("services");
  for (const service of services) {
    await collection.updateOne(
      { serviceId: service.serviceId },
      { $set: service },
      { upsert: true }
    );
    console.log(`  upserted ${service.serviceId} (${service.name})`);
  }

  const count = await collection.countDocuments();
  console.log(`Done. sage.services now has ${count} documents.`);
  await mongo.close();
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
