# SAGE Service Dataset — Edge-Case Scenario Coverage

This document maps the 9 edge-case categories required by the D3 (service dataset & evidence layer) specification to concrete, reproducible example requests against `services.json` v1.1.0. Each scenario names the exact services and constraint values involved, so it can be run verbatim once the Negotiator/Reviewer rework (D4-D5) lands, and reused directly as part of the D8 test suite later.

Categories 1-4 and 8 are demonstrated primarily using the `image-resizing` capability group, which was specifically extended in v1.1.0 (see `CHANGELOG.md`) to contain three candidates spanning the full cost/latency/reliability space:

| Service | Price | Uptime | Latency |
|---|---|---|---|
| `svc-budgetresize` (BudgetResize) | 0.005 | 97.5% | 650ms |
| `svc-fastresize` (FastResize) | 0.02 | 99.9% | 180ms |
| `svc-turboresize` (TurboResize) | 0.045 | 99.7% | 45ms |

## 1. Low-cost service

Request: *"I need the cheapest available email delivery service, reliability is not a concern."*
Capability: `email-delivery`. Only one candidate exists (`svc-emailapi`, MailRelay, price 0.001) — demonstrates the trivial single-candidate, price-dominant case.

## 2. High-performance service

Request: *"I need the fastest possible image resizing service; budget is a low priority."*
Capability: `image-resizing`, optional preference weighted heavily toward `latencyMs`. Expected selection: `svc-turboresize` (45ms) over `svc-fastresize` (180ms) and `svc-budgetresize` (650ms), despite not being the cheapest — demonstrates the negotiation algorithm's weighted-preference mechanism operating on a dimension other than price.

## 3. High-reliability service

Request: *"I need a compute service with guaranteed uptime, at least 99.9%."*
Capability: `compute`, mandatory constraint `uptime >= 99.9`. Candidates: `svc-computereserved` (SteadyCompute, 99.99%) passes; `svc-computespot` (SpotCompute, 95.0%) is excluded outright as a mandatory-constraint failure, not merely scored lower.

## 4. Cost/performance trade-off

Request: *"I need an image resizing service, balance cost and uptime evenly."*
Capability: `image-resizing`, no mandatory constraints, price and uptime weighted equally. Illustrates the core scoring trade-off between `svc-budgetresize` (cheap, lower uptime) and `svc-fastresize` (more expensive, higher uptime) — this is the scenario used as the worked example in the architecture specification.

## 5. Multiple constraints

Request: *"I need an image resizing service under $0.05, at least 99.5% uptime, and under 100ms latency."*
Capability: `image-resizing`, three simultaneous mandatory constraints. `svc-fastresize` fails on latency (180ms); `svc-budgetresize` fails on both uptime (97.5%) and latency (650ms); only `svc-turboresize` (0.045, 99.7%, 45ms) satisfies all three simultaneously — demonstrates a candidate set narrowed to exactly one valid result by the joint application of several mandatory filters, not any single one alone.

## 6. Constraint conflict

Request: *"I need an image resizing service under $0.01 with latency under 50ms."*
Capability: `image-resizing`. No candidate satisfies both: `svc-turboresize` meets the latency bound (45ms) but not the budget (0.045 > 0.01); `svc-budgetresize` meets the budget (0.005) but not the latency (650ms >> 50ms). Distinguished from "no valid solution" (below) in that each individual constraint is independently satisfiable by some candidate in the group — the conflict is between the two constraints jointly, a realistic cost/latency tension, not an impossible or catalog-absent request.

## 7. No valid solution

Request: *"I need an image resizing service with 100% uptime guaranteed."*
Capability: `image-resizing`, mandatory constraint `uptime >= 100.0`. No candidate in the catalog — or realistically any service — can satisfy a literal 100% uptime guarantee; every candidate is excluded. Distinguished from a constraint-conflict case in that no candidate satisfies this constraint in isolation, regardless of any other constraint present.

## 8. Multiple valid candidates

Request: *"I need an image resizing service under $0.10 with at least 95% uptime."*
Capability: `image-resizing`, loosely-set mandatory constraints. All three candidates (`svc-budgetresize`, `svc-fastresize`, `svc-turboresize`) satisfy both constraints — the Negotiator must rank three simultaneously valid candidates by weighted score rather than trivially selecting the only option, and the full ranked alternative set (not just the top choice) is meaningful output.

## 9. Re-negotiation required

Request: *"I need an image resizing service under $0.05 with at least 99% uptime."*
Capability: `image-resizing`. On the first negotiation pass, the highest-scoring candidate by a price/uptime-weighted objective is `svc-budgetresize` (0.005, 97.5%) — but 97.5% fails the mandatory 99% uptime constraint on independent verification, producing a `Violation` citing the uptime gap. The second negotiation pass, informed by that violation, selects `svc-fastresize` (0.02, 99.9%), which passes. Demonstrates the bounded refinement loop completing in 2 of the configured maximum iterations. This is the same scenario reproduced as the worked example in the architecture specification and the scenario previously live-verified end-to-end (see `docs/PROJECT_PLAN.md`).
