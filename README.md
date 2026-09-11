# SAGE — Service-Agent Graph Ecosystem

SAGE is an AI-driven cloud service marketplace that autonomously composes and optimizes microservice pipelines from a natural-language request, using a coordinated chain of specialized AI agents. Built on AWS student credits for BCSE355L (Cloud Architecture Design).

Full requirements, constraints, and architecture rationale live in [`docs/spec.md`](docs/spec.md) — that's the source of truth for scope. This README covers setup, architecture, and how to run/demo the system.

## Architecture

A user's natural-language request flows through six typed stages, each a strictly-scoped JSON handoff — never raw conversation history:

```
user request → Input Guard → Intent Agent → Broker Agent → Negotiator Agent → Reviewer Agent → Explainer Agent → response
```

| Stage | What it does | Status |
|---|---|---|
| **Input Guard** | Screens the request for prompt injection before any LLM-facing agent runs | Not yet built |
| **Intent Agent** | Bedrock call that turns the natural-language request into a structured `Intent` (capability + constraints) | Implemented |
| **Broker Agent** | Semantic search (Qdrant Cloud embeddings via Bedrock Titan) + hard-constraint filtering (MongoDB Atlas — price/uptime) to find candidate services | Implemented |
| **Negotiator Agent** | Deterministic cost/uptime scoring + dependency resolution to pick the optimal composition — explicitly *not* an LLM call, so the decision is reproducible and auditable | Implemented |
| **Reviewer Agent** | Validates the chosen composition against constraints; hard max-retries circuit breaker (3 attempts) escalates to a Human-in-the-Loop node via SNS instead of looping indefinitely | Implemented |
| **Explainer Agent** | Produces a plain-language rationale for the final composition via Bedrock | Implemented |
| **Conductor** | Orchestrates the full chain via AWS SDK Lambda invocations; intended to run always-on on EC2 (t2/t3.micro) behind API Gateway | Skeleton only — not yet wired to invoke the agents |

Every inter-agent payload is a type from [`src/packages/shared-types`](src/packages/shared-types) — this shared contract layer is what keeps agents decoupled and avoids passing full conversation history between them (see `docs/spec.md` §1 for why that matters).

Architecture diagrams: [`architecture/AWS_Architecture.png`](architecture/AWS_Architecture.png), [`architecture/System_Architecture.png`](architecture/System_Architecture.png).

### Why EC2 + Lambda

The Conductor runs as steady-state, always-on orchestration on EC2, while individual agents run as bursty, isolated Lambda functions. This hybrid split is a deliberate cost/performance trade-off (see `docs/spec.md` §4) — don't move Conductor to Lambda or add other always-on compute without an equally strong reason.

### Data stores / external services

- **MongoDB Atlas** — structured service metadata (price, uptime, endpoint) for hard-constraint filtering
- **Qdrant Cloud** — vector search over service embeddings for semantic candidate retrieval
- **Amazon Bedrock** — all LLM inference (Intent, Explainer) and embeddings (Broker) — no third-party LLM API is used anywhere
- **DynamoDB + CloudTrail** *(planned)* — immutable per-agent audit trail
- **SNS** *(planned deployment; logic already implemented in Reviewer)* — Human-in-the-Loop escalation alerts

## Repository structure

```
docs/           spec.md (source of truth) and other project documentation
architecture/   architecture diagrams
dataset/        seed data for the service marketplace (not yet populated)
results/        demo outputs / audit evidence (not yet populated)
src/
  agents/       one folder per agent (intent, broker, negotiator, reviewer, explainer)
  services/     conductor (orchestration API)
  packages/     shared-types (contract layer)
  apps/         dashboard (observability UI — not yet built)
  infra/        infrastructure-as-code (not yet built)
```

This is an npm workspaces monorepo (workspaces: `src/apps/*`, `src/services/*`, `src/agents/*`, `src/packages/*`). Built and tested with Node 22+ (no `engines` field is enforced yet).

## Setup

```bash
npm install
```

Each agent that calls external services (Bedrock, MongoDB, Qdrant) needs its own `.env` file — see `src/agents/broker/.env` for the expected variables (`MONGO_URI`, `QDRANT_URL`, `QDRANT_API_KEY`, `AWS_REGION`). Never commit `.env` files; they're gitignored.

## Running locally

Per-agent (`src/agents/intent`, `src/agents/broker`, `src/agents/negotiator`, `src/agents/reviewer`, `src/agents/explainer`):

```bash
npm run test:local --workspace=src/agents/<name>   # runs src/local-test.ts via tsx against real Bedrock/Mongo/Qdrant — needs a valid .env
npm run typecheck --workspace=src/agents/<name>     # tsc --noEmit
npm run build --workspace=src/agents/<name>         # esbuild bundle to dist/index.js (the eventual Lambda deployment artifact)
```

Conductor (`src/services/conductor`):

```bash
npm run dev --workspace=src/services/conductor      # tsx watch, runs the Express server locally (default port 3001)
npm run build --workspace=src/services/conductor    # tsc
npm run start --workspace=src/services/conductor    # node dist/index.js
```

Shared types (`src/packages/shared-types`):

```bash
npm run build --workspace=src/packages/shared-types # tsc — run after changing shared types so dependent packages pick up dist/
```

There is currently no automated test framework (no Jest/Vitest) — the `local-test.ts` scripts make live calls to real external services rather than mocking them, so they need valid credentials and network access. A mocked unit-test layer is planned (see `docs/spec.md`).

## Deploying / demoing on AWS

Not yet available — Conductor isn't wired to invoke the agent chain, no agent is deployed as a Lambda function, and there's no infrastructure-as-code yet. This section will be filled in once that work lands; track progress against the Definition of Done in `docs/spec.md` §6.

## Status

This project is under active development against a 4-week build deadline. See `docs/spec.md` for the full must-haves list, constraints, deliverables, and Definition of Done.
