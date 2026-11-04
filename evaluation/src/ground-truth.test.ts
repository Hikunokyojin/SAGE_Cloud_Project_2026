import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GROUND_TRUTH, satisfiesRequest } from "./ground-truth";
import { TEST_CASES } from "./test-cases";
import { CATALOGUE_REFERENCES } from "@sage/shared-types";

const raw = JSON.parse(readFileSync(join(__dirname, "..", "..", "data", "services.json"), "utf-8"));
const catalog: { serviceId: string }[] = Array.isArray(raw) ? raw : raw.services;

describe("satisfiesRequest", () => {
  it("accepts a service in the right capability that meets every mandatory constraint", () => {
    expect(satisfiesRequest("MC-1", "svc-turboresize")).toBe(true);
  });

  it("accepts a valid but non-optimal choice (optimality is Selection Accuracy's job)", () => {
    expect(satisfiesRequest("CO-1", "svc-fastresize")).toBe(true);
  });

  it("rejects a service from the wrong capability even with no constraints", () => {
    expect(satisfiesRequest("SS-1", "svc-queueservice")).toBe(false);
  });

  it("rejects a service that breaks a mandatory constraint", () => {
    expect(satisfiesRequest("MC-1", "svc-fastresize")).toBe(false); // 180ms latency vs < 100ms
  });

  it("rejects unknown or missing service ids", () => {
    expect(satisfiesRequest("SS-1", "svc-does-not-exist")).toBe(false);
    expect(satisfiesRequest("SS-1", undefined)).toBe(false);
  });
});

describe("GROUND_TRUTH consistency with the test suite and catalog", () => {
  it("covers every test case", () => {
    expect(TEST_CASES.every((tc) => GROUND_TRUTH[tc.id])).toBe(true);
  });

  it("has no valid service for any case expected to escalate", () => {
    for (const tc of TEST_CASES.filter((t) => t.expectedOutcome === "escalated")) {
      expect(catalog.filter((s) => satisfiesRequest(tc.id, s.serviceId))).toEqual([]);
    }
  });

  it("treats every expected service as valid", () => {
    for (const tc of TEST_CASES.filter((t) => t.expectedServiceId)) {
      expect(satisfiesRequest(tc.id, tc.expectedServiceId)).toBe(true);
    }
  });
});

describe("CATALOGUE_REFERENCES", () => {
  it("matches data/services.json exactly (run npm run catalogue:refs after changing the catalogue)", () => {
    const expected: Record<string, { price: { min: number; max: number }; uptime: { min: number; max: number }; latencyMs: { min: number; max: number } }> = {};
    for (const s of raw as { capability: string; price: number; uptime: number; latencyMs: number }[]) {
      const r = (expected[s.capability] ??= {
        price: { min: s.price, max: s.price },
        uptime: { min: s.uptime, max: s.uptime },
        latencyMs: { min: s.latencyMs, max: s.latencyMs },
      });
      r.price = { min: Math.min(r.price.min, s.price), max: Math.max(r.price.max, s.price) };
      r.uptime = { min: Math.min(r.uptime.min, s.uptime), max: Math.max(r.uptime.max, s.uptime) };
      r.latencyMs = { min: Math.min(r.latencyMs.min, s.latencyMs), max: Math.max(r.latencyMs.max, s.latencyMs) };
    }
    expect(CATALOGUE_REFERENCES).toEqual(expected);
  });
});
