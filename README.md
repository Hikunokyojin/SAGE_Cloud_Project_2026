# SAGE — Service-Agent Graph Ecosystem

SAGE is an AI-driven cloud service marketplace. A user describes the service they need in plain English, and a chain of specialized agents finds, selects, verifies and explains a matching service, or passes the request to a human when nothing fits. Every decision is recorded and traceable. Deployed live on AWS.

**Live dashboard:** https://hiz4sheyl5.execute-api.ap-south-1.amazonaws.com/prod/ (trailing slash required). See [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) for suggested requests and the full service catalogue.

## Architecture

```
request → Input Guard → Intent → Broker → Negotiator ⇄ Reviewer → Explainer → response
                                            (bounded loop)
```

Every handoff between agents is a typed payload from [`src/packages/shared-types`](src/packages/shared-types), never raw conversation history.

| Stage | What it does |
|---|---|
| **Input Guard** | Rule-based screen for prompt injection; replaces matched phrases with `[filtered]` before any LLM sees the request |
| **Intent** | LLM turns the request into a service category plus structured constraints (price, uptime, latency; mandatory or preferred) |
| **Broker** | Semantic search over the catalogue (Qdrant Cloud) joined with service metadata (MongoDB Atlas); retrieval only, no filtering |
| **Negotiator** | Deterministic scoring, no LLM: excludes candidates in the wrong category or breaking a mandatory constraint, then ranks the rest by a weighted, normalised score |
| **Reviewer** | Independently re-checks the choice with its own logic; on failure feeds structured violations back to the Negotiator (max 3 attempts), then escalates to a human via SNS |
| **Explainer** | LLM writes a plain-language rationale, or remediation advice when a request is escalated |
| **Conductor** | Orchestrates the chain on EC2 behind API Gateway, invoking each agent as its own Lambda; also serves the dashboard |

Requests that no service can satisfy, including ones that match nothing in the catalogue, are escalated to a human rather than failing silently. Each agent writes a decision record to DynamoDB, linked to the decision before it, so a request's full decision path can be reconstructed and viewed in the dashboard.

Architecture diagrams: [`architecture/`](architecture).

### Deviations from the original design

This AWS account is restricted by AWS (new account), which forced two changes:
- **Amazon Bedrock is unavailable.** Intent and Explainer use Groq (`openai/gpt-oss-20b`); Broker runs a local embedding model (`Xenova/all-MiniLM-L6-v2`) inside its Lambda.
- **CloudFront is unavailable.** The dashboard is served by the Conductor instead of S3 + CloudFront.

### AWS resources

8 Lambda functions (one least-privilege role each), an EC2 t3.micro Conductor (SSM access only, no SSH), API Gateway, DynamoDB (`agent_decisions`), SNS (human escalation), CloudTrail, and an AWS Budgets alert, all defined in CDK under [`src/infra/cdk`](src/infra/cdk). The VPC has no NAT gateways.

## Repository structure

```
docs/           specification, project plan and status, demo guide, IAM policy review
architecture/   architecture diagrams
dataset/        service catalogue (21 services) and edge-case scenarios
results/        experiment results and reports, prompt-injection report
src/
  agents/       input-guard, intent, broker, negotiator, reviewer, explainer
  services/     conductor (orchestration API)
  packages/     shared-types (contracts), audit (decision records), secrets
  apps/         dashboard (decision-trace viewer)
  infra/        AWS CDK app
  experiments/  D8-D9 test suite, baselines and ablation study
```

npm workspaces monorepo, Node 22+.

## Setup

```bash
npm install --force
```

`--force` is required on Windows/macOS: Broker deliberately declares Linux-only native binaries for its Lambda. Secrets (Groq API key, MongoDB and Qdrant credentials) are read from a local `.env` in development and from AWS SSM Parameter Store in production. Never commit `.env` files.

## Running and testing

```bash
npm test                                              # full Vitest suite (125 tests)
npm run typecheck  --workspace=src/agents/<name>      # per-package typecheck
npm run build      --workspace=src/agents/<name>      # esbuild bundle (the Lambda artifact)
npm run test:local --workspace=src/agents/<name>      # run an agent against the real external services
npm run dev --workspace=src/services/conductor        # run Conductor locally (in-process agents, port 3001)
npm run dev --workspace=src/apps/dashboard            # run the dashboard locally
npm run experiment --workspace=src/experiments/d8-d9  # run the D8-D9 evaluation (uses most of a day's Groq quota)
```

## Deploying

```bash
cd src/infra/cdk && npx cdk diff && npx cdk deploy --require-approval never
```

Build every agent first; CDK packages each agent's existing `dist/`. Conductor's application code is deployed separately (bundle to S3, then install and restart on EC2 via SSM). The exact steps are in [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md).

## Evaluation

27 controlled test cases, three baselines and a six-condition ablation study; see [`results/d8-d9-experimental-report.md`](results/d8-d9-experimental-report.md). In short, SAGE never approved a service that broke a stated requirement, escalated every impossible request to a human, and is the only approach tested that keeps a complete decision record. On this small catalogue, a single LLM given the whole catalogue picked the best option more often (100% against 88.9%).

## Documentation

- [`docs/spec.md`](docs/spec.md): original requirements and scope
- [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md): dated status of every milestone and the reasoning behind each change
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md): demonstration guide and service catalogue
- [`docs/iam-policy-review.md`](docs/iam-policy-review.md): least-privilege review of every IAM role

Current release: `v1.0` (released 2026-10-05).
