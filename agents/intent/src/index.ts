import { randomUUID } from "node:crypto";
import { resolveSecret } from "@sage/secrets";
import { SERVICE_CATEGORIES, USAGE_UNITS, isWarmup, WARMED } from "@sage/shared-types";
import type { IntentAgentInput, Intent, LlmUsage } from "@sage/shared-types";
import { normalizeCategory, normalizeConstraints, normalizeVolume, normalizeSteps, applyVolume } from "./steps";
import { recordDecision, warmUp } from "@sage/audit";
import { chat, isStubMode } from "@sage/llm";
import { cacheKey, getShared, putShared } from "./sharedCache";

// Parsing of the model's JSON (categories, constraints, T4.1a steps and volumes) lives in
// ./steps; a model can produce malformed output despite the prompt, so it is defensive.
export { normalizeCategory } from "./steps";

// Bedrock is unreachable for this AWS account (account-standing restriction on model
// access, confirmed with AWS support -- not an IAM/region issue). Calls Groq's free-tier
// API directly instead: the spec's "no third-party LLM subscription" wording isn't
// preserved literally, but there's no cost, and Groq's OpenAI-compatible chat completions
// endpoint needed no new SDK dependency (plain fetch). Documented as a deliberate
// deviation from the spec's Bedrock-only constraint, forced by the account restriction,
// not a design preference.
// llama-3.3-70b-versatile was removed from Groq's lineup since this was first written --
// confirmed via Groq's own Playground model list, which no longer has any plain Llama
// chat model (only llama-prompt-guard-2-* classifiers remain under Meta). gpt-oss-20b is
// the closer match to Claude Haiku's original small/fast/cheap profile, vs. the 120b
// variant.
const GROQ_MODEL = "openai/gpt-oss-20b";
let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (!cachedApiKey) {
    cachedApiKey = await resolveSecret("GROQ_API_KEY", "/sage/shared/GROQ_API_KEY");
  }
  return cachedApiKey;
}

const SYSTEM_PROMPT = `You are the Intent Agent for SAGE, a cloud service marketplace.
Convert the user's request into a JSON object with exactly these fields:
{
  "capability": "<short description of what they need>",
  "category": "<exactly one of: ${SERVICE_CATEGORIES.join(", ")}; or \"unknown\" if none fits>",
  "constraints": [
    { "field": "price" | "uptime" | "latencyMs", "operator": "lt" | "lte" | "gt" | "gte" | "eq", "value": <number>, "mandatory": true | false, "priority": <1-10, only when mandatory is false>, "per": "unit" (only for a price stated per item, e.g. "$0.05 per image") }
  ],
  "volume": { "amount": <number>, "unit": "<one of: ${USAGE_UNITS.join(", ")}>" } (only when the user states how much they need per month),
  "steps": [ ... ] (only when the user needs TWO OR MORE different services working together; otherwise [])
}
Each entry of "steps" is { "capability", "category", "constraints", "volume", "dependsOn": [<indexes of earlier steps whose output it uses>] } with the same meaning as above, in the order the services are used.
When there are steps: the top-level "capability" and "category" repeat the first step, and the top-level "constraints" are limits on the WHOLE chain (total monthly price, overall uptime, total latency); limits on one service go in that step's "constraints".
Rules for "constraints":
- Use "mandatory": true for a hard requirement explicitly stated (e.g. "must be under $0.05", "at least 99% uptime", "under 100ms").
- Use "mandatory": false with a "priority" from 1-10 (higher = more important) for a softer preference (e.g. "prefer cheap", "ideally fast", "reliability matters most").
- Only include a constraint for a dimension (price, uptime, latencyMs) the user actually mentioned, explicitly or clearly implied. Omit dimensions not mentioned.
- price is in dollars, uptime is a percentage (0-100), latencyMs is milliseconds.
Return ONLY the JSON object, no explanation, no markdown formatting.`;

type PreferenceField = "price" | "uptime" | "latencyMs";

