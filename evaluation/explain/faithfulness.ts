// T4.6: an explanation-faithfulness metric that does not trust the Explainer's own fact sheet.
//
// Each check reads the raw decision the Explainer was given (its audit-record input) and the
// text the client actually saw. A number in the text must come from that decision (directly or
// rounded); an internal ranking score must never be shown; the chosen service(s) and every
// rejected candidate must be named; "no alternatives" must not be claimed when there were some.

// Ranking internals: written to the audit trail, never meant for the client.
const INTERNAL_KEYS = new Set(["score", "similarityScore", "totalScore", "dimensions", "weights", "evidence"]);
// Bookkeeping numbers that are not facts about a service.
const IGNORED_KEYS = new Set(["iteration", "retrievedAt", "timestamp", "requestId", "decisionId", "parentDecisionId", "endpoint", "serviceId"]);

// Thousands may be grouped with commas or (thin/no-break) spaces: "10,000", "10 000".
const NUMBER = /\d{1,3}(?:[,\u00a0\u202f ]\d{3})+(?:\.\d+)?(?!\d)|\d+(?:\.\d+)?/g;

export function numbersIn(text: string): number[] {
  return (text.match(NUMBER) ?? []).map((s) => Number(s.replace(/[,   ]/g, ""))).filter((n) => Number.isFinite(n));
}

interface Collected {
  facts: number[];
  internal: number[];
}

function collect(value: unknown, internal: boolean, out: Collected): void {
  if (typeof value === "number") (internal ? out.internal : out.facts).push(value);
  else if (typeof value === "string") {
    if (!internal) out.facts.push(...numbersIn(value));
  } else if (Array.isArray(value)) value.forEach((v) => collect(v, internal, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (IGNORED_KEYS.has(k)) continue;
      collect(v, internal || INTERNAL_KEYS.has(k), out);
    }
  }
}

// n "comes from" a if it is a, or a rounded to 0-4 decimals, or a as a percentage (0.999 -> 99.9).
function matches(n: number, a: number): boolean {
  for (const x of [a, a * 100]) {
    if (Math.abs(n - x) < 1e-9) return true;
    for (let d = 0; d <= 4; d++) if (Math.abs(n - Number(x.toFixed(d))) < 1e-9) return true;
  }
  return false;
}

export interface FaithfulnessResult {
  faithful: boolean;
  problems: string[];
  scoreLeak: boolean;
}

interface Named {
  name: string;
}

export interface DecisionInput {
  composition?: {
    chosen?: { service?: Named };
    alternatives?: { service?: Named }[];
    rejected?: Named[];
    chain?: { steps?: { chosen?: { service?: Named } }[] };
  };
  attempts?: { composition?: { chosen?: { service?: Named } } }[];
}

export function checkFaithfulness(text: string, input: DecisionInput): FaithfulnessResult {
  const problems: string[] = [];
  const c: Collected = { facts: [], internal: [] };
  collect(input, false, c);
  // Small counts ("two alternatives", "3 steps") are allowed up to the number of services involved.
  const services =
    (input.composition?.alternatives?.length ?? 0) + (input.composition?.rejected?.length ?? 0) + (input.attempts?.length ?? 0) + (input.composition?.chain?.steps?.length ?? 0) + 1;
  let scoreLeak = false;
  for (const n of numbersIn(text)) {
    if (c.facts.some((a) => matches(n, a))) continue;
    if (Number.isInteger(n) && n <= services) continue;
    if (c.internal.some((a) => n !== 0 && n !== 1 && matches(n, a))) {
      scoreLeak = true;
      problems.push(`internal score ${n} shown to the client`);
    } else problems.push(`number ${n} is not in the decision`);
  }

  const lower = text.toLowerCase();
  const chosen = input.composition?.chain?.steps?.length
    ? input.composition.chain.steps.map((s) => s.chosen?.service?.name)
    : [input.composition?.chosen?.service?.name];
  for (const name of chosen) if (name && !lower.includes(name.toLowerCase())) problems.push(`chosen service ${name} is not named`);
  const rejected = input.composition?.rejected ?? [];
  for (const r of rejected) if (!lower.includes(r.name.toLowerCase())) problems.push(`rejected candidate ${r.name} is not named`);
  for (const a of input.attempts ?? []) {
    const name = a.composition?.chosen?.service?.name;
    if (name && !lower.includes(name.toLowerCase())) problems.push(`attempted service ${name} is not named`);
  }
  const others = rejected.length + (input.composition?.alternatives?.length ?? 0);
  if (others > 0 && /\bno (?:other )?alternatives?\b|\bno other options?\b/i.test(text)) {
    problems.push("claims there were no alternatives, but there were");
  }
  return { faithful: problems.length === 0, problems, scoreLeak };
}
