import { Construct } from "constructs";
import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { DataConstruct } from "./data-construct";
import { AgentsConstruct } from "./agents-construct";
import { ConductorConstruct } from "./conductor-construct";
import { CloudTrailConstruct } from "./cloudtrail-construct";
import { BudgetConstruct } from "./budget-construct";
import { RecoveryConstruct } from "./recovery-construct";
import { ObservabilityConstruct } from "./observability-construct";

export class SageStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const data = new DataConstruct(this, "Data");

    const agents = new AgentsConstruct(this, "Agents", {
      escalationTopic: data.escalationTopic,
      auditTable: data.auditTable,
      intentCacheTable: data.intentCacheTable,
    });

    const conductor = new ConductorConstruct(this, "Conductor", {
      invokableFunctions: [
        agents.inputGuardFn,
        agents.intentFn,
        agents.brokerFn,
        agents.negotiatorFn,
        agents.reviewerFn,
        agents.unsatisfiableEscalationFn,
        agents.explainerFn,
        agents.escalationExplainerFn,
      ],
      auditTable: data.auditTable,
      pausedRequestsTable: data.pausedRequestsTable,
    });

    new RecoveryConstruct(this, "Recovery", { instance: conductor.instance, alertTopic: data.escalationTopic });
    new ObservabilityConstruct(this, "Observability", {
      functions: [
        agents.inputGuardFn,
        agents.intentFn,
        agents.brokerFn,
        agents.negotiatorFn,
        agents.reviewerFn,
        agents.unsatisfiableEscalationFn,
        agents.explainerFn,
        agents.escalationExplainerFn,
      ],
      groqFunctions: [agents.intentFn, agents.explainerFn],
      escalationFunctions: [agents.unsatisfiableEscalationFn, agents.escalationExplainerFn],
      api: conductor.api,
      alertTopic: data.escalationTopic,
    });

    new CfnOutput(this, "ConductorApiUrl", { value: conductor.api.url });
    new CfnOutput(this, "ConductorPublicIp", { value: conductor.eip.ref });
    new CfnOutput(this, "AuditTableName", { value: data.auditTable.tableName });
    new CfnOutput(this, "EscalationTopicArn", { value: data.escalationTopic.topicArn });
    new CfnOutput(this, "ConductorDeployBucketName", { value: conductor.deployBucket.bucketName });
    new CfnOutput(this, "PilotUserPoolId", { value: conductor.userPool.userPoolId });
    new CfnOutput(this, "PilotUserPoolClientId", { value: conductor.userPoolClient.userPoolClientId });

    const audit = new CloudTrailConstruct(this, "Audit");
    new CfnOutput(this, "CloudTrailName", { value: audit.trail.trailArn });

    new BudgetConstruct(this, "Budget", {
      limitUsd: Number(this.node.tryGetContext("budgetLimitUsd") ?? 50),
      alertEmail: this.node.tryGetContext("budgetAlertEmail") ?? "divikbhaskar@gmail.com",
    });
  }
}
