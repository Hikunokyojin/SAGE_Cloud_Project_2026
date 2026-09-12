import { MongoClient } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { resolveSecret } from "@sage/secrets";
import type { BrokerAgentInput, ServiceCandidate, IntentConstraints } from "@sage/shared-types";

// Deployed Lambda ships the model weights inside node_modules/@huggingface/transformers/.cache
// (pre-downloaded at build time -- see scripts/download-model.js) and must never attempt a
// live fetch to huggingface.co, since the demo shouldn't depend on that being reachable.
// Local dev leaves remote models allowed so the very first `npm run test:local` run can
// populate that cache in the first place.
if (process.env.TRANSFORMERS_OFFLINE === "1") {
  env.allowRemoteModels = false;
}

let mongoClient: MongoClient | null = null;
let qdrantClient: QdrantClient | null = null;
let embedder: FeatureExtractionPipeline | null = null;

interface BrokerSecrets {
  mongoUri: string;
  qdrantUrl: string;
  qdrantApiKey: string;
}

let cachedSecrets: BrokerSecrets | null = null;

async function getSecrets(): Promise<BrokerSecrets> {
  if (!cachedSecrets) {
    cachedSecrets = {
      mongoUri: await resolveSecret("MONGO_URI", "/sage/broker/MONGO_URI"),
      qdrantUrl: await resolveSecret("QDRANT_URL", "/sage/broker/QDRANT_URL"),
      qdrantApiKey: await resolveSecret("QDRANT_API_KEY", "/sage/broker/QDRANT_API_KEY"),
    };
  }
  return cachedSecrets;
}

async function getMongoClient(): Promise<MongoClient> {
  if (!mongoClient) {
    const secrets = await getSecrets();
    mongoClient = new MongoClient(secrets.mongoUri);
  }
  return mongoClient;
}

async function getQdrantClient(): Promise<QdrantClient> {
  if (!qdrantClient) {
    const secrets = await getSecrets();
    qdrantClient = new QdrantClient({ url: secrets.qdrantUrl, apiKey: secrets.qdrantApiKey });
  }
  return qdrantClient;
}

// Bedrock Titan Embed v2 is unreachable for this AWS account (Bedrock model access is
// blocked at the account-standing level -- confirmed with AWS support, not an IAM/region
// issue). Runs a small open-source embedding model locally inside the Lambda instead, via
// onnxruntime-node (its npm package ships every platform's native binary in one install,
// including linux/x64, regardless of the machine it was installed on -- confirmed by
// inspecting node_modules/onnxruntime-node/bin after a Windows install). Model weights are
// bundled into the deployment package at build time (see package.json's build script) so
// a cold start never depends on live internet access to Hugging Face during a demo.
//
// This is a 384-dimension embedding space (all-MiniLM-L6-v2), incompatible with the
// previous 1024-dimension Titan space -- the Qdrant "services" collection was re-seeded
// with this model via scripts/reembed-services.ts, not just pointed at the old vectors.
const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedder) {
    // TS2590 (union type too complex) on pipeline()'s heavily overloaded signature is a
    // known limitation of this library's types, not a real type error -- routing the call
    // through `any` avoids TS trying to resolve every overload against the return type
    // annotation at once. The actual runtime call is unaffected.
    const untypedPipeline = pipeline as (task: string, model: string) => Promise<FeatureExtractionPipeline>;
    embedder = await untypedPipeline("feature-extraction", EMBEDDING_MODEL);
  }
  return embedder;
}

async function embedText(text: string): Promise<number[]> {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

const TOP_N = 5;
const MIN_SIMILARITY = 0.6;

function passesHardConstraints(candidate: ServiceCandidate, constraints: IntentConstraints): boolean {
  if (constraints.maxBudget !== undefined && candidate.price > constraints.maxBudget) return false;
  if (constraints.minUptime !== undefined && candidate.uptime < constraints.minUptime) return false;
  return true;
}

export async function handler(input: BrokerAgentInput): Promise<ServiceCandidate[]> {
  const qdrant = await getQdrantClient();
  const mongo = await getMongoClient();
  await mongo.connect();

  const queryVector = await embedText(input.capability);

  const searchResult = await qdrant.search("services", {
    vector: queryVector,
    limit: TOP_N * 3,
    score_threshold: MIN_SIMILARITY,
  });

  const serviceIds = searchResult.map((r) => String(r.id));

  const db = mongo.db("sage");
  const metadataDocs = await db
    .collection("services")
    .find({ serviceId: { $in: serviceIds } })
    .toArray();

  const metadataById = new Map(metadataDocs.map((doc) => [doc.serviceId, doc]));

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

  return candidates.slice(0, TOP_N);
}
