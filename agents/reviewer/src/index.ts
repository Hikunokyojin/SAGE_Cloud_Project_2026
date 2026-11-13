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
import { recordDecision, warmUp } from "@sage/audit";
import { isWarmup, WARMED, USAGE_UNITS } from "@sage/shared-types";
import type { UsageVolume } from "@sage/shared-types";
import { monthlyCost } from "@sage/catalogue/src/normalise";

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

// independent re-derivation, deliberately a separate code path from
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

type Service = ReviewerAgentInput["composition"]["chosen"]["service"];

function fieldValue(service: { price: number; uptime: number; latencyMs?: number }, field: string): number | undefined {
  if (field === "price") return service.price;
  if (field === "uptime") return service.uptime;
  if (field === "latencyMs") return service.latencyMs;
  return undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function listed(s: Service) {
  if (typeof s.listPrice !== "number" || !s.priceUnit || !s.currency) return undefined;
  return { amount: s.listPrice, unit: s.priceUnit, currency: s.currency };
}

// T4.1c (L12): the monthly price recomputed here from the provider's list price, not taken
// from the Negotiator. Undefined when it cannot be recomputed (the stated price is then used).
function independentPrice(s: Service, volume?: UsageVolume): number | undefined {
  const pricing = listed(s);
  if (!pricing) return undefined;
  try {
    const usage = volume && !s.volumeBasis ? { [volume.unit]: volume.amount } : {};
    return round2(monthlyCost(pricing, usage).usd);
  } catch {
    return undefined;
  }
}

// Price of one unit of use, for a limit stated per unit.
function independentUnitPrice(s: Service, price: number): number | undefined {
  if (s.volumeBasis === "quota" && s.includedUnits) return price / s.includedUnits.amount;
  if (s.volumeBasis) return undefined;
  const pricing = listed(s);
  if (!pricing) return undefined;
  try {
    const one = monthlyCost(pricing, Object.fromEntries(USAGE_UNITS.map((u) => [u, 1])));
    const two = monthlyCost(pricing, Object.fromEntries(USAGE_UNITS.map((u) => [u, 2])));
    return one.usd === two.usd ? undefined : one.usd;
  } catch {
    return undefined;
  }
}

function checkService(
  service: Service,
  constraints: Constraint[],
  requiredCategory: string | undefined,
  volume: UsageVolume | undefined,
  label = ""
): Violation[] {
  const violations: Violation[] = [];
  const at = label ? `${label}: ` : "";

  if (requiredCategory && service.capability !== requiredCategory) {
    violations.push({
      constraint: `${at}capability`,
      actualValue: service.capability ?? "unknown",
      requiredValue: requiredCategory,
      severity: "hard",
      affectedCandidate: service.serviceId,
      correctiveAction: `select a candidate in the "${requiredCategory}" category`,
    });
  }

  const recomputed = independentPrice(service, volume);
  if (recomputed !== undefined && Math.abs(recomputed - service.price) > 0.01) {
    violations.push({
      constraint: `${at}price`,
      actualValue: service.price,
      requiredValue: recomputed,
      severity: "hard",
      affectedCandidate: service.serviceId,
      correctiveAction: `the stated price does not match the list price (${service.priceUnit}) at the stated volume; re-price the candidate`,
    });
  }
  const price = recomputed ?? service.price;

  const inc = service.includedUnits;
  if (volume && service.volumeBasis === "quota" && inc && inc.unit === volume.unit && volume.amount > inc.amount) {
    violations.push({
      constraint: `${at}volume`,
      actualValue: inc.amount,
      requiredValue: volume.amount,
      severity: "hard",
      affectedCandidate: service.serviceId,
      correctiveAction: `select a plan that covers ${volume.amount} ${volume.unit} a month`,
    });
  }

  for (const constraint of constraints.filter((c) => c.mandatory)) {
    const perUnit = constraint.per === "unit" && constraint.field === "price";
    const actual = perUnit
      ? independentUnitPrice(service, price)
      : constraint.field === "price"
        ? price
        : fieldValue(service, constraint.field);
    if (actual === undefined || violatesConstraint(actual, constraint)) {
      violations.push({
        constraint: `${at}${perUnit ? "price per unit" : constraint.field}`,
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

// T4.1c: a chain is checked step by step, then its totals are recomputed here and checked
// against the chain-wide limits. A failing total names the step that contributes most.
function checkChain(input: ReviewerAgentInput): Violation[] {
  const chain = input.composition.chain!;
  const steps = input.steps ?? [];
  if (chain.steps.length !== steps.length || chain.steps.some((s, i) => s.capability !== steps[i].capability)) {
    return [
      {
        constraint: "chain",
        actualValue: chain.steps.map((s) => s.capability).join(" > "),
        requiredValue: steps.map((s) => s.capability).join(" > "),
        severity: "hard",
        affectedCandidate: chain.steps[0]?.chosen.service.serviceId ?? "unknown",
        correctiveAction: "compose one service for each requested step, in order",
      },
    ];
  }
  const violations: Violation[] = [];
  const services = chain.steps.map((s) => s.chosen.service);
  services.forEach((svc, i) => {
    violations.push(...checkService(svc, steps[i].constraints, steps[i].requiredCategory, steps[i].volume, `step ${i + 1}`));
  });
  const prices = services.map((svc, i) => independentPrice(svc, steps[i].volume) ?? svc.price);
  const latencies = services.map((svc) => svc.latencyMs);
  const totals: Record<string, number | undefined> = {
    price: round2(prices.reduce((a, b) => a + b, 0)),
    uptime: Math.round(services.reduce((a, svc) => a * (svc.uptime / 100), 1) * 1e6) / 1e4,
    latencyMs: latencies.every((l) => typeof l === "number") ? latencies.reduce((a, l) => a + (l as number), 0) : undefined,
  };
  const worst = (field: string): string => {
    let idx = 0;
    services.forEach((svc, i) => {
      const better =
        field === "uptime"
          ? svc.uptime < services[idx].uptime
          : field === "latencyMs"
            ? (svc.latencyMs ?? 0) > (services[idx].latencyMs ?? 0)
            : prices[i] > prices[idx];
      if (better) idx = i;
    });
    return services[idx].serviceId;
  };
  for (const constraint of input.constraints.filter((c) => c.mandatory && c.per !== "unit")) {
    const actual = totals[constraint.field];
    if (actual === undefined || violatesConstraint(actual, constraint)) {
      violations.push({
        constraint: `chain ${constraint.field}`,
        actualValue: actual ?? "unavailable",
        requiredValue: constraint.value,
        severity: "hard",
        affectedCandidate: worst(constraint.field),
        correctiveAction: `replace the step that contributes most so the chain's total ${constraint.field} ${describeOperator(constraint.operator)} ${constraint.value}`,
      });
    }
  }
  return violations;
}

function findViolations(input: ReviewerAgentInput): Violation[] {
  if (input.composition.chain) return checkChain(input);
  return checkService(input.composition.chosen.service, input.constraints, input.requiredCategory, input.volume);
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
      Subject: snsSubject(`SAGE: request ${input.requestId} needs human review`),
      Message: `Request ${input.requestId} failed Reviewer Agent validation after ${input.composition.iteration} attempt(s).\nChosen service: ${service.name} (${service.serviceId}), price=${service.price}, uptime=${service.uptime}%${service.latencyMs !== undefined ? `, latency=${service.latencyMs}ms` : ""}\nViolations: ${JSON.stringify(violations)}${input.reviewUrl ? `\n\nReview and resolve: ${input.reviewUrl}` : ""}`,
    })
  );
}

async function finish(
  startedAt: number,
  input: ReviewerAgentInput,
  output: ReviewerResult,
  reasoning: string
): Promise<ReviewerResult> {
  try {
    await recordDecision({
      durationMs: Date.now() - startedAt,
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

// SNS rejects a Subject over 100 characters ("Invalid parameter: Subject"), which would
// turn an escalation into a failed request, so every subject is clamped.
const SNS_SUBJECT_LIMIT = 100;
export function snsSubject(text: string): string {
  return text.length <= SNS_SUBJECT_LIMIT ? text : text.slice(0, SNS_SUBJECT_LIMIT - 3) + "...";
}

export async function handler(input: ReviewerAgentInput): Promise<ReviewerResult> {
  if (isWarmup(input)) {
    await warmUp();
    return WARMED as never;
  }
  const startedAt = Date.now();
  const iteration = input.composition.iteration;
  const violations = findViolations(input);
  const decisionId = input.decisionId ?? randomUUID();

  if (violations.length === 0) {
    return finish(
      startedAt,
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
      startedAt,
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
    startedAt,
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
  if (isWarmup(input)) {
    await warmUp();
    return WARMED as never;
  }
  const startedAt = Date.now();
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
      Subject: snsSubject(
        input.kind === "capability_not_in_catalogue"
          ? `SAGE review: ${input.requestId} (not in the catalogue)`
          : `SAGE review: ${input.requestId} (no valid candidate)`
      ),
      Message: `Request ${input.requestId} could not be satisfied: ${input.reason}.\nRequested constraints: ${constraintsText}${input.reviewUrl ? `\n\nReview and resolve: ${input.reviewUrl}` : ""}`,
    })
  );

  // User-facing text: input.reason carries internal error plumbing (e.g. the
  // lambdaInvoker prefix), so it goes only to the SNS message and audit record.
  const explanation = input.kind === "capability_not_in_catalogue"
    ? `The marketplace does not offer this kind of service yet, so the request has been passed to a human reviewer ` +
      `instead of being matched to an unrelated service. Try describing what you need in other words, ` +
      `or ask the marketplace to add this type of service.`
    : input.constraints.length === 0
    ? `No service in the catalog matches this request, so it has been passed to a human reviewer. ` +
      `Try describing the service you need differently, or check whether the marketplace offers it.`
    : `No available service could satisfy every mandatory requirement at once. ` +
    `The constraints requested were: ${constraintsText}. ` +
    `Consider relaxing one of the mandatory constraints above (for example, raising a budget limit or lowering a minimum uptime/latency requirement) and resubmitting the request.`;

  const output: EscalationExplanation = {
    requestId: input.requestId,
    explanation,
    attemptedOptions: [],
  };

  try {
    await recordDecision({
      durationMs: Date.now() - startedAt,
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
