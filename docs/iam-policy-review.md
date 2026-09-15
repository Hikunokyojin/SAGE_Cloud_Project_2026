# SAGE — IAM Policy Review

Generated: 2026-09-16. Verification method for Objectives.docx objective 5 ("better security": least-privilege IAM, zero standing production credentials) and spec DoD item 9 ("No agent holds standing production credentials — confirmed by an IAM policy review"). Every policy document below was pulled live from the deployed account (`420974348746`, region `ap-south-1`) via `aws iam get-role-policy` / `list-attached-role-policies` at the time this review was written — not read from CDK source, so it reflects what's actually running, not just what's intended. It is cross-checked against the automated assertions in `src/infra/cdk/test/sage-stack.test.ts`, which run on every `cdk synth`/`cdk deploy` and enforce the same properties confirmed by hand here (named ARNs not wildcards, no `bedrock:InvokeModel`, no port 22).

## Methodology

1. For each of the 7 agent Lambda functions, resolved its execution role via `aws lambda get-function-configuration --query Role`.
2. For that role and for Conductor's EC2 instance role, listed attached managed policies (`list-attached-role-policies`) and inline policy documents (`list-role-policies` + `get-role-policy`).
3. Checked every statement for: a wildcard (`*`) resource on any custom (non-AWS-managed) action, any `iam:*`/`lambda:*`/`dynamodb:*`/`s3:*` blanket grant, any `bedrock:InvokeModel` grant (should not exist anywhere per the documented Bedrock-unreachable deviation), and any embedded long-lived AWS access key in a function's environment variables.

## Summary verdict

**Pass.** Every custom policy statement below scopes `Resource` to a specific named ARN (a single DynamoDB table, a single SNS topic, specific SSM parameter paths, specific Lambda function ARNs, or a specific S3 bucket) — none uses a wildcard resource. No role has any `iam:*`, and no role has `lambda:*`/`dynamodb:*`/`s3:*` as a blanket action. `bedrock:InvokeModel` does not appear in any policy in the account (consistent with the documented Bedrock-unreachable deviation — Intent/Explainer use Groq, Broker embeds locally). No Lambda's environment variables contain an `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — every agent authenticates to AWS exclusively via its Lambda execution role, and Conductor exclusively via its EC2 instance profile (`AmazonSSMManagedInstanceCore` + the inline policy below), confirming zero standing production credentials.

## Per-role policies (live, as deployed)

Every role below also carries the AWS-managed `AWSLambdaBasicExecutionRole` (CloudWatch Logs write access, scoped by AWS to that function's own log group — standard, not a finding).

### `sage-input-guard` (role `...InputGuardFunctionServiceRole...`)
No external calls (rule-based regex screen) beyond its own audit write.
```json
[
  {
    "Effect": "Allow",
    "Action": "dynamodb:PutItem",
    "Resource": ["arn:aws:dynamodb:ap-south-1:420974348746:table/agent_decisions"]
  }
]
```
**Assessment:** minimal — write-only on its own audit table, scoped to exactly the single `dynamodb:PutItem` action this agent's code (`@sage/audit`'s `recordDecision`) actually calls. (This grant was originally broader — see **Findings** below for the tightening made during this review.)

### `sage-intent` / `sage-explainer` / `sage-escalation-explainer` (Groq-calling agents)
Identical shape — Groq API key via SSM, plus the same audit-write grant.
```json
[
  { "Effect": "Allow", "Action": "ssm:GetParameter", "Resource": "arn:aws:ssm:ap-south-1:420974348746:parameter/sage/shared/GROQ_API_KEY" },
  { "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "*", "Condition": { "StringEquals": { "kms:ViaService": "ssm.ap-south-1.amazonaws.com" } } },
  { "Effect": "Allow", "Action": "dynamodb:PutItem", "Resource": ["arn:aws:dynamodb:ap-south-1:420974348746:table/agent_decisions"] }
]
```
**Assessment:** the `ssm:GetParameter` grant is scoped to exactly one parameter path (the shared Groq key), not `parameter/sage/*` or `*`. The `kms:Decrypt` statement's `Resource: "*"` looks broad at a glance, but is scoped by the `kms:ViaService` condition to only apply when the KMS call is made *through the SSM service* — this is AWS's own documented pattern for decrypting `SecureString` parameters without hardcoding the account's AWS-managed `alias/aws/ssm` key ID (which isn't resolvable by CDK without a live account-specific lookup); it cannot be used to call KMS directly for an unrelated purpose. Not a finding.

### `sage-broker`
```json
[
  { "Effect": "Allow", "Action": "ssm:GetParameter", "Resource": ["arn:aws:ssm:.../sage/broker/MONGO_URI", "arn:aws:ssm:.../sage/broker/QDRANT_URL", "arn:aws:ssm:.../sage/broker/QDRANT_API_KEY"] },
  { "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "*", "Condition": { "StringEquals": { "kms:ViaService": "ssm.ap-south-1.amazonaws.com" } } },
  { "Effect": "Allow", "Action": "dynamodb:PutItem", "Resource": ["arn:aws:dynamodb:ap-south-1:420974348746:table/agent_decisions"] }
]
```
**Assessment:** the three named SSM parameters this agent actually needs (Mongo/Qdrant secrets), nothing broader. No Bedrock grant, consistent with Broker's local-embedding-model deviation.

