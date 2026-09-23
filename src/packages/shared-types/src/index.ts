// ── Core Request/Intent Types ──────────────────────────────

export interface IntentConstraints {
  maxBudget?: number;
  minUptime?: number;
  maxLatencyMs?: number;
}

export interface Intent {
  requestId: string;
  capability: string;
  // D4.1: Intent Agent now emits the structured, weighted Constraint[] form
  // (mandatory/optional + priority) rather than the flat IntentConstraints
  // shape -- IntentConstraints itself is retained above for any external
  // consumer still on the old shape, but no agent constructs it anymore.
  constraints: Constraint[];
  rawInput: string;
}

// ── Marketplace Data Types ─────────────────────────────────

export interface ServiceCandidate {
  serviceId: string;
  name: string;
  description: string;
  price: number;
  uptime: number;
  endpoint: string;
  similarityScore?: number;
  // D4.2: surfaced from the dataset's latencyMs field (v1.1.0) so Negotiator's
  // scoring algorithm has a real latency dimension to normalize and weight,
  // not just price/uptime. Optional since older dataset records predate it.
  latencyMs?: number;
}

// ── Negotiator/Optimizer Output ────────────────────────────

export interface CompositionChoice {
  // D4.3: carries the retrieval Evidence through to the final composition and
  // explanation, not just the raw candidate fields.
  service: ServiceCandidateWithEvidence;
  score: number;
  reason: string;
}

export interface CompositionBlueprint {
  requestId: string;
  chosen: CompositionChoice;
  alternatives: CompositionChoice[];
}

// ── Explainer Output ────────────────────────────────────────
// D4.5: extends Composition (not the older CompositionBlueprint) so the final
// explained result still carries its iteration number and full ScoreBreakdown.

export interface ExplainedBlueprint extends Composition {
  explanation: string;
}

// ── Scoped Payloads (inter-agent communication) ─────────────

// D6.1: every agent input optionally carries the decisionId Conductor assigned
// to *this* invocation and the parentDecisionId of whichever prior decision fed
// into it -- letting each agent's own DecisionProvenance record link back into
// a reconstructable per-request causal chain, without changing any agent's
// actual output contract.
export interface InputGuardAgentInput {
  requestId: string;
  rawInput: string;
  decisionId?: string;
  parentDecisionId?: string;
}

export interface InputGuardAgentOutput {
  requestId: string;
  rawInput: string;
  sanitizedInput: string;
  flagged: boolean;
  detectedPatterns: string[];
}

export interface IntentAgentInput {
  requestId: string;
  rawInput: string;
  decisionId?: string;
  parentDecisionId?: string;
}

export interface BrokerAgentInput {
  requestId: string;
  capability: string;
  // Retained on the input for symmetry with the other agents and possible
  // future use, but Broker performs retrieval only -- per the architecture
  // spec (S5.3) it must never filter or rank by constraints. Enforcement is
  // exclusively Negotiator's (S5.4) and Reviewer's (S5.5) responsibility.
  constraints: Constraint[];
  decisionId?: string;
  parentDecisionId?: string;
}

export interface NegotiatorAgentInput {
  requestId: string;
  candidates: ServiceCandidateWithEvidence[];
  constraints: Constraint[];
  iteration: number;
  // D5: on a refinement iteration following a verification failure, the
  // prior iteration's violations are fed back in so re-negotiation is
  // informed rather than blind.
  priorViolations?: Violation[];
  decisionId?: string;
  parentDecisionId?: string;
}

export interface ReviewerAgentInput {
  requestId: string;
  composition: Composition;
  constraints: Constraint[];
  decisionId?: string;
  parentDecisionId?: string;
}

export interface ExplainerAgentInput {
  requestId: string;
  composition: Composition;
  // D5: when the approved composition was reached after one or more failed
  // iterations, the full refinement history is passed through so the
  // rationale can reference what was tried and rejected, not just the
  // final choice.
  negotiationHistory?: NegotiationAttempt[];
  decisionId?: string;
  parentDecisionId?: string;
}

// ── Escalation Explanation (Human-in-the-Loop context) ─────

export interface EscalationExplainerInput {
  requestId: string;
  constraints: Constraint[];
  attempts: NegotiationAttempt[];
  decisionId?: string;
  parentDecisionId?: string;
}

// Live testing surfaced a real gap after D4/D5: when Negotiator finds zero candidates
// satisfying the mandatory constraints (a "no valid solution" case, e.g. a constraint
// conflict), it never reaches Reviewer/the normal retry loop at all, so the normal
// escalation path was unreachable for that failure mode -- it just failed silently
// with no SNS notification. This input lets Conductor route that specific failure
// through the same Human-in-the-Loop escalation Reviewer already performs.
export interface UnsatisfiableEscalationInput {
  requestId: string;
  constraints: Constraint[];
  reason: string;
  decisionId?: string;
  parentDecisionId?: string;
}

export interface EscalationExplanation {
  requestId: string;
  explanation: string;
  attemptedOptions: ServiceCandidateWithEvidence[];
}

// ── Audit Trail ──────────────────────────────────────────────

