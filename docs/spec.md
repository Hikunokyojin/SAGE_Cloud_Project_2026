# SAGE (Service-Agent Graph Ecosystem) — Spec

## 1. PROJECT OVERVIEW

SAGE is an AI-driven cloud service marketplace that autonomously composes and optimizes microservice pipelines using a coordinated team of specialized AI agents, built entirely on AWS student credits, for BCSE355L (Cloud Architecture Design), an individual/solo project instructed by Dr. Priya V.

The problem: with thousands of independent microservices available, selecting and combining the right ones into a working pipeline is a manual, expertise-dependent process today. Developers must individually evaluate services on cost, performance, and reliability, then hand-wire integrations — slow, error-prone, and not scalable. Existing multi-agent AI frameworks (AutoGen, CrewAI, LangGraph) automate parts of this but suffer from four well-documented limitations, identified across a 15-paper literature survey already completed for this project: context bloat (passing full conversation history between agents inflates tokens and hallucination risk), black-box observability (no visibility into which agent made which decision), being heavily Python-centric (hard to integrate into TypeScript/JS web stacks), and no deterministic safeguards against agents looping unproductively.

SAGE's stated novelty is not any single technique (vector search, cost-aware negotiation, and circuit-breaker patterns each exist individually in prior work) but their disciplined integration into one coherent, secure, explainable system that directly answers the four framework limitations above:
- strictly-typed, scoped JSON payloads between agents instead of full conversation history
- a graph-based observability dashboard with DynamoDB-backed "time-travel debugging" of any past request
- a TypeScript-first architecture shared across frontend and backend
- a Reviewer Agent with a hard max-retries circuit breaker that escalates to a Human-in-the-Loop node + SNS alert instead of looping indefinitely

End-to-end flow: a user describes a desired capability in natural language → an **Input Guard** layer screens the request for prompt injection → an **Intent Agent** structures it into a formal request → a **Broker Agent** retrieves matching services via semantic search (Qdrant Cloud embeddings) + structured metadata filtering (MongoDB Atlas — price, uptime) → a **Negotiator Agent** deterministically selects the optimal composition via cost/uptime scoring and dependency resolution (not a repeated LLM call) → a **Reviewer Agent** validates the composition against constraints with a bounded retry limit, escalating to a human via SNS if exceeded → an **Explainer Agent** produces a transparent, human-readable rationale for the final choice via Amazon Bedrock.

