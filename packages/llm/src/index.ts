// Language-model calls for SAGE agents (T2.7).
//
// One chat() for every agent that needs a model. Providers are tried in order
// (LLM_PROVIDERS, default "groq,openrouter"); each call has a timeout, and a provider that
// fails 3 times in a row is skipped for 60 s (circuit breaker), so a Groq outage or a used-up
// free quota falls back to the next provider instead of failing the request. Bedrock is
// implemented but off by default: this AWS account cannot call Bedrock models yet
// ("Operation not allowed"); once AWS unblocks it, set LLM_PROVIDERS=bedrock,groq,cerebras.
//
// Every provider failure is logged with console.warn. Groq's keep the wording
// "Groq API error (<status>)", which the CloudWatch quota alarm (T2.5) searches for.
import { resolveSecret } from "@sage/secrets";
import { toLlmUsage, type LlmUsage } from "@sage/shared-types";

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  seed?: number;
  // Asks for JSON matching this schema (strictly where the provider supports it).
  jsonSchema?: { name: string; schema: object };
  // Time limit for the first provider tried; default 8 s.
  timeoutMs?: number;
  // Time limit for any later (fallback) provider; defaults to timeoutMs. Free fallback
  // models answer more slowly (measured live 2026-11-08: often over 6 s), so callers give
  // them longer while a broken primary still fails fast.
  fallbackTimeoutMs?: number;
}

export interface ChatResult {
  text: string;
  usage?: LlmUsage;
  provider: string;
  model: string;
  // Providers that were tried first and failed.
  fallbackFrom?: string[];
}

interface OpenAiStyleProvider {
  kind: "openai";
  name: string;
  label: string;
  url: string;
  model: string;
  keyEnv: string;
  keyParam: string;
  // "schema": strict json_schema; "object": json_object (the prompt describes the shape).
  jsonMode: "schema" | "object";
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
}
interface BedrockProvider {
  kind: "bedrock";
  name: "bedrock";
  label: string;
  model: string;
}
type Provider = OpenAiStyleProvider | BedrockProvider;

const PROVIDERS: Record<string, Provider> = {
  groq: {
    kind: "openai",
    name: "groq",
    label: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    keyEnv: "GROQ_API_KEY",
    keyParam: "/sage/shared/GROQ_API_KEY",
    jsonMode: "schema",
    // gpt-oss is a reasoning model; reasoning tokens count against max_tokens.
    extra: { reasoning_effort: "low" },
  },
  // Free fallback without a payment method (chosen 2026-11-07 after Cerebras asked for a
  // card). Free models are capped at a low daily request count, which suits a backup.
  openrouter: {
    kind: "openai",
    name: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    // openrouter/free routes to whichever free model is available: in the live test a
    // single free model (gemma-4-31b) was rate-limited upstream (429) while the router answered.
    model: process.env.OPENROUTER_MODEL || "openrouter/free",
    keyEnv: "OPENROUTER_API_KEY",
    keyParam: "/sage/shared/OPENROUTER_API_KEY",
    jsonMode: "object",
    headers: { "X-Title": "SAGE" },
  },
  // Opt-in only (its key now needs a payment method).
  cerebras: {
    kind: "openai",
    name: "cerebras",
    label: "Cerebras",
    url: "https://api.cerebras.ai/v1/chat/completions",
    model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
    keyEnv: "CEREBRAS_API_KEY",
    keyParam: "/sage/shared/CEREBRAS_API_KEY",
    jsonMode: "object",
  },
  bedrock: {
    kind: "bedrock",
    name: "bedrock",
    label: "Bedrock",
    model: process.env.BEDROCK_MODEL || "apac.amazon.nova-micro-v1:0",
  },
};

function order(): Provider[] {
  return (process.env.LLM_PROVIDERS || "groq,openrouter")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => PROVIDERS[s])
    .map((s) => PROVIDERS[s]);
}

// ---------------------------------------------------------------- circuit breaker
const FAILURE_THRESHOLD = 3;
const COOL_DOWN_MS = 60_000;
let clock: () => number = Date.now;
const breakers = new Map<string, { failures: number; openUntil: number }>();

