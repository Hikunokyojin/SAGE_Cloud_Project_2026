# 0005: Secret header from API Gateway to the Conductor

**Status:** accepted, 2026-11-11.

## Context

API Gateway calls the Conductor over the public internet (an HTTP integration to the Elastic IP), so the security group has to allow port 3001 from any address. Anyone who learned the address could skip API Gateway's throttling (T2.1) and the Cognito sign-in on `/pilot/*`. API Gateway's outgoing addresses are not a fixed, published set we could allow-list. A private integration (VPC link with a load balancer) costs money.

## Decision

- API Gateway adds the header `X-Sage-Origin` to every call. Its value is an SSM String parameter, `/sage/conductor/ORIGIN_SECRET`, resolved at deploy time, so it is never in the template or in git.
- The Conductor's `originGuard` middleware refuses anything without the right value (HTTP 403), using a timing-safe comparison.
- Calls from the instance itself (`localhost`, used by SSM health checks) are always allowed.
- If no secret is configured, everything is allowed with a warning, so the rollout order cannot cause an outage.

## Consequences

- Direct requests to the IP get 403; requests through the API are unaffected.
- The value is visible to anyone who can read the API Gateway configuration or the parameter (operators only). Rotate it per the runbook; a rotation needs a `cdk deploy` so API Gateway picks up the new value.
- SSM String, not SecureString: API Gateway's integration settings cannot resolve `ssm-secure` references.
