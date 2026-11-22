// T4.1e: the approved chain as table rows and a dependency graph laid out in columns
// (a step sits one column right of the deepest step it uses).

interface ChosenLike {
  service: { serviceId: string; name: string; price: number; uptime: number; latencyMs?: number; volumeNote?: string };
}

export interface ChainResult {
  chosen: ChosenLike;
  chain?: {
    steps: { capability: string; chosen: ChosenLike; dependsOn: number[] }[];
    totals: { price: number; uptime: number; latencyMs?: number };
    combinationsCompared: number;
    combinationsValid: number;
    edges?: { from: string; to: string }[];
  };
}

export interface StepRow {
  step: number;
  capability: string;
  name: string;
  price: string;
  uptime: string;
  latency?: string;
  note?: string;
  // Step numbers (1-based) whose output this step uses.
  uses: number[];
}

export interface ChainView {
  steps: StepRow[];
  columns: StepRow[][];
  totals: string;
}

export function chainView(result: ChainResult): ChainView | null {
  const chain = result.chain;
  if (!chain) return null;
  const steps: StepRow[] = chain.steps.map((s, i) => {
    const svc = s.chosen.service;
    const row: StepRow = {
      step: i + 1,
      capability: s.capability,
      name: svc.name,
      price: `$${svc.price.toFixed(2)}`,
      uptime: `${svc.uptime}%`,
      uses: s.dependsOn.map((d) => d + 1),
    };
    if (svc.latencyMs !== undefined) row.latency = `${svc.latencyMs} ms`;
    if (svc.volumeNote) row.note = svc.volumeNote;
    return row;
  });

  // Steps only depend on earlier steps (Intent guarantees it), so one pass sets every depth.
  const depth: number[] = [];
  chain.steps.forEach((s, i) => {
    depth[i] = s.dependsOn.reduce((d, p) => Math.max(d, (depth[p] ?? 0) + 1), 0);
  });
  const columns: StepRow[][] = [];
  steps.forEach((row, i) => {
    (columns[depth[i]] ??= []).push(row);
  });

  const t = chain.totals;
  const totals =
    `$${t.price.toFixed(2)} a month, ${t.uptime}% combined uptime` +
    `${t.latencyMs !== undefined ? `, ${t.latencyMs} ms total latency` : ""}` +
    `; ${chain.combinationsValid} of ${chain.combinationsCompared} combinations met every limit`;
  return { steps, columns: columns.filter(Boolean), totals };
}
