# Hosting and operations

SAGE is hosted to cost as close to nothing as possible, and the expensive part can be switched off when nobody needs it.

## How it is hosted

| Part | Where | Cost |
|---|---|---|
| Dashboard (React) | **GitHub Pages**, built and published by a GitHub Action on every change | Free |
| API | Amazon API Gateway, with a request limiter in the Conductor | Free tier, then pennies at demo traffic |
| Conductor | One EC2 `t3.micro` (can be paused, see below) | Free tier for 12 months, then about $8/month |
| Agents | 8 AWS Lambda functions | Always-free tier (1M requests/month) |
| Audit trail, alerts | DynamoDB, SNS, CloudTrail | Free tier |
| Language model | Groq free tier | Free (daily token cap) |
| Vector and metadata stores | Qdrant Cloud and MongoDB Atlas free clusters | Free |

The dashboard lives on GitHub, not AWS, so it stays online whatever the backend is doing. When the backend is paused it detects that (via `/health`) and shows a notice instead of an error.

## The dashboard copy served from the API address

The Conductor also serves a copy of the dashboard at the API Gateway address (`https://<api-id>.execute-api.<region>.amazonaws.com/prod`). That copy must be built in **api mode**, which uses absolute asset paths under the stage (`/prod/assets/...`):

```bash
npm run build:dashboard-api      # writes apps/dashboard/dist with /prod/ asset paths
```

A normal build uses relative paths (`./assets/...`), which is right for GitHub Pages but breaks here: opened as `.../prod` without a trailing slash, the page loads but its script is requested from the domain root, returns 403 and the screen stays white. With absolute paths both `.../prod` and `.../prod/` work. To install it, upload `apps/dashboard/dist` to the private deploy bucket and sync it into `/opt/conductor/dashboard` on the instance over SSM; no restart is needed.

## Protecting the free quotas

Every request calls two language-model APIs on a free tier, so the public `POST /request` route is rate limited by the Conductor:

- **10 requests per visitor per hour**, and
- **60 requests per UTC day in total** (about what the Groq free tier supports).

Both are adjustable on the Conductor with the `CLIENT_HOURLY_LIMIT` and `DAILY_REQUEST_LIMIT` environment variables. Over-limit callers get HTTP 429 with a `Retry-After` header.

## Pause and resume the backend

Needs the AWS CLI with credentials allowed to describe, start and stop EC2 instances.

```bash
npm run backend:status    # instance state and whether /health answers
npm run backend:pause     # stop the Conductor instance
npm run backend:resume    # start it and wait until /health answers
```

What pausing does and does not save:

- **Saves:** the EC2 compute charge (about $8/month once the 12-month free tier has ended).
- **Does not save:** the Elastic IP that API Gateway points at, about $3.60/month while it stays allocated. Releasing it as well means re-creating it and updating the API integration through the CDK stack, so only do that for a long pause.
- **Everything else** (Lambda, DynamoDB, API Gateway, Pages) is idle-free or within free tiers.

When resumed, the Conductor starts on boot (systemd restarts it), the health check goes green and the dashboard banner disappears on its own. No redeploy is needed.

## Keeping the free databases alive

Free MongoDB Atlas and Qdrant Cloud clusters can go dormant, or be deleted, after a stretch with no activity. A weekly GitHub Action (`.github/workflows/keepalive.yml`) sends one small request while the backend is up, which touches both. It does nothing while the backend is paused, so for a **long pause** either resume briefly every few weeks or re-seed the data afterwards (`agents/broker` has `seed-services` and `reembed-services` scripts). GitHub also disables scheduled workflows after 60 days without repository activity.

## Publishing the product for real

1. `npm run backend:resume` and confirm `npm run backend:status` shows the backend healthy.
2. Review the limits above; raise `DAILY_REQUEST_LIMIT` only if you have a paid model quota.
3. Add authentication (for example an API key or Cognito) before inviting the public, since the request limits are a safety net, not access control.
4. Consider the upgrades in [ARCHITECTURE.md](ARCHITECTURE.md#known-limitations): a second availability zone and a stateless Conductor.

## Automatic recovery of the Conductor (T2.2)

The Conductor is a single EC2 instance (a documented design choice). It recovers on its own at three levels, all free:

| Failure | What notices it | What happens | Typical time |
|---|---|---|---|
| The Node process crashes | systemd (`Restart=always`, 3 s) | `conductor.service` restarts | about 5 s |
| The operating system hangs (instance status check fails) | CloudWatch alarm `sage-conductor-instance-check-reboot` (3 minutes) | instance reboots; systemd starts the service at boot | about 4 to 5 min |
| The AWS host fails (system status check fails) | CloudWatch alarm `sage-conductor-system-check-recover` (2 minutes) | EC2 auto-recovery moves the instance to healthy hardware, keeping its ID, private IP and Elastic IP, so API Gateway needs no change | about 5 to 8 min |

Both alarms also email the operator through the `sage-hitl-escalation` topic when they fire and when they clear.

A deliberate pause (`npm run backend:pause`) never triggers recovery: a stopped instance sends no status metrics, and the alarms treat missing data as healthy. Recovery also does not start a stopped instance; use `npm run backend:resume`.

### Recovery drill

Run these after any change to the instance or the alarms. Record the timings in `docs/EVALUATION.md`.

1. **Process crash:** on the instance (through Session Manager), run `sudo systemctl kill -s KILL conductor.service`. Then poll `GET /health` until it answers; it should take under 10 s.
2. **Reboot path:** run `aws ec2 reboot-instances --region ap-south-1 --instance-ids <id>`. Then poll `GET /health`; it should answer within 2 minutes, with no manual step (RT5).
3. **Alarm wiring:** run `aws cloudwatch set-alarm-state --region ap-south-1 --alarm-name sage-conductor-instance-check-reboot --state-value ALARM --state-reason drill`. Check that the alert email arrives. This really reboots the instance, so it also tests step 2.

The host-failure path cannot be triggered on purpose; AWS documents the recover action, and the alarm wiring is covered by the CDK test.
