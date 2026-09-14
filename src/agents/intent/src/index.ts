import { resolveSecret } from "@sage/secrets";
import type { IntentAgentInput, Intent } from "@sage/shared-types";
import { recordDecision } from "@sage/audit";

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
  "constraints": {
    "maxBudget": <number or omit>,
    "minUptime": <number or omit>,
    "maxLatencyMs": <number or omit>
  }
}
Return ONLY the JSON object, no explanation, no markdown formatting.`;

export async function handler(input: IntentAgentInput): Promise<Intent> {
  const apiKey = await getApiKey();

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input.rawInput },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Intent Agent: Groq API error (${response.status}): ${errorText}`);
  }

  const responseBody = await response.json();
  const modelText: string = responseBody.choices[0].message.content;

  let parsed: { capability: string; constraints: Intent["constraints"] };
  try {
    parsed = JSON.parse(modelText);
  } catch {
    throw new Error(`Intent Agent: model returned non-JSON output: ${modelText}`);
  }

  const output: Intent = {
    requestId: input.requestId,
    capability: parsed.capability,
    constraints: parsed.constraints ?? {},
    rawInput: input.rawInput,
  };

  try {
    await recordDecision({
      requestId: input.requestId,
      agent: "IntentAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning: `Parsed capability "${output.capability}" with constraints ${JSON.stringify(output.constraints)}.`,
    });
  } catch (err) {
    console.error("Intent Agent: failed to write audit record", err);
  }

  return output;
}
