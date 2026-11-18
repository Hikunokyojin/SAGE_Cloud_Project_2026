// T4.5: runs every injected fault through the real Reviewer handler.
// `npm run faults -w @sage/evaluation` also writes evaluation/results/t45-faults.json.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Service } from "@sage/shared-types";
import { toV1 } from "@sage/catalogue/src/project";
import { faultsFor, summarise, type FaultOutcome } from "./inject";

vi.mock("@sage/audit", () => ({ recordDecision: vi.fn(async () => undefined), warmUp: vi.fn() }));
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class { send = vi.fn(async () => ({})); },
  PublishCommand: class { constructor(public input: unknown) {} },
}));

const ROOT = join(__dirname, "..", "..");
const raw = JSON.parse(readFileSync(join(ROOT, "data", "services.v2.json"), "utf-8"));
const catalogue: Service[] = (Array.isArray(raw) ? raw : raw.services)
  .filter((s: { synthetic?: boolean }) => !s.synthetic)
  .map((s: never) => toV1(s) as unknown as Service);

let outcomes: FaultOutcome[] = [];

beforeAll(async () => {
  const { handler } = await import("@sage/agent-reviewer/src/index");
  for (const fault of catalogue.flatMap(faultsFor)) {
    const r = await handler(fault.input);
    outcomes.push({ fault, caught: !r.approved, violations: r.violations.map((v) => v.constraint) });
  }
  if (process.env.FAULT_REPORT) {
    const summary = summarise(outcomes);
    const examples = Object.fromEntries(
      Object.keys(summary.byKind).map((k) => [k, outcomes.filter((o) => o.fault.kind === k).slice(0, 3).map((o) => ({ service: o.fault.serviceId, fault: o.fault.description, caught: o.caught, violations: o.violations }))])
    );
    writeFileSync(join(ROOT, "evaluation", "results", "t45-faults.json"), JSON.stringify({ generatedAt: new Date().toISOString(), services: catalogue.length, ...summary, examples }, null, 1) + "\n");
  }
});

describe("T4.5 Reviewer fault injection", () => {
  it("injects faults across the real catalogue", () => {
    expect(catalogue.length).toBeGreaterThan(200);
    expect(outcomes.length).toBeGreaterThan(500);
  });

  it.each(["off-by-one-price", "off-by-one-uptime", "wrong-category", "stale-price", "wrong-unit-price"])("catches every %s fault", (kind) => {
    const k = outcomes.filter((o) => o.fault.kind === kind);
    expect(k.length).toBeGreaterThan(0);
    expect(k.filter((o) => !o.caught).map((o) => o.fault.id)).toEqual([]);
  });

  it("documents the blind spot (L22): uptime and list price come from the Negotiator's own service object", () => {
    // The Reviewer has no second source for these, so a consistent stale value passes. Kept as a
    // measured limit rather than a pass condition; see docs/LOOPHOLES.md L22.
    const s = summarise(outcomes);
    expect(s.byKind["stale-uptime"].caught).toBe(0);
    expect(s.byKind["stale-list-price"].caught / s.byKind["stale-list-price"].injected).toBeLessThan(0.05);
  });
});
