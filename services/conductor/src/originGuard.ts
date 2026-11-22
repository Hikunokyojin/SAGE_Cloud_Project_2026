// Closes direct access to the Conductor's port (T2.9).
//
// The security group has to allow port 3001 from any address, because API Gateway calls
// the instance over the public internet. Without a check, anyone who learns the Elastic IP
// can skip API Gateway's throttling and Cognito sign-in. API Gateway therefore adds a
// secret header, X-Sage-Origin (value from SSM /sage/conductor/ORIGIN_SECRET, resolved at
// deploy time), and this middleware refuses any request without the right value.
//
// Calls from the instance itself (health checks run through SSM) are always allowed.
// While no secret is configured everything is allowed, with a warning, so the rollout
// order (secret, API Gateway, then Conductor) can never lock out real traffic.
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createOriginGuard(getSecret: () => Promise<string | undefined>) {
  let warned = false;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (LOCAL.has(req.socket?.remoteAddress ?? "")) return next();
    const secret = await getSecret();
    if (!secret) {
      if (!warned) {
        console.warn("origin guard: no ORIGIN_SECRET configured; direct access to the Conductor is not blocked");
        warned = true;
      }
      return next();
    }
    const given = req.header("x-sage-origin");
    if (given && same(given, secret)) return next();
    res.status(403).json({ error: "Requests must come through the SAGE API." });
  };
}
