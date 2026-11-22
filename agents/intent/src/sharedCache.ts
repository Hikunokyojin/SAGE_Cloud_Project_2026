// Shared Intent cache in DynamoDB, so every Lambda instance gives the same parse for the
// same request (the in-process cache only covers one warm instance). Items expire via a
// DynamoDB TTL. Best-effort: if the table is not configured or a call fails, the agent
// simply asks the model, so the cache can never block a request.
import { createHash } from "node:crypto";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";

const TTL_SECONDS = 7 * 24 * 60 * 60;
let client: DynamoDBClient | undefined;

function table(): string | undefined {
  return process.env.INTENT_CACHE_TABLE_NAME || undefined;
}

function db(): DynamoDBClient {
  return (client ??= new DynamoDBClient({}));
}

// The key covers the model and prompt version too, so changing either never serves a stale parse.
export function cacheKey(normalizedRequest: string, version: string): string {
  return createHash("sha256").update(`${version}\n${normalizedRequest}`).digest("hex");
}

export async function getShared<T>(key: string): Promise<T | undefined> {
  const name = table();
  if (!name) return undefined;
  try {
    const res = await db().send(new GetItemCommand({ TableName: name, Key: { cacheKey: { S: key } } }));
    const item = res.Item;
    if (!item?.parse?.S) return undefined;
    // TTL deletion can lag by hours, so check expiry ourselves as well.
    if (item.expiresAt?.N && Number(item.expiresAt.N) < Math.floor(Date.now() / 1000)) return undefined;
    return JSON.parse(item.parse.S) as T;
  } catch {
    return undefined;
  }
}

export async function putShared(key: string, value: unknown): Promise<void> {
  const name = table();
  if (!name) return;
  try {
    await db().send(
      new PutItemCommand({
        TableName: name,
        Item: {
          cacheKey: { S: key },
          parse: { S: JSON.stringify(value) },
          expiresAt: { N: String(Math.floor(Date.now() / 1000) + TTL_SECONDS) },
        },
      })
    );
  } catch {
    // best-effort
  }
}
