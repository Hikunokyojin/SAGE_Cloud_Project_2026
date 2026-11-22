# 0002: Dashboard without CloudFront

**Status:** accepted, 2026-10-03. Revisit when the account is verified.

## Context

The usual AWS way to host a static dashboard is S3 behind CloudFront. Creating a CloudFront distribution failed with "account must be verified". A deploy attempt on 2026-10-03 was rolled back cleanly.

## Decision

The dashboard is served in two ways:
- by the Conductor itself, at the API Gateway address (`/prod/`);
- as a static copy on GitHub Pages, which calls the same API.

## Consequences

- No CDN: every dashboard load reaches the single EC2 instance (small files, low traffic).
- The Conductor's copy must be deployed with an explicit `index.html` copy (see OPERATIONS.md: `aws s3 sync` skipped it once and the page went blank).
- Moving to S3 + CloudFront later needs no code change, only infrastructure.
