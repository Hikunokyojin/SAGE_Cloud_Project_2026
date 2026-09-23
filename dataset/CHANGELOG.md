# SAGE Service Dataset — Changelog

This dataset (`services.json`) is versioned independently of the application code, since its content and schema directly affect Broker's retrieval quality and the reproducibility of any example or test request run against it.

## v1.1.0 — 2026-09-23

**Schema change (additive, backward-compatible):** every service record gained four new fields, per the D3 (service dataset & evidence layer) specification:

| Field | Type | Purpose |
|---|---|---|
| `capability` | `string` | A short, canonical capability label (e.g. `"image-resizing"`), aligned with what the Intent agent extracts from a natural-language request. Lets services be grouped by capability independent of their free-text `description`. |
| `latencyMs` | `number` | Typical response latency in milliseconds — the third scoring dimension alongside `price` and `uptime`, and what makes a "high-performance service" edge case (below) meaningfully distinct from a "high-reliability" one. |
| `dependencies` | `string[]` | `serviceId`s of other catalog services this service typically depends on in a real deployment (e.g. a payment gateway depending on an auth service). Mostly empty; populated where a realistic dependency exists. |
| `constraints` | `string[]` | Free-text operational constraints on using the service (e.g. payload size limits, retrieval-latency caveats) — distinct from a *requester's* constraints (see `IntentConstraints`/`Constraint` in `shared-types`), these describe constraints the *service itself* imposes. |

**Content change:** added one new service, `svc-turboresize` (TurboResize), to the `image-resizing` capability group specifically so that group has three candidates spanning the full cost/latency/reliability trade-off space (see the edge-case mapping in `edge-case-scenarios.md`) — previously it only had two (a cost/reliability trade-off, but no clear "high-performance" option).

**Existing 20 services:** all retained, all existing fields (`serviceId`, `name`, `description`, `price`, `uptime`, `endpoint`) unchanged in value — only the four new fields were added to each record.

## v1.0.0 — 2026-09-11

Initial dataset: 20 services across 18 capability areas, fields `serviceId`, `name`, `description`, `price`, `uptime`, `endpoint`.
