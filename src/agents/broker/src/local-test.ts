import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
import { handler } from "./index";

async function run() {
  const result = await handler({
    requestId: "test-broker-1",
    capability: "fast image resizing service",
    constraints: [
      { field: "price", operator: "lte", value: 0.05, mandatory: true },
      { field: "uptime", operator: "gte", value: 99.0, mandatory: true },
    ],
  });
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);