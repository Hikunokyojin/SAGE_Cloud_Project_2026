import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";
import { runPipeline } from "./pipeline";
import type { AgentInvoker } from "./pipeline";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

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

app.listen(PORT, () => {
  console.log(`SAGE conductor listening on port ${PORT}`);
});
