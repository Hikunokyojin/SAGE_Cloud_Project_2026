import { describe, it, expect, vi } from "vitest";

vi.mock("@sage/secrets", () => ({ resolveSecret: vi.fn() }));

describe("normalizeCategory", () => {
  it("accepts an exact catalog category", async () => {
    const { normalizeCategory } = await import("./index");
    expect(normalizeCategory("email-delivery")).toBe("email-delivery");
  });

  it("drops 'unknown', near-misses, and non-strings instead of guessing", async () => {
    const { normalizeCategory } = await import("./index");
    expect(normalizeCategory("unknown")).toBeUndefined();
    expect(normalizeCategory("email delivery")).toBeUndefined();
    expect(normalizeCategory(undefined)).toBeUndefined();
    expect(normalizeCategory(42)).toBeUndefined();
  });
});
