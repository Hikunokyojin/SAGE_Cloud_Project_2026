// Checks that one request's audit trail has not been altered (T2.4).
//
//   npm run audit:verify <requestId>
//
// Reads every record of the request from agent_decisions in timestamp order and walks
// the hash chain. Exit code 0 = intact, 1 = tampering detected, 2 = usage or read error.
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { verifyChain, type Item } from "../src/chain";

async function main() {
  const requestId = process.argv[2];
  if (!requestId) {
    console.error("usage: npm run audit:verify <requestId>");
    process.exit(2);
  }
  const table = process.env.AUDIT_TABLE_NAME || "agent_decisions";
  const client = new DynamoDBClient({ region: process.env.AWS_REGION || "ap-south-1" });

  const items: Item[] = [];
  let start: Record<string, any> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "requestId = :r",
        ExpressionAttributeValues: { ":r": { S: requestId } },
        ScanIndexForward: true,
        ConsistentRead: true,
        ExclusiveStartKey: start,
      })
    );
    items.push(...((page.Items ?? []) as Item[]));
    start = page.LastEvaluatedKey;
  } while (start);

  if (items.length === 0) {
    console.error(`No audit records found for ${requestId}.`);
    process.exit(2);
  }

  const r = verifyChain(items);
  const legacy = r.unchained ? ` (${r.unchained} older record(s) written before the chain existed were not checked)` : "";
  if (r.ok) {
    console.log(`INTACT: ${r.checked} chained record(s) for ${requestId} verified${legacy}.`);
    process.exit(0);
  }
  const bad = items[r.problem!.index];
  console.log(
    `TAMPERED: record ${r.problem!.index + 1} of ${items.length} (${bad.agent?.S ?? "?"}, ${r.problem!.timestamp ?? "no timestamp"}): ${r.problem!.reason}.`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
