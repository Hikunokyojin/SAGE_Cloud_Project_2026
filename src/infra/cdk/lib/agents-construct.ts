import * as path from "path";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import { Duration, Stack } from "aws-cdk-lib";

export interface AgentsConstructProps {
  /** SNS topic Reviewer publishes to when it escalates to Human-in-the-Loop. */
  escalationTopic: sns.ITopic;
}

/**
 * The five SAGE agents + Input Guard, each an independently deployable Lambda function
 * with its own execution role (least privilege: only the specific agent that calls
 * Bedrock or SNS gets that permission -- no shared "do everything" role).
 *
 * Deployment artifact: each agent's own `npm run build` (esbuild --bundle) output at
 * src/agents/<name>/dist/index.js -- this construct does not rebuild agent code, it
 * packages whatever is already built there. Run `npm run build --workspace=src/agents/<name>`
 * for every agent before `cdk synth`/`cdk deploy`.
 *
 * Explainer's dist bundle exports two functions (handler, explainEscalation), so it
 * backs two separate Lambda functions with different handler entry points rather than
 * one function trying to do both jobs.
 */
export class AgentsConstruct extends Construct {
  public readonly inputGuardFn: lambda.Function;
  public readonly intentFn: lambda.Function;
  public readonly brokerFn: lambda.Function;
  public readonly negotiatorFn: lambda.Function;
  public readonly reviewerFn: lambda.Function;
  public readonly explainerFn: lambda.Function;
  public readonly escalationExplainerFn: lambda.Function;

  constructor(scope: Construct, id: string, props: AgentsConstructProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    // Claude Haiku 4.5 only supports INFERENCE_PROFILE invocation in this region (not a
    // direct foundation-model ARN) -- confirmed via `aws bedrock list-foundation-models`.
    // The profile's underlying model ARNs (per `aws bedrock get-inference-profile`) need
    // their own grant too, one of them unscoped by region since the profile can route
    // globally.
    const bedrockInvokePolicy = new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:${region}:${account}:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    });

    const agentDir = (name: string) => path.join(__dirname, "..", "..", "..", "agents", name, "dist");

    this.inputGuardFn = new lambda.Function(this, "InputGuardFunction", {
      functionName: "sage-input-guard",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(agentDir("input-guard")),
      timeout: Duration.seconds(10),
      memorySize: 128,
      // Rule-based, no external calls -- no extra permissions beyond the default
      // CloudWatch Logs grant every lambda.Function gets automatically.
    });

    this.intentFn = new lambda.Function(this, "IntentFunction", {
      functionName: "sage-intent",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(agentDir("intent")),
      timeout: Duration.seconds(15),
      memorySize: 256,
      // AWS_REGION is injected automatically by the Lambda runtime -- setting it here
      // is rejected by CDK ("reserved environment variable").
    });
    this.intentFn.addToRolePolicy(bedrockInvokePolicy);

    this.brokerFn = new lambda.Function(this, "BrokerFunction", {
      functionName: "sage-broker",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(agentDir("broker")),
      timeout: Duration.seconds(20),
      memorySize: 256,
      // MONGO_URI / QDRANT_URL / QDRANT_API_KEY are SSM SecureString parameters, fetched
      // at runtime by the agent's own code (see src/agents/broker/src/index.ts) --
      // Lambda's Environment.Variables cannot hold an ssm-secure dynamic reference
      // directly (confirmed by cdk synth's own template validation), so this grants
      // read+decrypt on just these three parameter ARNs instead of baking values in.
    });
    this.brokerFn.addToRolePolicy(bedrockInvokePolicy);
    this.brokerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${region}:${Stack.of(this).account}:parameter/sage/broker/MONGO_URI`,
          `arn:aws:ssm:${region}:${Stack.of(this).account}:parameter/sage/broker/QDRANT_URL`,
          `arn:aws:ssm:${region}:${Stack.of(this).account}:parameter/sage/broker/QDRANT_API_KEY`,
        ],
      })
    );
    // AWS's documented pattern for granting decrypt on the account's AWS-managed
    // alias/aws/ssm key without hardcoding its physical key ID (which is account-
    // specific and not something CDK can resolve without a live lookup): scope by
    // kms:ViaService so this only ever applies to KMS calls made through SSM, not a
    // general kms:Decrypt grant. kms.Alias.fromAliasName(...).grantDecrypt() was tried
    // first but synthesizes no policy statement at all for an unresolved alias target
    // (confirmed by grepping the synthesized template) -- this is the reliable version.
    this.brokerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ssm.${region}.amazonaws.com` } },
      })
    );

    this.negotiatorFn = new lambda.Function(this, "NegotiatorFunction", {
      functionName: "sage-negotiator",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(agentDir("negotiator")),
      timeout: Duration.seconds(10),
      memorySize: 128,
      // Pure deterministic computation -- no external calls, no extra permissions.
    });

    this.reviewerFn = new lambda.Function(this, "ReviewerFunction", {
      functionName: "sage-reviewer",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(agentDir("reviewer")),
      timeout: Duration.seconds(10),
      memorySize: 128,
      environment: {
        SNS_TOPIC_ARN: props.escalationTopic.topicArn,
      },
    });
    props.escalationTopic.grantPublish(this.reviewerFn);

    const explainerAsset = lambda.Code.fromAsset(agentDir("explainer"));

    this.explainerFn = new lambda.Function(this, "ExplainerFunction", {
      functionName: "sage-explainer",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: explainerAsset,
      timeout: Duration.seconds(20),
      memorySize: 256,
    });
    this.explainerFn.addToRolePolicy(bedrockInvokePolicy);

    this.escalationExplainerFn = new lambda.Function(this, "EscalationExplainerFunction", {
      functionName: "sage-escalation-explainer",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.explainEscalation",
      code: explainerAsset,
      timeout: Duration.seconds(20),
      memorySize: 256,
    });
    this.escalationExplainerFn.addToRolePolicy(bedrockInvokePolicy);
  }
}
