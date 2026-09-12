import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";
import { runPipeline } from "./pipeline";
import { localInvoker } from "./localInvoker";
import { lambdaInvoker } from "./lambdaInvoker";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// AGENT_INVOKE_MODE selects how Conductor talks to the agents: "local" (default) calls
// each agent's handler in-process for local dev; "lambda" invokes the real deployed
// AWS Lambda functions. pipeline.ts is identical either way.
const invoker = process.env.AGENT_INVOKE_MODE === "lambda" ? lambdaInvoker : localInvoker;

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "sage-conductor" });
});

app.post("/request", async (req, res) => {
  const rawInput: string = req.body.text ?? "";
  const requestId = randomUUID();

  try {
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
