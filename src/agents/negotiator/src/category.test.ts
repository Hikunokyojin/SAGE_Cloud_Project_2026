import { describe, it, expect } from "vitest";
import { handler } from "./index";
import type { ServiceCandidateWithEvidence } from "@sage/shared-types";

function candidate(serviceId: string, capability: string | undefined, price: number): ServiceCandidateWithEvidence {
  return { serviceId, name: serviceId, description: "", price, uptime: 99.5, endpoint: "https://example.com", capability, evidence: [] };
}

describe("Negotiator category filter", () => {
  const candidates = [
    candidate("svc-queue", "message-queue", 0.0007),
    candidate("svc-email", "email-delivery", 0.001),
  ];

  it("excludes cheaper candidates from the wrong category", async () => {
    const result = await handler({ requestId: "r", candidates, constraints: [], iteration: 1, requiredCategory: "email-delivery" });
    expect(result.chosen.service.serviceId).toBe("svc-email");
    expect(result.alternatives).toEqual([]);
  });

  it("applies no category filter when none is required", async () => {
    const result = await handler({ requestId: "r", candidates, constraints: [], iteration: 1 });
    expect(result.chosen.service.serviceId).toBe("svc-queue");
  });

  it("excludes candidates with no recorded category when a category is required", async () => {
    await expect(
      handler({ requestId: "r", candidates: [candidate("svc-x", undefined, 0.01)], constraints: [], iteration: 1, requiredCategory: "email-delivery" })
    ).rejects.toThrow('in category "email-delivery"');
  });
});
