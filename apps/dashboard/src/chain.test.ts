import { describe, it, expect } from "vitest";
import { chainView } from "./chain";

const svc = (serviceId: string, name: string, price: number, uptime: number, latencyMs?: number, volumeNote?: string) => ({
  service: { serviceId, name, price, uptime, latencyMs, volumeNote },
});

describe("chain view (T4.1e)", () => {
  it("is null for a single-service result", () => {
    expect(chainView({ chosen: svc("a", "A", 1, 99) })).toBeNull();
  });

  it("lists each step and lays the graph out in columns by dependency depth", () => {
    const view = chainView({
      chosen: svc("ocr", "Vision OCR", 7.5, 99.9),
      chain: {
        steps: [
          { capability: "extract text", chosen: svc("ocr", "Vision OCR", 7.5, 99.9, 900, "5,000 pages counted as 5,000 images"), dependsOn: [] },
          { capability: "translate", chosen: svc("tr", "Translate", 150, 99.95, 648), dependsOn: [0] },
          { capability: "store", chosen: svc("s3", "S3", 2.3, 99.99), dependsOn: [0] },
          { capability: "email", chosen: svc("ses", "SES", 1, 99.9), dependsOn: [1, 2] },
        ],
        totals: { price: 160.8, uptime: 99.6, latencyMs: undefined },
        combinationsCompared: 12,
        combinationsValid: 4,
        edges: [
          { from: "ocr", to: "tr" },
          { from: "ocr", to: "s3" },
          { from: "tr", to: "ses" },
          { from: "s3", to: "ses" },
        ],
      },
    })!;
    expect(view.steps[0]).toEqual({ step: 1, capability: "extract text", name: "Vision OCR", price: "$7.50", uptime: "99.9%", latency: "900 ms", note: "5,000 pages counted as 5,000 images", uses: [] });
    expect(view.steps[3].uses).toEqual([2, 3]);
    expect(view.columns.map((c) => c.map((s) => s.name))).toEqual([["Vision OCR"], ["Translate", "S3"], ["SES"]]);
    expect(view.totals).toBe("$160.80 a month, 99.6% combined uptime; 4 of 12 combinations met every limit");
  });
});
