import { randomUUID } from "node:crypto";
import { resolveSecret } from "@sage/secrets";
import type {
  ExplainerAgentInput,
  ExplainedBlueprint,
  EscalationExplainerInput,
  EscalationExplanation,
} from "@sage/shared-types";
import { recordDecision } from "@sage/audit";

// Bedrock is unreachable for this AWS account (account-standing restriction on model
// access, confirmed with AWS support -- not an IAM/region issue). Calls Groq's free-tier
// API directly instead, same deviation as Intent Agent -- see its index.ts for the full
// rationale.
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
Given a chosen service composition, the alternatives it was selected over, and (when present)
a history of earlier attempts that were rejected during negotiation, write a short,
plain-language explanation (2-4 sentences) of why the chosen service was picked. If there is
prior-attempt history, briefly mention what was tried first and why it was rejected before
explaining the final choice.
Return ONLY the explanation text, no markdown formatting, no preamble.`;

export async function handler(input: ExplainerAgentInput): Promise<ExplainedBlueprint> {
  const { composition, negotiationHistory } = input;
  const { chosen, alternatives } = composition;

  const alternativesText = alternatives.length
    ? alternatives
        .map((a) => `${a.service.name} (price: ${a.service.price}, uptime: ${a.service.uptime}%, score: ${a.score.toFixed(3)})`)
        .join("; ")
    : "none";

  const historyText =
    negotiationHistory && negotiationHistory.length > 1
      ? negotiationHistory
          .slice(0, -1)
          .map(
            (attempt) =>
              `Attempt ${attempt.iteration}: ${attempt.composition.chosen.service.name} was rejected -- ${attempt.reviewerResult.violations
                .map((v) => `${v.constraint} was ${v.actualValue}, required ${v.correctiveAction}`)
                .join("; ")}`
          )
          .join("\n")
      : "none -- approved on the first attempt";

  const userPrompt = `Chosen: ${chosen.service.name} (price: ${chosen.service.price}, uptime: ${chosen.service.uptime}%, score: ${chosen.score.toFixed(3)})
Alternatives considered: ${alternativesText}
Prior rejected attempts: ${historyText}`;

  const explanation = await callGroq(SYSTEM_PROMPT, userPrompt, 350);

  const output: ExplainedBlueprint = {
    ...composition,
    explanation,
  };

  try {
    await recordDecision({
      requestId: input.requestId,
      agent: "ExplainerAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning: explanation,
      decisionId: input.decisionId ?? randomUUID(),
      parentDecisionId: input.parentDecisionId,
      iteration: composition.iteration,
      status: "success",
    });
  } catch (err) {
    console.error("Explainer Agent: failed to write audit record", err);
  }

  return output;
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
    .map((attempt) => {
      const { service } = attempt.composition.chosen;
      const violations = attempt.reviewerResult.violations
        .map((v) => `${v.constraint}: actual ${v.actualValue}, required ${v.requiredValue}`)
        .join("; ");
      return `Attempt ${attempt.iteration}: ${service.name} (price: ${service.price}, uptime: ${service.uptime}%) violated: ${violations}`;
    })
    .join("\n");

  const userPrompt = `User's constraints: ${JSON.stringify(constraints)}
Attempted options and why each failed:
${attemptsText}`;

  const explanation = await callGroq(ESCALATION_SYSTEM_PROMPT, userPrompt, 400);

  const output: EscalationExplanation = {
    requestId: input.requestId,
    explanation,
    attemptedOptions: attempts.map((a) => a.composition.chosen.service),
  };

  try {
    await recordDecision({
      requestId: input.requestId,
      agent: "ExplainerAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning: `Escalation remediation explanation for ${attempts.length} failed attempt(s): ${explanation}`,
      decisionId: input.decisionId ?? randomUUID(),
      parentDecisionId: input.parentDecisionId,
      iteration: attempts.length > 0 ? attempts[attempts.length - 1].iteration : 0,
      status: "escalated",
    });
  } catch (err) {
    console.error("Explainer Agent (escalation): failed to write audit record", err);
  }

  return output;
}