AWS services in use: Amazon Bedrock (LLM inference — no third-party LLM subscription anywhere in the pipeline), AWS Lambda (per-agent isolated compute), EC2 (t2/t3.micro, hosting the always-on Conductor — a deliberate hybrid split: steady-state orchestration on EC2, bursty per-agent logic on Lambda, chosen for cost/performance reasons per the project's own literature survey), DynamoDB + CloudTrail (immutable audit trail), API Gateway (request routing), Amazon SNS (Human-in-the-Loop escalation alerts), IAM/SSM Parameter Store (least-privilege access, zero standing production credentials for any agent) — all within a metered AWS Student credit allowance.

## 2. TARGET AUDIENCE

Dual audience:
- **Academic evaluators** (Dr. Priya V and BCSE355L graders) — judged via a live demo plus the project's written report set, against the six stated objectives and their verification methods (see Definition of Done).
- **Recruiters/peers** — the finished repo and demo also need to hold up as a portfolio piece (clean code, clear README, working deploy), since Dveek intends to show it in interviews.

Primary interaction mode: a user (demoed live) types a natural-language capability request into the dashboard, and watches the request move through the agent pipeline to a final, explained, auditable service composition.

## 3. MUST-HAVES

1. **Input Guard** — a Lambda-based (or Input-Guard-layer) screen for prompt injection that runs before any LLM-facing agent processes the request; paired with least-privilege IAM roles and zero standing production credentials for any agent.
2. **Intent Agent** — parses a natural-language request into a formal, strictly-typed structured request (already scaffolded; needs to be finished/verified).
3. **Broker Agent** — retrieves candidate services via semantic search (Qdrant Cloud embeddings, generated via Bedrock) + structured metadata filtering (MongoDB Atlas — price/uptime as hard constraints, not soft semantic signals), deployed as an AWS Lambda function (already scaffolded with Bedrock/Qdrant/MongoDB wiring; needs a Lambda handler wrapper, since the current export has no invocation bootstrap).
4. **Negotiator Agent** (not yet built) — deterministically selects the optimal service composition from Broker's candidates using deterministic scoring + dependency resolution on cost/uptime — explicitly not a repeated LLM call, so the decision is reproducible and auditable. Deployed as an AWS Lambda function.
5. **Reviewer Agent** (not yet built) — validates the selected composition against constraints; enforces a hard max-retries circuit breaker, escalating to a Human-in-the-Loop node + Amazon SNS alert once the limit is hit, instead of retrying indefinitely. Deployed as an AWS Lambda function.
6. **Explainer Agent** (not yet built) — produces a human-readable rationale for the final composition via Amazon Bedrock, surfaced to the end user and the dashboard. Deployed as an AWS Lambda function.
7. **Conductor** — orchestrates the pipeline across all agents (Input Guard → Intent → Broker → Negotiator → Reviewer → Explainer), invoking Lambdas via the AWS SDK; runs as an always-on EC2-hosted service (t2/t3.micro) fronted by API Gateway (already running as an Express server on port 3001; needs invocation logic added for the new agents and deployment to EC2).
8. **Shared, strictly-typed payload contracts** (`src/packages/shared-types`) used between every agent instead of passing full conversation history — extend the existing Intent/Blueprint/AuditRecord/GraphEdge types to cover Negotiator/Reviewer/Explainer payloads.
9. **Immutable audit trail + observability dashboard** — every agent decision written to a DynamoDB table (e.g. `agent_decisions`) plus CloudTrail, queryable per request; surfaced in a graph-based, TypeScript-first dashboard UI showing step-by-step decision tracing (which agent acted, what it decided, why) for "time-travel debugging" of any past request.
11. **End-to-end live demo path** — a real natural-language request must flow through the full pipeline on deployed AWS infrastructure and produce a working, explained, audited composition, demoable live.
12. **Cost-conscious AWS architecture** — the EC2 (Conductor) + Lambda (agents) hybrid split is intentional and should be preserved; no other always-on compute should be added, and Bedrock/Qdrant Cloud/MongoDB Atlas usage should stay within the student credit allowance for the full build+demo period.
13. **Security-by-design verification** — an IAM policy review and a prompt-injection test suite run against the Input Guard layer, per the project's own stated verification method for this objective, confirming zero standing production credentials for any agent.

## 4. CONSTRAINTS & OUT-OF-SCOPE

- **Hard deadline: within 4 weeks** from today (2026-09-10) for a working live demo (this is the Phase-II build; the Phase-I report set already carries a 30 July 2026 submission date that has passed). This is aggressive for the full pipeline + dashboard + report update — scope cuts should favor a working end-to-end path over polish on any single agent.
- **AWS budget constraint**: must run within a student AWS credit allowance. The EC2 Conductor + Lambda agents split is the approved cost/performance trade-off (per the project's own Paper 14 analysis) — don't move Conductor to Lambda or add further always-on infrastructure without a reason as strong as that analysis.
- **Language/stack constraint**: TypeScript-first across the whole system (Node 22, npm workspaces) — a stated differentiator from the Python-centric competing frameworks (AutoGen, CrewAI, LangGraph); no agent should be implemented in Python.
- **No full conversation-history passing between agents** — every inter-agent payload must be a strictly-typed, scoped object from `shared-types`, not raw chat history. Core architectural constraint, not a style preference.
- **No unbounded agent retry loops** — Reviewer Agent's retry limit must be a fixed, deterministic number with an explicit human-escalation path; "keep trying until it works" is explicitly out of scope.
- **No standing production credentials for any agent** — each Lambda invocation must be authenticated/scoped independently via IAM; this is a stated security objective, not optional hardening.
- **Explicitly out of scope for this phase** (per the project's own "Future Work" section): the compliance-constraint gateway-and-masking extension to the Broker Agent (deterministic constraint extraction + encrypted masking ahead of semantic search) is a documented Phase-II *stretch goal only*, not required for this build. Hardware-isolated execution (TEE) for that extension is assessed as infeasible and fully excluded.
- Also out of scope: multi-tenant support, billing/payment integration, a public marketplace for third parties to list their own services, and horizontal scaling beyond demo-scale workload.
- `apps/` and `src/infra/` workspace folders currently exist but are empty — the dashboard app and any infra-as-code are net-new work, not migrations of existing code.
- **Naming/structure drift to reconcile**: the Phase-I docs specify repo name `SAGE_Cloud_Project_2026` and a structure with top-level `docs/`, `architecture/`, `dataset/`, `src/`, `results/` folders plus a `main → develop → feature/sage-solo` branch model with PRs. The actual local repo is named `sage` (remote: `github.com/Hikunokyojin/sage`), lives flat at the workspace root (no `docs/`/`architecture/`/`dataset/`/`results/` folders, code directly in `src/agents/`, `services/`, `packages/`), and only has a `main` branch. Decide explicitly whether to realign the repo to the Phase-I plan (rename, restructure, add branches) or update the docs to match reality — don't let this stay silently inconsistent going into Phase-II.

## 5. DELIVERABLES

1. Working monorepo at `C:\Projects\sage` (migrated off WSL to this path — already in progress) containing:
   - `src/agents/intent`, `src/agents/broker`, `src/agents/negotiator` (new), `src/agents/reviewer` (new), `src/agents/explainer` (new), and an Input Guard component — each an AWS Lambda function
   - `src/services/conductor` — orchestration API (Express), deployed to EC2 behind API Gateway
   - `src/packages/shared-types` — shared TypeScript contract types
   - `src/apps/dashboard` (new) — the observability web dashboard
   - `src/infra/` — infrastructure-as-code / deployment config for the AWS resources in use
2. Deployed AWS environment (EC2 Conductor, Lambda agents, API Gateway, DynamoDB, CloudTrail, SNS, Bedrock access, IAM/SSM config, MongoDB Atlas + Qdrant Cloud connections) reachable for a live demo.
3. A committed, clean git history on `main` (current working tree has uncommitted changes across `src/agents/broker`, `src/agents/intent`, `src/packages/shared-types`, `src/services/conductor`, `README.md`, plus an untracked `input.json` — these need to be reviewed and committed or reverted before new work stacks on top).
4. A real `README.md` (currently just the title) documenting setup, architecture, and how to run/demo the system.
5. Updated/Phase-II project report(s) in `C:\Projects\SAGE documentation` (kept local, not pushed to GitHub) building on the existing Novelty Summary, Objectives, Research Gap, Literature Survey, and Project Report documents, plus the two existing architecture diagrams (`AWS_Architecture.png`, `System_Architecture.png`).

## 6. DEFINITION OF DONE

1. Input Guard screens a request for prompt injection before any LLM-facing agent runs, and a prompt-injection test suite has been run against it.
2. All agents (Intent, Broker, Negotiator, Reviewer, Explainer) exist as independently deployable AWS Lambda functions with a working handler.
3. Conductor, running on EC2, successfully invokes the full agent chain via the AWS SDK in the correct pipeline order for a single request.
4. A natural-language request submitted through the dashboard produces a final service composition with a human-readable explanation, end-to-end, on deployed AWS infrastructure (not just localhost), deliverable within 4 weeks of 2026-09-10.
5. Reviewer Agent enforces a specific, documented retry limit (e.g., "3 attempts") and sends an SNS notification to a Human-in-the-Loop node on escalation when that limit is exceeded — verified by deliberately forcing a Reviewer Agent failure.
6. Every inter-agent payload uses a type defined in `src/packages/shared-types` — no raw conversation history is passed between agents.
7. Querying the DynamoDB audit table after a test run shows a decision record for each agent step in that request.
8. The observability dashboard displays, for at least one completed request, the full step-by-step trace of which agent acted, what it decided, and why, sourced from the DynamoDB audit trail.
9. No agent holds standing production credentials — confirmed by an IAM policy review.
10. The working tree is clean on `main` (current uncommitted changes committed or discarded) and the repo-naming/structure drift from the Phase-I docs (see Constraints) has been explicitly resolved one way or the other.
11. `README.md` documents setup, architecture, and demo instructions in more than one line.
12. At least one Phase-II report update exists in `C:\Projects\SAGE documentation` covering the built system and how it verifies against the six stated objectives.
