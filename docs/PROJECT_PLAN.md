# SAGE — Project Plan & Status

Last updated: 2026-09-15. This file tracks real, verified status against the plan — not aspirational status. If a task isn't checked off, it isn't done, even if related work exists nearby. See `CLAUDE.md` for architecture/commands and `spec.md` for the original requirements this plan was built from.

## How to pick this project up cold

1. Read `CLAUDE.md` (architecture, current deviations from spec, commands).
2. Read this file (exact status, what's left).
3. Read `spec.md` (original requirements — still the source of truth for *scope*, even though the "Current status" section below documents where the build has since deviated).
4. Live system: API Gateway URL, EC2 IP, Lambda function names, and the exact deployment method are all in this file's "Deployed AWS resources" section below — don't rediscover them from scratch.

## Milestone status

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

### ✅ Milestone 2 — Deploy to AWS — DONE, with one gap
- Full CDK stack authored (`src/infra/cdk`): 7 Lambda functions, VPC (zero NAT gateways), EC2 + API Gateway for Conductor, DynamoDB table, SNS topic. Least-privilege IAM throughout, verified by CDK assertion tests (named ARNs not wildcards, no port 22, no `bedrock:InvokeModel` anywhere).
- All 7 agent Lambdas deployed and individually live-tested via direct `aws lambda invoke`.
- **Conductor deployed to its EC2 instance** — this had NOT been done as of the initial CDK deploy; the instance existed but ran no application code, and API Gateway returned "Network error communicating with endpoint" for any request. Fixed by:
  1. Adding `ConductorDeployBucket` (private S3, `bucket.grantRead()` to the EC2 instance role only) to `conductor-construct.ts`.
  2. Bundling Conductor with esbuild (`--external` for the 6 agent packages, since they're never reached when `AGENT_INVOKE_MODE=lambda`) into a single file.
  3. `aws s3 cp` the bundle to the deploy bucket.
  4. An `aws ssm send-command` (`AWS-RunShellScript`) that installs Node.js, downloads the bundle, writes a `systemd` unit (`conductor.service`, `Restart=always`) with `AGENT_INVOKE_MODE=lambda` and the seven `*_FUNCTION_NAME` env vars, and starts it. No SSH was used at any point.
- Zero standing production credentials confirmed (Lambda execution roles, EC2 instance role via `AmazonSSMManagedInstanceCore`, secrets via SSM `SecureString`).
- **Gap: task 14a (AWS Budgets alert) was never set up.** Nothing tracks spend against the student credit allowance automatically.

### ❌ Milestone 3 — Audit trail & observability dashboard — NOT STARTED
- DynamoDB `agent_decisions` table exists (CDK-provisioned) but **no code anywhere writes to it**. No agent or Conductor code references the table.
- CloudTrail not enabled.
- `src/apps/dashboard` does not exist as a directory. The root `package.json`'s `src/apps/*` workspace glob currently matches nothing.
- Nothing here has been started at all — this is the largest remaining gap, and one of the six novelty claims (`Novelty.docx`'s "automation with accountability") has no evidence behind it yet.

### ⚠️ Milestone 4 — Security verification & final Definition-of-Done — MOSTLY NOT DONE
- ❌ Task 19 (dedicated prompt-injection test suite): partially covered — Input Guard's own `index.test.ts` tests several injection patterns as ordinary unit tests, but there's no separate, formal security-verification artifact.
- ❌ Task 20 (written IAM policy review): not done as a document. The design is least-privilege and this is enforced by CDK assertion tests, but no standalone review artifact exists.
- ⚠️ Task 21 (full live demo + DynamoDB check + dashboard trace): **partially done.** Confirmed live: a full successful request end-to-end, a zero-match failure, and a genuine forced-failure escalation (real SNS publish, real AI-written remediation explanation) — all against the deployed public API, not mocks. **Cannot** confirm the DynamoDB-per-step or dashboard-trace parts of this task, since neither exists yet (Milestone 3).
- ❌ Task 22 (Phase-II academic report): **not done.** A technical documentation PDF (`SAGE_Technical_Documentation.pdf`, in the repo root, gitignored) was generated — it's a code-analysis/architecture document for engineering purposes, not the academic report this task calls for (covering the six stated objectives, for submission alongside the existing Novelty/Objectives/Research-Gap docs).
- ✅ Task 23 (final cleanup): working tree clean on `develop`, no leftover placeholder code in Conductor, README accurate.

## A real correctness fix worth knowing about: Reviewer escalation was unreachable

Found via live testing, not code review: Broker used to hard-filter candidates by `maxBudget`/`minUptime` using the exact same check Reviewer re-applied later. Since Broker already discarded anything Reviewer would reject, Reviewer could never actually reject anything a real request produced — the retry loop and SNS escalation were fully built and unit-tested but structurally unreachable end-to-end. Fixed by removing Broker's hard-constraint filter; Reviewer is now the sole enforcer. Verified live with a forced-failure request. Full details and the exact before/after are in `CLAUDE.md`'s "Reviewer escalation/retry fix" section and in `SAGE_Technical_Documentation.pdf` §7–8 if that file is still present locally.

## Known open items / risks (not yet acted on)

- Root `package.json` still declares `@aws-sdk/client-bedrock-runtime` as a dependency; nothing imports it anymore (Bedrock was fully replaced). Dead weight, safe to remove.
- Root `package.json` declares `mongodb ^7.5.0`; Broker's own manifest separately pins `^6.8.0`. Two major versions of the same package in one workspace tree.
- `AgentName` (in `shared-types`) has no `"InputGuardAgent"` member — will need one once the audit trail (Milestone 3) needs to represent Input Guard's decisions.
- No AWS Budgets alert configured against the student credit allowance (plan task 14a).
- `MIN_SIMILARITY = 0.35` in Broker was calibrated on a handful of manually-checked query/service pairs, not a systematic evaluation — may need revisiting as more services are added to `dataset/services.json`.

## Deployed AWS resources (live as of 2026-09-14, account 420974348746, region ap-south-1)

- **API Gateway URL**: `https://hiz4sheyl5.execute-api.ap-south-1.amazonaws.com/prod/` — `POST /request` with `{"text": "..."}`, `GET /health` (via Conductor directly, not proxied specially).
- **Conductor EC2**: instance `i-03071853de7fb5e77`, Elastic IP `65.2.162.247`, port 3001, `systemd` service `conductor.service` with `Restart=always`. Access via SSM Session Manager only, no SSH.
- **Lambda functions**: `sage-input-guard`, `sage-intent`, `sage-broker`, `sage-negotiator`, `sage-reviewer`, `sage-explainer`, `sage-escalation-explainer`.
- **SSM parameters** (SecureString): `/sage/broker/MONGO_URI`, `/sage/broker/QDRANT_URL`, `/sage/broker/QDRANT_API_KEY`, `/sage/shared/GROQ_API_KEY`.
- **DynamoDB**: `agent_decisions` (provisioned, unused).
- **SNS**: `sage-hitl-escalation` (live, verified).
- **S3**: a private `ConductorDeployBucket` (name is stack-generated, see CDK outputs) — used only to deliver Conductor's deployment bundle to its EC2 instance.
- **External services**: MongoDB Atlas (`sage.services` collection, seeded with `dataset/services.json`'s 20 entries), Qdrant Cloud (`services` collection, 384-dim vectors, re-embedded to match the local model), Groq (model `openai/gpt-oss-20b`).

## Suggested next steps, in priority order

1. **Milestone 3** (DynamoDB audit writes + dashboard) — the biggest remaining functional gap and a stated must-have/novelty claim.
2. **Task 22** (Phase-II academic report) — likely time-sensitive given the original 4-week deadline from 2026-09-10.
3. Tasks 19–20 (formal prompt-injection suite + IAM review document) — lower effort, mostly a matter of writing down verification that already substantively exists in code/tests.
4. Task 14a (AWS Budgets alert) — quick, low-risk, protects against runaway spend.
