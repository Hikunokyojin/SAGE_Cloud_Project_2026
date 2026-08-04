import express from "express";
import type { PipelineState } from "@sage/shared-types";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "sage-conductor" });
});

app.post("/request", (req, res) => {
  const rawInput: string = req.body.text ?? "";

  const placeholderState: PipelineState = {
    requestId: crypto.randomUUID(),
    status: "in_progress",
    currentAgent: "IntentAgent",
    retryCount: 0,
  };

  res.json({ received: rawInput, pipeline: placeholderState });
});

app.listen(PORT, () => {
  console.log(`SAGE conductor listening on port ${PORT}`);
});