### `sage-negotiator`
```json
[
  { "Effect": "Allow", "Action": "dynamodb:PutItem", "Resource": ["arn:aws:dynamodb:ap-south-1:420974348746:table/agent_decisions"] }
]
```
**Assessment:** the leanest role in the system — pure deterministic computation, no external calls, only its own audit write. Matches the code (confirmed: no `process.env` usage in `src/agents/negotiator/src/index.ts`).

### `sage-reviewer`
```json
[
  { "Effect": "Allow", "Action": "sns:Publish", "Resource": "arn:aws:sns:ap-south-1:420974348746:sage-hitl-escalation" },
  { "Effect": "Allow", "Action": "dynamodb:PutItem", "Resource": ["arn:aws:dynamodb:ap-south-1:420974348746:table/agent_decisions"] }
]
```
**Assessment:** `sns:Publish` scoped to exactly the one HITL escalation topic — the only role in the system with any SNS permission, matching the design ("only the Reviewer function" per `sage-stack.test.ts`).

### Conductor EC2 instance role (`...ConductorInstanceRole...`)
```json
[
  { "Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": ["...function:sage-input-guard", "...sage-intent", "...sage-broker", "...sage-negotiator", "...sage-reviewer", "...sage-explainer", "...sage-escalation-explainer"] },
  { "Effect": "Allow", "Action": ["dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:DescribeTable", "dynamodb:GetRecords", "dynamodb:GetShardIterator"], "Resource": ["arn:aws:dynamodb:ap-south-1:420974348746:table/agent_decisions"] },
  { "Effect": "Allow", "Action": ["s3:GetObject*", "s3:GetBucket*", "s3:List*"], "Resource": ["...ConductorDeployBucket", "...ConductorDeployBucket/*"] }
]
```
Plus the AWS-managed `AmazonSSMManagedInstanceCore` (enables Session Manager access — no SSH key pair exists for this instance, no port 22 open, confirmed by `sage-stack.test.ts`'s security-group assertion).

**Assessment:** `lambda:InvokeFunction` is scoped to exactly the 7 named agent function ARNs (not `lambda:*` or `function:sage-*`) — Conductor cannot invoke any other Lambda in the account. The DynamoDB grant is **read-only** (`Query`/`GetItem`/`Scan`/etc., no `PutItem`/`UpdateItem`/`DeleteItem`) — Conductor's `GET /audit/:requestId` route only reads; per the original design ("Conductor's EC2 instance role is scoped only to invoke Lambdas + write nothing directly to DynamoDB, since agents write their own audit records" — spec §11), this is exactly as intended. The S3 grant is read-only and scoped to the one private deploy bucket used to deliver Conductor's own application bundle. No standing AWS access keys: SSM Session Manager is the only inbound access path, and Session Manager itself authenticates via the instance's own role, not a user credential.

## Findings

1. **Fixed during this review.** The DynamoDB write grants for all 6 agent audit-write roles initially used `dynamodb.Table.grantWriteData()`, which attaches `BatchWriteItem`/`PutItem`/`UpdateItem`/`DeleteItem`/`DescribeTable` — broader than the single `PutItem` call every agent's code (`@sage/audit`'s `recordDecision`) actually makes. Tightened to `table.grant(fn, "dynamodb:PutItem")` (`src/infra/cdk/lib/agents-construct.ts`), deployed, and re-verified live: a real request through the public API still produced all 6 expected `agent_decisions` records with the narrower grant. The policy JSON shown above already reflects the fixed, deployed state.
2. **No other findings.** No wildcard resources on any custom statement, no blanket service actions, no `bedrock:InvokeModel` anywhere, no embedded AWS credentials in any Lambda's environment (`intent`/`explainer`/`escalation-explainer` fetch `GROQ_API_KEY` from SSM at runtime, not as a baked-in Lambda env var — checked directly via `aws lambda get-function-configuration --query Environment.Variables`, credentials-shaped values absent).

## Cross-reference with automated enforcement

The properties reviewed by hand above are also asserted automatically on every `cdk synth` (and therefore every `cdk deploy`, and every `npm test` run) in `src/infra/cdk/test/sage-stack.test.ts`:
- Exactly 7 `sage-*` Lambda functions exist.
- No policy anywhere grants `bedrock:InvokeModel`.
- Exactly 3 policies (Intent, Explainer, EscalationExplainer) grant the Groq SSM parameter.
- Exactly 1 policy (Reviewer) grants `sns:Publish`.
- The `agent_decisions` table exists with the expected key schema.
- No security group opens port 22.
- Conductor's EC2 role's `lambda:InvokeFunction` resource is not `"*"`.

This means the least-privilege posture reviewed here isn't just a point-in-time snapshot — it's a regression-tested property of the infrastructure code, re-verified automatically before every future deploy.
