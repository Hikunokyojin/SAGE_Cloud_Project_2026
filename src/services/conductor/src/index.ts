import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { runPipeline } from "./pipeline";
import type { AgentInvoker } from "./pipeline";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Table name is a fixed literal (see src/infra/cdk/lib/data-construct.ts), not a
// generated CloudFormation token, so a hardcoded default here keeps a Conductor
// redeploy from needing to touch the EC2 systemd unit's env vars every time --
// AUDIT_TABLE_NAME still overrides it if ever pointed at a different table.
const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME || "agent_decisions";
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || "ap-south-1" });

// AGENT_INVOKE_MODE selects how Conductor talks to the agents: "local" (default) calls
// each agent's handler in-process for local dev; "lambda" invokes the real deployed
// AWS Lambda functions. pipeline.ts is identical either way.
//
// Loaded lazily (not a top-level import of both modules) because localInvoker.ts
// statically imports all 6 agent packages -- a static import of it would force those
// packages to exist even in "lambda" mode, bloating the EC2 deployment artifact with
// code that's never called there. Cached after first resolution.
let invokerPromise: Promise<AgentInvoker> | null = null;
function getInvoker(): Promise<AgentInvoker> {
  if (!invokerPromise) {
    invokerPromise =
      process.env.AGENT_INVOKE_MODE === "lambda"
        ? import("./lambdaInvoker").then((m) => m.lambdaInvoker)
        : import("./localInvoker").then((m) => m.localInvoker);
  }
  return invokerPromise;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "sage-conductor" });
});

app.post("/request", async (req, res) => {
  const rawInput: string = req.body.text ?? "";
  const requestId = randomUUID();

  try {
    const invoker = await getInvoker();
    const result = await runPipeline(requestId, rawInput, invoker);

    if (result.status === "completed") {
      res.status(200).json(result);
    } else if (result.status === "paused_for_review") {
      res.status(202).json(result);
    } else {
      res.status(422).json(result);
    }
  } catch (err) {
    res.status(500).json({
      requestId,
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

// Read API for the observability dashboard (Milestone 3, tasks 17-18): returns every
// AuditRecord written for a given requestId, ordered oldest-first (matches the table's
// own sort key), with input/output JSON-parsed back from the strings @sage/audit wrote.
app.get("/audit/:requestId", async (req, res) => {
  try {
    const response = await dynamoClient.send(
      new QueryCommand({
        TableName: AUDIT_TABLE_NAME,
        KeyConditionExpression: "requestId = :r",
        ExpressionAttributeValues: { ":r": { S: req.params.requestId } },
        ScanIndexForward: true,
      })
    );

    const steps = (response.Items ?? []).map((item) => ({
      agent: item.agent?.S ?? "",
      timestamp: item.timestamp?.S ?? "",
      reasoning: item.reasoning?.S,
      input: item.input?.S ? JSON.parse(item.input.S) : undefined,
      output: item.output?.S ? JSON.parse(item.output.S) : undefined,
    }));

    res.status(200).json({ requestId: req.params.requestId, steps });
  } catch (err) {
    res.status(500).json({
      requestId: req.params.requestId,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`SAGE conductor listening on port ${PORT}`);
});
