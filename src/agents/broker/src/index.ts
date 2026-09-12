import { MongoClient } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type { BrokerAgentInput, ServiceCandidate, IntentConstraints } from "@sage/shared-types";

let mongoClient: MongoClient | null = null;
let qdrantClient: QdrantClient | null = null;
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "ap-south-1" });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION || "ap-south-1" });

// Lambda's Environment.Variables can't hold an SSM SecureString directly (CloudFormation
// only resolves {{resolve:ssm-secure:...}} for certain resource properties, not Lambda
// env vars -- confirmed via `cdk synth`'s own template validation, not assumed). So the
// deployed Lambda fetches these at runtime instead; local dev still just uses .env via
// process.env, no SSM call needed there. Cached module-level after first resolution
// (once per cold start), matching how mongoClient/qdrantClient are already cached.
interface BrokerSecrets {
  mongoUri: string;
  qdrantUrl: string;
  qdrantApiKey: string;
}

let cachedSecrets: BrokerSecrets | null = null;

async function fetchFromSsm(parameterName: string): Promise<string> {
  const response = await ssmClient.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
  const value = response.Parameter?.Value;
  if (!value) {
    throw new Error(`Broker Agent: SSM parameter ${parameterName} not found or empty`);
  }
  return value;
}

async function resolveSecret(envVarName: string, ssmParameterName: string): Promise<string> {
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    return fromEnv;
  }
  return fetchFromSsm(ssmParameterName);
}

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
