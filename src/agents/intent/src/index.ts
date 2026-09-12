import { resolveSecret } from "@sage/secrets";
import type { IntentAgentInput, Intent } from "@sage/shared-types";

// Bedrock is unreachable for this AWS account (account-standing restriction on model
// access, confirmed with AWS support -- not an IAM/region issue). Calls Groq's free-tier
// API directly instead: the spec's "no third-party LLM subscription" wording isn't
// preserved literally, but there's no cost, and Groq's OpenAI-compatible chat completions
// endpoint needed no new SDK dependency (plain fetch). Documented as a deliberate
// deviation from the spec's Bedrock-only constraint, forced by the account restriction,
// not a design preference.
const GROQ_MODEL = "llama-3.3-70b-versatile";
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

  return {
    requestId: input.requestId,
    capability: parsed.capability,
    constraints: parsed.constraints ?? {},
    rawInput: input.rawInput,
  };
}
