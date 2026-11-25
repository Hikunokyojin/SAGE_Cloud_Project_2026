// L32: when the catalogue or vector database cannot be reached, the request is not broken, a
// dependency is down. The client gets HTTP 503 with a Retry-After time instead of a generic
// 500 "fetch failed" (and without the raw error text, which can name the database host).
const RETRY_SEC = 30;
const NETWORK = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|server selection timed out|MongoNetworkError/i;

export function dependencyDown(err: unknown): { retryAfterSec: number } | null {
  if (!(err instanceof Error)) return null;
  // Model providers fail through their own path (L28); their network errors are not a database outage.
  if (err.message.includes("No language model answered")) return null;
  const code = (err as { cause?: { code?: string } }).cause?.code ?? "";
  return NETWORK.test(`${err.message} ${code}`) ? { retryAfterSec: RETRY_SEC } : null;
}
