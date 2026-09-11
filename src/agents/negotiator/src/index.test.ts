import { describe, it, expect } from "vitest";
import { handler } from "./index";
import type { NegotiatorAgentInput, ServiceCandidate } from "@sage/shared-types";

function candidate(overrides: Partial<ServiceCandidate>): ServiceCandidate {
  return {
    serviceId: "svc-1",
    name: "Service",
    description: "A service",
    price: 0.05,
    uptime: 99.5,
    endpoint: "https://example.com",
    ...overrides,
  };
}

describe("Negotiator Agent handler", () => {
  it("chooses the candidate with the best combined price/uptime score", async () => {
    const input: NegotiatorAgentInput = {
      requestId: "req-1",
      constraints: {},
      candidates: [
        candidate({ serviceId: "cheap-low-uptime", price: 0.01, uptime: 95 }),
        candidate({ serviceId: "expensive-high-uptime", price: 0.5, uptime: 99.99 }),
        candidate({ serviceId: "balanced", price: 0.05, uptime: 99.5 }),
      ],
    };

    const result = await handler(input);

    expect(result.requestId).toBe("req-1");
    expect(result.chosen.service.serviceId).toBe("balanced");
    expect(result.alternatives).toHaveLength(2);
  });

  it("produces identical output for identical input, with no side effects (deterministic, not an LLM call)", async () => {
    const input: NegotiatorAgentInput = {
      requestId: "req-determinism",
      constraints: {},
      candidates: [
        candidate({ serviceId: "a", price: 0.02, uptime: 98 }),
        candidate({ serviceId: "b", price: 0.03, uptime: 99 }),
      ],
    };

    const first = await handler(input);
    const second = await handler(input);

    expect(second).toEqual(first);
  });

  it("breaks ties deterministically by serviceId when scores are equal", async () => {
    const input: NegotiatorAgentInput = {
      requestId: "req-tie",
      constraints: {},
      candidates: [
        candidate({ serviceId: "z-service", price: 0.05, uptime: 99 }),
        candidate({ serviceId: "a-service", price: 0.05, uptime: 99 }),
      ],
    };

    const result = await handler(input);

    // Equal price/uptime -> equal score -> tie-break picks lexicographically smallest serviceId.
    expect(result.chosen.service.serviceId).toBe("a-service");
  });

  it("throws when given an empty candidate list", async () => {
    const input: NegotiatorAgentInput = {
      requestId: "req-empty",
      constraints: {},
      candidates: [],
    };

    await expect(handler(input)).rejects.toThrow("no candidates to score");
  });
});
