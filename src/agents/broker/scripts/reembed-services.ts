// One-time migration: re-embeds every service in MongoDB's sage.services collection with
// the local MiniLM model and re-populates Qdrant's "services" collection.
//
// Why this is needed: Broker used to embed text via Bedrock Titan Embed v2 (1024
// dimensions). Bedrock is unreachable for this AWS account (see src/index.ts for the full
// story), so Broker now embeds locally via all-MiniLM-L6-v2 (384 dimensions). These are
// different, incompatible vector spaces -- a MiniLM query vector will never meaningfully
// match an existing Titan-embedded point, regardless of how similar the text actually is.
// The whole "services" collection must be re-created with the new dimension and every
// point re-embedded, not just left in place.
//
// What gets embedded: "<name>: <description>" for each service, matching the same shape
// of text a real user capability request looks like (e.g. "fast image resizing service"),
// so the query-time and index-time embeddings live in a comparable semantic space.
//
// Run this from a machine with normal DNS access -- mongodb+srv:// connection strings
// need SRV record lookups, which some sandboxed/firewalled environments block even when
// plain HTTPS works fine.
//
// Deliberately does NOT load broker/.env (unlike local-test.ts): that file holds local
// dev overrides (e.g. a localhost Mongo for testing Broker's code in isolation), and this
// script's whole job is to populate the real production Qdrant collection Broker reads
// from once deployed -- it must always resolve the real secrets from SSM, never silently
// fall back to a local dummy value.
import { MongoClient } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { resolveSecret } from "@sage/secrets";

const COLLECTION_NAME = "services";
const VECTOR_SIZE = 384;

interface ServiceDoc {
  serviceId: string;
  name: string;
  description: string;
  price: number;
  uptime: number;
  endpoint: string;
}

async function embedText(extractor: FeatureExtractionPipeline, text: string): Promise<number[]> {
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

async function main() {
  const mongoUri = await resolveSecret("MONGO_URI", "/sage/broker/MONGO_URI");
  const qdrantUrl = await resolveSecret("QDRANT_URL", "/sage/broker/QDRANT_URL");
  const qdrantApiKey = await resolveSecret("QDRANT_API_KEY", "/sage/broker/QDRANT_API_KEY");

  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  const services = (await mongo
    .db("sage")
    .collection("services")
    .find({})
    .toArray()) as unknown as ServiceDoc[];

  console.log(`Found ${services.length} services in MongoDB.`);
  if (services.length === 0) {
    console.log("Nothing to re-embed. Exiting.");
    await mongo.close();
    return;
  }

  console.log("Loading local embedding model (all-MiniLM-L6-v2)...");
  const untypedPipeline = pipeline as (task: string, model: string) => Promise<FeatureExtractionPipeline>;
  const extractor = await untypedPipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

  const qdrant = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey, checkCompatibility: false });

  console.log(`Re-creating Qdrant collection "${COLLECTION_NAME}" with ${VECTOR_SIZE}-dim cosine vectors...`);
  await qdrant.recreateCollection(COLLECTION_NAME, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
  });

  console.log("Embedding and upserting each service...");
  for (const service of services) {
    const text = `${service.name}: ${service.description}`;
    const vector = await embedText(extractor, text);
    await qdrant.upsert(COLLECTION_NAME, {
      wait: true,
      points: [{ id: service.serviceId, vector }],
    });
    console.log(`  upserted ${service.serviceId} (${service.name})`);
  }

  console.log(`Done. Re-embedded ${services.length} services into "${COLLECTION_NAME}".`);
  await mongo.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
