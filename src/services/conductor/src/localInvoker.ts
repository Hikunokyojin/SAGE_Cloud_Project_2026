import { handler as inputGuardHandler } from "input-guard-agent";
import { handler as intentHandler } from "intent-agent";
import { handler as brokerHandler } from "broker-agent";
import { handler as negotiatorHandler } from "negotiator-agent";
import { handler as reviewerHandler, escalateUnsatisfiable as escalateUnsatisfiableHandler } from "reviewer-agent";
import { handler as explainerHandler, explainEscalation as explainEscalationHandler } from "explainer-agent";
import type { AgentInvoker } from "./pipeline";

// In-process invocation for local development: calls each agent's exported handler
// directly, no network hop, no Lambda deployment required. This is what Conductor
// uses when AGENT_INVOKE_MODE is unset or "local". The Lambda-backed invoker
// (lambdaInvoker.ts) implements the exact same AgentInvoker interface, so switching
// between them at deploy time requires no change to pipeline.ts.
export const localInvoker: AgentInvoker = {
  inputGuard: inputGuardHandler,
  intent: intentHandler,
  broker: brokerHandler,
  negotiator: negotiatorHandler,
  reviewer: reviewerHandler,
  explainer: explainerHandler,
  explainEscalation: explainEscalationHandler,
  escalateUnsatisfiable: escalateUnsatisfiableHandler,
};
