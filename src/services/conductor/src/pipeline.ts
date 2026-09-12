import type {
  Intent,
  IntentConstraints,
  ServiceCandidate,
  CompositionBlueprint,
  ReviewerAgentOutput,
  ExplainedBlueprint,
  EscalationAttempt,
  EscalationExplanation,
  InputGuardAgentOutput,
} from "@sage/shared-types";

// One typed method per agent -- both the local (in-process) and Lambda-backed
// invokers implement this same shape, so runPipeline doesn't care which is used.
export interface AgentInvoker {
  inputGuard(input: { requestId: string; rawInput: string }): Promise<InputGuardAgentOutput>;
  intent(input: { requestId: string; rawInput: string }): Promise<Intent>;
  broker(input: {
    requestId: string;
    capability: string;
    constraints: IntentConstraints;
  }): Promise<ServiceCandidate[]>;
  negotiator(input: {
    requestId: string;
    candidates: ServiceCandidate[];
    constraints: IntentConstraints;
  }): Promise<CompositionBlueprint>;
  reviewer(input: {
    requestId: string;
    blueprint: CompositionBlueprint;
    constraints: IntentConstraints;
    attempt: number;
  }): Promise<ReviewerAgentOutput>;
  explainer(input: { requestId: string; blueprint: CompositionBlueprint }): Promise<ExplainedBlueprint>;
  explainEscalation(input: {
    requestId: string;
    constraints: IntentConstraints;
    attempts: EscalationAttempt[];
  }): Promise<EscalationExplanation>;
}

export type PipelineResult =
  | { status: "completed"; requestId: string; result: ExplainedBlueprint }
  | { status: "paused_for_review"; requestId: string; escalation: EscalationExplanation }
  | { status: "failed"; requestId: string; error: string };

// Hard safety cap independent of Reviewer's own MAX_RETRIES=3 -- if something ever
// changed Reviewer's behavior, Conductor still refuses to loop forever (spec constraint:
// no unbounded agent retry loops).
const SAFETY_MAX_ATTEMPTS = 5;

function violatedConstraintsFor(candidate: ServiceCandidate, constraints: IntentConstraints): string[] {
  const violated: string[] = [];
  if (constraints.maxBudget !== undefined && candidate.price > constraints.maxBudget) {
    violated.push("maxBudget");
  }
  if (constraints.minUptime !== undefined && candidate.uptime < constraints.minUptime) {
    violated.push("minUptime");
  }
  return violated;
}

export async function runPipeline(
  requestId: string,
  rawInput: string,
  invoker: AgentInvoker
): Promise<PipelineResult> {
  const guardResult = await invoker.inputGuard({ requestId, rawInput });

  const intent = await invoker.intent({ requestId, rawInput: guardResult.sanitizedInput });

  const candidates = await invoker.broker({
    requestId,
    capability: intent.capability,
    constraints: intent.constraints,
  });

  if (candidates.length === 0) {
    return { status: "failed", requestId, error: "No candidate services matched this request." };
  }

  let blueprint = await invoker.negotiator({ requestId, candidates, constraints: intent.constraints });

  const attemptsSoFar: EscalationAttempt[] = [];
  let attempt = 1;

  while (attempt <= SAFETY_MAX_ATTEMPTS) {
    const reviewResult = await invoker.reviewer({
      requestId,
      blueprint,
      constraints: intent.constraints,
      attempt,
    });

    if (reviewResult.approved) {
      const explained = await invoker.explainer({ requestId, blueprint: reviewResult.blueprint });
      return { status: "completed", requestId, result: explained };
    }

    attemptsSoFar.push({
      candidate: blueprint.chosen.service,
      violatedConstraints: violatedConstraintsFor(blueprint.chosen.service, intent.constraints),
    });

    if (reviewResult.escalated) {
      const escalation = await invoker.explainEscalation({
        requestId,
        constraints: intent.constraints,
        attempts: attemptsSoFar,
      });
      return { status: "paused_for_review", requestId, escalation };
    }

    const [nextChosen, ...remainingAlternatives] = blueprint.alternatives;
    if (nextChosen) {
      blueprint = { requestId: blueprint.requestId, chosen: nextChosen, alternatives: remainingAlternatives };
    }
    attempt += 1;
  }

  return {
    status: "failed",
    requestId,
    error: "Reviewer did not approve or escalate within the safety attempt limit.",
  };
}
