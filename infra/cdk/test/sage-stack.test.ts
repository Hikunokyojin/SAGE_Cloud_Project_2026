import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { SageStack } from "../lib/sage-stack";

// CDK needs each agent's compiled bundle (agents/<name>/dist) to exist before it can
// synthesise the stack. These tests assert infrastructure and permissions, not the
// bundles themselves, so when a bundle has not been built (a fresh clone, CI) a minimal
// placeholder is created for the duration of the run and removed afterwards.
const AGENT_NAMES = ["input-guard", "intent", "broker", "negotiator", "reviewer", "explainer"];
const createdPlaceholders: string[] = [];

beforeAll(() => {
  for (const name of AGENT_NAMES) {
    const distDir = path.join(__dirname, "..", "..", "..", "agents", name, "dist");
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, "index.js"), "exports.handler = async () => ({});" + String.fromCharCode(10));
      createdPlaceholders.push(distDir);
    }
  }
});

afterAll(() => {
  for (const dir of createdPlaceholders) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function synth(): Template {
  const app = new cdk.App();
  const stack = new SageStack(app, "TestStack", { env: { region: "ap-south-1", account: "123456789012" } });
  return Template.fromStack(stack);
}

describe("SageStack", () => {
  it("provisions exactly 8 agent Lambda functions (5 agents + Input Guard + escalation-explainer + unsatisfiable-escalation)", () => {
    const template = synth();
    // resourceCountIs would also count CDK's own auto-generated "S3 auto-delete objects"
    // custom-resource Lambda (added once the Conductor deploy bucket set
    // autoDeleteObjects: true) -- filter to functions with an explicit sage-* name
    // instead of a raw total, since only those are our 8 agent functions.
    const sageFunctions = template.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: Match.stringLikeRegexp("^sage-") },
    });
    expect(Object.keys(sageFunctions)).toHaveLength(8);
  });

  it("grants no function bedrock:InvokeModel (Bedrock is unreachable for this account)", () => {
    const template = synth();

    const bedrockPolicies = template.findResources("AWS::IAM::Policy", {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({ Action: "bedrock:InvokeModel" })]),
        },
      },
    });

    expect(Object.keys(bedrockPolicies)).toHaveLength(0);
  });

  it("gives Intent and both Explainer functions read access to the shared Groq API key parameter", () => {
    const template = synth();

    const groqPolicies = template.findResources("AWS::IAM::Policy", {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "ssm:GetParameter",
              Resource: Match.stringLikeRegexp(".*GROQ_API_KEY.*"),
            }),
          ]),
        },
      },
    });

    // Intent, Explainer, EscalationExplainer -- exactly 3 policies grant the Groq secret.
    expect(Object.keys(groqPolicies)).toHaveLength(3);
  });

  it("gives only Reviewer and the unsatisfiable-escalation function sns:Publish on the escalation topic", () => {
    const template = synth();

    const snsPolicies = template.findResources("AWS::IAM::Policy", {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({ Action: "sns:Publish" })]),
        },
      },
    });

    // Reviewer (circuit-breaker escalation) and the new unsatisfiable-escalation
    // function (Negotiator-found-zero-candidates escalation) -- no other role.
    expect(Object.keys(snsPolicies)).toHaveLength(2);
  });

  it("creates the agent_decisions DynamoDB table with requestId/timestamp keys", () => {
    const template = synth();
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "agent_decisions",
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: "requestId", KeyType: "HASH" }),
        Match.objectLike({ AttributeName: "timestamp", KeyType: "RANGE" }),
      ]),
    });
  });

  it("creates exactly one VPC with zero NAT gateways", () => {
    const template = synth();
    template.resourceCountIs("AWS::EC2::VPC", 1);
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  it("does not open port 22 (SSH) on the Conductor security group", () => {
    const template = synth();
    const securityGroups = template.findResources("AWS::EC2::SecurityGroup");
    for (const sg of Object.values(securityGroups)) {
      const ingress = (sg as any).Properties?.SecurityGroupIngress ?? [];
      for (const rule of ingress) {
        expect(rule.FromPort).not.toBe(22);
      }
    }
  });

  it("grants the Conductor EC2 role SSM management and lambda:InvokeFunction on named ARNs, not a wildcard", () => {
    const template = synth();

    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: "ec2.amazonaws.com" } }),
        ]),
      }),
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          "Fn::Join": Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp("AmazonSSMManagedInstanceCore")]),
          ]),
        }),
      ]),
    });

    const invokePolicies = template.findResources("AWS::IAM::Policy", {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({ Action: "lambda:InvokeFunction" })]),
        },
      },
    });
    const invokeStatement = Object.values(invokePolicies)[0] as any;
    const statement = invokeStatement.Properties.PolicyDocument.Statement.find(
      (s: any) => s.Action === "lambda:InvokeFunction"
    );
    expect(statement.Resource).not.toBe("*");
  });

  it("gives Intent a shared cache table with TTL", () => {
    const template = synth();
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "intent_cache",
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      BillingMode: "PAY_PER_REQUEST",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "sage-intent",
      Environment: { Variables: Match.objectLike({ INTENT_CACHE_TABLE_NAME: Match.anyValue() }) },
    });
  });

  it("throttles the whole API stage so bursts get HTTP 429 instead of exhausting the Groq quota", () => {
    const template = synth();
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      StageName: "prod",
      MethodSettings: Match.arrayWith([
        Match.objectLike({ HttpMethod: "*", ResourcePath: "/*", ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 }),
      ]),
    });
  });

  it("creates a Cognito user pool for pilot users with self sign-up disabled", () => {
    const template = synth();
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH"]),
    });
  });

  it("protects /pilot/* with the Cognito authorizer and leaves the public demo routes open", () => {
    const template = synth();
    template.resourceCountIs("AWS::ApiGateway::Authorizer", 1);
    template.hasResourceProperties("AWS::ApiGateway::Authorizer", { Type: "COGNITO_USER_POOLS" });
    const methods = template.findResources("AWS::ApiGateway::Method");
    const auth = Object.values(methods).map((m: any) => m.Properties.AuthorizationType ?? "NONE");
    expect(auth.filter((a) => a === "COGNITO_USER_POOLS")).toHaveLength(1);
    expect(auth.filter((a) => a === "NONE").length).toBeGreaterThanOrEqual(2);
  });

  it("lets browser CORS preflights (OPTIONS) through /pilot/* without a token", () => {
    const template = synth();
    const methods = Object.values(template.findResources("AWS::ApiGateway::Method")) as any[];
    const options = methods.filter((m) => m.Properties.HttpMethod === "OPTIONS");
    expect(options).toHaveLength(1);
    expect(options[0].Properties.AuthorizationType ?? "NONE").toBe("NONE");
  });

  it("recovers the Conductor instance automatically on a host failure and reboots it on an OS failure", () => {
    const template = synth();
    const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")) as any[];
    const byMetric = (name: string) => alarms.find((a) => a.Properties.MetricName === name)?.Properties;

    const system = byMetric("StatusCheckFailed_System");
    expect(system).toBeDefined();
    expect(JSON.stringify(system.AlarmActions)).toContain("ec2:recover");
    expect(system.TreatMissingData).toBe("notBreaching");

    const instance = byMetric("StatusCheckFailed_Instance");
    expect(instance).toBeDefined();
    expect(JSON.stringify(instance.AlarmActions)).toContain("ec2:reboot");
    expect(instance.TreatMissingData).toBe("notBreaching");

    // both also notify the operator through the existing alert topic
    for (const a of [system, instance]) {
      expect(JSON.stringify(a.AlarmActions)).toContain("EscalationTopic");
    }
  });

  it("stores paused requests in their own table and lets only the Conductor use it and the review key", () => {
    const template = synth();
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "paused_requests",
      KeySchema: [{ AttributeName: "requestId", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("parameter/sage/conductor/HITL_SIGNING_KEY");
    const conductorPolicy = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) => id.includes("ConductorInstanceRole"));
    const text = JSON.stringify(conductorPolicy);
    expect(text).toContain("dynamodb:UpdateItem");
    expect(text).toContain("dynamodb:PutItem");
    const allows = (conductorPolicy![1] as any).Properties.PolicyDocument.Statement.filter((st: any) => st.Effect === "Allow");
    expect(JSON.stringify(allows)).not.toContain("dynamodb:DeleteItem");
  });

  it("explicitly denies update and delete on the audit table to every role that can write it", () => {
    const template = synth();
    const policies = Object.entries(template.findResources("AWS::IAM::Policy")) as [string, any][];
    const writers = policies.filter(([, p]) =>
      JSON.stringify(p.Properties.PolicyDocument.Statement).includes("dynamodb:PutItem") &&
      JSON.stringify(p.Properties.PolicyDocument.Statement).includes("AgentDecisionsTable")
    );
    expect(writers.length).toBeGreaterThanOrEqual(9); // 8 agent Lambdas + the Conductor
    for (const [id, p] of writers) {
      const deny = p.Properties.PolicyDocument.Statement.find((st: any) => st.Effect === "Deny");
      expect(deny, id).toBeDefined();
      for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) {
        expect(deny.Action, id).toContain(action);
      }
      // writers read the latest record to link the chain
      expect(JSON.stringify(p.Properties.PolicyDocument.Statement), id).toContain("dynamodb:Query");
    }
  });

  describe("observability (T2.5)", () => {
    it("alarms on agent errors, API 5XX, slow responses, escalation rate and Groq 429s, all to the alert topic", () => {
      const template = synth();
      const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")) as any[];
      const names = alarms.map((a) => a.Properties.AlarmName);
      for (const n of [
        "sage-agent-errors",
        "sage-api-5xx",
        "sage-api-latency-p95",
        "sage-escalation-rate",
        "sage-groq-rate-limited",
      ]) {
        const alarm = alarms.find((a) => a.Properties.AlarmName === n);
        expect(alarm, n).toBeDefined();
        expect(JSON.stringify(alarm.Properties.AlarmActions), n).toContain("EscalationTopic");
        expect(alarm.Properties.TreatMissingData, n).toBe("notBreaching");
      }
      // stays inside the 10 free CloudWatch alarms
      expect(names.length).toBeLessThanOrEqual(10);
    });

    it("counts Groq 429s from the Intent and Explainer logs", () => {
      const template = synth();
      const filters = Object.values(template.findResources("AWS::Logs::MetricFilter")) as any[];
      expect(filters.length).toBeGreaterThanOrEqual(2);
      for (const f of filters) expect(f.Properties.FilterPattern).toContain("Groq API error (429)");
    });

    it("traces every agent with X-Ray and the API stage too", () => {
      const template = synth();
      const fns = Object.values(template.findResources("AWS::Lambda::Function")) as any[];
      const agents = fns.filter((f) => String(f.Properties.FunctionName ?? "").startsWith("sage-"));
      expect(agents).toHaveLength(8);
      for (const f of agents) expect(f.Properties.TracingConfig, f.Properties.FunctionName).toEqual({ Mode: "Active" });
      template.hasResourceProperties("AWS::ApiGateway::Stage", { TracingEnabled: true });
    });

    it("keeps agent logs for 30 days instead of forever", () => {
      const template = synth();
      const retention = Object.values(template.findResources("Custom::LogRetention")) as any[];
      expect(retention.length).toBe(8);
      for (const r of retention) expect(r.Properties.RetentionInDays).toBe(30);
    });

    it("has one CloudWatch dashboard", () => {
      synth().resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    });
  });

  describe("cold start (T2.6)", () => {
    it("pings every agent every 5 minutes with a warm-up event", () => {
      const template = synth();
      const rules = Object.values(template.findResources("AWS::Events::Rule")) as any[];
      const warm = rules.filter((r) => r.Properties.ScheduleExpression === "rate(5 minutes)");
      const targets = warm.flatMap((r) => r.Properties.Targets);
      expect(targets).toHaveLength(8);
      for (const t of targets) expect(JSON.parse(t.Input)).toEqual({ warmup: true });
    });

    it("gives every agent at least 512 MB (Lambda CPU scales with memory) and the Broker a full vCPU", () => {
      const template = synth();
      const fns = (Object.values(template.findResources("AWS::Lambda::Function")) as any[]).filter((f) =>
        String(f.Properties.FunctionName ?? "").startsWith("sage-")
      );
      for (const f of fns) expect(f.Properties.MemorySize, f.Properties.FunctionName).toBeGreaterThanOrEqual(512);
      expect(fns.find((f) => f.Properties.FunctionName === "sage-broker").Properties.MemorySize).toBeGreaterThanOrEqual(1769);
    });
  });
});
