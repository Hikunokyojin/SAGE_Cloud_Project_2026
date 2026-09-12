import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";

export interface ConductorConstructProps {
  /** Every agent Lambda Conductor's IAM role is allowed to invoke -- least privilege: named ARNs, not lambda:*. */
  invokableFunctions: lambda.IFunction[];
}

/**
 * Conductor: the always-on orchestrator, deliberately kept on EC2 rather than Lambda
 * (see docs/spec.md "Why the EC2 + Lambda split" -- a documented cost/performance
 * trade-off, not something to collapse into Lambda for convenience).
 *
 * VPC: a new, minimal VPC with public subnets only and NO NAT Gateway (~$32/month
 * avoided) -- neither the EC2 instance nor any Lambda here needs private-subnet
 * egress, since Bedrock/Mongo Atlas/Qdrant Cloud are all public internet endpoints
 * reachable from a public subnet with an internet gateway.
 *
 * Access: AWS Systems Manager Session Manager only -- no SSH key pair, no inbound
 * port 22, matching the project's "zero standing credentials" security goal. The
 * instance role also carries only the specific Lambda ARNs it's allowed to invoke.
 */
export class ConductorConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly instance: ec2.Instance;
  public readonly eip: ec2.CfnEIP;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ConductorConstructProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "ConductorVpc", {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const securityGroup = new ec2.SecurityGroup(this, "ConductorSecurityGroup", {
      vpc: this.vpc,
      description: "SAGE Conductor -- inbound HTTP from API Gateway only, no SSH",
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(3001),
      "Conductor HTTP port, fronted by API Gateway"
    );

    const role = new iam.Role(this, "ConductorInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: props.invokableFunctions.map((fn) => fn.functionArn),
      })
    );

    this.instance = new ec2.Instance(this, "ConductorInstance", {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
      role,
    });

    // Elastic IP so Conductor's address is stable across instance stop/start --
    // API Gateway's HTTP_PROXY integration below is configured against this fixed IP.
    this.eip = new ec2.CfnEIP(this, "ConductorEip", { instanceId: this.instance.instanceId });

    this.api = new apigateway.RestApi(this, "ConductorApi", {
      restApiName: "sage-conductor-api",
      deployOptions: { stageName: "prod" },
    });
    const proxyIntegration = new apigateway.HttpIntegration(
      `http://${this.eip.ref}:3001/{proxy}`,
      {
        httpMethod: "ANY",
        proxy: true,
        options: {
          requestParameters: { "integration.request.path.proxy": "method.request.path.proxy" },
        },
      }
    );
    const proxyResource = this.api.root.addResource("{proxy+}");
    proxyResource.addMethod("ANY", proxyIntegration, {
      requestParameters: { "method.request.path.proxy": true },
    });
  }
}
