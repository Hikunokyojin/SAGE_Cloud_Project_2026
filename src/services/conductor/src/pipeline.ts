import type {
  Intent,
  Constraint,
  ServiceCandidateWithEvidence,
  Composition,
  ReviewerResult,
  ExplainedBlueprint,
  NegotiationAttempt,
  EscalationExplanation,
  InputGuardAgentOutput,
  Violation,
  UnsatisfiableEscalationInput,
} from "@sage/shared-types";

// One typed method per agent -- both the local (in-process) and Lambda-backed
// invokers implement this same shape, so runPipeline doesn't care which is used.
export interface AgentInvoker {
  inputGuard(input: { requestId: string; rawInput: string }): Promise<InputGuardAgentOutput>;
  intent(input: { requestId: string; rawInput: string }): Promise<Intent>;
  broker(input: {
    requestId: string;
    capability: string;
    constraints: Constraint[];
  }): Promise<ServiceCandidateWithEvidence[]>;
  negotiator(input: {
    requestId: string;
    candidates: ServiceCandidateWithEvidence[];
    constraints: Constraint[];
    iteration: number;
    priorViolations?: Violation[];
  }): Promise<Composition>;
  reviewer(input: {
    requestId: string;
    composition: Composition;
    constraints: Constraint[];
  }): Promise<ReviewerResult>;
  explainer(input: {
    requestId: string;
    composition: Composition;
    negotiationHistory?: NegotiationAttempt[];
  }): Promise<ExplainedBlueprint>;
  explainEscalation(input: {
    requestId: string;
    constraints: Constraint[];
    attempts: NegotiationAttempt[];
  }): Promise<EscalationExplanation>;
  // Live testing found this path was needed: Negotiator finding zero eligible
  // candidates never reaches Reviewer, so it needs its own escalation route to the
  // same Human-in-the-Loop channel -- see reviewer/src/index.ts's escalateUnsatisfiable.
  escalateUnsatisfiable(input: UnsatisfiableEscalationInput): Promise<EscalationExplanation>;
}

export type PipelineResult =
  | { status: "completed"; requestId: string; result: ExplainedBlueprint }
  | { status: "paused_for_review"; requestId: string; escalation: EscalationExplanation }
  | { status: "failed"; requestId: string; error: string };

// Hard safety cap independent of Reviewer's own MAX_RETRIES=3 -- if something ever
// changed Reviewer's behavior, Conductor still refuses to loop forever (spec constraint:
// no unbounded agent retry loops).
const SAFETY_MAX_ATTEMPTS = 5;

// D5: the bounded re-negotiation loop. Each iteration calls Negotiator (which now
// does its own hard-constraint filtering and, from iteration 2 on, excludes whatever
// candidate the prior iteration's Violation named) then Reviewer (which independently
// re-derives pass/fail). Conductor no longer manually promotes "the next alternative"
// itself -- that responsibility now lives entirely in Negotiator, informed by
// Reviewer's structured feedback, per the architecture spec's S5.3/S5.4 division of
// labor.
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

  const history: NegotiationAttempt[] = [];
  let priorViolations: Violation[] | undefined;
  let iteration = 1;

  while (iteration <= SAFETY_MAX_ATTEMPTS) {
    let composition: Composition;
    try {
      composition = await invoker.negotiator({
        requestId,
        candidates,
        constraints: intent.constraints,
        iteration,
        priorViolations,
      });
    } catch (err) {
      // Negotiator throws when no candidate satisfies the mandatory constraints
      // (with or without a prior-violation exclusion) -- a genuine no-valid-solution
      // or constraint-conflict outcome. Found via live testing: this never reaches
      // Reviewer, so without this explicit route it would silently bypass the
      // Human-in-the-Loop escalation path entirely (a bare "failed" status, no SNS
      // notification) -- exactly the kind of unresolved request a human should be
      // notified about. Routed through the same escalation channel as a
      // Reviewer-driven circuit-breaker trip.
      const reason = err instanceof Error ? err.message : "Negotiator Agent failed to produce a composition.";
      const escalation = await invoker.escalateUnsatisfiable({ requestId, constraints: intent.constraints, reason });
      return { status: "paused_for_review", requestId, escalation };
    }

    const reviewResult = await invoker.reviewer({ requestId, composition, constraints: intent.constraints });

    history.push({
      iteration,
      composition,
      reviewerResult: reviewResult,
      timestamp: new Date().toISOString(),
    });

    if (reviewResult.approved) {
      const explained = await invoker.explainer({
        requestId,
        composition: reviewResult.composition,
        negotiationHistory: history,
      });
      return { status: "completed", requestId, result: explained };
    }

    if (reviewResult.escalated) {
      const escalation = await invoker.explainEscalation({
        requestId,
        constraints: intent.constraints,
        attempts: history,
      });
      return { status: "paused_for_review", requestId, escalation };
    }

    priorViolations = reviewResult.violations;
    iteration += 1;
  }

  return {
    status: "failed",
    requestId,
    error: "Reviewer did not approve or escalate within the safety attempt limit.",
  };
}
