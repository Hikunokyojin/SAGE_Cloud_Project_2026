import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import path from "path";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { runPipeline, resumePipeline } from "./pipeline";
import { resolveSecret } from "@sage/secrets";
import { recordDecision } from "@sage/audit";
import { createReviewService, ResolveError } from "./hitl/service";
import { savePaused, getPaused, markResolved } from "./hitl/store";
import type { AgentInvoker } from "./pipeline";
import { createRateLimiter } from "./rateLimit";
import { createOriginGuard } from "./originGuard";

const app = express();
// Behind API Gateway the visitor address arrives in X-Forwarded-For. Trust exactly one
// proxy hop so req.ip is the entry API Gateway appended, not a value the caller can forge.
app.set("trust proxy", 1);
app.use(cors());
// T2.9: only API Gateway (which adds the secret header) may reach the Conductor.
let originSecret: { value?: string; at: number } | undefined;
app.use(
  createOriginGuard(async () => {
    if (originSecret && (originSecret.value || Date.now() - originSecret.at < 60_000)) return originSecret.value;
    try {
      originSecret = { value: await resolveSecret("ORIGIN_SECRET", "/sage/conductor/ORIGIN_SECRET"), at: Date.now() };
    } catch {
      originSecret = { value: undefined, at: Date.now() };
    }
    return originSecret.value;
  })
);
app.use(express.json());

// Every /request calls two free-tier language-model APIs, so the public endpoint is
// capped: per visitor per hour, and in total per UTC day (override with env vars).
const requestLimiter = createRateLimiter({
  dailyLimit: Number(process.env.DAILY_REQUEST_LIMIT) || 60,
  perClientPerHour: Number(process.env.CLIENT_HOURLY_LIMIT) || 10,
});

const PORT = process.env.PORT || 3001;

// Table name is a fixed literal (see infra/cdk/lib/data-construct.ts), not a
// generated CloudFormation token, so a hardcoded default here keeps a Conductor
// redeploy from needing to touch the EC2 systemd unit's env vars every time --
// AUDIT_TABLE_NAME still overrides it if ever pointed at a different table.
const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME || "agent_decisions";
// @sage/audit reads the table name from the environment.
process.env.AUDIT_TABLE_NAME ??= AUDIT_TABLE_NAME;
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

// Human-in-the-loop (T2.3). The HMAC key for review links lives in SSM; if it is missing
// the pipeline still pauses and alerts, just without a link, and the review routes
// answer 503. A failed lookup is retried after a minute rather than on every request.
let signingKey: { value?: string; at: number } | undefined;
async function getSigningKey(): Promise<string | undefined> {
  if (signingKey && (signingKey.value || Date.now() - signingKey.at < 60_000)) return signingKey.value;
  try {
    signingKey = { value: await resolveSecret("HITL_SIGNING_KEY", "/sage/conductor/HITL_SIGNING_KEY"), at: Date.now() };
  } catch {
    signingKey = { value: undefined, at: Date.now() };
  }
  return signingKey.value;
}

const review = createReviewService({
  signingKey: getSigningKey,
  dashboardUrl: process.env.DASHBOARD_URL || "https://hiz4sheyl5.execute-api.ap-south-1.amazonaws.com/prod/",
  save: savePaused,
  get: getPaused,
  markResolved,
  record: recordDecision,
  rerun: async (requestId, intent, parent) => {
    const invoker = await getInvoker();
    const result = await resumePipeline(requestId, intent, invoker, parent, { reviewUrl: await review.reviewUrl(requestId) });
    if (result.status === "paused_for_review") await review.onPaused(result);
    return result;
  },
});

function sendReviewError(res: express.Response, err: unknown) {
  if (err instanceof ResolveError) return res.status(err.httpStatus).json({ error: err.message });
  console.error("review route failed", err);
  return res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
}

app.get("/requests/:requestId", async (req, res) => {
  try {
    res.status(200).json(await review.view(req.params.requestId, String(req.query.token ?? "")));
  } catch (err) {
    sendReviewError(res, err);
  }
});

app.post("/requests/:requestId/resolve", async (req, res) => {
  try {
    res.status(200).json(await review.resolve(req.params.requestId, req.body));
  } catch (err) {
    sendReviewError(res, err);
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "sage-conductor" });
});

app.post("/request", requestLimiter, async (req, res) => {
  const rawInput: string = req.body.text ?? "";
  const requestId = randomUUID();

  try {
    const invoker = await getInvoker();
    const result = await runPipeline(requestId, rawInput, invoker, { reviewUrl: await review.reviewUrl(requestId) });

    if (result.status === "completed") {
      res.status(200).json(result);
    } else if (result.status === "paused_for_review") {
      // Stored so a human can resume it; a storage failure must not hide the pause.
      await review.onPaused(result).catch((err) => console.error("could not store paused request", err));
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

// Read API for the observability dashboard: returns every
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

// Static observability dashboard (apps/dashboard's Vite build), served at "/" so
// it shares Conductor's HTTPS API Gateway URL -- CloudFront is unavailable to this
// account until AWS verifies it. Registered after the API routes so they always win.
const DASHBOARD_DIR = process.env.DASHBOARD_DIR || path.join(__dirname, "dashboard");
if (existsSync(path.join(DASHBOARD_DIR, "index.html"))) {
  app.use(express.static(DASHBOARD_DIR));
}

app.listen(PORT, () => {
  console.log(`SAGE conductor listening on port ${PORT}`);
});
