import { describe, it, expect, afterEach, vi } from "vitest";
import type { ServiceCandidateWithEvidence } from "@sage/shared-types";

// WP3.5 L6: the live Lambda (SAGE_CATALOGUE=v2) must score against the real catalogue's
// reference values, not the 21 synthetic services'. With the old table, every real email
// service at 99.908% uptime scored 0 for uptime because the "best" uptime was 99.7.

function candidate(serviceId: string, price: number, uptime: number, latencyMs: number): ServiceCandidateWithEvidence {
  return { serviceId, name: serviceId, description: "", price, uptime, latencyMs, capability: "email-delivery", endpoint: "https://x", evidence: [] };
}

const limits = [
  { field: "price" as const, operator: "lt" as const, value: 50, mandatory: true },
  { field: "uptime" as const, operator: "gte" as const, value: 99.9, mandatory: true },
];

afterEach(() => {
  delete process.env.SAGE_CATALOGUE;
  vi.resetModules();
});

describe("live catalogue references", () => {
  it("scores real services against the real catalogue when SAGE_CATALOGUE=v2", async () => {
    process.env.SAGE_CATALOGUE = "v2";
    vi.resetModules();
    const { handler } = await import("./index");
    const r = await handler({
      requestId: "r",
      iteration: 1,
      constraints: limits,
      requiredCategory: "email-delivery",
      candidates: [candidate("brevo", 7.5, 99.95, 1351), candidate("ses", 10, 99.99, 772)],
    });
    expect(r.scoreBreakdown.basis).toBe("catalogue-references");
    expect(r.scoreBreakdown.dimensions.uptime).toBeGreaterThan(0);
    expect(r.scoreBreakdown.dimensions.price).toBeLessThan(1);
  });

  it("keeps the synthetic references for the offline evaluation by default", async () => {
    const { referencesFor, CATALOGUE_REFERENCES } = await import("@sage/shared-types");
    expect(referencesFor("email-delivery")).toEqual(CATALOGUE_REFERENCES["email-delivery"]);
  });
});
