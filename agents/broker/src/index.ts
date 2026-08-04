import { MongoClient } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BrokerAgentInput, ServiceCandidate, IntentConstraints } from "@sage/shared-types";

let mongoClient: MongoClient | null = null;
let qdrantClient: QdrantClient | null = null;
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "ap-south-1" });

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

function passesHardConstraints(candidate: ServiceCandidate, constraints: IntentConstraints): boolean {
  if (constraints.maxBudget !== undefined && candidate.price > constraints.maxBudget) return false;
  if (constraints.minUptime !== undefined && candidate.uptime < constraints.minUptime) return false;
  return true;
}

async function embedText(text: string): Promise<number[]> {
  const command = new InvokeModelCommand({
    modelId: "amazon.titan-embed-text-v2:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({ inputText: text }),
  });
  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  return responseBody.embedding;
}

export async function handler(input: BrokerAgentInput): Promise<ServiceCandidate[]> {
  const qdrant = getQdrantClient();
  const mongo = getMongoClient();
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