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
let falseAlarms: string[] = [];

beforeAll(async () => {
  const { handler, _setCatalogueLookup } = await import("@sage/agent-reviewer/src/index");
  // L22: the Reviewer reads each service from the catalogue (here the same file MongoDB is seeded from).
  const byId = new Map(catalogue.map((s) => [s.serviceId, s]));
  _setCatalogueLookup(async (ids) => new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)! as never])));
  // Control: every unaltered service, with no limits, must still be approved.
  for (const s of catalogue) {
    const f = faultsFor(s)[0];
    if (!f) continue;
    const clean = structuredClone(f.input);
    clean.composition.chosen.service = { ...clean.composition.chosen.service, ...s };
    clean.constraints = [];
    const r = await handler(clean);
    if (!r.approved) falseAlarms.push(`${s.serviceId}: ${r.violations.map((v) => v.constraint).join(", ")}`);
  }
  for (const fault of catalogue.flatMap(faultsFor)) {
    const r = await handler(fault.input);
    outcomes.push({ fault, caught: !r.approved, violations: r.violations.map((v) => v.constraint) });
  }
  if (process.env.FAULT_REPORT) {
    const summary = summarise(outcomes);
    const examples = Object.fromEntries(
      Object.keys(summary.byKind).map((k) => [k, outcomes.filter((o) => o.fault.kind === k).slice(0, 3).map((o) => ({ service: o.fault.serviceId, fault: o.fault.description, caught: o.caught, violations: o.violations }))])
    );
    writeFileSync(join(ROOT, "evaluation", "results", "t45-faults.json"), JSON.stringify({ generatedAt: new Date().toISOString(), services: catalogue.length, cleanFalseAlarms: falseAlarms.length, ...summary, examples }, null, 1) + "\n");
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

  it("catches stale uptime and stale list prices by re-reading the catalogue (L22)", () => {
    const s = summarise(outcomes);
    expect(s.byKind["stale-uptime"].caught).toBe(s.byKind["stale-uptime"].injected);
    expect(s.byKind["stale-list-price"].caught).toBe(s.byKind["stale-list-price"].injected);
  });

  it("approves every unaltered service (no false alarms from the catalogue check)", () => {
    expect(falseAlarms).toEqual([]);
  });
});
