// D8: controlled test suite (>= 20 cases) covering the 9 required categories.
//
// Built directly on top of dataset/services.json (v1.1.0, 21 services) and the 9
// documented scenarios in dataset/edge-case-scenarios.md -- each category below is a
// direct extension/multiplication of those scenarios across more capability groups
// (image-resizing, object-storage, compute, email-delivery, authentication,
// geolocation), not an invented parallel dataset.
//
// expectedOutcome/expectedServiceId are the ground truth used by metrics.ts to score
// Selection Accuracy and Constraint Satisfaction/Violation. They were derived by hand
// from the actual price/uptime/latencyMs values in dataset/services.json (reproduced
// in the comments below), the same way dataset/edge-case-scenarios.md documents its
// own worked examples -- not by running any agent and copying its answer.
//
// Important, honest caveat (see results/d8-d9-experimental-report.md "Limitations"):
// under the CURRENT Negotiator/Reviewer implementation (src/agents/negotiator/src/index.ts,
// src/agents/reviewer/src/index.ts), Negotiator already excludes any candidate that fails
// a mandatory constraint *before* scoring, and Reviewer re-derives the exact same
// mandatory-constraint check independently. The two are therefore always consistent by
// construction, which means the "re-negotiation" and "hitl-escalation" categories below
// cannot organically reach a *second* Negotiator/Reviewer round through Broker retrieval
// alone (that would require Negotiator and Reviewer to disagree, which the D4/D5 fix
// deliberately eliminated) -- and Reviewer's iteration>=MAX_RETRIES circuit breaker is
// consequently unreachable through the full pipeline today, the same way the pre-D4/D5
// "Reviewer escalation/retry fix" described in CLAUDE.md was unreachable before that fix.
// Those two categories are therefore constructed as the only two paths that DO reach
// escalation in the current code: Negotiator finding zero eligible candidates at all
// (a genuine constraint conflict or literally-impossible constraint), which routes through
// Conductor's escalateUnsatisfiable path. This is reported as a real, current architectural
// finding, not worked around by faking a scenario the pipeline can't actually produce.

export type TestCategory =
  | "simple-selection"
  | "cost-optimization"
  | "performance-optimization"
  | "reliability-optimization"
  | "multiple-constraints"
  | "constraint-violation"
  | "re-negotiation"
  | "no-valid-solution"
  | "hitl-escalation";

export type ExpectedOutcome = "approved" | "escalated" | "failed";

export interface TestCase {
  id: string;
  category: TestCategory;
  rawInput: string;
  expectedOutcome: ExpectedOutcome;
  /** Only meaningful when expectedOutcome === "approved" and the scenario is unambiguous. */
  expectedServiceId?: string;
  notes: string;
}

