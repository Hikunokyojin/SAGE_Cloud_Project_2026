import { randomUUID } from "node:crypto";
import type {
  NegotiatorAgentInput,
  Composition,
  CompositionChoice,
  ServiceCandidateWithEvidence,
  Constraint,
  ScoreBreakdown,
  ScoreDimensions,
  RejectedCandidate,
} from "@sage/shared-types";
import { CATALOGUE_REFERENCES } from "@sage/shared-types";
import { recordDecision } from "@sage/audit";

// Deterministic scoring algorithm. Still
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


// Step 1: min-max normalization to [0, 1] across the current eligible candidate
// set. When every candidate ties on a dimension, that dimension is fully
// favorable for everyone (matches the earlier tie-handling behavior).
function normalizedDimension(value: number, allValues: number[], higherIsBetter: boolean): number {
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  if (max === min) return 1;
  const raw = (value - min) / (max - min);
  return higherIsBetter ? raw : 1 - raw;
}

// Absolute score in [0, 1] for one dimension, comparable across requests: how far the value
// is from the bound towards the best value in the whole catalogue category. The bound is
// the user's own mandatory limit when they gave one, otherwise the category's worst value.
function absoluteDimension(value: number, best: number, bound: number, lowerIsBetter: boolean): number {
  if (best === bound) return 1;
  const raw = lowerIsBetter ? (bound - value) / (bound - best) : (value - bound) / (best - bound);
  return Math.min(1, Math.max(0, raw));
}

function mandatoryLimit(constraints: Constraint[], field: "price" | "uptime" | "latencyMs"): number | undefined {
  const limit = constraints.find((c) => c.mandatory && c.field === field);
  return typeof limit?.value === "number" ? limit.value : undefined;
}

const FIELD_LABEL: Record<string, string> = { price: "price", uptime: "uptime", latencyMs: "latency" };
const OPERATOR_WORDS: Record<string, string> = { lt: "below", lte: "at most", gt: "above", gte: "at least", eq: "exactly" };

function withUnit(field: string, value: number): string {
  if (field === "price") return `$${value}`;
  if (field === "uptime") return `${value}%`;
  if (field === "latencyMs") return `${value} ms`;
  return String(value);
}

function resolveWeight(
  field: "price" | "uptime" | "latencyMs",
  constraints: Constraint[],
  preferences?: NegotiatorAgentInput["preferences"]
): number {
  const optional = constraints.find((c) => !c.mandatory && c.field === field);
  return optional?.priority ?? preferences?.[field] ?? DEFAULT_WEIGHT;
}