// Deterministic soft-word reading: these words never become hard constraints, only weights.
const PREFERENCE_WORDS: { field: PreferenceField; strong: RegExp; normal: RegExp; low: RegExp }[] = [
  {
    field: "price",
    strong: /\b(cheapest|lowest[- ]cost|lowest price)\b/i,
    normal: /\b(cheap|inexpensive|affordable|low[- ]cost)\b/i,
    low: /\b(price|cost|budget)\s+(is\s+)?(not a concern|doesn'?t matter|does not matter|is low priority|low priority)/i,
  },
  {
    field: "latencyMs",
    strong: /\b(fastest|lowest latency)\b/i,
    normal: /\b(fast|quick|low[- ]latency|responsive)\b/i,
    low: /\b(speed|latency)\s+(is\s+)?(not a concern|doesn'?t matter|does not matter|low priority)/i,
  },
  {
    field: "uptime",
    strong: /\b(most reliable|highly reliable|very reliable)\b/i,
    normal: /\b(reliable|dependable|stable)\b/i,
    low: /\b(reliability|uptime)\s+(is\s+)?(not a concern|doesn'?t matter|does not matter|low priority)/i,
  },
];

export function extractPreferences(text: string): NonNullable<Intent["preferences"]> {
  const out: NonNullable<Intent["preferences"]> = {};
  for (const w of PREFERENCE_WORDS) {
    if (w.low.test(text)) out[w.field] = 0.5;
    else if (w.strong.test(text)) out[w.field] = 3;
    else if (w.normal.test(text)) out[w.field] = 2;
  }
  return out;
}


const GROQ_SEED = 42;
// Bump when the prompt or schema changes so the shared cache stops serving old parses.
const CACHE_VERSION = `${GROQ_MODEL}|intent-v2`;

const CONSTRAINTS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      field: { type: "string", enum: ["price", "uptime", "latencyMs"] },
      operator: { type: "string", enum: ["lt", "lte", "gt", "gte", "eq"] },
      value: { type: "number" },
      mandatory: { type: "boolean" },
      priority: { type: "number" },
      per: { type: "string", enum: ["unit"] },
    },
    required: ["field", "operator", "value", "mandatory"],
    additionalProperties: false,
  },
};
const CATEGORY_SCHEMA = { type: "string", enum: [...SERVICE_CATEGORIES, "unknown"] };
const VOLUME_SCHEMA = {
  type: "object",
  properties: { amount: { type: "number" }, unit: { type: "string", enum: [...USAGE_UNITS] } },
  required: ["amount", "unit"],
  additionalProperties: false,
};

const INTENT_JSON_SCHEMA = {
  name: "intent",
  schema: {
    type: "object",
    properties: {
      capability: { type: "string" },
      category: CATEGORY_SCHEMA,
      constraints: CONSTRAINTS_SCHEMA,
      volume: VOLUME_SCHEMA,
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            capability: { type: "string" },
            category: CATEGORY_SCHEMA,
            constraints: CONSTRAINTS_SCHEMA,
            volume: VOLUME_SCHEMA,
            dependsOn: { type: "array", items: { type: "integer" } },
          },
          required: ["capability", "category", "constraints"],
          additionalProperties: false,
        },
      },
    },
    required: ["capability", "category", "constraints"],
    additionalProperties: false,
  },
};

type ModelParse = { capability: string; category?: unknown; constraints: unknown; volume?: unknown; steps?: unknown };

// Same request (ignoring case and spacing) gives the same parse for as long as this
// process (a warm Lambda) lives. Bounded so memory stays flat.
const PARSE_CACHE = new Map<string, ModelParse>();
const PARSE_CACHE_LIMIT = 500;

