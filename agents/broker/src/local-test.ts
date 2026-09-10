import "dotenv/config";
import { handler } from "./index";

async function run() {
  const result = await handler({
    requestId: "test-broker-1",
    capability: "fast image resizing service",
    constraints: { maxBudget: 0.05, minUptime: 99.0 },
  });
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);