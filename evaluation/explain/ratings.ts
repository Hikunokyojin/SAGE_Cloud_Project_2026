// T4.6 human rating: summarise the rating page's `ratings` store (one document per rater,
// { ratings: { <itemId>: { clarity: 1-5, correctness: 1-5 } } }).
// Usage: tsx explain/ratings.ts <folder of exported rating documents>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Scores = Record<string, { clarity?: number; correctness?: number }>;

export function summariseRatings(raters: Scores[]) {
  const out: Record<string, { n: number; mean: number; min: number; max: number }> = {};
  for (const dim of ["clarity", "correctness"] as const) {
    const v = raters.flatMap((r) => Object.values(r).map((x) => x[dim])).filter((x): x is number => typeof x === "number");
    out[dim] = { n: v.length, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN, min: Math.min(...v), max: Math.max(...v) };
  }
  return { raters: raters.length, ...out };
}

if (require.main === module) {
  const dir = process.argv[2];
  const docs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  console.log(JSON.stringify(summariseRatings(docs.map((d) => (d.data ?? d).ratings ?? {})), null, 2));
}
