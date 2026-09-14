import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { ReviewerAgentInput, ReviewerAgentOutput } from "@sage/shared-types";
import { recordDecision } from "@sage/audit";

// Hard circuit breaker: once attempt reaches this, we escalate to a human
// instead of letting the pipeline retry indefinitely.
const MAX_RETRIES = 3;

let snsClient: SNSClient | null = null;
function getSnsClient(): SNSClient {
  if (!snsClient) {
    snsClient = new SNSClient({ region: process.env.AWS_REGION || "ap-south-1" });
  }
  return snsClient;
}

function passesConstraints(input: ReviewerAgentInput): boolean {
  const { price, uptime } = input.blueprint.chosen.service;
  const { maxBudget, minUptime } = input.constraints;
  if (maxBudget !== undefined && price > maxBudget) return false;
  if (minUptime !== undefined && uptime < minUptime) return false;
  return true;
}

async function escalate(input: ReviewerAgentInput): Promise<void> {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) {
    throw new Error("Reviewer Agent: SNS_TOPIC_ARN is not set, cannot escalate to Human-in-the-Loop");
  }
  const { service } = input.blueprint.chosen;
  await getSnsClient().send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: `SAGE: request ${input.requestId} needs human review`,
      Message: `Request ${input.requestId} failed Reviewer Agent validation after ${input.attempt} attempt(s).\nChosen service: ${service.name} (${service.serviceId}), price=${service.price}, uptime=${service.uptime}%\nConstraints: ${JSON.stringify(input.constraints)}`,
    })
  );
}

async function finish(
  input: ReviewerAgentInput,
  output: ReviewerAgentOutput,
  reasoning: string
): Promise<ReviewerAgentOutput> {
  try {
    await recordDecision({
      requestId: input.requestId,
      agent: "ReviewerAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning,
    });
  } catch (err) {
    console.error("Reviewer Agent: failed to write audit record", err);
  }
  return output;
}

export async function handler(input: ReviewerAgentInput): Promise<ReviewerAgentOutput> {
  const approved = passesConstraints(input);

  if (approved) {
    return finish(
      input,
      {
        requestId: input.requestId,
        approved: true,
        blueprint: input.blueprint,
        attempt: input.attempt,
        escalated: false,
      },
      "Composition satisfies maxBudget/minUptime constraints."
    );
  }

  if (input.attempt >= MAX_RETRIES) {
    await escalate(input);
    return finish(
      input,
      {
        requestId: input.requestId,
        approved: false,
        blueprint: input.blueprint,
        attempt: input.attempt,
        escalated: true,
      },
      `Circuit breaker tripped at attempt ${input.attempt} (MAX_RETRIES=${MAX_RETRIES}); escalated to Human-in-the-Loop via SNS.`
    );
  }

  return finish(
    input,
    {
      requestId: input.requestId,
      approved: false,
      blueprint: input.blueprint,
      attempt: input.attempt,
      escalated: false,
    },
    `Composition violates constraints on attempt ${input.attempt}; will retry with next alternative.`
  );
}
