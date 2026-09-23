import type {
  NegotiatorAgentInput,
  Composition,
  CompositionChoice,
  ServiceCandidateWithEvidence,
  Constraint,
  ScoreBreakdown,
  ScoreDimensions,
} from "@sage/shared-types";
import { recordDecision } from "@sage/audit";

// D4.3: formalized deterministic scoring algorithm (architecture spec S8). Still
// no LLM call anywhere in this file -- the same candidates, constraints, and prior
// violations always produce the same composition.

const DEFAULT_WEIGHT = 1;
const CAPABILITY_WEIGHT = 0.5; // fixed secondary factor: strength of the semantic match

function evaluateConstraint(actual: number, constraint: Constraint): boolean {
  switch (constraint.operator) {
    case "lt":
      return actual < constraint.value;
    case "lte":
      return actual <= constraint.value;
    case "gt":
      return actual > constraint.value;
    case "gte":
      return actual >= constraint.value;
    case "eq":
      return actual === constraint.value;
  }
}

function fieldValue(candidate: ServiceCandidateWithEvidence, field: string): number | undefined {
  if (field === "price") return candidate.price;
  if (field === "uptime") return candidate.uptime;
  if (field === "latencyMs") return candidate.latencyMs;
  return undefined;
}

// Step 4 of S8: apply every mandatory constraint as a hard exclusion filter --
// a candidate failing a mandatory constraint is excluded outright, not penalized.
// A candidate missing the relevant field (e.g. no latencyMs on record) is treated
// as failing a mandatory constraint on that field, conservatively.
function passesMandatoryConstraints(candidate: ServiceCandidateWithEvidence, constraints: Constraint[]): boolean {
  for (const constraint of constraints.filter((c) => c.mandatory)) {
    const actual = fieldValue(candidate, constraint.field);
    if (actual === undefined || !evaluateConstraint(actual, constraint)) return false;
  }
  return true;
}

// Step 1: min-max normalization to [0, 1] across the current eligible candidate
// set. When every candidate ties on a dimension, that dimension is fully
// favorable for everyone (matches the pre-D4 tie-handling behavior).
function normalizedDimension(value: number, allValues: number[], higherIsBetter: boolean): number {
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  if (max === min) return 1;
  const raw = (value - min) / (max - min);
  return higherIsBetter ? raw : 1 - raw;
}

function resolveWeight(field: "price" | "uptime" | "latencyMs", constraints: Constraint[]): number {
  const optional = constraints.find((c) => !c.mandatory && c.field === field);
  return optional?.priority ?? DEFAULT_WEIGHT;
}

export async function handler(input: NegotiatorAgentInput): Promise<Composition> {
  if (input.candidates.length === 0) {
    throw new Error("Negotiator Agent: no candidates to score");
  }

  // D5: exclude any candidate a prior iteration's Violation named, so
  // re-negotiation is informed by the specific reason for the prior failure
  // rather than being an undirected retry over the full candidate set.
  const excludedIds = new Set((input.priorViolations ?? []).map((v) => v.affectedCandidate));
  const eligible = input.candidates.filter(
    (c) => !excludedIds.has(c.serviceId) && passesMandatoryConstraints(c, input.constraints)
  );

  if (eligible.length === 0) {
    throw new Error(
      "Negotiator Agent: no candidate satisfies the mandatory constraints" +
        (excludedIds.size > 0 ? ` after excluding ${excludedIds.size} previously-failed candidate(s)` : "")
    );
  }

  // Step 1-3 of S8: normalize each dimension across the eligible set, apply
  // weights (a user-specified optional-preference priority overrides the
  // default), sum the weighted contributions.
  const latencyDimensionPresent = eligible.every((c) => typeof c.latencyMs === "number");
  const priceValues = eligible.map((c) => c.price);
  const uptimeValues = eligible.map((c) => c.uptime);
  const latencyValues = latencyDimensionPresent ? eligible.map((c) => c.latencyMs as number) : [];
  const capabilityValues = eligible.map((c) => c.similarityScore ?? 0);

  const priceWeight = resolveWeight("price", input.constraints);
  const uptimeWeight = resolveWeight("uptime", input.constraints);
  const latencyWeight = latencyDimensionPresent ? resolveWeight("latencyMs", input.constraints) : 0;
  const weights: ScoreDimensions = {
    price: priceWeight,
    uptime: uptimeWeight,
    latency: latencyWeight,
    capability: CAPABILITY_WEIGHT,
  };
  const weightSum = priceWeight + uptimeWeight + latencyWeight + CAPABILITY_WEIGHT;

  function scoreOf(candidate: ServiceCandidateWithEvidence): { dimensions: ScoreDimensions; total: number } {
    const dimensions: ScoreDimensions = {
      price: normalizedDimension(candidate.price, priceValues, false),
      uptime: normalizedDimension(candidate.uptime, uptimeValues, true),
      capability: normalizedDimension(candidate.similarityScore ?? 0, capabilityValues, true),
    };
    if (latencyDimensionPresent) {
      dimensions.latency = normalizedDimension(candidate.latencyMs as number, latencyValues, false);
    }
    const total =
      (dimensions.price * priceWeight +
        dimensions.uptime * uptimeWeight +
        (dimensions.latency ?? 0) * latencyWeight +
        (dimensions.capability ?? 0) * CAPABILITY_WEIGHT) /
      weightSum;
    return { dimensions, total };
  }

  // Step 5: select the highest-scoring valid candidate, deterministic
  // tie-break by serviceId so equal scores don't depend on input ordering.
  const scored = eligible
    .map((candidate) => ({ candidate, ...scoreOf(candidate) }))
    .sort((a, b) => b.total - a.total || a.candidate.serviceId.localeCompare(b.candidate.serviceId));

  const [best, ...rest] = scored;

  const toChoice = (entry: (typeof scored)[number]): CompositionChoice => ({
    service: entry.candidate,
    score: entry.total,
    reason: `price=${entry.candidate.price}, uptime=${entry.candidate.uptime}%${
      entry.candidate.latencyMs !== undefined ? `, latency=${entry.candidate.latencyMs}ms` : ""
    }`,
  });

  const chosen = toChoice(best);
  const alternatives = rest.map(toChoice);

  // Step 6: emit the full per-dimension score breakdown alongside the
  // selection -- the basis for the choice is fully recoverable, not just the
  // final aggregate score. constraintStatus/violatedConstraints here are
  // self-reported (mandatory constraints only, since eligible already passed
  // them) -- Reviewer never trusts this and re-derives independently.
  const scoreBreakdown: ScoreBreakdown = {
    requestId: input.requestId,
    candidateId: best.candidate.serviceId,
    dimensions: best.dimensions,
    weights,
    totalScore: best.total,
    constraintStatus: "pass",
    violatedConstraints: [],
  };

  const output: Composition = {
    requestId: input.requestId,
    chosen,
    alternatives,
    iteration: input.iteration,
    scoreBreakdown,
  };

  try {
    await recordDecision({
      requestId: input.requestId,
      agent: "NegotiatorAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning: `Chose ${chosen.service.name} (score ${chosen.score.toFixed(3)}) over ${alternatives.length} alternative(s) on iteration ${input.iteration}, deterministically -- no LLM call.`,
    });
  } catch (err) {
    console.error("Negotiator Agent: failed to write audit record", err);
  }

  return output;
}
