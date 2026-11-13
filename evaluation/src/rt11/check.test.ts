import { describe, it, expect } from "vitest";
import { executeChain, checkCase, type ChainLike, type Rt11Case } from "./check";

const step = (id: string, capability: string, price: number, uptime: number, latencyMs: number, dependsOn: number[]) => ({
  capability,
  chosen: { service: { serviceId: id, name: id.toUpperCase(), price, uptime, latencyMs, capability } },
  dependsOn,
});
const chain: ChainLike = {
  steps: [step("ocr", "document-ocr", 7.5, 99.9, 900, []), step("tr", "translation", 150, 99.95, 648, [0])],
  totals: { price: 157.5, uptime: 99.85, latencyMs: 1548 },
  edges: [{ from: "ocr", to: "tr" }],
};

describe("executeChain (RT11)", () => {
  it("calls each step once, after the steps it depends on, passing their outputs", async () => {
    const calls: { category: string; inputs: string[] }[] = [];
    const run = await executeChain(chain, async (category, inputs) => {
      calls.push({ category, inputs });
      return { ok: true, output: `${category}-out` };
    });
    expect(calls).toEqual([
      { category: "document-ocr", inputs: [] },
      { category: "translation", inputs: ["document-ocr-out"] },
    ]);
    expect(run.ok).toBe(true);
    expect(run.steps.map((s) => s.ok)).toEqual([true, true]);
  });

  it("stops a step whose dependency failed", async () => {
    const run = await executeChain(chain, async (category) => ({ ok: category !== "document-ocr", output: "x" }));
    expect(run.ok).toBe(false);
    expect(run.steps[1]).toMatchObject({ ok: false, error: "dependency step 1 failed" });
  });
});

describe("checkCase (RT11)", () => {
  const feasible: Rt11Case = { id: "c1", text: "...", steps: ["document-ocr", "translation"], limits: { price: 200, uptime: 99.5 } };

  it("passes an approved chain that has the expected steps, ran, and honours every limit", () => {
    const r = checkCase(feasible, { status: "completed", result: { chain } }, { ok: true, steps: [] });
    expect(r).toEqual({ pass: true, problems: [] });
  });

  it("recomputes the totals and reports each limit broken", () => {
    const r = checkCase({ ...feasible, limits: { price: 100, uptime: 99.9, latencyMs: 1000 } }, { status: "completed", result: { chain } }, { ok: true, steps: [] });
    expect(r.pass).toBe(false);
    expect(r.problems).toEqual([
      "total price 157.5 is over the limit 100",
      "combined uptime 99.8501 is under the limit 99.9",
      "total latency 1548 ms is over the limit 1000",
    ]);
  });

  it("fails a chain whose steps are not the expected categories, or that did not run", () => {
    const r = checkCase({ ...feasible, steps: ["document-ocr", "text-to-speech"] }, { status: "completed", result: { chain } }, { ok: false, steps: [] });
    expect(r.problems).toEqual([
      "steps were document-ocr > translation, expected document-ocr > text-to-speech",
      "the chain did not run end to end against the sandbox",
    ]);
  });

  it("an infeasible case passes only when it is refused (paused for review)", () => {
    const infeasible: Rt11Case = { ...feasible, expect: "refused" };
    expect(checkCase(infeasible, { status: "paused_for_review" }, undefined).pass).toBe(true);
    expect(checkCase(infeasible, { status: "completed", result: { chain } }, { ok: true, steps: [] }).problems).toEqual([
      "expected a refusal, but a chain was approved",
    ]);
  });

  it("fails a feasible case that was refused or returned no chain", () => {
    expect(checkCase(feasible, { status: "paused_for_review" }, undefined).problems).toEqual(["no chain was approved (status paused_for_review)"]);
  });
});
