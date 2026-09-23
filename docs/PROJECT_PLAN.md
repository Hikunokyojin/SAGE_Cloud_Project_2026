# SAGE — Project Plan & Status

Last updated: 2026-09-16. This file tracks real, verified status against the plan — not aspirational status. If a task isn't checked off, it isn't done, even if related work exists nearby. See `CLAUDE.md` for architecture/commands and `spec.md` for the original requirements this plan was built from.

## Superseding plan: the Reconciled Definition of Done

The original build plan below (Milestones 0-4) is **fully complete** as of 2026-09-16 — every task done and live-verified, including the Phase-II report (task 22). However, a new, more rigorous plan has since superseded it: `SAGE documentation/SAGE-Reconciled-Definition-of-Done.md`, merging the original spec with Dr. Priya V's suggestions (WP1-WP9, D1-D9). It asks for real rework beyond what's built — a formal mathematical Negotiator scoring model, a structurally independent Reviewer emitting `Violation` objects, a bounded re-negotiation loop that feeds violations back into Negotiator (not just "promote the next alternative"), full `DecisionProvenance` with `parentDecisionId` chains replacing the current flatter `AuditRecord`, an edge-case dataset, and (later, once confirmed) baseline/ablation experiments.

**Current status against the Reconciled DoD.** Note on numbering: the DoD document groups work into 4 macro-phases (Phase 1 = architecture freeze, Phase 2 = repo hygiene, Phase 3 = full pipeline implementation, Phase 4 = baselines/ablation); within macro-Phase 3, individual work items are labeled D2-D7 per the DoD's own sub-numbering. The two numbering schemes are distinct — "Phase 2" (repo hygiene, done) is not the same thing as "D2" (shared-types, a sub-item of macro-Phase 3, tracked below).

- **Macro-Phase 1 (architecture freeze): DONE (2026-09-16).** `SAGE documentation/` now holds a complete, self-contained architecture and technical-disclosure specification — full system description, agent responsibilities, the complete D2 shared-types design, the deterministic scoring algorithm, a formal Conductor state-transition table, a worked request lifecycle, the security architecture, and the decision-provenance/observability design. No pipeline code was touched while writing it, per the DoD's own gate.
- **Macro-Phase 2 (repo hygiene): already satisfied** by the existing deployed system — clean working tree on `develop`, repo restructured to the Phase-I layout, `README.md` written, no stray credentials. Not re-actioned separately.
- **Macro-Phase 3 (D2-D7 — full pipeline implementation): in progress.**
  - **D2 (shared types): DONE (2026-09-22).** `src/packages/shared-types` extended with `Constraint`, `Evidence`, `ServiceCandidateWithEvidence`, `ScoreBreakdown`, `Composition`, `Violation`, `ReviewerResult`, `NegotiationAttempt`, `DecisionProvenance` — purely additive, every existing type retained unchanged, no agent code modified yet. Verified: shared-types builds clean, every consumer (all 6 agents, Conductor, infra, dashboard, `@sage/audit`) typechecks clean, full test suite (81/81) unaffected.
  - **D3 (service dataset & evidence layer): DONE (2026-09-23).** `dataset/services.json` bumped to v1.1.0: every record gains `capability`, `latencyMs`, `dependencies`, `constraints` fields (additive, existing fields unchanged); one new service (TurboResize) added so `image-resizing` has 3 candidates spanning the full cost/latency/reliability space. `dataset/CHANGELOG.md` versions the dataset independently of app code. `dataset/edge-case-scenarios.md` maps all 9 required edge-case categories (low-cost, high-performance, high-reliability, cost/performance trade-off, multiple constraints, constraint conflict, no-valid-solution, re-negotiation-required, multiple-valid-candidates) to concrete, reproducible requests. `seed-services.ts`/`reembed-services.ts` widened to the new schema. Verified: dataset validates, both scripts typecheck, full suite (81/81) unaffected. **Applied to the live system (2026-09-23)**: `seed-services` upserted all 21 records into production MongoDB, `reembed-services` dropped and rebuilt the live Qdrant `services` collection with the new set. Live-verified: a real request ("fastest possible image resizing service") through the public API now retrieves `svc-turboresize` as a candidate alongside `svc-fastresize`/`svc-budgetresize` — confirms the new dataset is live. Negotiator still scores on price/uptime only (not yet `latencyMs`), correctly, since that dimension isn't consumed by agent logic until D4.
  - D4.1-D4.5 (core agents rework: Intent, Broker, deterministic Negotiator, independent Reviewer, Explainer, adopting the Phase-3 types above): not started.
  - D5 (bounded re-negotiation loop, Violation-fed): not started.
  - D6.1-D6.3 (decision provenance, context minimization, real Lambda isolation): not started.
  - D7 (end-to-end integration of the above): not started.
