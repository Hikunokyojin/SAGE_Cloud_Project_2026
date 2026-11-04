import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sns from "aws-cdk-lib/aws-sns";
import { RemovalPolicy } from "aws-cdk-lib";

/**
 * The immutable audit trail (DynamoDB) and the Human-in-the-Loop escalation channel
 * (SNS). Agents write their own audit records to the table, and the Reviewer and
 * escalation functions publish to the topic; each role is granted only that access.
 */
export class DataConstruct extends Construct {
  public readonly auditTable: dynamodb.Table;
  public readonly intentCacheTable: dynamodb.Table;
  public readonly escalationTopic: sns.Topic;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Partition key groups all steps of one request together; sort key orders them.
    // On-demand billing (PAY_PER_REQUEST) -- no provisioned capacity to pay for while idle,
    // appropriate for a low-volume demo rather than production traffic.
    this.auditTable = new dynamodb.Table(this, "AgentDecisionsTable", {
      tableName: "agent_decisions",
      partitionKey: { name: "requestId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // demo project, not production data
    });

    // Shared Intent cache: same request, same parse, across all Lambda instances.
    // Items expire through DynamoDB TTL on expiresAt (free; on-demand billing).
    this.intentCacheTable = new dynamodb.Table(this, "IntentCacheTable", {
      tableName: "intent_cache",
      partitionKey: { name: "cacheKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.escalationTopic = new sns.Topic(this, "EscalationTopic", {
      topicName: "sage-hitl-escalation",
      displayName: "SAGE Human-in-the-Loop Escalation",
    });
  }
}
