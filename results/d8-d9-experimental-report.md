# SAGE — D8/D9 Experimental Report: Test Suite, Baselines, and Ablation Study

Final run: 2026-10-04 (`results/d8-d9-raw-results.json`, `results/d8-d9-metrics-summary.json`), with the full-SAGE condition re-run on 2026-10-05 after adding a service-category check (see "Capability check" below). It supersedes the 2026-09-26 run, whose data is kept as `*.pre-fix.json` and compared in the "What changed from the first run" section below. Covers D8 (test suite and baselines) and D9 (experimental validation and ablation study) of the Reconciled Definition of Done.

## Methodology

- **27 controlled test cases** (`src/experiments/d8-d9/src/test-cases.ts`) across all 9 required categories: simple selection (3), cost optimization (4), performance optimization (4), reliability optimization (3), multiple constraints (4), constraint violation (2), re-negotiation (2), no valid solution (3), and human escalation (2). Each case is grounded in the real 21-service catalog (`dataset/services.json` v1.1.0). 20 cases have a valid answer. For the other 7, no service in the catalog satisfies the request, and the correct behaviour is to escalate to a human.
- **Local, in-process execution.** No Lambda invocation, no `cdk deploy`, no writes to the live audit table. Each condition calls the real agent code and the real Groq, Qdrant, and MongoDB services.
- **8 condition implementations, each run once against all 27 cases.** These are Baseline 1 (LLM only), Baseline 2 (retrieval + LLM), Full SAGE (the real `runPipeline`), and 5 single-factor ablations. D8's "Baseline 3" and D9's "B" share one run, as do "Proposed" and "A".
- **Every condition uses identical LLM settings:** Groq `openai/gpt-oss-20b`, `reasoning_effort: "low"`, `max_tokens: 1024`. These match the deployed agents.

### Metrics

- **CSR / CVR** (constraint satisfaction / violation rate): share of all 27 requests where the condition *approved* a service that does / does not satisfy the request. Satisfying means the service is in the requested capability and meets every mandatory constraint stated in the request ("under $0.05", "at least 99.5% uptime"). This is checked against real catalog values by `ground-truth.ts`, independently of the condition's own verdict. Correct escalations count in neither, so **the maximum achievable CSR is 20/27 = 74.1%**. A unit test (`ground-truth.test.ts`) verifies that every expected answer satisfies its ground truth and that the 7 escalation cases have no valid answer in the catalog.
- **Selection accuracy:** the outcome matches the expected outcome (approve or escalate) and, where the case names one, the expected best service. A valid but non-optimal pick (e.g. not the cheapest when the request asks for the cheapest) lowers selection accuracy but is *not* a violation.
- **HITL%:** share of requests where the condition's code path actually invoked the human-escalation route. Only Full SAGE and ablation F run that route. The other conditions return an "escalated" outcome without notifying anyone, so they score 0% even when they escalate correctly; use selection accuracy to compare escalation correctness.
- **Audit completeness:** share of requests that produced a decision-provenance chain in the harness (not a DynamoDB persistence check; that was verified live in D6).
- **Explanation consistency:** share of approved or escalated requests that produced a non-empty explanation. This is a proxy; it does not judge the explanation's content.
- Latency is local wall-clock time; LLM calls are counted at each call site.

## D8: Baselines vs. proposed method

| Condition | CSR | CVR | Sel. acc. | Avg tries | HITL | Latency (ms) | LLM calls/req | Audit | Expl. | Errors |
|---|---|---|---|---|---|---|---|---|---|---|
| Baseline 1: LLM only | 74.1% | 0.0% | 100.0% | 0.00 | 0.0% | 682 | 1.00 | 0.0% | 100.0% | 0.0% |
| Baseline 2: retrieval + LLM | 55.6% | 18.5% | 77.8% | 0.00 | 0.0% | 1,162 | 1.00 | 0.0% | 100.0% | 0.0% |
| Baseline 3: SAGE without Reviewer | 70.4% | 3.7% | 88.9% | 0.74 | 0.0% | 1,361 | 1.74 | 74.1% | 74.1% | 0.0% |
| Proposed: full SAGE (with capability check) | 74.1% | 0.0% | 88.9% | 0.74 | 22.2% | 1,619 | 1.74 | 96.3% | 100.0% | 3.7% |