export const TEST_CASES: TestCase[] = [
  // ── 1. simple-selection (single obviously-dominant or single-candidate case) ──
  {
    id: "SS-1",
    category: "simple-selection",
    rawInput: "I need the cheapest available email delivery service, reliability is not a concern.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-emailapi",
    notes: "Only one email-delivery candidate exists in the catalog (MailRelay, price 0.001).",
  },
  {
    id: "SS-2",
    category: "simple-selection",
    rawInput: "I need a managed authentication service with OAuth2 support.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-authservice",
    notes: "Only one authentication candidate exists (SecureAuth, price 0.0).",
  },
  {
    id: "SS-3",
    category: "simple-selection",
    rawInput: "I need an IP geolocation lookup API.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-geolocation",
    notes: "Only one geolocation candidate exists (GeoLocate).",
  },

  // ── 2. cost-optimization ──
  {
    id: "CO-1",
    category: "cost-optimization",
    rawInput: "I need the cheapest possible image resizing service; performance and uptime are a low priority.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-budgetresize",
    notes: "image-resizing: budgetresize 0.005 < fastresize 0.02 < turboresize 0.045.",
  },
  {
    id: "CO-2",
    category: "cost-optimization",
    rawInput: "I need the cheapest object storage service available, I don't care how slow it is.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-budgetstorage",
    notes: "object-storage: budgetstorage (ArchiveBin) 0.004 < objectstorage (CloudVault) 0.023.",
  },
  {
    id: "CO-3",
    category: "cost-optimization",
    rawInput: "I need the cheapest compute instances, uptime doesn't matter for this batch job.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-computespot",
    notes: "compute: computespot (SpotCompute) 0.008 << computereserved (SteadyCompute) 0.12.",
  },

  // ── 3. performance-optimization ──
  {
    id: "PO-1",
    category: "performance-optimization",
    rawInput: "I need the fastest possible image resizing service; budget is a low priority.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-turboresize",
    notes: "Doc scenario 2: turboresize 45ms beats fastresize 180ms and budgetresize 650ms.",
  },
  {
    id: "PO-2",
    category: "performance-optimization",
    rawInput: "I need the lowest-latency object storage service, cost is not a factor.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-objectstorage",
    notes: "object-storage: objectstorage 60ms vs budgetstorage 1200ms.",
  },
  {
    id: "PO-3",
    category: "performance-optimization",
    rawInput: "I need the fastest compute instances available, price is not important.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-computereserved",
    notes: "compute: computereserved 200ms vs computespot 3000ms.",
  },

  // ── 4. reliability-optimization (mandatory uptime constraint) ──
  {
    id: "RO-1",
    category: "reliability-optimization",
    rawInput: "I need a compute service with guaranteed uptime, at least 99.9%.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-computereserved",
    notes: "Doc scenario 3: computereserved 99.99% passes; computespot 95.0% is a mandatory-constraint exclusion.",
  },
  {
    id: "RO-2",
    category: "reliability-optimization",
    rawInput: "I need an object storage service with at least 99.5% uptime guaranteed.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-objectstorage",
    notes: "objectstorage 99.99% passes; budgetstorage 99.0% fails the mandatory 99.5% floor.",
  },
  {
    id: "RO-3",
    category: "reliability-optimization",
    rawInput: "I need an image resizing service with at least 99.8% uptime guaranteed.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-fastresize",
    notes: "fastresize 99.9% passes; turboresize 99.7% and budgetresize 97.5% both fail the mandatory 99.8% floor.",
  },

  // ── 5. multiple-constraints (>= 2 simultaneous mandatory constraints) ──
  {
    id: "MC-1",
    category: "multiple-constraints",
    rawInput: "I need an image resizing service under $0.05, at least 99.5% uptime, and under 100ms latency.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-turboresize",
    notes: "Doc scenario 5: only turboresize (0.045, 99.7%, 45ms) satisfies all three simultaneously.",
  },
  {
    id: "MC-2",
    category: "multiple-constraints",
    rawInput: "I need a compute service under $0.15, at least 99% uptime, and under 500ms latency.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-computereserved",
    notes: "computereserved (0.12, 99.99%, 200ms) passes all three; computespot fails uptime and latency.",
  },
  {
    id: "MC-3",
    category: "multiple-constraints",
    rawInput: "I need an object storage service under $0.03, at least 99.9% uptime, and under 100ms latency.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-objectstorage",
    notes: "objectstorage (0.023, 99.99%, 60ms) passes all three; budgetstorage fails uptime, price margin, and latency.",
  },

  // ── 6. constraint-violation (independently satisfiable constraints, jointly impossible) ──
  {
    id: "CV-1",
    category: "constraint-violation",
    rawInput: "I need an image resizing service under $0.01 with latency under 50ms.",
    expectedOutcome: "escalated",
    notes:
      "Doc scenario 6: turboresize meets latency (45ms) but not budget (0.045 > 0.01); budgetresize meets budget (0.005) but not latency (650ms). No candidate satisfies both -> Negotiator finds zero eligible candidates -> escalateUnsatisfiable.",
  },
  {
    id: "CV-2",
    category: "constraint-violation",
    rawInput: "I need a compute service under $0.01 with at least 99% uptime.",
    expectedOutcome: "escalated",
    notes:
      "computespot meets budget (0.008) but not uptime (95% < 99%); computereserved meets uptime (99.99%) but not budget (0.12 > 0.01). Constraint conflict -> escalated.",
  },

  // ── 7. re-negotiation (exercises the D5 bounded refinement loop mechanism) ──
  {
    id: "RN-1",
    category: "re-negotiation",
    rawInput: "I need an image resizing service under $0.05 with at least 99% uptime.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-fastresize",
    notes:
      "Doc scenario 9 (the architecture spec's worked re-negotiation example): budgetresize (0.005, 97.5%) fails the mandatory 99% uptime floor and fastresize (0.02, 99.9%) passes. NOTE (see file header + report Limitations): under the current Negotiator implementation, Negotiator's own mandatory-constraint pre-filter already excludes budgetresize before scoring, so this converges to fastresize on iteration 1 rather than needing a second round -- reported honestly as a current-architecture finding, not simulated as a 2-iteration case.",
  },
  {
    id: "RN-2",
    category: "re-negotiation",
    rawInput: "I need an object storage service under $0.03 with at least 99.5% uptime.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-objectstorage",
    notes:
      "Same structure as RN-1 (a cheaper candidate that fails the mandatory uptime floor, alongside one that passes) applied to object-storage, to give the metric a second independent data point.",
  },

  // ── 8. no-valid-solution (mandatory constraint impossible for any candidate) ──
  {
    id: "NVS-1",
    category: "no-valid-solution",
    rawInput: "I need an image resizing service with 100% uptime guaranteed.",
    expectedOutcome: "escalated",
    notes: "Doc scenario 7: no candidate can satisfy a literal 100% uptime guarantee.",
  },
  {
    id: "NVS-2",
    category: "no-valid-solution",
    rawInput: "I need an object storage service with latency under 10ms.",
    expectedOutcome: "escalated",
    notes: "The fastest object-storage candidate (objectstorage) is 60ms; no candidate can satisfy <10ms.",
  },
  {
    id: "NVS-3",
    category: "no-valid-solution",
    rawInput: "I need a compute service under $0.001 per unit.",
    expectedOutcome: "escalated",
    notes: "Cheapest compute candidate (computespot) is 0.008; no candidate can satisfy <0.001.",
  },

  // ── 9. HITL escalation (routes to the same Human-in-the-Loop / SNS channel) ──
  {
    id: "HITL-1",
    category: "hitl-escalation",
    rawInput: "I need an email delivery service under $0.0001 with at least 99.99% uptime.",
    expectedOutcome: "escalated",
    notes:
      "Only email-delivery candidate (svc-emailapi, 0.001, 99.7%) fails both bounds -> Negotiator finds zero eligible candidates -> escalateUnsatisfiable -> SNS Human-in-the-Loop notification. (See file header: this and NVS-*/CV-* are the only escalation-reaching paths in the current code -- Reviewer's iteration>=MAX_RETRIES circuit breaker is not separately exercisable through the full pipeline today.)",
  },
  {
    id: "HITL-2",
    category: "hitl-escalation",
    rawInput: "I need a messaging service under $0.001 with latency under 10ms.",
    expectedOutcome: "escalated",
    notes: "Only messaging candidate (svc-smsapi, 0.012, 500ms) fails both bounds -> escalateUnsatisfiable.",
  },

  // ── extra cases to comfortably clear the 20-case minimum with more capability coverage ──
  {
    id: "CO-4",
    category: "cost-optimization",
    rawInput: "I need the cheapest full-text search indexing service.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-searchindex",
    notes: "Only one full-text-search candidate exists (FastSearch, 0.04) -- trivial single-candidate cost case.",
  },
  {
    id: "PO-4",
    category: "performance-optimization",
    rawInput: "I need the lowest-latency message queue service.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-queueservice",
    notes: "Only one message-queue candidate exists (QueueRunner, 15ms) -- trivial single-candidate latency case.",
  },
  {
    id: "MC-4",
    category: "multiple-constraints",
    rawInput: "I need a document generation service under $0.02 with at least 98% uptime.",
    expectedOutcome: "approved",
    expectedServiceId: "svc-pdfgen",
    notes: "Only one document-generation candidate exists (DocForge, 0.01, 98.8%) and it satisfies both bounds.",
  },
];

// Lowercase alias used by run-experiments.ts (the D8/D9 orchestrator script).
export const testCases = TEST_CASES;

export function testCasesByCategory(): Record<TestCategory, TestCase[]> {
  const out = {} as Record<TestCategory, TestCase[]>;
  for (const tc of TEST_CASES) {
    (out[tc.category] ??= []).push(tc);
  }
  return out;
}
