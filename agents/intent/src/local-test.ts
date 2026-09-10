import { handler } from "./index";

async function run() {
  const result = await handler({
    requestId: "test-123",
    rawInput: "I need a fast image resizer, budget under 5 cents per call",
  });
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);