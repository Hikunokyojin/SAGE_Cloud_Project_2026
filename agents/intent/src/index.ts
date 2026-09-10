import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { IntentAgentInput, Intent } from "@sage/shared-types";

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "ap-south-1" });

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
  const command = new InvokeModelCommand({
    modelId: "anthropic.claude-3-5-haiku-20241022-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: input.rawInput }],
    }),
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const modelText: string = responseBody.content[0].text;

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