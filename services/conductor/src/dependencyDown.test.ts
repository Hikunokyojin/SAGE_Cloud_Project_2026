import { describe, expect, it } from "vitest";
import { dependencyDown } from "./dependencyDown";

describe("dependencyDown (L32)", () => {
  it("recognises an unreachable database, locally and through Lambda", () => {
    const local = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(dependencyDown(local)).toEqual({ retryAfterSec: 30 });
    expect(dependencyDown(new Error("lambdaInvoker: sage-broker returned an error: fetch failed"))).toBeTruthy();
    expect(dependencyDown(new Error("connect ECONNREFUSED 127.0.0.1:27017"))).toBeTruthy();
    expect(dependencyDown(new Error("getaddrinfo ENOTFOUND cluster0.mongodb.net"))).toBeTruthy();
    expect(dependencyDown(new Error("Server selection timed out after 30000 ms"))).toBeTruthy();
  });

  it("ignores model and other failures", () => {
    expect(dependencyDown(new Error("No language model answered. groq: fetch failed"))).toBeNull();
    expect(dependencyDown(new Error("Broker failed"))).toBeNull();
    expect(dependencyDown("not an error")).toBeNull();
  });
});
