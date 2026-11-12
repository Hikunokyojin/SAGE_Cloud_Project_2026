// RT6: simulates an outage of one live service, then restores it.
//
//   npx tsx scripts/simulate-outage.ts <serviceId> --uptime 95   overwrite its live uptime
//   npx tsx scripts/simulate-outage.ts <serviceId> --restore     put back the catalogue values (toV1)
//
// Writes only that one MongoDB document. Qdrant is untouched: uptime is not embedded.
import * as fs from "fs";
import * as path from "path";
import { MongoClient } from "mongodb";
import { resolveSecret } from "@sage/secrets";
import { toV1, type CatalogueServiceV2 } from "../../../packages/catalogue/src";

async function main() {
  const [serviceId, flag, value] = process.argv.slice(2);
  if (!serviceId || (flag !== "--uptime" && flag !== "--restore")) {
    throw new Error("usage: simulate-outage.ts <serviceId> --uptime <percent> | --restore");
  }
  const mongo = new MongoClient(await resolveSecret("MONGO_URI", "/sage/broker/MONGO_URI"));
  await mongo.connect();
  const services = mongo.db("sage").collection("services");
  const before = await services.findOne({ serviceId });
  if (!before) throw new Error(`${serviceId} is not in sage.services`);

  if (flag === "--uptime") {
    const uptime = Number(value);
    if (!Number.isFinite(uptime) || uptime < 0 || uptime > 100) throw new Error("--uptime needs a percentage");
    await services.updateOne({ serviceId }, { $set: { uptime, qosBasis: "simulated-outage" } });
    console.log(`${serviceId}: uptime ${before.uptime} -> ${uptime} (simulated outage)`);
  } else {
    const all: CatalogueServiceV2[] = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "data", "services.v2.json"), "utf8")
    );
    const record = all.find((s) => s.serviceId === serviceId && !s.synthetic);
    if (!record) throw new Error(`${serviceId} is not a real service in services.v2.json`);
    const v1 = toV1(record);
    await services.updateOne({ serviceId }, { $set: v1 });
    console.log(`${serviceId}: restored (uptime ${before.uptime} -> ${v1.uptime}, qosBasis ${v1.qosBasis})`);
  }
  await mongo.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