export async function handler(input: NegotiatorAgentInput): Promise<Composition> {
  const startedAt = Date.now();
  if (input.candidates.length === 0) {
    throw new Error("Negotiator Agent: no candidates to score");
  }

  // exclude any candidate a prior iteration's Violation named, so
  // re-negotiation is informed by the specific reason for the prior failure
  // rather than being an undirected retry over the full candidate set.
  const excludedIds = new Set((input.priorViolations ?? []).map((v) => v.affectedCandidate));
  // Category is a hard filter like a mandatory constraint: semantic retrieval returns
  // near neighbours from other categories (e.g. a message queue for an email request),
  // and without this the cheapest/fastest wrong-category candidate would win. A
  // candidate with no recorded category is excluded, conservatively.
  const inRequiredCategory = (c: ServiceCandidateWithEvidence) =>
    !input.requiredCategory || c.capability === input.requiredCategory;

  // Every candidate either passes all hard filters or is recorded with the first rule it
  // failed, so the explanation can say exactly why it was not chosen.
  const rejected: RejectedCandidate[] = [];
  const eligible = input.candidates.filter((c) => {
    const reason = rejectionReason(c);
    if (reason) rejected.push({ serviceId: c.serviceId, name: c.name, reason });
    return !reason;
  });

  function rejectionReason(c: ServiceCandidateWithEvidence): string | undefined {
    if (excludedIds.has(c.serviceId)) return "rejected by the Reviewer on an earlier attempt";
    if (!inRequiredCategory(c)) return `wrong category (${c.capability ?? "unknown"}, needed ${input.requiredCategory})`;
    for (const constraint of input.constraints.filter((k) => k.mandatory)) {
      const actual = fieldValue(c, constraint.field);
      if (actual === undefined) return `no recorded ${constraint.field}`;
      if (!evaluateConstraint(actual, constraint)) {
        const label = FIELD_LABEL[constraint.field] ?? constraint.field;
        const words = OPERATOR_WORDS[constraint.operator] ?? constraint.operator;
        return `${label} ${withUnit(constraint.field, actual)} is not ${words} ${withUnit(constraint.field, constraint.value as number)}`;
      }
    }
    return undefined;
  }

  if (eligible.length === 0) {
    throw new Error(
      "Negotiator Agent: no candidate satisfies the mandatory constraints" +
        (input.requiredCategory ? ` in category "${input.requiredCategory}"` : "") +
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

  const priceWeight = resolveWeight("price", input.constraints, input.preferences);
  const uptimeWeight = resolveWeight("uptime", input.constraints, input.preferences);
  const latencyWeight = latencyDimensionPresent ? resolveWeight("latencyMs", input.constraints, input.preferences) : 0;
  const weights: ScoreDimensions = {
    price: priceWeight,
    uptime: uptimeWeight,
    latency: latencyWeight,
    capability: CAPABILITY_WEIGHT,
  };
  const weightSum = priceWeight + uptimeWeight + latencyWeight + CAPABILITY_WEIGHT;

  // Absolute scoring against fixed catalogue references when the category is known, so a
  // score does not depend on which other candidates are present and a lone survivor does
  // not score 1.000 automatically. Scoring relative to the candidates remains only as a
  // fallback for categories without references.
  const references = input.requiredCategory ? CATALOGUE_REFERENCES[input.requiredCategory] : undefined;
  const basis = references ? "catalogue-references" : "relative-to-candidates";

  function scoreOf(candidate: ServiceCandidateWithEvidence): { dimensions: ScoreDimensions; total: number } {
    let dimensions: ScoreDimensions;
    if (references) {
      dimensions = {
        price: absoluteDimension(
          candidate.price,
          references.price.min,
          mandatoryLimit(input.constraints, "price") ?? references.price.max,
          true
        ),
        uptime: absoluteDimension(
          candidate.uptime,
          references.uptime.max,
          mandatoryLimit(input.constraints, "uptime") ?? references.uptime.min,
          false
        ),
        capability: Math.min(1, Math.max(0, candidate.similarityScore ?? 0)),
      };
      if (latencyDimensionPresent) {
        dimensions.latency = absoluteDimension(
          candidate.latencyMs as number,
          references.latencyMs.min,
          mandatoryLimit(input.constraints, "latencyMs") ?? references.latencyMs.max,
          true
        );
      }
    } else {
      dimensions = {
        price: normalizedDimension(candidate.price, priceValues, false),
        uptime: normalizedDimension(candidate.uptime, uptimeValues, true),
        capability: normalizedDimension(candidate.similarityScore ?? 0, capabilityValues, true),
      };
      if (latencyDimensionPresent) {
        dimensions.latency = normalizedDimension(candidate.latencyMs as number, latencyValues, false);
      }
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
    soleSurvivor: eligible.length === 1,
    basis,
  };

  const output: Composition = {
    requestId: input.requestId,
    chosen,
    alternatives,
    iteration: input.iteration,
    scoreBreakdown,
    rejected,
  };

  try {
    await recordDecision({
      durationMs: Date.now() - startedAt,
      requestId: input.requestId,
      agent: "NegotiatorAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning: `Chose ${chosen.service.name} (score ${chosen.score.toFixed(3)}) over ${alternatives.length} alternative(s) on iteration ${input.iteration}, deterministically -- no LLM call.`,
      decisionId: input.decisionId ?? randomUUID(),
      parentDecisionId: input.parentDecisionId,
      iteration: input.iteration,
      status: "success",
      score: output.scoreBreakdown,
      constraintStatus: output.scoreBreakdown.constraintStatus,
      evidence: chosen.service.evidence,
    });
  } catch (err) {
    console.error("Negotiator Agent: failed to write audit record", err);
  }

  return output;
}
