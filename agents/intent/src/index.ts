import { randomUUID } from "node:crypto";
import { resolveSecret } from "@sage/secrets";
import { SERVICE_CATEGORIES, toLlmUsage, isWarmup, WARMED } from "@sage/shared-types";
import type { IntentAgentInput, Intent, Constraint, ConstraintOperator, LlmUsage } from "@sage/shared-types";
import { recordDecision, warmUp } from "@sage/audit";
import { chat } from "@sage/llm";
import { cacheKey, getShared, putShared } from "./sharedCache";

const VALID_FIELDS = new Set(["price", "uptime", "latencyMs"]);
const VALID_OPERATORS: ConstraintOperator[] = ["lt", "lte", "gt", "gte", "eq"];

// Only an exact catalog category is accepted; anything else (including "unknown")
// means no category filter downstream, rather than filtering on a guess.
export function normalizeCategory(raw: unknown): string | undefined {
  return typeof raw === "string" && (SERVICE_CATEGORIES as readonly string[]).includes(raw) ? raw : undefined;
}

// normalizes the LLM's raw JSON into strictly-typed Constraint[] --
// a model can produce a malformed field/operator/type despite the prompt's
// instructions, so this is defensive parsing, not a pass-through cast.
function normalizeConstraints(raw: unknown): Constraint[] {
  if (!Array.isArray(raw)) return [];
  const result: Constraint[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.field !== "string" || !VALID_FIELDS.has(e.field)) continue;
    if (typeof e.operator !== "string" || !VALID_OPERATORS.includes(e.operator as ConstraintOperator)) continue;
    if (typeof e.value !== "number" || Number.isNaN(e.value)) continue;
    const mandatory = e.mandatory === true;
    const constraint: Constraint = {
      field: e.field,
      operator: e.operator as ConstraintOperator,
      value: e.value,
      mandatory,
    };
    if (!mandatory) {
      constraint.priority = typeof e.priority === "number" && !Number.isNaN(e.priority) ? e.priority : 5;
    }
    result.push(constraint);
  }
  return result;
}

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
    { "field": "price" | "uptime" | "latencyMs", "operator": "lt" | "lte" | "gt" | "gte" | "eq", "value": <number>, "mandatory": true | false, "priority": <1-10, only when mandatory is false> }
  ]
}
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
const CACHE_VERSION = `${GROQ_MODEL}|intent-v1`;

const INTENT_JSON_SCHEMA = {
  name: "intent",
  schema: {
    type: "object",
    properties: {
      capability: { type: "string" },
      category: { type: "string", enum: [...SERVICE_CATEGORIES, "unknown"] },
      constraints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: ["price", "uptime", "latencyMs"] },
            operator: { type: "string", enum: ["lt", "lte", "gt", "gte", "eq"] },
            value: { type: "number" },
            mandatory: { type: "boolean" },
            priority: { type: "number" },
          },
          required: ["field", "operator", "value", "mandatory"],
          additionalProperties: false,
        },
      },
    },
    required: ["capability", "category", "constraints"],
    additionalProperties: false,
  },
};

type ModelParse = { capability: string; category?: unknown; constraints: unknown };

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
  // Through @sage/llm (T2.7): Groq first, Cerebras if Groq fails or is rate-limited.
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
  let cachedParse = PARSE_CACHE.get(key);
  if (cachedParse) cacheSource = "memory";
  else {
    cachedParse = await getShared<ModelParse>(sharedKey);
    if (cachedParse) {
      cacheSource = "shared";
      remember(key, cachedParse);
    }
  }
  const { parsed, usage } = cachedParse
    ? { parsed: cachedParse, usage: undefined }
    : await parseWithModel(input.rawInput);
  if (!cachedParse) {
    remember(key, parsed);
    await putShared(sharedKey, parsed);
  }

  const output: Intent = {
    requestId: input.requestId,
    capability: parsed.capability,
    category: normalizeCategory(parsed.category),
    constraints: normalizeConstraints(parsed.constraints),
    rawInput: input.rawInput,
  };
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
      reasoning: `${cacheSource ? `Reused the cached parse of an identical request (${cacheSource} cache). ` : ""}Parsed capability "${output.capability}" (category: ${output.category ?? "none"}) with ${output.constraints.length} constraint(s): ${JSON.stringify(output.constraints)}.`,
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
