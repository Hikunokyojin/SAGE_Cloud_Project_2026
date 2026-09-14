import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sns from "aws-cdk-lib/aws-sns";
import { RemovalPolicy } from "aws-cdk-lib";

/**
 * The immutable audit trail (DynamoDB) and the Human-in-the-Loop escalation channel
 * (SNS). Neither is wired to agent code yet -- that's Milestone 3 (audit writes) and
 * already-implemented Reviewer code (SNS publish) respectively. Provisioning the
 * resources now, ahead of the write code, keeps infra and feature work separable.
 */
export class DataConstruct extends Construct {
  public readonly auditTable: dynamodb.Table;
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
      removalPolicy: RemovalPolicy.DESTROY, // demo/coursework project, not production data
    });

    this.escalationTopic = new sns.Topic(this, "EscalationTopic", {
      topicName: "sage-hitl-escalation",
      displayName: "SAGE Human-in-the-Loop Escalation",
    });
  }
}
