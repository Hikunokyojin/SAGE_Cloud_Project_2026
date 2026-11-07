import { describe, it, expect } from "vitest";
import { parseReviewHash, resolveRequest, viewRequest } from "./review";

describe("review link", () => {
  it("reads the request id and token from the link's hash", () => {
    expect(parseReviewHash("#review=req-1&token=123.abc_-")).toEqual({ requestId: "req-1", token: "123.abc_-" });
    expect(parseReviewHash("#review=req%2D1&token=1.a")).toEqual({ requestId: "req-1", token: "1.a" });
  });

  it("ignores any other hash", () => {
    expect(parseReviewHash("")).toBeNull();
    expect(parseReviewHash("#review=req-1")).toBeNull();
    expect(parseReviewHash("#something")).toBeNull();
  });

  it("builds the view and resolve calls against the Conductor", () => {
    const v = viewRequest("https://x/prod/", { requestId: "req 1", token: "1.a" });
    expect(v.url).toBe("https://x/prod/requests/req%201?token=1.a");
    const r = resolveRequest("https://x/prod", { requestId: "req-1", token: "1.a" }, { action: "reject", reviewer: "D", note: "n" });
    expect(r.url).toBe("https://x/prod/requests/req-1/resolve");
    expect(r.init.method).toBe("POST");
    expect(JSON.parse(r.init.body as string)).toEqual({ token: "1.a", action: "reject", reviewer: "D", note: "n" });
  });
});
