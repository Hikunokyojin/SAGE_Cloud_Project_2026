import { describe, expect, it } from "vitest";
import type { ServiceCandidateWithEvidence } from "@sage/shared-types";
import { priceAtVolume } from "./volume";

function plan(amount: number, unit: "requests" | "gb"): ServiceCandidateWithEvidence {
  return {
    serviceId: "s", name: "MailPlan", description: "", price: 20, uptime: 99.9, endpoint: "", evidence: [],
    volumeBasis: "quota", includedUnits: { amount, unit },
  } as ServiceCandidateWithEvidence;
}

describe("L13: request quotas against countable volumes", () => {
  it("confirms a request quota that covers one request per email", () => {
    const r = priceAtVolume(plan(100000, "requests"), { amount: 50000, unit: "emails" });
    expect(r.rejectReason).toBeUndefined();
    expect(r.candidate.volumeNote).toMatch(/100,000 requests.*enough for 50,000 emails/);
  });

  it("keeps a smaller request quota but says it is enough only with batching", () => {
    const r = priceAtVolume(plan(10000, "requests"), { amount: 50000, unit: "emails" });
    expect(r.rejectReason).toBeUndefined();
    expect(r.candidate.volumeNote).toMatch(/only if.*one request/);
  });

  it("still cannot check units with no request equivalent", () => {
    const r = priceAtVolume(plan(10, "gb"), { amount: 50000, unit: "emails" });
    expect(r.candidate.volumeNote).toMatch(/could not be checked/);
  });
});
