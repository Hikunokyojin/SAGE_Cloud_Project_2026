// Signed review links (T2.3). The alert email carries
//   <dashboard>#review=<requestId>&token=<expiresAtSeconds>.<signature>
// where signature = HMAC-SHA256(key, "<requestId>.<expiresAtSeconds>"), base64url.
// Holding the link is what authorises a person to resolve that one request; it
// expires, and it cannot be moved to another request or extended.
import { createHmac, timingSafeEqual } from "node:crypto";

export const REVIEW_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function signature(requestId: string, exp: number, key: string): string {
  return createHmac("sha256", key).update(`${requestId}.${exp}`).digest("base64url");
}

export function signReviewToken(
  requestId: string,
  key: string,
  nowMs = Date.now(),
  ttlSeconds = REVIEW_TOKEN_TTL_SECONDS
): string {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  return `${exp}.${signature(requestId, exp, key)}`;
}

export function verifyReviewToken(requestId: string, token: string, key: string, nowMs = Date.now()): boolean {
  const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(token ?? "");
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return false;
  const expected = Buffer.from(signature(requestId, exp, key));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
