import { MongoClient } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { BrokerAgentInput, ServiceCandidate, IntentConstraints } from "@sage/shared-types";

// Connections are created once per Lambda "warm" instance, not per-request,
// to avoid reconnecting on every invocation.
let mongoClient: MongoClient | null = null;
let qdrantClient: QdrantClient | null = null;

function getMongoClient(): MongoClient {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGO_URI!);
  }
  return mongoClient;
}

function getQdrantClient(): QdrantClient {
  if (!qdrantClient) {
    qdrantClient = new QdrantClient({
      url: process.env.QDRANT_URL!,
      apiKey: process.env.QDRANT_API_KEY!,
    });
  }
  return qdrantClient;
}

const TOP_N = 5;
const MIN_SIMILARITY = 0.6;

// Research-gap-informed design: hard constraints (budget, uptime) are applied
// as a genuine filter, not a soft ranking signal alongside similarity score.
// This directly addresses the gap identified in Papers 6/7/15 — semantic
// search alone cannot enforce a hard price or uptime ceiling.
function passesHardConstraints(candidate: ServiceCandidate, constraints: IntentConstraints): boolean {
  if (constraints.maxBudget !== undefined && candidate.price > constraints.maxBudget) return false;
  if (constraints.minUptime !== undefined && candidate.uptime < constraints.minUptime) return false;
  return true;
}

export async function handler(input: BrokerAgentInput): Promise<ServiceCandidate[]> {
  const qdrant = getQdrantClient();
  const mongo = getMongoClient();
  await mongo.connect();

  // Step 1: semantic search in Qdrant using the capability description.
  // NOTE: embedding generation for the query itself happens via Bedrock's
  // embedding model — wired in Step 7.5 below.
  const queryVector = await embedText(input.capability);

  const searchResult = await qdrant.search("services", {
    vector: queryVector,
    limit: TOP_N * 3, // over-fetch, since hard filtering below will shrink this
    score_threshold: MIN_SIMILARITY,
  });

  const serviceIds = searchResult.map((r) => String(r.id));

  // Step 2: enrich with structured metadata from MongoDB (price, uptime, endpoint)
  const db = mongo.db("sage");
  const metadataDocs = await db
    .collection("services")
    .find({ serviceId: { $in: serviceIds } })
    .toArray();

  const metadataById = new Map(metadataDocs.map((doc) => [doc.serviceId, doc]));

  // Step 3: combine semantic score + structured metadata, then apply hard filters
  const candidates: ServiceCandidate[] = searchResult
    .map((r) => {
      const meta = metadataById.get(String(r.id));
      if (!meta) return null;
      const candidate: ServiceCandidate = {
        serviceId: meta.serviceId,
        name: meta.name,
        description: meta.description,
        price: meta.price,
        uptime: meta.uptime,
        endpoint: meta.endpoint,
        similarityScore: r.score,
      };
      return candidate;
    })
    .filter((c): c is ServiceCandidate => c !== null)
    .filter((c) => passesHardConstraints(c, input.constraints));

  // Step 4: return only the top N after filtering — an empty array is a
  // valid, non-error result (per REQ-BRK-3), not a thrown exception.
  return candidates.slice(0, TOP_N);
}

async function embedText(text: string): Promise<number[]> {
  throw new Error("embedText not yet implemented — see Step 7.5");
}