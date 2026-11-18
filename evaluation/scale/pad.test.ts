import { describe, it, expect } from "vitest";
import { pad, llmOnlyPromptChars, type ScaleService } from "./pad";

const base: ScaleService[] = [
  { serviceId: "a", name: "A", description: "resize", capability: "image-resizing", price: 0.02, uptime: 99.9, latencyMs: 180 },
  { serviceId: "b", name: "B", description: "resize cheap", capability: "image-resizing", price: 0.005, uptime: 99, latencyMs: 650 },
];
const sources = [
  { name: "R", description: "image resize api", capability: "image-resizing" },
  { name: "M", description: "mail api", capability: "email-delivery" },
];

describe("pad", () => {
  it("reaches the requested size and flags every padded service", () => {
    const c = pad(base, sources, 50);
    expect(c).toHaveLength(50);
    expect(c.slice(2).every((s) => s.synthetic && s.serviceId.startsWith("pad-"))).toBe(true);
    expect(new Set(c.map((s) => s.serviceId)).size).toBe(50);
  });

  it("keeps padding in an original category strictly worse than every original there", () => {
    for (const s of pad(base, sources, 40).filter((s) => s.synthetic && s.capability === "image-resizing")) {
      expect(s.price).toBeGreaterThan(0.02);
      expect(s.uptime).toBeLessThan(99);
      expect(s.latencyMs!).toBeGreaterThan(650);
    }
  });

  it("returns the base unchanged at or below its size", () => {
    expect(pad(base, sources, 2)).toEqual(base);
  });

  it("LLM-only prompt grows with the catalogue", () => {
    expect(llmOnlyPromptChars(pad(base, sources, 100), "x")).toBeGreaterThan(10 * llmOnlyPromptChars(base, "x"));
  });
});
