import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssmClient = new SSMClient({ region: process.env.AWS_REGION || "ap-south-1" });

// Lambda's Environment.Variables can't hold an SSM SecureString directly (CloudFormation
// only resolves {{resolve:ssm-secure:...}} for certain resource properties, not Lambda
// env vars). So a deployed Lambda fetches secrets at runtime instead; local dev just uses
// .env via process.env, no SSM call needed there. Callers are expected to cache the result
// module-level (once per cold start) the same way Broker already caches its Mongo/Qdrant
// clients -- this function itself does not cache, since different secrets have different
// natural cache scopes per agent.
async function fetchFromSsm(parameterName: string): Promise<string> {
  const response = await ssmClient.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
  const value = response.Parameter?.Value;
  if (!value) {
    throw new Error(`Secret resolution: SSM parameter ${parameterName} not found or empty`);
  }
  return value;
}

export async function resolveSecret(envVarName: string, ssmParameterName: string): Promise<string> {
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    return fromEnv;
  }
  return fetchFromSsm(ssmParameterName);
}
