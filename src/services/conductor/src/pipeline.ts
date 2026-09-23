import { randomUUID } from "node:crypto";
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
//
// D6.1: every call also carries decisionId/parentDecisionId (optional on each
// agent's own input type, see shared-types) -- runPipeline is the sole assigner
// of decisionId (via randomUUID()) and the sole threader of parentDecisionId
// across stages, so each agent's own audit record can be linked into a full
// per-request causal chain without any agent needing to know about its peers.
export interface AgentInvoker {
  inputGuard(input: {
    requestId: string;
    rawInput: string;
    decisionId?: string;
    parentDecisionId?: string;
  }): Promise<InputGuardAgentOutput>;
  intent(input: {
    requestId: string;
    rawInput: string;
    decisionId?: string;
    parentDecisionId?: string;
  }): Promise<Intent>;
  broker(input: {
    requestId: string;
    capability: string;
    constraints: Constraint[];
    decisionId?: string;
    parentDecisionId?: string;
  }): Promise<ServiceCandidateWithEvidence[]>;
  negotiator(input: {
    requestId: string;
    candidates: ServiceCandidateWithEvidence[];
    constraints: Constraint[];
    iteration: number;
    priorViolations?: Violation[];
    decisionId?: string;
    parentDecisionId?: string;
  }): Promise<Composition>;
  reviewer(input: {
    requestId: string;
    composition: Composition;
    constraints: Constraint[];
    decisionId?: string;
    parentDecisionId?: string;
  }): Promise<ReviewerResult>;
  explainer(input: {
    requestId: string;
    composition: Composition;
    negotiationHistory?: NegotiationAttempt[];
    decisionId?: string;
    parentDecisionId?: string;
  }): Promise<ExplainedBlueprint>;
  explainEscalation(input: {
    requestId: string;
    constraints: Constraint[];
    attempts: NegotiationAttempt[];
    decisionId?: string;
    parentDecisionId?: string;
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
  // D6.1: decisionId is assigned here, once per stage invocation, and the previous
  // stage's decisionId is threaded in as parentDecisionId -- the only place in the
  // system that needs to know the pipeline's actual call order.
  const inputGuardDecisionId = randomUUID();
  const guardResult = await invoker.inputGuard({ requestId, rawInput, decisionId: inputGuardDecisionId });

  const intentDecisionId = randomUUID();
  const intent = await invoker.intent({
    requestId,
    rawInput: guardResult.sanitizedInput,
    decisionId: intentDecisionId,
    parentDecisionId: inputGuardDecisionId,
  });

  const brokerDecisionId = randomUUID();
  const candidates = await invoker.broker({
    requestId,
    capability: intent.capability,
    constraints: intent.constraints,
    decisionId: brokerDecisionId,
    parentDecisionId: intentDecisionId,
  });

  if (candidates.length === 0) {
    return { status: "failed", requestId, error: "No candidate services matched this request." };
  }

  const history: NegotiationAttempt[] = [];
  let priorViolations: Violation[] | undefined;
  let iteration = 1;
  // The decisionId of whatever just fed into the next Negotiator call -- Broker's
  // on iteration 1, the prior iteration's Reviewer decision from iteration 2 on.
  let lastDecisionId = brokerDecisionId;

  while (iteration <= SAFETY_MAX_ATTEMPTS) {
    const negotiatorDecisionId = randomUUID();
    let composition: Composition;
    try {
      composition = await invoker.negotiator({
        requestId,
        candidates,
        constraints: intent.constraints,
        iteration,
        priorViolations,
        decisionId: negotiatorDecisionId,
        parentDecisionId: lastDecisionId,
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
      const escalation = await invoker.escalateUnsatisfiable({
        requestId,
        constraints: intent.constraints,
        reason,
        decisionId: randomUUID(),
        parentDecisionId: lastDecisionId,
      });
      return { status: "paused_for_review", requestId, escalation };
    }

    const reviewerDecisionId = randomUUID();
    const reviewResult = await invoker.reviewer({
      requestId,
      composition,
      constraints: intent.constraints,
      decisionId: reviewerDecisionId,
      parentDecisionId: negotiatorDecisionId,
    });
    lastDecisionId = reviewerDecisionId;

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
        decisionId: randomUUID(),
        parentDecisionId: reviewerDecisionId,
      });
      return { status: "completed", requestId, result: explained };
    }

    if (reviewResult.escalated) {
      const escalation = await invoker.explainEscalation({
        requestId,
        constraints: intent.constraints,
        attempts: history,
        decisionId: randomUUID(),
        parentDecisionId: reviewerDecisionId,
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
