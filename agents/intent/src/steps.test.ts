// T4.1a: Intent can describe a chain of capability steps, each with its own usage volume,
// and per-unit price limits become monthly limits when the volume is known (L2, L3).
import { describe, it, expect } from "vitest";
import { normalizeVolume, normalizeSteps, applyVolume } from "./steps";
import type { Constraint } from "@sage/shared-types";

const price = (value: number, per?: "unit"): Constraint => ({ field: "price", operator: "lt", value, mandatory: true, ...(per ? { per } : {}) });

describe("normalizeVolume", () => {
  it("keeps a positive amount with a known unit", () => {
    expect(normalizeVolume({ amount: 100000, unit: "emails" })).toEqual({ amount: 100000, unit: "emails" });
  });
  it("drops unknown units, zero, negative and non-numbers", () => {
    expect(normalizeVolume({ amount: 5, unit: "widgets" })).toBeUndefined();
    expect(normalizeVolume({ amount: 0, unit: "emails" })).toBeUndefined();
    expect(normalizeVolume({ amount: -1, unit: "emails" })).toBeUndefined();
    expect(normalizeVolume({ amount: "lots", unit: "emails" })).toBeUndefined();
    expect(normalizeVolume(undefined)).toBeUndefined();
  });
});

describe("applyVolume (L2: per-unit budgets)", () => {
  it("turns a per-unit price limit into a monthly one at the stated volume", () => {
    const out = applyVolume([price(0.05, "unit")], { amount: 10000, unit: "images" });
    expect(out).toEqual([{ field: "price", operator: "lt", value: 500, mandatory: true }]);
  });
  it("leaves the per-unit flag when there is no volume, and leaves monthly limits alone", () => {
    expect(applyVolume([price(0.05, "unit"), price(50)], undefined)).toEqual([price(0.05, "unit"), price(50)]);
    expect(applyVolume([price(50)], { amount: 10, unit: "images" })).toEqual([price(50)]);
  });
});

describe("normalizeSteps", () => {
  const raw = [
    { capability: "send receipt emails", category: "email-delivery", constraints: [price(0.001, "unit")], volume: { amount: 20000, unit: "emails" } },
    { capability: "send SMS alerts", category: "messaging", constraints: [], volume: { amount: 2000, unit: "sms" }, dependsOn: [0] },
  ];

  it("keeps a two-step chain with categories, volumes and per-step limits converted", () => {
    const steps = normalizeSteps(raw)!;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      capability: "send receipt emails",
      category: "email-delivery",
      constraints: [{ field: "price", operator: "lt", value: 20, mandatory: true }],
      volume: { amount: 20000, unit: "emails" },
      dependsOn: [],
    });
    expect(steps[1].dependsOn).toEqual([0]);
  });

  it("returns undefined for fewer than two usable steps, so single requests keep today's shape", () => {
    expect(normalizeSteps(undefined)).toBeUndefined();
    expect(normalizeSteps([raw[0]])).toBeUndefined();
    expect(normalizeSteps([raw[0], { capability: 42 }])).toBeUndefined();
  });

  it("drops an unknown category (no filter on a guess) and dependencies that are not earlier steps", () => {
    const steps = normalizeSteps([raw[0], { ...raw[1], category: "teleportation", dependsOn: [1, 5, 0] }])!;
    expect(steps[1].category).toBeUndefined();
    expect(steps[1].dependsOn).toEqual([0]);
  });

  it("caps a chain at four steps", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ capability: `step ${i}`, category: "compute", constraints: [] }));
    expect(normalizeSteps(many)).toHaveLength(4);
  });
});
