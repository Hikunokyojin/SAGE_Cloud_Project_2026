import { describe, it, expect, vi } from "vitest";
import { createOriginGuard } from "./originGuard";

function run(guard: ReturnType<typeof createOriginGuard>, headers: Record<string, string>, ip = "203.0.113.9") {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => ((res.statusCode = c), res));
  res.json = vi.fn((b: unknown) => ((res.body = b), res));
  const next = vi.fn();
  const req: any = { header: (n: string) => headers[n.toLowerCase()], socket: { remoteAddress: ip } };
  return guard(req, res, next).then(() => ({ res, next }));
}

describe("origin guard (direct access to port 3001)", () => {
  it("lets a request through when API Gateway's secret header matches", async () => {
    const { next, res } = await run(createOriginGuard(async () => "s3cret-value"), { "x-sage-origin": "s3cret-value" });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("refuses a request without the header or with a wrong one (someone hitting the IP directly)", async () => {
    for (const headers of [{}, { "x-sage-origin": "guess" }] as Record<string, string>[]) {
      const { next, res } = await run(createOriginGuard(async () => "s3cret-value"), headers);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
  });

  it("always allows calls from the instance itself (health checks over SSM)", async () => {
    const { next } = await run(createOriginGuard(async () => "s3cret-value"), {}, "127.0.0.1");
    expect(next).toHaveBeenCalled();
    const v6 = await run(createOriginGuard(async () => "s3cret-value"), {}, "::ffff:127.0.0.1");
    expect(v6.next).toHaveBeenCalled();
  });

  it("allows everything while no secret is configured, so the rollout order cannot cause an outage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { next } = await run(createOriginGuard(async () => undefined), {});
    expect(next).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
