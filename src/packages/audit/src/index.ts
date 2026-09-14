import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { AuditRecord } from "@sage/shared-types";

// Immutable audit trail writer (Milestone 3, task 15): every agent calls this once per
// decision, writing to the `agent_decisions` DynamoDB table (partition key requestId,
// sort key timestamp -- see src/infra/cdk/lib/data-construct.ts). `input`/`output` are
// arbitrary agent-specific payloads, so they're stored as JSON strings rather than
// marshalled DynamoDB maps -- keeps this writer agent-agnostic and avoids a
// util-dynamodb dependency just for nested unknown shapes.
let client: DynamoDBClient | null = null;
function getClient(): DynamoDBClient {
  if (!client) {
    client = new DynamoDBClient({ region: process.env.AWS_REGION || "ap-south-1" });
  }
  return client;
}

export async function recordDecision(record: AuditRecord): Promise<void> {
  const tableName = process.env.AUDIT_TABLE_NAME;
  if (!tableName) {
    throw new Error("recordDecision: AUDIT_TABLE_NAME is not set");
  }

  await getClient().send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        requestId: { S: record.requestId },
        timestamp: { S: record.timestamp },
        agent: { S: record.agent },
        input: { S: JSON.stringify(record.input) },
        output: { S: JSON.stringify(record.output) },
        ...(record.reasoning !== undefined ? { reasoning: { S: record.reasoning } } : {}),
      },
    })
  );
}
