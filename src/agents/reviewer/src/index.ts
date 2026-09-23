import { randomUUID } from "crypto";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type {
  ReviewerAgentInput,
  ReviewerResult,
  Constraint,
  Violation,
  UnsatisfiableEscalationInput,
  EscalationExplanation,
} from "@sage/shared-types";
import { recordDecision } from "@sage/audit";

// Hard circuit breaker: once iteration reaches this, we escalate to a human
// instead of letting the pipeline retry indefinitely.
const MAX_RETRIES = 3;

let snsClient: SNSClient | null = null;
function getSnsClient(): SNSClient {
  if (!snsClient) {
    snsClient = new SNSClient({ region: process.env.AWS_REGION || "ap-south-1" });
  }
  return snsClient;
}

// D4.4: independent re-derivation, deliberately a separate code path from
// Negotiator's own evaluateConstraint (negotiator/src/index.ts) rather than a
// shared/imported helper -- Reviewer must never trust Negotiator's
// self-reported ScoreBreakdown.constraintStatus, so a defect confined to
// Negotiator's scoring logic cannot also cause Reviewer to erroneously
// approve an invalid selection.
function violatesConstraint(actual: number, constraint: Constraint): boolean {
  switch (constraint.operator) {
    case "lt":
      return !(actual < constraint.value);
    case "lte":
      return !(actual <= constraint.value);
    case "gt":
      return !(actual > constraint.value);
    case "gte":
      return !(actual >= constraint.value);
    case "eq":
      return actual !== constraint.value;
  }
}

function fieldValue(service: { price: number; uptime: number; latencyMs?: number }, field: string): number | undefined {
  if (field === "price") return service.price;
  if (field === "uptime") return service.uptime;
  if (field === "latencyMs") return service.latencyMs;
  return undefined;
}

function findViolations(input: ReviewerAgentInput): Violation[] {
  const service = input.composition.chosen.service;
  const violations: Violation[] = [];

  for (const constraint of input.constraints.filter((c) => c.mandatory)) {
    const actual = fieldValue(service, constraint.field);
    if (actual === undefined || violatesConstraint(actual, constraint)) {
      violations.push({
        constraint: constraint.field,
        actualValue: actual ?? "unavailable",
        requiredValue: constraint.value,
        severity: "hard",
        affectedCandidate: service.serviceId,
        correctiveAction: `select a candidate whose ${constraint.field} ${describeOperator(constraint.operator)} ${constraint.value}, or relax this constraint`,
      });
    }
  }

  return violations;
}

function describeOperator(operator: Constraint["operator"]): string {
  switch (operator) {
    case "lt":
      return "is less than";
    case "lte":
      return "is at most";
    case "gt":
      return "is greater than";
    case "gte":
      return "is at least";
    case "eq":
      return "equals";
  }
}

async function escalate(input: ReviewerAgentInput, violations: Violation[]): Promise<void> {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) {
    throw new Error("Reviewer Agent: SNS_TOPIC_ARN is not set, cannot escalate to Human-in-the-Loop");
  }
  const { service } = input.composition.chosen;
  await getSnsClient().send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: `SAGE: request ${input.requestId} needs human review`,
      Message: `Request ${input.requestId} failed Reviewer Agent validation after ${input.composition.iteration} attempt(s).\nChosen service: ${service.name} (${service.serviceId}), price=${service.price}, uptime=${service.uptime}%${service.latencyMs !== undefined ? `, latency=${service.latencyMs}ms` : ""}\nViolations: ${JSON.stringify(violations)}`,
    })
  );
}

async function finish(input: ReviewerAgentInput, output: ReviewerResult, reasoning: string): Promise<ReviewerResult> {
  try {
    await recordDecision({
      requestId: input.requestId,
      agent: "ReviewerAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning,
      decisionId: output.decisionId,
      parentDecisionId: input.parentDecisionId,
      iteration: output.iteration,
      status: output.approved ? "success" : output.escalated ? "escalated" : "failure",
      constraintStatus: output.approved ? "pass" : "fail",
      score: input.composition.scoreBreakdown,
    });
  } catch (err) {
    console.error("Reviewer Agent: failed to write audit record", err);
  }
  return output;
}