export function normalizeRequest(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function remember(key: string, parsed: ModelParse): void {
  if (PARSE_CACHE.size >= PARSE_CACHE_LIMIT) {
    const oldest = PARSE_CACHE.keys().next().value;
    if (oldest !== undefined) PARSE_CACHE.delete(oldest);
  }
  PARSE_CACHE.set(key, parsed);
}

async function parseWithModel(rawInput: string): Promise<{ parsed: ModelParse; usage: LlmUsage | undefined }> {
  // Through @sage/llm (T2.7): Groq first, OpenRouter if Groq fails or is rate-limited.
  // Reproducibility (T1.6): no sampling randomness, a fixed seed, JSON forced to the Intent
  // schema where the provider supports it (the prompt describes the same shape).
  const reply = await chat({
    system: SYSTEM_PROMPT,
    user: rawInput,
    maxTokens: 1024,
    temperature: 0,
    seed: GROQ_SEED,
    jsonSchema: INTENT_JSON_SCHEMA,
    timeoutMs: 6000,
    fallbackTimeoutMs: 15000,
  });

  let parsed: ModelParse;
  try {
    parsed = JSON.parse(reply.text);
  } catch {
    throw new Error(`Intent Agent: model (${reply.provider}) returned non-JSON output: ${reply.text}`);
  }
  return { parsed, usage: reply.usage };
}

export async function handler(input: IntentAgentInput): Promise<Intent> {
  if (isWarmup(input)) {
    await warmUp();
    return WARMED as never;
  }
  const startedAt = Date.now();

  // Lookup order: this instance's memory, then the shared DynamoDB cache, then the model.
  const key = normalizeRequest(input.rawInput);
  const sharedKey = cacheKey(key, CACHE_VERSION);
  let cacheSource: "memory" | "shared" | undefined;
  // Stub answers (load tests, T2.8) must never be stored where real requests would reuse them.
  const stub = isStubMode();
  let cachedParse = stub ? undefined : PARSE_CACHE.get(key);
  if (cachedParse) cacheSource = "memory";
  else if (!stub) {
    cachedParse = await getShared<ModelParse>(sharedKey);
    if (cachedParse) {
      cacheSource = "shared";
      remember(key, cachedParse);
    }
  }
  const { parsed, usage } = cachedParse
    ? { parsed: cachedParse, usage: undefined }
    : await parseWithModel(input.rawInput);
  if (!cachedParse && !stub) {
    remember(key, parsed);
    await putShared(sharedKey, parsed);
  }

  const steps = normalizeSteps(parsed.steps);
  // A chain's top-level limits are totals, so a per-unit flag there has no single volume.
  const volume = steps ? undefined : normalizeVolume(parsed.volume);
  const output: Intent = {
    requestId: input.requestId,
    capability: steps ? steps[0].capability : parsed.capability,
    category: steps ? steps[0].category : normalizeCategory(parsed.category),
    constraints: applyVolume(normalizeConstraints(parsed.constraints), volume),
    rawInput: input.rawInput,
  };
  if (volume) output.volume = volume;
  if (steps) output.steps = steps;
  const preferences = extractPreferences(input.rawInput);
  if (Object.keys(preferences).length > 0) output.preferences = preferences;

  try {
    await recordDecision({
      durationMs: Date.now() - startedAt,
      requestId: input.requestId,
      agent: "IntentAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      usage,
      reasoning: `${cacheSource ? `Reused the cached parse of an identical request (${cacheSource} cache). ` : ""}Parsed capability "${output.capability}" (category: ${output.category ?? "none"}) with ${output.constraints.length} constraint(s): ${JSON.stringify(output.constraints)}.${output.volume ? ` Volume: ${output.volume.amount} ${output.volume.unit}/month.` : ""}${output.steps ? ` Chain of ${output.steps.length} steps: ${output.steps.map((s) => s.category ?? s.capability).join(" -> ")}.` : ""}`,
      decisionId: input.decisionId ?? randomUUID(),
      parentDecisionId: input.parentDecisionId,
      iteration: 0,
      status: "success",
    });
  } catch (err) {
    console.error("Intent Agent: failed to write audit record", err);
  }

  return output;
}
