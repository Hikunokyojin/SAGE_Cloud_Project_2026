# Loophole register

Small gaps found while testing each stage. "Covered by" names the later task that fixes it;
**none** means no planned task fixes it, so it needs a decision.

| # | Found in | Loophole | Evidence | Covered by |
|---|----------|----------|----------|------------|
| L1 | T3.4 live test | Flat-plan prices ignore volume. Brevo ($7.50) and SendGrid ($19.95) are plan prices that likely do not cover 100k emails, yet they beat per-email services. | rt-live request: Brevo chosen at $7.50 for "about 100k emails a month" | **none** |
| L2 | T3.4 | Per-unit budgets ("under $0.05 per image") are compared with monthly prices, so they match almost nothing. Intent still emits raw dollar limits. | Design decision in T3.4; Intent unchanged to keep the offline T01-T08 set valid | **none** (T4.1 adds chain totals, not unit conversion) |
| L3 | T3.4 | The monthly estimate uses a fixed usage profile (100k requests, 100k emails...), not the volume the user states. | Request said 100k emails; matched the default by coincidence | **none** |
| L4 | T3.4 calibration | Out-of-catalogue refusal fell to 60% on v2 (target at least 95%). Near neighbours: Kubernetes 0.546, e-signatures 0.520. | results/retrieval-calibration-v2.json | Measured by T4.2 / RT15 in T5.2, **fix: none** |
| L5 | T3.3 / T3.4 | Measured QoS does not reach live by itself. Probes commit to the repo, but MongoDB changes only on a manual re-seed; the probe schedule only runs from `main`. RT6 passed only with a simulated outage written straight to MongoDB. | scripts/simulate-outage.ts used for RT6 | **none** |
| L6 | T3.4 live test | Uptime mark was 0 for Brevo and SES at 99.908%; the catalogue reference values used for scoring may still be the old synthetic ones. | negotiator scoreBreakdown `dimensions.uptime: 0` | **none** (to investigate) |
| L7 | T3.4 deploy | Lambdas deploy from `dist/`; a stale build gives "no differences" in `cdk diff` with no warning. Broker build on Windows needs sharp Linux binaries installed by hand. | First cdk diff empty; broker build failed | Partly T2.8 (staging stack); **build check: none** |
| L8 | T3.4 | Re-embedding drops and recreates the Qdrant collection, so live search is empty for the minutes it runs. | reembed-services.ts | **none** |
| L9 | T3.4 live test | Explainer repeats the internal price-basis text ("one seat, user, key or location"), which is awkward for non-experts. | rt-live explanation | T4.6 human rating would surface it; **fix: none** |