- **Full SAGE now matches the best condition on constraint safety.** With the capability check, it reaches the maximum possible CSR (74.1%) with no violations, the same as Baseline 1. It is the only condition that also keeps a decision-provenance chain for its requests.
- **Baseline 1 is still the most accurate at choosing the *best* option** (100% against 88.9%). The likely reason is that the whole 21-service catalog fits in a single prompt, so the model sees every option at once. That approach does not scale to a realistic marketplace, and it has no decision provenance or deterministic scoring.
- **Full SAGE's three remaining misses.** Two (CO-1, CO-3) picked a valid but not the cheapest service: Intent read "the cheapest possible …; performance and uptime are a low priority" without a strong price preference. That is an Intent extraction-quality limit, not a violation. The third (NVS-3, "compute under $0.001") **failed instead of escalating**: in this run Broker's search returned no candidates at all, and the pipeline's "no candidates found" path returns a bare failure without notifying a human. That path predates the capability check and is listed as an open gap below. It also accounts for the one error and the one incomplete audit chain.
- **Baseline 2 is the least safe condition.** Its 18.5% CVR comes from picking services from the wrong capability, or ones that break stated constraints, with no checking step.

## D9: Ablation study

| Condition | CSR | CVR | Sel. acc. | Avg tries | HITL | Latency (ms) | LLM calls/req | Audit | Expl. | Errors |
|---|---|---|---|---|---|---|---|---|---|---|
| A: full SAGE (with capability check) | 74.1% | 0.0% | 88.9% | 0.74 | 22.2% | 1,619 | 1.74 | 96.3% | 100.0% | 3.7% |
| B: without Reviewer | 70.4% | 3.7% | 88.9% | 0.74 | 0.0% | 1,361 | 1.74 | 74.1% | 74.1% | 0.0% |
| C: without re-negotiation | 70.4% | 3.7% | 96.3% | 0.74 | 0.0% | 1,541 | 1.74 | 74.1% | 74.1% | 0.0% |
| D: LLM-based Negotiator | 70.4% | 0.0% | 63.0% | 0.74 | 0.0% | 2,031 | 2.67 | 74.1% | 90.5% | 22.2% |
| E: without scoped payloads | 74.1% | 3.7% | 92.6% | 0.00 | 0.0% | 744 | 1.00 | 0.0% | 100.0% | 0.0% |
| F: without provenance | 66.7% | 3.7% | 88.9% | 1.00 | 29.6% | 1,881 | 1.70 | 0.0% | 70.4% | 0.0% |

- **D, the LLM-based Negotiator: valid picks, worse choices, broken failure handling.** It never approved an invalid service (CVR 0%), but selection accuracy drops to 63.0% because it often picks a valid but non-optimal service (e.g. the cheap option when the request asked for the fastest). It also fails 6 of the 7 impossible requests outright instead of escalating them (it returns no service ID rather than declaring "no valid option"), and it needs the most LLM calls (2.67 per request). The deterministic Negotiator's advantage is optimal choices, clean escalation, and lower cost, not raw validity. *The first run's claim that D "collapses" (11.1% CSR, 88.9% errors) is retracted*: that result came from a token-budget bug that hit this condition hardest (see below).
- **E, without scoped payloads: approved an impossible request.** It approved a service for NVS-1 (100% uptime, which no service offers), and it is the only ablation to do so. Its audit completeness is 0%, the same as both baselines, because with no structured payloads there is nothing for a decision chain to attach to. Scoped payloads and provenance remain causally linked.
- **Comparing A with B–F: only A was re-run with the capability check.** B–F still run without it, so A's lower violation rate here reflects the capability check rather than the single component each ablation removes. A like-for-like ablation would need B–F re-run with the check in place.
- **B, without the Reviewer: no measurable benefit from the Reviewer on this data.** That is expected given the earlier D7 finding: the Negotiator already applies the same mandatory filters that the Reviewer re-checks (now including category), so on consistent data they never disagree. The Reviewer's value is defence in depth against a faulty Negotiator, which this dataset never produces.
- **C, without re-negotiation: highest selection accuracy (96.3%).** It also has one fewer violation than full SAGE. With one run per condition, a one-case difference (3.7 percentage points) is within noise. Since the retry loop rarely triggers on consistent data, removing it costs nothing here.
- **F, without provenance: audit completeness 0% by construction.** Its other metrics track full SAGE.

## Capability check (2026-10-05)

The 2026-10-04 run traced all of full SAGE's constraint violations to one gap: Broker's semantic search returns similar services from neighbouring categories, and nothing checked the chosen service's category. For example, "the cheapest email delivery service" chose a message queue, and "the fastest compute instances" chose an image resizer. The fix, now deployed:

- **Intent** classifies each request into one of the catalog's 17 categories, or none.
- **Broker** passes each candidate's category through.
- **Negotiator** excludes wrong-category candidates as a hard filter, so a request with no valid candidate in its category still escalates.
- **Reviewer** re-verifies the category on its own code path.

| Full SAGE | CSR | CVR | Selection accuracy | Errors | HITL | Audit |
|---|---|---|---|---|---|---|
| Without capability check (2026-10-04) | 66.7% | 7.4% | 88.9% | 0.0% | 25.9% | 100.0% |
| With capability check (2026-10-05) | **74.1%** | **0.0%** | 88.9% | 3.7% | 22.2% | 96.3% |

