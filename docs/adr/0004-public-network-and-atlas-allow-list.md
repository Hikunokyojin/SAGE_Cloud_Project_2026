# 0004: Public subnets, no NAT, and an open MongoDB Atlas allow list

**Status:** accepted, known trade-off.

## Context

Every dependency is a public endpoint: Groq, OpenRouter, Qdrant Cloud, MongoDB Atlas and the AWS APIs. A NAT gateway costs about $32 a month. Private connectivity to Atlas (VPC peering or PrivateLink) needs a paid Atlas tier. The agent Lambdas run outside a VPC, so their outgoing addresses are not fixed.

## Decision

- The VPC has public subnets only and zero NAT gateways.
- The Lambdas run outside the VPC.
- MongoDB Atlas must therefore allow connections from any address (`0.0.0.0/0`); access is protected by the database username and password, stored as an SSM SecureString.

## Consequences

- The database relies on credentials, not on network position. Leaking the connection string would expose the (non-sensitive, synthetic) catalogue.
- Mitigations: credentials only in SSM; rotate them per the runbook. Recommended, not yet verified: give the Atlas user read-write access to the `sage` database only.
- With real or personal data, move to a paid Atlas tier with private connectivity, or fixed outgoing addresses (a NAT gateway) plus a narrow allow list.
