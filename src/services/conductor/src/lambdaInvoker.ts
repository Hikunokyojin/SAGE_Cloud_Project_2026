import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import type { AgentInvoker } from "./pipeline";

// Lambda-backed invocation for deployed environments: calls each agent's real AWS
// Lambda function by name (via a direct SDK Invoke -- not API-Gateway-proxy shaped,
// since Conductor passes the same typed payload the local handler receives directly).
// Selected via AGENT_INVOKE_MODE=lambda; see index.ts.
const client = new LambdaClient({ region: process.env.AWS_REGION || "ap-south-1" });

async function invokeFunction<TOut>(functionNameEnvVar: string, payload: unknown): Promise<TOut> {
  const functionName = process.env[functionNameEnvVar];
  if (!functionName) {
    throw new Error(`lambdaInvoker: ${functionNameEnvVar} is not set`);
  }

  const command = new InvokeCommand({
    FunctionName: functionName,
    Payload: JSON.stringify(payload),
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.Payload));

  if (response.FunctionError) {
    const message = responseBody?.errorMessage ?? JSON.stringify(responseBody);
    throw new Error(`lambdaInvoker: ${functionName} returned an error: ${message}`);
  }

  return responseBody as TOut;
}

export const lambdaInvoker: AgentInvoker = {
  inputGuard: (input) => invokeFunction("INPUT_GUARD_FUNCTION_NAME", input),
  intent: (input) => invokeFunction("INTENT_FUNCTION_NAME", input),
  broker: (input) => invokeFunction("BROKER_FUNCTION_NAME", input),
  negotiator: (input) => invokeFunction("NEGOTIATOR_FUNCTION_NAME", input),
  reviewer: (input) => invokeFunction("REVIEWER_FUNCTION_NAME", input),
  explainer: (input) => invokeFunction("EXPLAINER_FUNCTION_NAME", input),
  explainEscalation: (input) => invokeFunction("ESCALATION_EXPLAINER_FUNCTION_NAME", input),
  escalateUnsatisfiable: (input) => invokeFunction("UNSATISFIABLE_ESCALATION_FUNCTION_NAME", input),
};
