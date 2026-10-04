import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GROUND_TRUTH, satisfiesRequest } from "./ground-truth";
import { TEST_CASES } from "./test-cases";

const raw = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dataset", "services.json"), "utf-8"));
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
