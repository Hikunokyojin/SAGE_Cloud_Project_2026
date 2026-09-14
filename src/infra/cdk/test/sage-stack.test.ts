import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { SageStack } from "../lib/sage-stack";

function synth(): Template {
  const app = new cdk.App();
  const stack = new SageStack(app, "TestStack", { env: { region: "ap-south-1", account: "123456789012" } });
  return Template.fromStack(stack);
}

describe("SageStack", () => {
  it("provisions exactly 7 agent Lambda functions (5 agents + Input Guard + escalation-explainer)", () => {
    const template = synth();
    // resourceCountIs would also count CDK's own auto-generated "S3 auto-delete objects"
    // custom-resource Lambda (added once the Conductor deploy bucket set
    // autoDeleteObjects: true) -- filter to functions with an explicit sage-* name
    // instead of a raw total, since only those are our 7 agent functions.
    const sageFunctions = template.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: Match.stringLikeRegexp("^sage-") },
    });
    expect(Object.keys(sageFunctions)).toHaveLength(7);
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

  it("gives only the Reviewer function sns:Publish on the escalation topic", () => {
    const template = synth();

    const snsPolicies = template.findResources("AWS::IAM::Policy", {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({ Action: "sns:Publish" })]),
        },
      },
    });

    expect(Object.keys(snsPolicies)).toHaveLength(1);
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
});
