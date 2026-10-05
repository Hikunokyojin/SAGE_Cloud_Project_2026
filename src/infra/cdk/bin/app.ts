#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { SageStack } from "../lib/sage-stack";

const app = new cdk.App();

new SageStack(app, "SageStack", {
  env: {
    region: process.env.CDK_DEFAULT_REGION || "ap-south-1",
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
  description: "SAGE (Service-Agent Graph Ecosystem) -- agent Lambdas, Conductor EC2, audit trail, HITL escalation",
});
