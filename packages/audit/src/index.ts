import { DynamoDBClient, PutItemCommand, QueryCommand, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GENESIS, hashItem, type Item } from "./chain";
export { verifyChain, hashItem, GENESIS } from "./chain";
import type { AuditRecord, DecisionProvenance } from "@sage/shared-types";

// Immutable audit trail writer (extended for decision
// provenance): every agent calls this once per decision, writing to the
// `agent_decisions` DynamoDB table (partition key requestId, sort key timestamp --
// see infra/cdk/lib/data-construct.ts). `input`/`output` are arbitrary
// agent-specific payloads, so they're stored as JSON strings rather than marshalled
// DynamoDB maps -- keeps this writer agent-agnostic and avoids a util-dynamodb
// dependency just for nested unknown shapes.
//
// Accepts the full DecisionProvenance shape (a superset of AuditRecord) so the
// causal chain -- decisionId, parentDecisionId, iteration, score, constraintStatus,
// evidence, status -- is captured per record, letting a full request's decision path
// be reconstructed by following parentDecisionId links. AuditRecord alone is still
// accepted (the DecisionProvenance-only fields are simply omitted from the item) so
// this stays backward compatible with any caller that hasn't adopted provenance yet.
let client: DynamoDBClient | null = null;
function getClient(): DynamoDBClient {
  if (!client) {
    client = new DynamoDBClient({ region: process.env.AWS_REGION || "ap-south-1" });
  }
  return client;
}

// The first record a process writes is treated as its cold start: in a Lambda container
// that is the first invocation, which includes module and model loading.
let firstRecordInProcess = true;
function takeColdStart(): boolean {
  const cold = firstRecordInProcess;
  firstRecordInProcess = false;
  return cold;
}

export async function recordDecision(record: AuditRecord | DecisionProvenance): Promise<void> {
  const tableName = process.env.AUDIT_TABLE_NAME;
  if (!tableName) {
    throw new Error("recordDecision: AUDIT_TABLE_NAME is not set");
  }

  const provenance = record as Partial<DecisionProvenance>;
  const coldStart = provenance.coldStart ?? takeColdStart();

  const item: Item = {
    requestId: { S: record.requestId },
    timestamp: { S: record.timestamp },
    agent: { S: record.agent },
    input: { S: JSON.stringify(record.input) },
    output: { S: JSON.stringify(record.output) },
    ...(record.reasoning !== undefined ? { reasoning: { S: record.reasoning } } : {}),
    ...(provenance.decisionId !== undefined ? { decisionId: { S: provenance.decisionId } } : {}),
    ...(provenance.parentDecisionId !== undefined
      ? { parentDecisionId: { S: provenance.parentDecisionId } }
      : {}),
    ...(provenance.iteration !== undefined ? { iteration: { N: String(provenance.iteration) } } : {}),
    ...(provenance.status !== undefined ? { status: { S: provenance.status } } : {}),
    ...(provenance.constraintStatus !== undefined
      ? { constraintStatus: { S: provenance.constraintStatus } }
      : {}),
    ...(provenance.score !== undefined ? { score: { S: JSON.stringify(provenance.score) } } : {}),
    ...(provenance.evidence !== undefined ? { evidence: { S: JSON.stringify(provenance.evidence) } } : {}),
    ...(provenance.durationMs !== undefined ? { durationMs: { N: String(provenance.durationMs) } } : {}),
    ...(provenance.usage !== undefined ? { usage: { S: JSON.stringify(provenance.usage) } } : {}),
    coldStart: { BOOL: coldStart },
  };
  await writeChained(tableName, item);
}

// Tamper evidence (T2.4): link the record to the request's latest one and store its hash.
// The write is conditional, so an existing record can never be overwritten; on a clash
// (two records in the same millisecond) the timestamp moves on by 1 ms and the link is
// re-read. A request's agents run one after another, so the chain stays linear.
async function writeChained(tableName: string, item: Item): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await getClient().send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "requestId = :r",
        ExpressionAttributeValues: { ":r": { S: item.requestId.S! } },
        ProjectionExpression: "#h",
        ExpressionAttributeNames: { "#h": "hash" },
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      })
    );
    const prevHash = latest?.Items?.[0]?.hash?.S ?? GENESIS;
    const chained: Item = { ...item, prevHash: { S: prevHash } };
    delete chained.hash;
    chained.hash = { S: hashItem(chained) };
    try {
      await getClient().send(
        new PutItemCommand({
          TableName: tableName,
          Item: chained as Record<string, any>,
          ConditionExpression: "attribute_not_exists(requestId)",
        })
      );
      return;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException) || attempt === 2) throw err;
      item = { ...item, timestamp: { S: new Date(Date.parse(item.timestamp.S!) + 1).toISOString() } };
    }
  }
}

// Keep-warm support (T2.6): one cheap read so the DynamoDB connection (TLS, credentials)
// is open before the first real request. Never throws.
export async function warmUp(): Promise<void> {
  const tableName = process.env.AUDIT_TABLE_NAME;
  if (!tableName) return;
  try {
    await getClient().send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "requestId = :r",
        ExpressionAttributeValues: { ":r": { S: "__warmup__" } },
        Limit: 1,
      })
    );
  } catch {
    // best-effort
  }
}
