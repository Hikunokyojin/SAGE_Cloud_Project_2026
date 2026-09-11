import type {
  NegotiatorAgentInput,
  CompositionBlueprint,
  CompositionChoice,
  ServiceCandidate,
} from "@sage/shared-types";

// Deterministic cost/uptime score, normalized against the candidate set for this
// request. Not an LLM call — the same candidates always produce the same score,
// so the composition decision stays reproducible and auditable.
function score(candidate: ServiceCandidate, candidates: ServiceCandidate[]): number {
  const prices = candidates.map((c) => c.price);
  const uptimes = candidates.map((c) => c.uptime);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const minUptime = Math.min(...uptimes);
  const maxUptime = Math.max(...uptimes);

  const normalizedPrice = maxPrice === minPrice ? 0 : (candidate.price - minPrice) / (maxPrice - minPrice);
  const normalizedUptime = maxUptime === minUptime ? 1 : (candidate.uptime - minUptime) / (maxUptime - minUptime);

  // Lower price is better, higher uptime is better — equal weight.
  return 0.5 * (1 - normalizedPrice) + 0.5 * normalizedUptime;
}

export async function handler(input: NegotiatorAgentInput): Promise<CompositionBlueprint> {
  if (input.candidates.length === 0) {
    throw new Error("Negotiator Agent: no candidates to score");
  }

  const choices: CompositionChoice[] = input.candidates
    .map((candidate) => ({
      service: candidate,
      score: score(candidate, input.candidates),
      reason: `price=${candidate.price}, uptime=${candidate.uptime}%`,
    }))
    // Deterministic tie-break so equal scores don't depend on input ordering.
    .sort((a, b) => b.score - a.score || a.service.serviceId.localeCompare(b.service.serviceId));

  const [chosen, ...alternatives] = choices;

  return {
    requestId: input.requestId,
    chosen,
    alternatives,
  };
}