export async function handler(input: ReviewerAgentInput): Promise<ReviewerResult> {
  const iteration = input.composition.iteration;
  const violations = findViolations(input);
  const decisionId = input.decisionId ?? randomUUID();

  if (violations.length === 0) {
    return finish(
      input,
      {
        requestId: input.requestId,
        decisionId,
        approved: true,
        violations: [],
        iteration,
        composition: input.composition,
        escalated: false,
      },
      "Composition independently re-verified against every mandatory constraint; all satisfied."
    );
  }

  if (iteration >= MAX_RETRIES) {
    await escalate(input, violations);
    return finish(
      input,
      {
        requestId: input.requestId,
        decisionId,
        approved: false,
        violations,
        iteration,
        composition: input.composition,
        escalated: true,
      },
      `Circuit breaker tripped at iteration ${iteration} (MAX_RETRIES=${MAX_RETRIES}); escalated to Human-in-the-Loop via SNS. Violations: ${violations.map((v) => v.constraint).join(", ")}.`
    );
  }

  return finish(
    input,
    {
      requestId: input.requestId,
      decisionId,
      approved: false,
      violations,
      iteration,
      composition: input.composition,
      escalated: false,
    },
    `Composition violates ${violations.length} mandatory constraint(s) on iteration ${iteration}: ${violations.map((v) => v.constraint).join(", ")}. Will retry with the violation fed back into re-negotiation.`
  );
}

// Separate Lambda entry point sharing this same bundle (deployed as its own function,
// same pattern as Explainer's handler/explainEscalation split) -- reuses Reviewer's
// existing SNS permission rather than granting it to Conductor or any other role.
//
// Found via live testing (not code review): when Negotiator finds zero candidates
// satisfying the mandatory constraints (a genuine no-valid-solution or
// constraint-conflict outcome), it never reaches this file's handler at all, so the
// normal Reviewer -> SNS escalation path was structurally unreachable for that
// failure mode -- Conductor was returning a bare "failed" status with no
// Human-in-the-Loop notification. This function gives Conductor an escalation path
// for that specific case too, reusing the same SNS topic and Human-in-the-Loop
// channel as a circuit-breaker escalation.
export async function escalateUnsatisfiable(input: UnsatisfiableEscalationInput): Promise<EscalationExplanation> {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) {
    throw new Error("Reviewer Agent: SNS_TOPIC_ARN is not set, cannot escalate to Human-in-the-Loop");
  }

  const constraintsText = input.constraints
    .map((c) => `${c.field} ${describeOperator(c.operator)} ${c.value} (${c.mandatory ? "mandatory" : "optional"})`)
    .join("; ");

  await getSnsClient().send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: `SAGE: request ${input.requestId} needs human review (no valid candidate)`,
      Message: `Request ${input.requestId} could not be satisfied: ${input.reason}.\nRequested constraints: ${constraintsText}`,
    })
  );

  const explanation =
    `No available service could satisfy every requirement at once: ${input.reason}. ` +
    `The constraints requested were: ${constraintsText}. ` +
    `Consider relaxing one of the mandatory constraints above (for example, raising a budget limit or lowering a minimum uptime/latency requirement) and resubmitting the request.`;

  const output: EscalationExplanation = {
    requestId: input.requestId,
    explanation,
    attemptedOptions: [],
  };

  try {
    await recordDecision({
      requestId: input.requestId,
      agent: "ReviewerAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning: `No candidate satisfied the mandatory constraints; escalated to Human-in-the-Loop via SNS without a Negotiator/Reviewer cycle. Reason: ${input.reason}.`,
      decisionId: input.decisionId ?? randomUUID(),
      parentDecisionId: input.parentDecisionId,
      iteration: 0,
      status: "escalated",
      constraintStatus: "fail",
    });
  } catch (err) {
    console.error("Reviewer Agent (unsatisfiable escalation): failed to write audit record", err);
  }

  return output;
}