Both violations are gone, and both cases are now answered correctly, which was also confirmed live on the deployed system. Selection accuracy is unchanged because one other case regressed: NVS-3 failed rather than escalating, for the reason described under D8 above, which is unrelated to the capability check. That one case also accounts for the error rate, HITL, and audit differences.

**Open gap: the "no candidates found" path does not reach a human.** When Broker returns no candidates at all, the pipeline returns `failed` without notifying anyone. That breaks the design rule that every failure path must reach a human. The fix is the same as for the earlier no-valid-solution gap (route it through the escalation function), but it has not been made.

## What changed from the first run (2026-09-26)

The first run's headline numbers were dominated by a defect in how every condition called the LLM, found during a live demo dry run on 2026-10-04. `gpt-oss-20b` is a reasoning model whose hidden reasoning tokens count against `max_tokens`. With small budgets (300 for the deployed Intent agent; 100–200 in the experiment harness) and default reasoning effort, the reasoning often used the whole budget and the answer came back empty. A direct probe of Intent's prompt produced valid JSON 3/6 times before the fix and 6/6 after it.

| Condition (first run → final) | CSR | Selection accuracy | Error rate |
|---|---|---|---|
| Baseline 1: LLM only | 55.6% → 74.1% | 63.0% → 100.0% | 37.0% → 0.0% |
| Baseline 2: retrieval + LLM | 40.7% → 55.6% | 66.7% → 77.8% | 25.9% → 0.0% |
| Full SAGE | 33.3% → 66.7% | 33.3% → 88.9% | 66.7% → 0.0% |
| D: LLM-based Negotiator | 11.1% → 70.4% | 11.1% → 63.0% | 88.9% → 22.2% |
| E: without scoped payloads | 51.9% → 74.1% | 63.0% → 92.6% | 37.0% → 0.0% |

Four further corrections were made for this run:

1. **CSR/CVR now check real constraints.** The first run's checker only compared the chosen service against the test case's expected service ID. It counted a valid but non-optimal pick as a "violation", and left cases without an expected ID unscored. Both runs are now scored by the real checker. The first run's numbers happen to be unchanged by this, but the final run's are not.
2. **Full SAGE's escalations are no longer scored as failures.** Its real no-valid-solution route publishes to SNS, which the local harness has no topic for. The resulting exception was counted as a failure for Full SAGE only, while the other conditions scored the same 7 cases as escalated. The harness now treats a missing SNS topic as the escalation it represents, as it already did for the Reviewer's circuit-breaker route.
3. **Every condition got the same LLM settings.** The harness's baselines and LLM-based ablations had their own, smaller token budgets (100 for ablation D). All conditions now match the deployed agents.
4. **Results are checkpointed after each condition** instead of only at the end of a roughly one-hour run.

## Limitations

1. **Small catalog.** 21 services fit comfortably in one prompt, which favours the LLM-only baseline. The comparison would need a much larger catalog to test SAGE's retrieval-first design where it is meant to matter.
2. **Single run per condition.** LLM sampling is nondeterministic. With 27 cases, one case is 3.7 percentage points, so most gaps between SAGE variants are within noise. Only large, explained differences (D's escalation failures, E's impossible approval, Baseline 2's violation rate) should be relied on.
3. **Ground truth is hand-derived** from each request's wording and the catalog, and validated by unit test. "Cheapest" and "fastest" are treated as preferences scored by selection accuracy, not as constraints.
4. **HITL% and explanation consistency are partial measures** (see Metrics). Escalation correctness is better read from selection accuracy, and explanation quality is not judged.
5. **The local harness has no SNS topic or audit-table writes.** Both are verified on the deployed system instead (D5/D6 and the 2026-10-04 dry run).
6. **Groq free tier: 8,000 tokens per minute and 200,000 per day.** With the fixed settings, the full run completed with no rate-limit retries.
7. **Only full SAGE was re-run with the capability check.** The baselines and ablations B–F are from 2026-10-04 and run without it, so A-versus-ablation differences partly reflect the capability check.

## Summary

With the LLM defect fixed, every condition is far more reliable, and the comparison reads differently from the first run. The evaluation exposed one concrete design gap, the missing category check. That gap has since been fixed and deployed, and full SAGE now never approves an invalid service, matching the best condition on constraint safety while also keeping a decision-provenance record, which no baseline does. A single LLM call over the whole small catalog still chooses the *best* option more often (100% against 88.9%). Two ablations carry clear evidence. The deterministic Negotiator makes better choices, handles impossible requests correctly, and is cheaper than an LLM-based one. Dropping scoped payloads removes provenance entirely, and that condition also approved an impossible request. One gap remains open: when retrieval finds no candidates at all, the request fails without reaching a human.
