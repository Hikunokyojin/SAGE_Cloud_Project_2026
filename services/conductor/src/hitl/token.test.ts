import { describe, it, expect } from "vitest";
import { signReviewToken, verifyReviewToken } from "./token";

const KEY = "test-signing-key-0123456789";

describe("review link token", () => {
  it("accepts a token for the request it was signed for, before it expires", () => {
    const t = signReviewToken("req-1", KEY, 1_000, 60);
    expect(verifyReviewToken("req-1", t, KEY, 1_000 + 59_000)).toBe(true);
  });

  it("refuses it for another request, after expiry, with another key, or tampered", () => {
    const t = signReviewToken("req-1", KEY, 1_000, 60);
    expect(verifyReviewToken("req-2", t, KEY, 2_000)).toBe(false);
    expect(verifyReviewToken("req-1", t, KEY, 1_000 + 61_000)).toBe(false);
    expect(verifyReviewToken("req-1", t, "other-key-0123456789", 2_000)).toBe(false);
    const [exp, sig] = t.split(".");
    expect(verifyReviewToken("req-1", `${Number(exp) + 999}.${sig}`, KEY, 2_000)).toBe(false);
    expect(verifyReviewToken("req-1", "garbage", KEY, 2_000)).toBe(false);
    expect(verifyReviewToken("req-1", "", KEY, 2_000)).toBe(false);
  });
});