export type AgentName =
  | "InputGuardAgent"
  | "IntentAgent"
  | "BrokerAgent"
  | "NegotiatorAgent"
  | "ReviewerAgent"
  | "ExplainerAgent"
  | "HumanInTheLoop";

export interface AuditRecord {
  requestId: string;
  agent: AgentName;
  timestamp: string;
  input: unknown;
  output: unknown;
  reasoning?: string;
}

// ── Graph Orchestration ──────────────────────────────────────

export interface GraphEdge {
  from: AgentName;
  to: AgentName;
  maxRetries: number;
}

export type PipelineStatus =
  | "in_progress"
  | "completed"
  | "paused_for_review"
  | "failed";

export interface PipelineState {
  requestId: string;
  status: PipelineStatus;
  currentAgent: AgentName;
  retryCount: number;
}

// ── Generalized Constraints (Phase 2 / architecture spec S6.1) ──────────────
// Extends IntentConstraints (retained, unchanged, still used by every agent
// today) with a structured, weighted representation: a list of individual
// Constraint entries distinguishing a mandatory hard filter from an optional,
// weighted preference. Agents adopt Constraint[] in a later phase; this phase
// only introduces the type.

export type ConstraintOperator = "lt" | "lte" | "gt" | "gte" | "eq";

export interface Constraint {
  field: "price" | "uptime" | "latencyMs" | string;
  operator: ConstraintOperator;
  value: number;
  mandatory: boolean; // true = hard filter, false = weighted preference
  priority?: number; // relative weight, used when mandatory = false
}

// ── Evidence (S6.2) ───────────────────────────────────────────────────────
// Attached to a ServiceCandidate to record why it was retrieved, not just
// that it was -- the retrieval source, similarity score, and timestamp.

export type EvidenceSource = "semantic-search" | "structured-metadata-store";

export interface Evidence {
  source: EvidenceSource;
  similarityScore?: number;
  matchedFields?: string[];
  retrievedAt: string; // ISO timestamp
}

export interface ServiceCandidateWithEvidence extends ServiceCandidate {
  evidence: Evidence[];
}

// ── Score Breakdown (S6.3) ────────────────────────────────────────────────
// The full per-dimension output of the deterministic scoring algorithm,
// replacing a single opaque score with a recoverable breakdown.

export interface ScoreDimensions {
  price: number;
  uptime: number;
  latency?: number;
  capability?: number;
}

export interface ScoreBreakdown {
  requestId: string;
  candidateId: string;
  dimensions: ScoreDimensions; // each normalized to [0, 1]
  weights: ScoreDimensions;
  totalScore: number;
  constraintStatus: "pass" | "fail"; // self-reported by the negotiation agent
  violatedConstraints: string[];
}

// ── Composition (S6.4) ────────────────────────────────────────────────────
// Extends CompositionBlueprint (retained, unchanged) with the iteration
// number and full score breakdown needed for the bounded refinement loop
// and the decision-provenance chain.

export interface Composition extends CompositionBlueprint {
  iteration: number;
  scoreBreakdown: ScoreBreakdown;
}

// ── Violation (S6.5) ──────────────────────────────────────────────────────
// The verification agent's structured failure output, fed back into the
// negotiation agent on the next refinement iteration.

export interface Violation {
  constraint: string;
  actualValue: number | string;
  requiredValue: number | string;
  severity: "hard" | "soft";
  affectedCandidate: string;
  correctiveAction: string;
}

// ── ReviewerResult (S6.6) ─────────────────────────────────────────────────
// Replaces the boolean-only ReviewerAgentOutput.approved with a structured
// result carrying every violation found.

export interface ReviewerResult {
  requestId: string;
  decisionId: string;
  approved: boolean;
  violations: Violation[];
  iteration: number;
  // Practical additions beyond the architecture spec's minimal definition:
  // Conductor needs the reviewed composition back (to hand to Explainer or
  // to promote on the next iteration) and an explicit escalation flag
  // (iteration reached the configured maximum without a passing result).
  composition: Composition;
  escalated: boolean;
}

// ── NegotiationAttempt (S6.6 in the architecture spec) ───────────────────
// One complete negotiation/verification round within the bounded refinement
// loop; the ordered sequence of these forms the refinement history the
// Explainer consumes on escalation.

export interface NegotiationAttempt {
  iteration: number;
  composition: Composition;
  reviewerResult: ReviewerResult;
  timestamp: string;
}

// ── DecisionProvenance (S6.7) ─────────────────────────────────────────────
// Extends AuditRecord (retained, unchanged, still what @sage/audit writes
// today) with the causal-chain fields: a stable decisionId, an optional
// parentDecisionId linking to the preceding decision, the iteration number,
// and the score/constraint/evidence context behind that specific decision.

export interface DecisionProvenance extends AuditRecord {
  decisionId: string;
  parentDecisionId?: string;
  iteration: number;
  score?: ScoreBreakdown;
  constraintStatus?: "pass" | "fail" | "n/a";
  evidence?: Evidence[];
  status: "success" | "failure" | "escalated";
}
