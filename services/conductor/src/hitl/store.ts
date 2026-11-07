// Paused requests (T2.3): everything a human needs to resume one, in DynamoDB
// table paused_requests (partition key requestId). A request can be resolved once:
// markResolved is a conditional update that only succeeds while status is "pending".
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import type { Constraint, EscalationExplanation, Intent } from "@sage/shared-types";

export const PAUSED_TABLE_NAME = process.env.PAUSED_TABLE_NAME || "paused_requests";
const TTL_DAYS = 30;

export type PausedStatus = "pending" | "approved" | "rejected" | "rerun";

export interface OfferedService {
  serviceId: string;
  name: string;
  price: number;
  uptime: number;
  latencyMs?: number;
}

export interface Resolution {
  action: "approve" | "reject" | "relax";
  reviewer: string;
  note?: string;
  serviceId?: string;
  constraints?: Constraint[];
  resolvedAt: string;
  decisionId: string;
}

export interface PausedRequest {
  requestId: string;
  status: PausedStatus;
  reason: string;
  intent: Intent;
  candidates: OfferedService[];
  escalation: EscalationExplanation;
  createdAt: string;
  // The escalation's decisionId, so the human decision links into the provenance chain.
  lastDecisionId?: string;
  resolution?: Resolution;
}

let client: DynamoDBClient | undefined;
const db = () => (client ??= new DynamoDBClient({ region: process.env.AWS_REGION || "ap-south-1" }));

export async function savePaused(p: PausedRequest): Promise<void> {
  await db().send(
    new PutItemCommand({
      TableName: PAUSED_TABLE_NAME,
      Item: {
        requestId: { S: p.requestId },
        status: { S: p.status },
        body: { S: JSON.stringify(p) },
        expiresAt: { N: String(Math.floor(Date.now() / 1000) + TTL_DAYS * 86400) },
      },
    })
  );
}

export async function getPaused(requestId: string): Promise<PausedRequest | undefined> {
  const res = await db().send(
    new GetItemCommand({ TableName: PAUSED_TABLE_NAME, Key: { requestId: { S: requestId } } })
  );
  if (!res.Item?.body?.S) return undefined;
  const p = JSON.parse(res.Item.body.S) as PausedRequest;
  p.status = (res.Item.status?.S as PausedStatus) ?? p.status;
  return p;
}

// Returns false when the request was no longer pending (already resolved by someone).
export async function markResolved(requestId: string, resolution: Resolution, status: PausedStatus): Promise<boolean> {
  const current = await getPaused(requestId);
  if (!current) return false;
  const body = JSON.stringify({ ...current, status, resolution });
  try {
    await db().send(
      new UpdateItemCommand({
        TableName: PAUSED_TABLE_NAME,
        Key: { requestId: { S: requestId } },
        UpdateExpression: "SET #s = :s, body = :b",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": { S: status }, ":b": { S: body }, ":pending": { S: "pending" } },
      })
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
