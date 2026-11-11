# Runbook

Step-by-step procedures for operating SAGE. Background (hosting, pausing, quotas, recovery layers, load testing) is in [OPERATIONS.md](OPERATIONS.md), and the reasons behind the design are in [adr/](adr/README.md). Region is always `ap-south-1`. Commands are shown for Git Bash; in Windows PowerShell 5.1, run lines joined by `&&` one at a time.

## 1. Deploy

Order matters: infrastructure first, then the Conductor code.

1. **Tests:** `npm test` and `npm run typecheck` pass, and CI is green on the pull request. Merge to `develop` only when every check reports SUCCESS.
2. **Build the agents:**
   - Before the Broker on Windows: `npm install --no-save --force @img/sharp-linux-x64@0.34.5 @img/sharp-libvips-linux-x64@1.2.4`.
   - Then: `npm run build --workspace=agents/<name>` for each changed agent.
3. **Infrastructure** (from `infra/cdk`):
   - `npx cdk diff`. Stop if anything says "replace" on the Conductor instance, a table or the user pool.
   - `npx cdk deploy --require-approval never`.
4. **Conductor code:**
   - Bundle: from `services/conductor`, run `npx esbuild src/index.ts --bundle --platform=node --target=node18 --outfile=deploy-bundle.js "--external:@sage/agent-*"`.
   - Build the dashboard: `VITE_COGNITO_CLIENT_ID=<PilotUserPoolClientId> npm run build:dashboard-api`.
   - Upload the bundle to `s3://<ConductorDeployBucketName>/conductor/index.js`.
   - Sync `apps/dashboard/dist` to `.../conductor/dashboard`, then **copy `index.html` explicitly**.
   - On the instance (SSM Run Command): copy the bundle to `/opt/conductor/index.js`, sync the dashboard to `/opt/conductor/dashboard` and copy `index.html` explicitly, then `systemctl restart conductor.service`.
5. **Check:**
   - `GET /prod/health` returns ok.
   - The dashboard page loads (check the browser console for missing assets).
   - One real request completes.
   - `npm run audit:verify <its requestId>` says INTACT.

## 2. Roll back

- **Code (agents or Conductor):**
  1. Revert the merge on `develop` (`git revert -m 1 <merge commit>`) through a pull request.
  2. Redeploy with section 1.
- **Infrastructure:**
  1. Revert the CDK change the same way.
  2. Run `cdk diff`, then `cdk deploy`.
  3. If a deploy failed half-way, CloudFormation rolls back by itself; check that the stack ends in `UPDATE_ROLLBACK_COMPLETE`, then fix forward.
- **Configuration drills** (for example a forced provider failure): restore the Lambda environment variables exactly as listed below, then send one request to confirm.

| Function | Environment variables |
|---|---|
| `sage-intent` | `AUDIT_TABLE_NAME=agent_decisions`, `INTENT_CACHE_TABLE_NAME=intent_cache` |
| `sage-explainer`, `sage-escalation-explainer` | `AUDIT_TABLE_NAME=agent_decisions` |

## 3. Rotate secrets

| Secret | SSM parameter | Type | After updating it |
|---|---|---|---|
| Groq API key | `/sage/shared/GROQ_API_KEY` | SecureString | nothing: Lambdas read it on their next cold start (force one by redeploying or waiting) |
| OpenRouter API key | `/sage/shared/OPENROUTER_API_KEY` | SecureString | same as Groq |
| MongoDB URI, Qdrant URL and key | `/sage/broker/*` | SecureString | same; rotate the credential in Atlas or Qdrant first |
| Review-link signing key | `/sage/conductor/HITL_SIGNING_KEY` | SecureString | restart `conductor.service`. Links already sent stop working; re-send any pending reviews |
| Origin secret | `/sage/conductor/ORIGIN_SECRET` | String | `cdk deploy` (API Gateway reads it at deploy time), then restart `conductor.service` within a minute; requests fail with 403 in between |

Update a value without showing it on screen, for example:

```
aws ssm put-parameter --region ap-south-1 --name /sage/conductor/ORIGIN_SECRET --type String --overwrite --value "$(openssl rand -hex 32)"
```

Revoke the old key at the provider (Groq, OpenRouter, Atlas, Qdrant) after the new one works. Never paste keys into chats, tickets or commits.

## 4. Handle an escalation

An alert email (subject starting `SAGE review:` or `SAGE: request ... needs human review`) means a request was paused for a person.

1. Open the "Review and resolve" link in the email. It is valid for 7 days and only for that request.
2. Read what the user asked, why it stopped and what they were told.
3. Enter your name and choose one:
   - **Approve** one of the services that were found. Use this when it is acceptable despite the automatic verdict.
   - **Relax** a requirement and re-run. Use this when the user's limit was unrealistic; the new values are recorded.
   - **Reject.** Use this when nothing in the catalogue fits; add a note.
4. The decision is written to the audit trail, linked to the alert. Each request can be resolved once.

If the link says it is invalid or expired, or the email has no link, the request is still stored in `paused_requests` for 30 days, but it cannot be resolved without a valid link. Check `/sage/conductor/HITL_SIGNING_KEY`.

## 5. Respond to alarms

Every alarm emails `sage-hitl-escalation` when it fires and when it clears. The dashboard is `sage-operations` in CloudWatch.

| Alarm | First checks |
|---|---|
| `sage-agent-errors` | CloudWatch logs of the failing agent; the last deploy; whether Groq and OpenRouter both fail (Intent then fails requests) |
| `sage-api-5xx` | `GET /health`; `systemctl status conductor.service` over SSM; the instance state (`npm run backend:status`) |
| `sage-api-latency-p95` | X-Ray traces for slow stages; cold starts after a deploy; Groq slowness (fallback may be in use) |
| `sage-escalation-rate` | the paused requests: a catalogue gap, an Intent misreading, or a broken agent |
| `sage-groq-rate-limited` | the Groq daily quota (200k tokens); OpenRouter is answering meanwhile, but slowly |
| `sage-conductor-instance-check-reboot`, `sage-conductor-system-check-recover` | nothing to do if it clears by itself within minutes; otherwise `npm run backend:status`, and stop and start the instance |

## 6. Check the audit trail

`npm run audit:verify <requestId>` prints INTACT, or TAMPERED with the record and reason. A request created before 2026-11-07 shows its records as "written before the chain existed".
