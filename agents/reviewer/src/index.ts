import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { ReviewerAgentInput, ReviewerAgentOutput } from "@sage/shared-types";

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

export async function handler(input: ReviewerAgentInput): Promise<ReviewerAgentOutput> {
  const approved = passesConstraints(input);

  if (approved) {
    return {
      requestId: input.requestId,
      approved: true,
      blueprint: input.blueprint,
      attempt: input.attempt,
      escalated: false,
    };
  }

  if (input.attempt >= MAX_RETRIES) {
    await escalate(input);
    return {
      requestId: input.requestId,
      approved: false,
      blueprint: input.blueprint,
      attempt: input.attempt,
      escalated: true,
    };
  }

  return {
    requestId: input.requestId,
    approved: false,
    blueprint: input.blueprint,
    attempt: input.attempt,
    escalated: false,
  };
}
