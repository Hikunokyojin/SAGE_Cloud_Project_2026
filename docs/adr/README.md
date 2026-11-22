# Architecture decision records

Each record explains one decision that differs from the original specification or that a reviewer is likely to question: what was decided, why, and what it costs.

| # | Decision | Status |
|---|---|---|
| [0001](0001-groq-instead-of-bedrock.md) | Language models from Groq (with an OpenRouter fallback) instead of Amazon Bedrock | Accepted, revisit when AWS unblocks Bedrock |
| [0002](0002-dashboard-without-cloudfront.md) | Dashboard served by the Conductor and GitHub Pages instead of S3 + CloudFront | Accepted, revisit when the account is verified |
| [0003](0003-single-conductor-with-auto-recovery.md) | One Conductor EC2 instance with automatic recovery instead of a redundant cluster | Accepted for the pilot |
| [0004](0004-public-network-and-atlas-allow-list.md) | Public subnets, no NAT, and MongoDB Atlas open to all addresses (credential-protected) | Accepted, known trade-off |
| [0005](0005-origin-secret-header.md) | Secret header from API Gateway to close direct access to the Conductor port | Accepted |
