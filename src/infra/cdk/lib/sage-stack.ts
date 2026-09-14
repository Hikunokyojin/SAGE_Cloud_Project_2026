import { Construct } from "constructs";
import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { DataConstruct } from "./data-construct";
import { AgentsConstruct } from "./agents-construct";
import { ConductorConstruct } from "./conductor-construct";

export class SageStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const data = new DataConstruct(this, "Data");

    const agents = new AgentsConstruct(this, "Agents", {
      escalationTopic: data.escalationTopic,
    });

    const conductor = new ConductorConstruct(this, "Conductor", {
      invokableFunctions: [
        agents.inputGuardFn,
        agents.intentFn,
        agents.brokerFn,
        agents.negotiatorFn,
        agents.reviewerFn,
        agents.explainerFn,
        agents.escalationExplainerFn,
      ],
    });

    new CfnOutput(this, "ConductorApiUrl", { value: conductor.api.url });
    new CfnOutput(this, "ConductorPublicIp", { value: conductor.eip.ref });
    new CfnOutput(this, "AuditTableName", { value: data.auditTable.tableName });
    new CfnOutput(this, "EscalationTopicArn", { value: data.escalationTopic.topicArn });
    new CfnOutput(this, "ConductorDeployBucketName", { value: conductor.deployBucket.bucketName });
  }
}
