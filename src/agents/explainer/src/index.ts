import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type {
  ExplainerAgentInput,
  ExplainedBlueprint,
  EscalationExplainerInput,
  EscalationExplanation,
} from "@sage/shared-types";

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "ap-south-1" });

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

  const command = new InvokeModelCommand({
    modelId: "anthropic.claude-3-5-haiku-20241022-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const explanation: string = responseBody.content[0].text;

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

  const command = new InvokeModelCommand({
    modelId: "anthropic.claude-3-5-haiku-20241022-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 400,
      system: ESCALATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const explanation: string = responseBody.content[0].text;

  return {
    requestId: input.requestId,
    explanation,
    attemptedOptions: attempts.map((a) => a.candidate),
  };
}
