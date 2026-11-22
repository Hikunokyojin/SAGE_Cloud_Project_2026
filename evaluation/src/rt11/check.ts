// RT11 (T4.1f): run an approved chain against sandbox endpoints in dependency order, and
// check a case's outcome against its expected steps and end-to-end limits. The totals are
// recomputed here from the chosen services, not taken from the pipeline.

export interface ChainLike {
  steps: {
    capability: string;
    chosen: { service: { serviceId: string; name: string; price: number; uptime: number; latencyMs?: number; capability?: string } };
    dependsOn: number[];
  }[];
  totals: { price: number; uptime: number; latencyMs?: number };
  edges?: { from: string; to: string }[];
}

export interface Rt11Case {
  id: string;
  text: string;
  // Expected catalogue category of each step, in order.
  steps: string[];
  // End-to-end limits stated in the text: price at most, uptime at least, latency at most.
  limits: { price?: number; uptime?: number; latencyMs?: number };
  // "refused": no chain can meet the limits, so the right outcome is a pause for review.
  expect?: "approved" | "refused";
}

export interface StepRun {
  step: number;
  category: string;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface ChainRun {
  ok: boolean;
  steps: StepRun[];
}

export type CallSandbox = (category: string, inputs: string[]) => Promise<{ ok: boolean; output: string }>;

const categoryOf = (s: ChainLike["steps"][number]) => s.chosen.service.capability ?? s.capability;

// Steps only depend on earlier steps, so running them in order respects every edge.
export async function executeChain(chain: ChainLike, call: CallSandbox): Promise<ChainRun> {
  const steps: StepRun[] = [];
  for (const [i, s] of chain.steps.entries()) {
    const category = categoryOf(s);
    const failed = s.dependsOn.find((d) => !steps[d]?.ok);
    if (failed !== undefined) {
      steps.push({ step: i + 1, category, ok: false, error: `dependency step ${failed + 1} failed` });
      continue;
    }
    try {
      const r = await call(category, s.dependsOn.map((d) => steps[d].output ?? ""));
      steps.push({ step: i + 1, category, ok: r.ok, output: r.output, ...(r.ok ? {} : { error: "sandbox call failed" }) });
    } catch (err) {
      steps.push({ step: i + 1, category, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: steps.every((s) => s.ok), steps };
}

export interface PipelineOutcome {
  status?: string;
  result?: { chain?: ChainLike };
}

export function checkCase(c: Rt11Case, outcome: PipelineOutcome, run: ChainRun | undefined): { pass: boolean; problems: string[] } {
  const problems: string[] = [];
  const chain = outcome.result?.chain;

  if (c.expect === "refused") {
    if (chain) problems.push("expected a refusal, but a chain was approved");
    else if (outcome.status !== "paused_for_review") problems.push(`expected a refusal, got status ${outcome.status}`);
    return { pass: problems.length === 0, problems };
  }

  if (outcome.status !== "completed" || !chain) {
    problems.push(`no chain was approved (status ${outcome.status})`);
    return { pass: false, problems };
  }

  const got = chain.steps.map(categoryOf).join(" > ");
  const want = c.steps.join(" > ");
  if (got !== want) problems.push(`steps were ${got}, expected ${want}`);
  if (!run?.ok) problems.push("the chain did not run end to end against the sandbox");

  const services = chain.steps.map((s) => s.chosen.service);
  const price = Math.round(services.reduce((a, s) => a + s.price, 0) * 100) / 100;
  const uptime = Math.round(services.reduce((a, s) => a * (s.uptime / 100), 1) * 1e6) / 1e4;
  const latencies = services.map((s) => s.latencyMs);
  const latency = latencies.every((l) => typeof l === "number")
    ? latencies.reduce<number>((a, l) => a + (l as number), 0)
    : undefined;

  if (c.limits.price !== undefined && price > c.limits.price) problems.push(`total price ${price} is over the limit ${c.limits.price}`);
  if (c.limits.uptime !== undefined && uptime < c.limits.uptime) problems.push(`combined uptime ${uptime} is under the limit ${c.limits.uptime}`);
  if (c.limits.latencyMs !== undefined) {
    if (latency === undefined) problems.push("total latency is unknown, so the latency limit cannot be confirmed");
    else if (latency > c.limits.latencyMs) problems.push(`total latency ${latency} ms is over the limit ${c.limits.latencyMs}`);
  }
  return { pass: problems.length === 0, problems };
}
