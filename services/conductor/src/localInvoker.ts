import { handler as inputGuardHandler } from "@sage/agent-input-guard";
import { handler as intentHandler } from "@sage/agent-intent";
import { handler as brokerHandler } from "@sage/agent-broker";
import { handler as negotiatorHandler } from "@sage/agent-negotiator";
import { handler as reviewerHandler, escalateUnsatisfiable as escalateUnsatisfiableHandler } from "@sage/agent-reviewer";
import { handler as explainerHandler, explainEscalation as explainEscalationHandler } from "@sage/agent-explainer";
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
