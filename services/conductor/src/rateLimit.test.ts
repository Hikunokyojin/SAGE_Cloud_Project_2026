import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rateLimit";

function fakeRes() {
  const res: { statusCode?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  return {
    state: res,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    json(body: unknown) {
      res.body = body;
      return this;
    },
  };
}

function call(limiter: ReturnType<typeof createRateLimiter>, ip: string) {
  const res = fakeRes();
  let passed = false;
  limiter({ ip } as never, res as never, () => {
    passed = true;
  });
  return { passed, res: res.state };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("createRateLimiter", () => {
  it("lets requests through while under both limits", () => {
    const limiter = createRateLimiter({ dailyLimit: 10, perClientPerHour: 3, now: () => 0 });
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
  });

  it("blocks a client's request over its hourly limit with 429 and Retry-After", () => {
    const limiter = createRateLimiter({ dailyLimit: 100, perClientPerHour: 2, now: () => 10 * 60 * 1000 });
    call(limiter, "1.1.1.1");
    call(limiter, "1.1.1.1");
    const blocked = call(limiter, "1.1.1.1");
    expect(blocked.passed).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers["Retry-After"]).toBe(String(50 * 60)); // 50 minutes to the next hour
    expect(blocked.res.body).toMatchObject({ status: "rate_limited" });
  });

  it("counts each client separately", () => {
    const limiter = createRateLimiter({ dailyLimit: 100, perClientPerHour: 1, now: () => 0 });
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
    expect(call(limiter, "2.2.2.2").passed).toBe(true);
    expect(call(limiter, "1.1.1.1").passed).toBe(false);
  });

  it("resets a client's allowance when the hour rolls over", () => {
    let t = 0;
    const limiter = createRateLimiter({ dailyLimit: 100, perClientPerHour: 1, now: () => t });
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
    expect(call(limiter, "1.1.1.1").passed).toBe(false);
    t = HOUR;
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
  });

  it("blocks everyone once the daily total is reached, and tells them to retry tomorrow", () => {
    const limiter = createRateLimiter({ dailyLimit: 2, perClientPerHour: 10, now: () => 6 * HOUR });
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
    expect(call(limiter, "2.2.2.2").passed).toBe(true);
    const blocked = call(limiter, "3.3.3.3");
    expect(blocked.passed).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers["Retry-After"]).toBe(String(18 * 60 * 60)); // 18h to UTC midnight
  });

  it("resets the daily total at the next UTC day", () => {
    let t = 0;
    const limiter = createRateLimiter({ dailyLimit: 1, perClientPerHour: 10, now: () => t });
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
    expect(call(limiter, "2.2.2.2").passed).toBe(false);
    t = DAY;
    expect(call(limiter, "2.2.2.2").passed).toBe(true);
  });

  it("does not count a blocked request against the daily total", () => {
    const limiter = createRateLimiter({ dailyLimit: 2, perClientPerHour: 1, now: () => 0 });
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
    expect(call(limiter, "1.1.1.1").passed).toBe(false); // blocked by hourly limit
    expect(call(limiter, "2.2.2.2").passed).toBe(true); // daily total is 2, not 3
  });
});
