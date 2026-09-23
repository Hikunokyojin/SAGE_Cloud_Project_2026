import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { resolveSecret } from "@sage/secrets";
import type { BrokerAgentInput, ServiceCandidateWithEvidence } from "@sage/shared-types";
import { recordDecision } from "@sage/audit";

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
// 0.6 was tuned for Bedrock Titan Embed v2's score distribution and silently filtered
// out genuinely relevant results once Broker switched to all-MiniLM-L6-v2 (confirmed via
// a real deployed-Lambda test returning [] for an obviously matching query, then measured
// directly: relevant service/query pairs score 0.53-0.67 with this model, irrelevant
// pairs score 0.04-0.23 -- a wide, clean gap). 0.35 sits well inside that gap.
const MIN_SIMILARITY = 0.35;

export async function handler(input: BrokerAgentInput): Promise<ServiceCandidateWithEvidence[]> {
  const qdrant = await getQdrantClient();
  const mongo = await getMongoClient();
  await mongo.connect();

  const queryVector = await embedText(input.capability);

  // Qdrant point IDs must be an unsigned integer or a UUID -- confirmed against the real
  // Qdrant Cloud instance while re-seeding actual data (ApiError 400 "not a valid point
  // ID" when a human-readable serviceId was used directly as the point ID). The point ID
  // is therefore an opaque UUID (see scripts/reembed-services.ts); serviceId travels in
  // the payload instead, so with_payload must be requested.
  const searchResult = await qdrant.search("services", {
    vector: queryVector,
    limit: TOP_N * 3,
    score_threshold: MIN_SIMILARITY,
    with_payload: true,
  });

  const serviceIds = searchResult.map((r) => String((r.payload as { serviceId?: string } | null)?.serviceId));

  const db = mongo.db("sage");
  const metadataDocs = await db
    .collection("services")
    .find({ serviceId: { $in: serviceIds } })
    .toArray();

  const metadataById = new Map(metadataDocs.map((doc) => [doc.serviceId, doc]));
  const retrievedAt = new Date().toISOString();

  const candidates: ServiceCandidateWithEvidence[] = searchResult
    .map((r) => {
      const serviceId = (r.payload as { serviceId?: string } | null)?.serviceId;
      const meta = serviceId ? metadataById.get(serviceId) : undefined;
      if (!meta) return null;
      // D4.2: every candidate carries its retrieval Evidence -- both the semantic
      // match (Qdrant score) and the structured-metadata lookup that supplied the
      // rest of its fields -- so downstream agents and the audit trail can see why
      // it was retrieved, not just that it was.
      const candidate: ServiceCandidateWithEvidence = {
        serviceId: meta.serviceId,
        name: meta.name,
        description: meta.description,
        price: meta.price,
        uptime: meta.uptime,
        latencyMs: typeof meta.latencyMs === "number" ? meta.latencyMs : undefined,
        endpoint: meta.endpoint,
        similarityScore: r.score,
        evidence: [
          { source: "semantic-search", similarityScore: r.score, retrievedAt },
          {
            source: "structured-metadata-store",
            matchedFields: ["price", "uptime", "latencyMs", "endpoint"],
            retrievedAt,
          },
        ],
      };
      return candidate;
    })
    // Broker returns candidates ranked by semantic similarity only. It used to also
    // hard-filter by input.constraints (maxBudget/minUptime) here, using the exact same
    // check Reviewer applies later -- which meant Reviewer could never actually reject
    // anything Broker had already returned, making the retry/escalation path
    // unreachable through the real pipeline (confirmed empirically against the live
    // deployed system, not just in theory). Constraint enforcement now belongs solely
    // to Negotiator (hard filtering) and Reviewer (independent verification), matching
    // the architecture spec's division of labor -- never Broker.
    .filter((c): c is ServiceCandidateWithEvidence => c !== null);

  const output = candidates.slice(0, TOP_N);

  try {
    await recordDecision({
      requestId: input.requestId,
      agent: "BrokerAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning: `Found ${output.length} candidate(s) above similarity threshold ${MIN_SIMILARITY}.`,
      decisionId: input.decisionId ?? randomUUID(),
      parentDecisionId: input.parentDecisionId,
      iteration: 0,
      status: "success",
      evidence: output.flatMap((candidate) => candidate.evidence),
    });
  } catch (err) {
    console.error("Broker Agent: failed to write audit record", err);
  }

  return output;
}
