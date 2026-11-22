import { describe, expect, it } from "vitest";
import { modelBusy } from "./modelBusy";

const GROQ_429 =
  "No language model answered. groq: Groq API error (429): {\"error\":{\"message\":\"Rate limit reached for model `openai/gpt-oss-20b` in organization `org_x` on tokens per minute (TPM): Limit 8000, Used 7472, Requested 1617. Please try again in 8.1675s.\"}}; openrouter: OpenRouter returned an empty answer";

describe("modelBusy (L28)", () => {
  it("recognises a rate-limited model failure and rounds the wait up", () => {
    expect(modelBusy(new Error(GROQ_429))).toEqual({ retryAfterSec: 9 });
  });

  it("uses a default wait when the provider gives none", () => {
    expect(modelBusy(new Error("No language model answered. groq: Groq API error (429): too many requests"))).toEqual({ retryAfterSec: 10 });
  });

  it("parses minutes and seconds", () => {
    expect(modelBusy(new Error("No language model answered. groq: Groq API error (429): Please try again in 2m3.5s."))).toEqual({ retryAfterSec: 124 });
  });

  it("ignores other failures", () => {
    expect(modelBusy(new Error("No language model answered. groq: Groq timed out after 5000 ms"))).toBeNull();
    expect(modelBusy(new Error("Broker failed"))).toBeNull();
    expect(modelBusy("not an error")).toBeNull();
  });
});
