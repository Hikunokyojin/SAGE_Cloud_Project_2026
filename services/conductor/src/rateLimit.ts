import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface RateLimitOptions {
  /** Maximum accepted requests per UTC day across all clients (protects the free LLM quota). */
  dailyLimit: number;
  /** Maximum accepted requests per client address per clock hour. */
  perClientPerHour: number;
  /** Injectable clock (milliseconds since epoch), for tests. */
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * In-memory rate limiter for the public POST /request route.
 *
 * Every request calls two language-model APIs on a free tier, so an unprotected
 * public endpoint could exhaust the daily quota. Two fixed windows keep that bounded:
 * a per-client hourly cap and a global daily cap. Blocked requests are answered with
 * 429 and a Retry-After header, and are not counted against the daily total.
 *
 * Counters live in this process's memory, so they reset if the Conductor restarts;
 * that is acceptable for a single-instance deployment.
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const now = options.now ?? Date.now;

  let dayStart = Math.floor(now() / DAY_MS) * DAY_MS;
  let dayCount = 0;
  let hourStart = Math.floor(now() / HOUR_MS) * HOUR_MS;
  let clientCounts = new Map<string, number>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const t = now();

    if (t >= dayStart + DAY_MS) {
      dayStart = Math.floor(t / DAY_MS) * DAY_MS;
      dayCount = 0;
    }
    if (t >= hourStart + HOUR_MS) {
      hourStart = Math.floor(t / HOUR_MS) * HOUR_MS;
      clientCounts = new Map();
    }

    const client = req.ip ?? "unknown";
    const clientCount = clientCounts.get(client) ?? 0;

    if (dayCount >= options.dailyLimit) {
      reject(
        res,
        Math.ceil((dayStart + DAY_MS - t) / 1000),
        "The daily request limit for this demo has been reached. Please try again tomorrow (UTC)."
      );
      return;
    }
    if (clientCount >= options.perClientPerHour) {
      reject(
        res,
        Math.ceil((hourStart + HOUR_MS - t) / 1000),
        "Too many requests from your address this hour. Please try again later."
      );
      return;
    }

    dayCount += 1;
    clientCounts.set(client, clientCount + 1);
    next();
  };
}

function reject(res: Response, retryAfterSeconds: number, message: string): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ status: "rate_limited", error: message });
}
