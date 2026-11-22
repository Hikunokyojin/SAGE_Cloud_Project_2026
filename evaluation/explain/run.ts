// T4.6 runner: score every live Explainer audit record with the independent faithfulness check.
// Usage: tsx explain/run.ts <scan.json>, where scan.json is
//   aws dynamodb scan --table-name agent_decisions --filter-expression "#a = :a"
//     --expression-attribute-names '{"#a":"agent"}' --expression-attribute-values '{":a":{"S":"ExplainerAgent"}}'
// Optional second argument: the same scan for IntentAgent, to attach each request's text.
// Writes results/t46-faithfulness.json (counts and problem examples) and
// results/t46-rating-sample.json (a fixed sample of explanations for the human rating).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkFaithfulness } from "./faithfulness";

interface Item {
  [k: string]: { S?: string } | undefined;
}
const S = (i: Item, k: string) => i[k]?.S;

const items: Item[] = JSON.parse(readFileSync(process.argv[2], "utf8")).Items;
const requests = new Map<string, string>();
if (process.argv[3]) {
  for (const i of JSON.parse(readFileSync(process.argv[3], "utf8")).Items as Item[]) {
    const raw = JSON.parse(S(i, "input") ?? "{}").rawInput;
    if (typeof raw === "string") requests.set(S(i, "requestId") ?? "", raw);
  }
}
// 2026-11-13T17:26Z: the Explainer stopped putting out-of-1 ranking scores in client text.
const SCORE_FIX = "2026-11-13T17:26:11Z";
type Group = "current (model wording)" | "current (plain facts)" | "after T1.4 (model wording)" | "after T1.4 (plain facts)" | "before T1.4" | "escalation";
const groups: Record<string, { n: number; faithful: number; scoreLeaks: number; examples: unknown[] }> = {};
const sample: unknown[] = [];

for (const item of items) {
  const raw = S(item, "output");
  if (!raw) continue;
  const output = JSON.parse(raw);
  const input = JSON.parse(S(item, "input") ?? "{}");
  if (typeof output.explanation !== "string") continue;
  const current = (S(item, "timestamp") ?? "") > SCORE_FIX;
  const group: Group = output.attemptedOptions
    ? "escalation"
    : current && output.explanationSource === "model"
      ? "current (model wording)"
      : current && output.explanationSource === "facts"
        ? "current (plain facts)"
    : output.explanationSource === "model"
      ? "after T1.4 (model wording)"
      : output.explanationSource === "facts"
        ? "after T1.4 (plain facts)"
        : "before T1.4";
  const r = checkFaithfulness(output.explanation, input);
  const g = (groups[group] ??= { n: 0, faithful: 0, scoreLeaks: 0, examples: [] });
  g.n++;
  if (r.faithful) g.faithful++;
  if (r.scoreLeak) g.scoreLeaks++;
  if (!r.faithful && g.examples.length < 5) g.examples.push({ requestId: S(item, "requestId"), request: requests.get(S(item, "requestId") ?? "") ?? null, problems: r.problems, explanation: output.explanation });
  if (group.startsWith("current") || group === "escalation") {
    sample.push({ id: S(item, "decisionId"), requestId: S(item, "requestId"), request: requests.get(S(item, "requestId") ?? "") ?? null, timestamp: S(item, "timestamp"), group, explanation: output.explanation, chosen: output.chosen?.service?.name ?? null, faithful: r.faithful });
  }
}

// Fixed sample for the human rating: the 20 most recent current-era explanations.
sample.sort((a, b) => String((b as { timestamp: string }).timestamp).localeCompare(String((a as { timestamp: string }).timestamp)));
const results = join(__dirname, "..", "results");
writeFileSync(join(results, "t46-faithfulness.json"), JSON.stringify({ generatedAt: new Date().toISOString(), records: items.length, groups }, null, 2));
writeFileSync(join(results, "t46-rating-sample.json"), JSON.stringify(sample.slice(0, 20), null, 2));
for (const [k, g] of Object.entries(groups)) console.log(`${k}: ${g.faithful}/${g.n} faithful, ${g.scoreLeaks} score leaks`);
