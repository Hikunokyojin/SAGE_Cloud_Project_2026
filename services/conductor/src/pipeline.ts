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
  StageTiming,
} from "@sage/shared-types";

// One typed method per agent -- both the local (in-process) and Lambda-backed
// invokers implement this same shape, so runPipeline doesn't care which is used.
//
// every call also carries decisionId/parentDecisionId (optional on each
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
    category?: string;
    decisionId?: string;
    parentDecisionId?: string;
  }): Promise<ServiceCandidateWithEvidence[]>;
  negotiator(input: {
    requestId: string;
    candidates: ServiceCandidateWithEvidence[];
    constraints: Constraint[];
    iteration: number;
    priorViolations?: Violation[];
    requiredCategory?: string;
    preferences?: Intent["preferences"];
    decisionId?: string;
    parentDecisionId?: string;
  }): Promise<Composition>;
  reviewer(input: {
    requestId: string;
    composition: Composition;
    constraints: Constraint[];
    requiredCategory?: string;
    reviewUrl?: string;
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

export type PipelineResult = (
  | { status: "completed"; requestId: string; result: ExplainedBlueprint }
  | { status: "paused_for_review"; requestId: string; escalation: EscalationExplanation; review?: ReviewContext }
  | { status: "failed"; requestId: string; error: string }
) & {
  // Wall-clock time of each agent call, in call order (retries appear once per attempt).
  timings?: StageTiming[];
};

// Lambda errors arrive wrapped as "lambdaInvoker: <fn> returned an error: <message>";
// the reviewer only needs the agent's own message.
export function plainReason(message: string): string {
  return message.replace(/^lambdaInvoker: \S+ returned an error: /, "");
}

// What a human reviewer needs to resume a paused request (T2.3). The Conductor stores it.
export interface ReviewContext {
  reason: string;
  intent: Intent;
  candidates: ServiceCandidateWithEvidence[];
  // decisionId of the escalation record, so the human decision links into the chain.
  escalationDecisionId: string;
}

export interface PipelineOptions {
  // Signed link to the review page, put into any escalation email.
  reviewUrl?: string;
}

// Wraps every invoker method so each call's duration is recorded, without changing what
// the call does or returns. Timing lives here, not in the agents, because only the
// Conductor sees the full request including network and Lambda overhead.
function withTimings(invoker: AgentInvoker, timings: StageTiming[]): AgentInvoker {
  const timed = {} as Record<string, unknown>;
  for (const [stage, fn] of Object.entries(invoker) as [string, (arg: unknown) => Promise<unknown>][]) {
    timed[stage] = async (arg: unknown) => {
      const started = Date.now();
      try {
        return await fn(arg);
      } finally {
        timings.push({ stage, durationMs: Date.now() - started });
      }
    };
  }
  return timed as unknown as AgentInvoker;
}

// Hard safety cap independent of Reviewer's own MAX_RETRIES=3 -- if something ever
// changed Reviewer's behavior, Conductor still refuses to loop forever (spec constraint:
// no unbounded agent retry loops).
const SAFETY_MAX_ATTEMPTS = 5;

// the bounded re-negotiation loop. Each iteration calls Negotiator (which now
// does its own hard-constraint filtering and, from iteration 2 on, excludes whatever
// candidate the prior iteration's Violation named) then Reviewer (which independently
// re-derives pass/fail). Conductor no longer manually promotes "the next alternative"
// itself -- that responsibility now lives entirely in Negotiator, informed by
// Reviewer's structured feedback, per the architecture spec's S5.3/S5.4 division of
// labor.
export async function runPipeline(
  requestId: string,
  rawInput: string,
  invoker: AgentInvoker,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const timings: StageTiming[] = [];
  const result = await runStages(requestId, rawInput, withTimings(invoker, timings), options);
  return { ...result, timings };
}

// Resumes a paused request from the Broker onward with an intent a human edited
// (for example relaxed constraints). parentDecisionId is the human decision's id, so
// the provenance chain shows exactly where the person stepped in.
export async function resumePipeline(
  requestId: string,
  intent: Intent,
  invoker: AgentInvoker,
  parentDecisionId: string,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const timings: StageTiming[] = [];
  const result = await fromIntent(requestId, intent, withTimings(invoker, timings), parentDecisionId, options);
  return { ...result, timings };
}

async function runStages(
  requestId: string,
  rawInput: string,
  invoker: AgentInvoker,
  options: PipelineOptions
): Promise<PipelineResult> {
  // decisionId is assigned here, once per stage invocation, and the previous
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

  return fromIntent(requestId, intent, invoker, intentDecisionId, options);
}

async function fromIntent(
  requestId: string,
  intent: Intent,
  invoker: AgentInvoker,
  intentDecisionId: string,
  options: PipelineOptions
): Promise<PipelineResult> {
  const { reviewUrl } = options;
  // Every pause goes through here, so each one carries the same review context.
  const paused = async (
    reason: string,
    candidates: ServiceCandidateWithEvidence[],
    escalate: (decisionId: string) => Promise<EscalationExplanation>
  ): Promise<PipelineResult> => {
    const escalationDecisionId = randomUUID();
    const escalation = await escalate(escalationDecisionId);
    return {
      status: "paused_for_review",
      requestId,
      escalation,
      review: { reason, intent, candidates, escalationDecisionId },
    };
  };

  // A request that fits no catalogue category is unresolved, not "any service will do".
  // Without this check retrieval returns the nearest neighbour from an unrelated category
  // (found live: a request for a database service was answered with a message queue), so
  // it goes straight to a human instead, before any search.
  if (!intent.category) {
    const reason = `capability_not_in_catalogue: "${intent.capability}" does not match any service category in the catalogue`;
    return paused(reason, [], (decisionId) =>
      invoker.escalateUnsatisfiable({
        requestId,
        constraints: intent.constraints,
        kind: "capability_not_in_catalogue",
        reason,
        reviewUrl,
        decisionId,
        parentDecisionId: intentDecisionId,
      })
    );
  }

  const brokerDecisionId = randomUUID();
  const candidates = await invoker.broker({
    requestId,
    capability: intent.capability,
    constraints: intent.constraints,
    category: intent.category,
    decisionId: brokerDecisionId,
    parentDecisionId: intentDecisionId,
  });

  // Retrieval finding nothing is still an unresolved request, so it goes to a human
  // like any other no-valid-solution outcome rather than ending as a bare failure.
  if (candidates.length === 0) {
    const reason = "no matching services were found in the catalog for this request";
    return paused(reason, [], (decisionId) =>
      invoker.escalateUnsatisfiable({
        requestId,
        constraints: intent.constraints,
        reason,
        reviewUrl,
        decisionId,
        parentDecisionId: brokerDecisionId,
      })
    );
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
        requiredCategory: intent.category,
        preferences: intent.preferences,
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
      const parent = lastDecisionId;
      return paused(plainReason(reason), candidates, (decisionId) =>
        invoker.escalateUnsatisfiable({
          requestId,
          constraints: intent.constraints,
          reason,
          reviewUrl,
          decisionId,
          parentDecisionId: parent,
        })
      );
    }

    const reviewerDecisionId = randomUUID();
    const reviewResult = await invoker.reviewer({
      requestId,
      composition,
      constraints: intent.constraints,
      requiredCategory: intent.category,
      reviewUrl,
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
      const reason = `Reviewer rejected ${history.length} attempt(s): ${reviewResult.violations.map((v) => v.constraint).join(", ")}`;
      return paused(reason, candidates, (decisionId) =>
        invoker.explainEscalation({
          requestId,
          constraints: intent.constraints,
          attempts: history,
          decisionId,
          parentDecisionId: reviewerDecisionId,
        })
      );
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
