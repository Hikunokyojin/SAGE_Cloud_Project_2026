// Pure metrics for choosing Broker's similarity cut-off from labelled data.
//
// In-catalogue query: retrieval succeeds at threshold t when a service of the right
// category is in the top 5 of that category's services and scores at least t (the
// Broker searches with Intent's category as a filter, so only that category competes).
// Out-of-catalogue query: it is correctly refused at t when its best score over the
// whole catalogue is below t (the case where Intent wrongly picks some category).

export interface ScoredQuery {
  kind: "in" | "out";
  // in: best score among services of the labelled category; out: best score overall.
  best: number;
}

export interface CurvePoint {
  threshold: number;
  recallAt5: number;
  outOfCatalogueRefused: number;
}

export function curve(queries: ScoredQuery[], thresholds: number[]): CurvePoint[] {
  const inQ = queries.filter((q) => q.kind === "in");
  const outQ = queries.filter((q) => q.kind === "out");
  return thresholds.map((t) => ({
    threshold: t,
    recallAt5: inQ.length ? inQ.filter((q) => q.best >= t).length / inQ.length : 1,
    outOfCatalogueRefused: outQ.length ? outQ.filter((q) => q.best < t).length / outQ.length : 1,
  }));
}

// Highest threshold that keeps recall at or above the target; this refuses as many
// out-of-catalogue requests as possible without losing in-catalogue ones.
export function chooseThreshold(points: CurvePoint[], minRecall = 0.95): CurvePoint | undefined {
  return points.filter((p) => p.recallAt5 >= minRecall).sort((a, b) => b.threshold - a.threshold)[0];
}

export function thresholdGrid(from = 0.1, to = 0.8, step = 0.01): number[] {
  const out: number[] = [];
  for (let t = from; t <= to + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
