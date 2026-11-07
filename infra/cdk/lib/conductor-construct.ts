import { Construct } from "constructs";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export interface ConductorConstructProps {
  /** Every agent Lambda Conductor's IAM role is allowed to invoke -- least privilege: named ARNs, not lambda:*. */
  invokableFunctions: lambda.IFunction[];
  /** agent_decisions table -- Conductor's GET /audit/:requestId route reads (never writes) from here. */
  auditTable: dynamodb.ITable;
  /** paused_requests table -- Conductor stores and resolves paused requests (T2.3). */
  pausedRequestsTable: dynamodb.ITable;
}

/**
 * Conductor: the always-on orchestrator, deliberately kept on EC2 rather than Lambda
 * (a deliberate cost/performance trade-off: a steady, always-on coordinator suits EC2,
 * while the bursty agents suit Lambda).
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
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly deployBucket: s3.Bucket;

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
    props.auditTable.grantReadData(role);
    // T2.3: the Conductor writes the human reviewer's decision to the audit trail, keeps
    // paused requests (no delete: they expire through TTL), and reads the review-link key.
    props.auditTable.grant(role, "dynamodb:PutItem");
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
        resources: [props.auditTable.tableArn],
      })
    );
    props.pausedRequestsTable.grant(role, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem");
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [`arn:aws:ssm:${Stack.of(this).region}:${Stack.of(this).account}:parameter/sage/conductor/HITL_SIGNING_KEY`],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ssm.${Stack.of(this).region}.amazonaws.com` } },
      })
    );

    // The EC2 instance has no way to receive Conductor's built application code other
    // than pulling it from somewhere -- SSM Session Manager has no built-in file
    // transfer, and embedding a multi-MB bundle directly in an SSM Run Command document
    // exceeds that API's payload size limits. A small private bucket, read-only to this
    // one instance role, is the standard AWS pattern for this instead of widening the
    // instance's permissions to the CDK bootstrap assets bucket (which is not meant to be
    // read by arbitrary EC2 roles).
    this.deployBucket = new s3.Bucket(this, "ConductorDeployBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
    this.deployBucket.grantRead(role);

    this.instance = new ec2.Instance(this, "ConductorInstance", {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      // Pinned rather than ec2.MachineImage.latestAmazonLinux2023(): that helper
      // re-resolves to whatever AMI AWS most recently published every time this stack
      // is synthesized, which silently triggers a full instance replacement (new
      // instance ID, Conductor's manually-deployed app code gone) on the next
      // unrelated `cdk deploy` -- confirmed via `cdk diff` while working on an
      // unrelated change. Pinned to the AMI this instance is actually
      // running today (verified via `aws ec2 describe-instances`); bump deliberately,
      // not as a drift side effect, if this ever needs to move.
      machineImage: ec2.MachineImage.genericLinux({
        [Stack.of(this).region]: "ami-07f35208dba26f009",
      }),
      securityGroup,
      role,
    });

    // Elastic IP so Conductor's address is stable across instance stop/start --
    // API Gateway's HTTP_PROXY integration below is configured against this fixed IP.
    this.eip = new ec2.CfnEIP(this, "ConductorEip", { instanceId: this.instance.instanceId });

    // Stage-wide throttling (T2.1): bursts get a clean HTTP 429 from API Gateway before
    // they reach the single Conductor or burn the Groq free-tier quota. Free.
    this.api = new apigateway.RestApi(this, "ConductorApi", {
      restApiName: "sage-conductor-api",
      deployOptions: { stageName: "prod", throttlingRateLimit: 5, throttlingBurstLimit: 10 },
    });

    // Pilot users (T2.1): a Cognito user pool, free tier. No self sign-up; pilot accounts
    // are created by the operator. The dashboard signs in with USER_PASSWORD_AUTH.
    this.userPool = new cognito.UserPool(this, "PilotUserPool", {
      userPoolName: "sage-pilot-users",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: { minLength: 12, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.userPoolClient = this.userPool.addClient("DashboardClient", {
      userPoolClientName: "sage-dashboard",
      generateSecret: false,
      authFlows: { userPassword: true },
      idTokenValidity: Duration.hours(1),
    });
    const pilotAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "PilotAuthorizer", {
      cognitoUserPools: [this.userPool],
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

    // /pilot/<path> is the same Conductor route, but only with a valid Cognito ID token
    // in the Authorization header; API Gateway refuses anything else with 401.
    const pilotProxy = this.api.root.addResource("pilot").addResource("{proxy+}");
    pilotProxy.addMethod("ANY", proxyIntegration, {
      requestParameters: { "method.request.path.proxy": true },
      authorizer: pilotAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    // Browsers send a CORS preflight (OPTIONS, never with a token) before a cross-site call
    // that carries Authorization, e.g. from the GitHub Pages dashboard. It must not hit the
    // authorizer; the Conductor's cors() middleware answers it.
    pilotProxy.addMethod("OPTIONS", proxyIntegration, {
      requestParameters: { "method.request.path.proxy": true },
    });

    // {proxy+} never matches the bare stage root, so the dashboard's index.html at
    // /prod/ needs its own method.
    this.api.root.addMethod(
      "GET",
      new apigateway.HttpIntegration(`http://${this.eip.ref}:3001/`, { httpMethod: "GET", proxy: true })
    );
  }
}