/** For tests only. */
export function _setClock(fn: () => number): void {
  clock = fn;
}

function isOpen(name: string): boolean {
  const b = breakers.get(name);
  return !!b && b.openUntil > clock();
}
function recordFailure(name: string): void {
  const b = breakers.get(name) ?? { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= FAILURE_THRESHOLD) {
    b.openUntil = clock() + COOL_DOWN_MS;
    b.failures = 0;
  }
  breakers.set(name, b);
}
function recordSuccess(name: string): void {
  breakers.delete(name);
}

// ---------------------------------------------------------------- providers
const keyCache = new Map<string, string>();
async function key(p: OpenAiStyleProvider): Promise<string> {
  const cached = keyCache.get(p.name);
  if (cached) return cached;
  const k = await resolveSecret(p.keyEnv, p.keyParam);
  keyCache.set(p.name, k);
  return k;
}

class MissingKey extends Error {}

async function callOpenAiStyle(p: OpenAiStyleProvider, req: ChatRequest, signal: AbortSignal) {
  let apiKey: string;
  try {
    apiKey = await key(p);
  } catch (err) {
    throw new MissingKey(err instanceof Error ? err.message : String(err));
  }
  const response_format = req.jsonSchema
    ? p.jsonMode === "schema"
      ? { type: "json_schema", json_schema: req.jsonSchema }
      : { type: "json_object" }
    : undefined;
  const res = await fetch(p.url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...(p.headers ?? {}) },
    body: JSON.stringify({
      model: p.model,
      max_tokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(response_format ? { response_format } : {}),
      ...(p.extra ?? {}),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`${p.label} API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${p.label} returned an empty answer`);
  return { text, usage: toLlmUsage(body.usage) };
}

let bedrockClient: any;
async function callBedrock(p: BedrockProvider, req: ChatRequest, signal: AbortSignal) {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  bedrockClient ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION || "ap-south-1" });
  const out = await bedrockClient.send(
    new ConverseCommand({
      modelId: p.model,
      system: [{ text: req.system + (req.jsonSchema ? "\nReturn only JSON." : "") }],
      messages: [{ role: "user", content: [{ text: req.user }] }],
      inferenceConfig: { maxTokens: req.maxTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
    }),
    { abortSignal: signal }
  );
  const text = out?.output?.message?.content?.find((c: { text?: string }) => c.text)?.text;
  if (!text) throw new Error("Bedrock returned an empty answer");
  const u = out.usage;
  const usage: LlmUsage | undefined = u
    ? { promptTokens: u.inputTokens ?? 0, completionTokens: u.outputTokens ?? 0, totalTokens: u.totalTokens ?? 0 }
    : undefined;
  return { text, usage };
}

// ---------------------------------------------------------------- chat
export async function chat(req: ChatRequest): Promise<ChatResult> {
  const failed: string[] = [];
  const reasons: string[] = [];
  let attempted = 0;
  for (const p of order()) {
    if (isOpen(p.name)) {
      reasons.push(`${p.name}: skipped, circuit open after repeated failures`);
      continue;
    }
    const limit = attempted === 0 ? (req.timeoutMs ?? 8000) : (req.fallbackTimeoutMs ?? req.timeoutMs ?? 8000);
    attempted++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    try {
      const out = p.kind === "openai" ? await callOpenAiStyle(p, req, controller.signal) : await callBedrock(p, req, controller.signal);
      recordSuccess(p.name);
      return { ...out, provider: p.name, model: p.model, ...(failed.length ? { fallbackFrom: failed } : {}) };
    } catch (err) {
      const message = controller.signal.aborted
        ? `${p.label} timed out after ${limit} ms`
        : err instanceof Error
          ? err.message
          : String(err);
      reasons.push(`${p.name}: ${message}`);
      // A missing key is a configuration gap, not an outage: it never opens the circuit.
      if (!(err instanceof MissingKey)) {
        recordFailure(p.name);
        failed.push(p.name);
        console.warn(`LLM provider ${p.name} failed: ${message}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`No language model answered. ${reasons.join("; ")}`);
}
