// L28: when every language-model provider is rate-limited, the request is not broken, the
// model is busy. The client gets HTTP 503 with a Retry-After time instead of a generic 500
// (and without the provider's raw error text, which names the account).
const DEFAULT_RETRY_SEC = 10;

export function modelBusy(err: unknown): { retryAfterSec: number } | null {
  const message = err instanceof Error ? err.message : "";
  if (!message.includes("No language model answered") || !/\(429\)/.test(message)) return null;
  const m = /try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(message);
  const retryAfterSec = m ? Math.ceil(Number(m[1] ?? 0) * 60 + Number(m[2])) : DEFAULT_RETRY_SEC;
  return { retryAfterSec };
}
