import { describe, it, expect } from "vitest";
import { curve, chooseThreshold, thresholdGrid, cosine } from "./calibration";

describe("retrieval calibration", () => {
  const queries = [
    { kind: "in" as const, best: 0.6 },
    { kind: "in" as const, best: 0.5 },
    { kind: "out" as const, best: 0.3 },
    { kind: "out" as const, best: 0.55 },
  ];

  it("computes recall and refusal per threshold", () => {
    const [p] = curve(queries, [0.5]);
    expect(p).toEqual({ threshold: 0.5, recallAt5: 1, outOfCatalogueRefused: 0.5 });
  });

  it("chooses the highest threshold that keeps recall at the target", () => {
    const best = chooseThreshold(curve(queries, thresholdGrid(0.1, 0.8, 0.05)), 0.95);
    expect(best?.threshold).toBe(0.5);
  });

  it("returns undefined when no threshold reaches the target", () => {
    expect(chooseThreshold(curve([{ kind: "in", best: 0.2 }], [0.3, 0.4]))).toBeUndefined();
  });

  it("cosine of identical vectors is 1", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
});
