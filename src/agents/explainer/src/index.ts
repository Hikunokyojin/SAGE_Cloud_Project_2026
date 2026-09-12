import { resolveSecret } from "@sage/secrets";
import type {
  ExplainerAgentInput,
  ExplainedBlueprint,
  EscalationExplainerInput,
  EscalationExplanation,
} from "@sage/shared-types";

// Bedrock is unreachable for this AWS account (account-standing restriction on model
// access, confirmed with AWS support -- not an IAM/region issue). Calls Groq's free-tier
// API directly instead, same deviation as Intent Agent -- see its index.ts for the full
// rationale.
const GROQ_MODEL = "llama-3.3-70b-versatile";
let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (!cachedApiKey) {
    cachedApiKey = await resolveSecret("GROQ_API_KEY", "/sage/shared/GROQ_API_KEY");
  }
  return cachedApiKey;
}

async function callGroq(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string> {
  const apiKey = await getApiKey();

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Explainer Agent: Groq API error (${response.status}): ${errorText}`);
  }

  const responseBody = await response.json();
  return responseBody.choices[0].message.content;
}

const SYSTEM_PROMPT = `You are the Explainer Agent for SAGE, a cloud service marketplace.
Given a chosen service composition and the alternatives it was selected over, write a short,
plain-language explanation (2-4 sentences) of why the chosen service was picked.
Return ONLY the explanation text, no markdown formatting, no preamble.`;

export async function handler(input: ExplainerAgentInput): Promise<ExplainedBlueprint> {
  const { blueprint } = input;
  const { chosen, alternatives } = blueprint;

  const alternativesText = alternatives.length
    ? alternatives
        .map((a) => `${a.service.name} (price: ${a.service.price}, uptime: ${a.service.uptime}%, score: ${a.score.toFixed(3)})`)
        .join("; ")
    : "none";

  const userPrompt = `Chosen: ${chosen.service.name} (price: ${chosen.service.price}, uptime: ${chosen.service.uptime}%, score: ${chosen.score.toFixed(3)})
Alternatives considered: ${alternativesText}`;

  const explanation = await callGroq(SYSTEM_PROMPT, userPrompt, 300);

  return {
    ...blueprint,
    explanation,
  };
}

const ESCALATION_SYSTEM_PROMPT = `You are the Explainer Agent for SAGE, a cloud service marketplace.
A request could not be fulfilled: every candidate service tried violated at least one of the
user's constraints, and the request has been escalated to a human reviewer. Given the list of
attempted options and exactly which constraint each one violated, write a short, plain-language
explanation (3-5 sentences) for a non-technical human reviewer covering: (1) why none of the
options worked, citing the specific numbers involved, and (2) concrete options to resolve it
(e.g. raising the budget to a specific amount, lowering the uptime requirement to a specific
percentage, or broadening the request). Return ONLY the explanation text, no markdown
formatting, no preamble.`;

export async function explainEscalation(input: EscalationExplainerInput): Promise<EscalationExplanation> {
  const { attempts, constraints } = input;

  const attemptsText = attempts
    .map(
      (a) =>
        `${a.candidate.name} (price: ${a.candidate.price}, uptime: ${a.candidate.uptime}%) violated: ${a.violatedConstraints.join(", ")}`
    )
    .join("\n");

  const userPrompt = `User's constraints: ${JSON.stringify(constraints)}
Attempted options and why each failed:
${attemptsText}`;

  const explanation = await callGroq(ESCALATION_SYSTEM_PROMPT, userPrompt, 400);

  return {
    requestId: input.requestId,
    explanation,
    attemptedOptions: attempts.map((a) => a.candidate),
  };
}