- **Macro-Phase 4 (D8-D9 — baselines & ablation): explicitly deferred**, per the DoD's own stated open question and the user's confirmation — not started until D1-D7 are complete and separately confirmed.

## How to pick this project up cold

1. Read `CLAUDE.md` (architecture, current deviations from spec, commands).
2. Read `SAGE documentation/SAGE-Reconciled-Definition-of-Done.md` — the current, active plan (supersedes the milestone plan below).
3. Read this file (exact status, what's left, against both the old and new plans).
4. Read `spec.md` (original requirements — still the source of truth for *scope* not covered by the Reconciled DoD).
5. Live system: API Gateway URL, EC2 IP, Lambda function names, and the exact deployment method are all in this file's "Deployed AWS resources" section below — don't rediscover them from scratch.

## Milestone status (original plan — fully complete, kept as historical record)

### ✅ Milestone 0 — Hygiene & repo realignment — DONE
- Leaked AWS credential CSVs rotated and moved out of the documentation folder by the user.
- `main`/`origin/main` divergence reconciled.
- Repo restructured to the Phase-I layout (`docs/`, `architecture/`, `dataset/`, `src/`).
- Branch model adopted: `main → develop → feature/*`. PR #1 (`feature/pipeline-wiring` → `develop`) merged.
- Real `README.md` written.

### ✅ Milestone 1 — Local pipeline wiring — DONE
- Lambda handler wrappers: turned out to already be satisfied (all 5 original agents already exported a directly Lambda-compatible `handler`) — verified by building and `require()`-ing the bundle, not assumed.
- Input Guard built (`src/agents/input-guard`) — rule-based, sanitize-and-continue.
- Conductor wired: `src/services/conductor/src/pipeline.ts` implements the real 6-stage orchestration with a retry loop and escalation branch.
- `shared-types` extended for Input Guard and escalation payloads.
- Vitest test framework added at the root; 56 tests across all packages.
- Reviewer's retry/escalation path covered by unit tests (and later, live-verified — see Milestone 4).

### ✅ Milestone 2 — Deploy to AWS — DONE
- Full CDK stack authored (`src/infra/cdk`): 7 Lambda functions, VPC (zero NAT gateways), EC2 + API Gateway for Conductor, DynamoDB table, SNS topic. Least-privilege IAM throughout, verified by CDK assertion tests (named ARNs not wildcards, no port 22, no `bedrock:InvokeModel` anywhere).
- All 7 agent Lambdas deployed and individually live-tested via direct `aws lambda invoke`.
- **Conductor deployed to its EC2 instance** — this had NOT been done as of the initial CDK deploy; the instance existed but ran no application code, and API Gateway returned "Network error communicating with endpoint" for any request. Fixed by:
  1. Adding `ConductorDeployBucket` (private S3, `bucket.grantRead()` to the EC2 instance role only) to `conductor-construct.ts`.
  2. Bundling Conductor with esbuild (`--external` for the 6 agent packages, since they're never reached when `AGENT_INVOKE_MODE=lambda`) into a single file.
  3. `aws s3 cp` the bundle to the deploy bucket.
  4. An `aws ssm send-command` (`AWS-RunShellScript`) that installs Node.js, downloads the bundle, writes a `systemd` unit (`conductor.service`, `Restart=always`) with `AGENT_INVOKE_MODE=lambda` and the seven `*_FUNCTION_NAME` env vars, and starts it. No SSH was used at any point.
- Zero standing production credentials confirmed (Lambda execution roles, EC2 instance role via `AmazonSSMManagedInstanceCore`, secrets via SSM `SecureString`).
- **Task 14a (AWS Budgets alert) — DONE (2026-09-16).** `BudgetConstruct`: $50/month cost budget (`sage-monthly-cost-budget`), email alerts at 80% actual + 100% forecasted spend. Deployed and confirmed via `aws budgets describe-budget`. While shipping this, `cdk diff` surfaced a real, unrelated deploy-safety issue: Conductor's EC2 instance was using `ec2.MachineImage.latestAmazonLinux2023()`, which re-resolves to whatever AMI AWS most recently published on every `cdk deploy` — the next deploy of *any* kind would have silently replaced the live instance (new instance ID, Conductor's manually-installed app gone). Pinned to the AMI the instance is actually running; verified the budget deploy went out without touching the instance (`/health` still responded immediately after).

### ✅ Milestone 3 — Audit trail & observability dashboard — DONE
- **Task 15 (DynamoDB audit writes):** new shared `@sage/audit` package (`recordDecision`), called from all 6 agent handlers (Input Guard, Intent, Broker, Negotiator, Reviewer, both Explainer entry points) after each decision. Best-effort (logged, non-fatal on failure) so a DynamoDB hiccup never blocks the pipeline. `AgentName` gained `"InputGuardAgent"`. All 7 Lambdas granted scoped `dynamodb:PutItem` + `AUDIT_TABLE_NAME` env var via CDK. **Live-verified**: a real request through the public API produced 7 correctly-ordered `agent_decisions` records for that `requestId`, including both Reviewer attempts on a reject-then-approve retry.
- **Task 16 (CloudTrail):** new `CloudTrailConstruct` — single-region trail `sage-trail`, management events only (no data events), S3-only delivery (no CloudWatch Logs ingestion) to keep cost down for a demo-scale project. Deployed; confirmed actively logging via `aws cloudtrail get-trail-status`.
- **Tasks 17-18 (dashboard):** new `@sage/dashboard` workspace (`src/apps/dashboard`, Vite + React + TS) — submit a natural-language request and watch it flow through the live pipeline, or look up any past `requestId` and see its full step-by-step agent-decision trace (the "time-travel debugging" view). Backed by a new `GET /audit/:requestId` route on Conductor (DynamoDB `Query` on `agent_decisions`, CORS-enabled), with the EC2 instance role granted read-only (`Query`/`GetItem`/`Scan`, not write) access to the table. **Live-verified end-to-end in a real browser**: both the "submit new request → auto-loaded trace" and "look up existing requestId → trace" paths render correctly against the deployed API Gateway URL.
- Conductor's EC2 app code was redeployed via the existing S3+SSM path (no SSH) to pick up the new `/audit` route; the CDK IAM change (read grant) was deployed via `cdk deploy` (clean, additive-only diff both times).

### ✅ Milestone 4 — Security verification & final Definition-of-Done — DONE
- ✅ Task 19 (dedicated prompt-injection test suite) — **DONE (2026-09-16).** A documented, structured 21-case list (`src/agents/input-guard/src/security/cases.ts`) — true positives across all 3 categories (role-override, delimiter-injection, prompt-leak), true-negative benign controls, and 3 honestly-documented known gaps (base64 encoding, Unicode homoglyphs, non-English-language phrasing) the rule-based screen isn't expected to catch. Asserted by `prompt-injection-suite.test.ts` (21/21 pass) and rendered to a human-readable, citable artifact at `results/prompt-injection-report.md` via `npm run security-report --workspace=src/agents/input-guard`. Distinct from `index.test.ts`'s pre-existing ordinary unit tests, which remain in place.
- ✅ Task 20 (written IAM policy review) — **DONE (2026-09-16).** `docs/iam-policy-review.md`, built from policies pulled live from the deployed account (not CDK source) for all 7 agent Lambda roles and Conductor's EC2 role. Verdict: pass — no wildcard resources on any custom statement, no `bedrock:InvokeModel` anywhere, no embedded AWS credentials in any Lambda environment. Found and fixed one real issue during the review: the DynamoDB audit-write grants used `grantWriteData()` (5 actions: Batch/Put/Update/Delete/DescribeTable) when every agent only ever calls `PutItem` — tightened to a scoped `PutItem`-only grant across all 6 roles in `agents-construct.ts`, deployed, and re-verified live (all 6 expected audit records still written for a real request afterward).
- ✅ Task 21 (full live demo + DynamoDB check + dashboard trace): **DONE.** Confirmed live: a full successful request end-to-end, a zero-match failure, a genuine forced-failure escalation (real SNS publish, real AI-written remediation explanation), a DynamoDB audit record per pipeline step (verified via direct query), and the dashboard rendering the full trace in a real browser against deployed infra — all against the deployed public API, not mocks.
- ✅ Task 22 (Phase-II academic report) — **DONE (2026-09-16).** `SAGE documentation/SAGE_Phase-II_Report.docx` (kept local, not pushed to GitHub, per the plan). Restates all six objectives verbatim from `Objectives.docx` and all six novelty claims verbatim from `Novelty.docx`, each with concrete live evidence: real API request/response pairs, the 7-record DynamoDB trace, the forced-failure escalation result, `docs/iam-policy-review.md`'s verdict, and `results/prompt-injection-report.md`'s 21/21 result. Explicitly discloses the Bedrock→Groq/local-embedding deviation and its effect on the "no third-party LLM subscription" novelty claim, as required. The engineering-focused `SAGE_Technical_Documentation.pdf` (gitignored, repo root) remains a separate artifact — this report is the academic one the task calls for.
- ✅ Task 23 (final cleanup): working tree clean on `develop`, no leftover placeholder code in Conductor, README accurate.

## A real correctness fix worth knowing about: Reviewer escalation was unreachable

Found via live testing, not code review: Broker used to hard-filter candidates by `maxBudget`/`minUptime` using the exact same check Reviewer re-applied later. Since Broker already discarded anything Reviewer would reject, Reviewer could never actually reject anything a real request produced — the retry loop and SNS escalation were fully built and unit-tested but structurally unreachable end-to-end. Fixed by removing Broker's hard-constraint filter; Reviewer is now the sole enforcer. Verified live with a forced-failure request. Full details and the exact before/after are in `CLAUDE.md`'s "Reviewer escalation/retry fix" section and in `SAGE_Technical_Documentation.pdf` §7–8 if that file is still present locally.

## Known open items / risks (not yet acted on)

- Root `package.json` still declares `@aws-sdk/client-bedrock-runtime` as a dependency; nothing imports it anymore (Bedrock was fully replaced). Dead weight, safe to remove.
- Root `package.json` declares `mongodb ^7.5.0`; Broker's own manifest separately pins `^6.8.0`. Two major versions of the same package in one workspace tree.
- `MIN_SIMILARITY = 0.35` in Broker was calibrated on a handful of manually-checked query/service pairs, not a systematic evaluation — may need revisiting as more services are added to `dataset/services.json`.

## Deployed AWS resources (live as of 2026-09-14, account 420974348746, region ap-south-1)

- **API Gateway URL**: `https://hiz4sheyl5.execute-api.ap-south-1.amazonaws.com/prod/` — `POST /request` with `{"text": "..."}`, `GET /health` (via Conductor directly, not proxied specially).
- **Conductor EC2**: instance `i-03071853de7fb5e77`, Elastic IP `65.2.162.247`, port 3001, `systemd` service `conductor.service` with `Restart=always`. Access via SSM Session Manager only, no SSH.
- **Lambda functions**: `sage-input-guard`, `sage-intent`, `sage-broker`, `sage-negotiator`, `sage-reviewer`, `sage-explainer`, `sage-escalation-explainer`.
- **SSM parameters** (SecureString): `/sage/broker/MONGO_URI`, `/sage/broker/QDRANT_URL`, `/sage/broker/QDRANT_API_KEY`, `/sage/shared/GROQ_API_KEY`.
- **DynamoDB**: `agent_decisions` (live, written by every agent per request, queried by Conductor's `/audit` route).
- **SNS**: `sage-hitl-escalation` (live, verified).
- **S3**: a private `ConductorDeployBucket` (name is stack-generated, see CDK outputs) — used only to deliver Conductor's deployment bundle to its EC2 instance.
- **CloudTrail**: `sage-trail` (single-region, management events only, live and logging), with a private S3 log bucket.
- **Budgets**: `sage-monthly-cost-budget` ($50/month, email alerts at 80% actual / 100% forecasted).
- **Dashboard**: `src/apps/dashboard` (Vite + React + TS), run locally via `npm run dev --workspace=src/apps/dashboard` — not deployed to a public host (e.g. S3 static site) yet, points at the live API Gateway URL by default (editable in the UI).
- **External services**: MongoDB Atlas (`sage.services` collection, seeded with `dataset/services.json`'s 21 entries as of v1.1.0), Qdrant Cloud (`services` collection, 384-dim vectors, re-embedded to match the local model), Groq (model `openai/gpt-oss-20b`).

## Plan status: complete

Every task in this plan (Milestones 0-4, including task 22) is done and live-verified as of 2026-09-16. There is no required work remaining against the original plan. Only optional stretch items remain:

1. Deploy the dashboard to a public host (e.g. S3 + CloudFront static site) instead of running it locally for the demo — not required by the plan's stated scope, but would make the "primary UI" easier to hand off/share.
2. Apply `docs/iam-policy-review.md`'s remaining minor observations if any resurface in a future review pass — none are currently outstanding as of this update.
3. Live demo rehearsal ahead of the actual grading session — everything needed for it (API Gateway URL, dashboard, escalation test, audit trail) is deployed and working, but a dry run closer to the deadline is worth doing regardless.
