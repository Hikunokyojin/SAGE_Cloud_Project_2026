import { describe, expect, it } from "vitest";
import type { Intent } from "@sage/shared-types";
import { contradiction } from "./contradiction";

const intent = (rawInput: string, extra: Partial<Intent> = {}): Intent =>
  ({ requestId: "r", capability: "image resizing", category: "image-resizing", constraints: [], rawInput, ...extra }) as Intent;

describe("contradiction (L30)", () => {
  it("flags a request for opposite extremes", () => {
    expect(contradiction(intent("I need image resizing that is both the most expensive and the cheapest option."))).toMatch(/cheapest and the most expensive/);
    expect(contradiction(intent("the fastest and the slowest compute"))).toBeTruthy();
    expect(contradiction(intent("the most reliable but least reliable storage"))).toBeTruthy();
  });

  it("flags a chain that repeats the same step without one feeding the other", () => {
    const steps = [
      { capability: "image resizing", category: "image-resizing", constraints: [], dependsOn: [] },
      { capability: "image resizing", category: "image-resizing", constraints: [], dependsOn: [] },
    ];
    expect(contradiction(intent("resize images", { steps } as Partial<Intent>))).toMatch(/same step/);
  });

  it("leaves ordinary requests alone", () => {
    expect(contradiction(intent("I need the cheapest image resizing service"))).toBeNull();
    expect(contradiction(intent("cheap and fast email delivery"))).toBeNull();
    const steps = [
      { capability: "translation to French", category: "translation", constraints: [], dependsOn: [] },
      { capability: "translation to German", category: "translation", constraints: [], dependsOn: [0] },
    ];
    expect(contradiction(intent("translate to French then German", { steps } as Partial<Intent>))).toBeNull();
  });
});
