# SAGE Service Dataset — Changelog

This dataset (`services.json`) is versioned independently of the application code, since its content and schema directly affect Broker's retrieval quality and the reproducibility of any example or test request run against it.

## v2.1.0 — 2026-11-12 (flat-plan coverage, T4.1 / L1)

All 58 real services priced on a flat monthly plan now say what the plan covers, in `pricing.plan`:

- `volume: "quota"` (30 services): `included` gives the monthly usage the fee covers (for example SendGrid Essentials, 50,000 emails).
- `volume: "unmetered"` (24 services): priced per seat, key, host, site, instance or storage size, or no usage cap stated.
- `volume: "unknown"` (4 services: imgix, Segment, DeepL, Grafana Cloud): the quota could not be confirmed.
- `otherPlans: true` (54 services). **Curation rule:** where a provider has several plans or prices, the catalogue records the cheaper one and flags that other plans exist for other usage levels. The four single-price AWS/GCP pay-per-key services have no flag.
- Choices made under that rule: Zuplo takes the 100K-request figure from the pricing table, not the 1M figure in the page text. Sentry keeps the $26 annual-billing rate ($29 billed monthly). Cloudinary counts all its credits as transformations.
- Kong Konnect's $25 plan is now called "Plus".
- Sources, quotes and retrieval dates: `data/drafts/included-units.draft.json` (pages read 2026-11-12).
- `toV1` projects these as `volumeBasis`, `includedUnits` and `otherPlans`. The Explainer states what the plan includes, and that it is the cheaper plan, with other plans available.

## v2.0.0 — 2026-11-12 (live)

**`services.v2.json` is now what the live system loads.** The 213 real services were seeded into MongoDB (`seed-services --v2 --prune`) and re-embedded into Qdrant; the 21 synthetic services were deleted from both and stay in the file for offline evaluation (`synthetic: true`).

- Seeded `price` is an **estimated USD per month** at a fixed usage profile (`packages/catalogue/src/normalise.ts`); the provider's own price is kept as `listPrice`, and `priceBasis` says how the estimate was made.
- Seeded `uptime`/`latencyMs` blend measured probe results with advertised values (`qosBasis: "blended"`).
- Retrieval re-calibrated on v2: cut-off 0.38 kept (recall@5 0.952). See `docs/EVALUATION.md`.
- Rollback: `npm run seed-services` (v1) then `reembed-services`.

## v2.0.0-alpha — 2026-11-11 (`services.v2.json`)

**New schema (T3.1), in a new file; `services.json` (v1.1.0) is unchanged and still what the agents load.** Each record now states where its numbers came from and when:

| Field | Purpose |
|---|---|
| `provider` | Who runs the service |
| `pricing.{amount, unit, currency, notes}` | The price with its unit (for example "per email") and currency, not a bare number |
| `advertised.{uptime, latencyMs}` | What the provider's SLA or docs claim |
| `measured.{uptime, latencyMs, sampledAt, samples}` | What our own probes measure (T3.3); preferred over advertised values when present |
| `source.{url, retrievedAt, terms}` | The public page the record came from, the date (YYYY-MM-DD) and a terms-of-use note |
| `synthetic` | `true` for the 21 original made-up services until real ones replace them |

**Content:** the 21 v1.1.0 services, migrated unchanged (`npm run catalogue:ingest -- --from-v1`), all marked `synthetic`.

**How records get in:** only through `npm run catalogue:ingest`. It sanitises provider-written text (instruction-like or ranking-steering phrases, markup, links, hidden and control characters, and length caps of 80 characters for names and 300 for descriptions), validates every field, refuses duplicates, and prints what it cleaned or refused. Curate in a sheet copied from `data/catalogue-template.csv`.

## v1.1.0 — 2026-09-23

**Schema change (additive, backward-compatible):** every service record gained four new fields, to support evidence tracking and latency-aware scoring:

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

## v2.0.0-alpha.2 (2026-11-11)
- First real services: 27 from the official AWS Price List and Azure Retail Prices feeds
  (`npm run catalogue:import`, then `catalogue:ingest -- data/sources/cloud-prices.json`).
  List prices, us-east-1 / eastus, first paid tier; uptime from each provider's SLA page.
- New categories: database, dns, data-streaming, secrets-management, text-to-speech,
  translation, document-ocr, image-analysis (25 in total).
