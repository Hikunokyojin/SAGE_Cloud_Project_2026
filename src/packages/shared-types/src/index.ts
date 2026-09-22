// ── Core Request/Intent Types ──────────────────────────────

export interface IntentConstraints {
  maxBudget?: number;
  minUptime?: number;
  maxLatencyMs?: number;
}

export interface Intent {
  requestId: string;
  capability: string;
  constraints: IntentConstraints;
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
}

// ── Negotiator/Optimizer Output ────────────────────────────

export interface CompositionChoice {
  service: ServiceCandidate;
  score: number;
  reason: string;
}

export interface CompositionBlueprint {
  requestId: string;
  chosen: CompositionChoice;
  alternatives: CompositionChoice[];
}

// ── Explainer Output ────────────────────────────────────────

export interface ExplainedBlueprint extends CompositionBlueprint {
  explanation: string;
}

// ── Scoped Payloads (inter-agent communication) ─────────────

export interface InputGuardAgentInput {
  requestId: string;
  rawInput: string;
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
}

export interface BrokerAgentInput {
  requestId: string;
  capability: string;
  constraints: IntentConstraints;
}

export interface NegotiatorAgentInput {
  requestId: string;
  candidates: ServiceCandidate[];
  constraints: IntentConstraints;
}

export interface ReviewerAgentInput {
  requestId: string;
  blueprint: CompositionBlueprint;
  constraints: IntentConstraints;
  attempt: number;
}

export interface ReviewerAgentOutput {
  requestId: string;
  approved: boolean;
  blueprint: CompositionBlueprint;
  attempt: number;
  escalated: boolean;
}

export interface ExplainerAgentInput {
  requestId: string;
  blueprint: CompositionBlueprint;
}

// ── Escalation Explanation (Human-in-the-Loop context) ─────

export interface EscalationAttempt {
  candidate: ServiceCandidate;
  violatedConstraints: string[];
}

export interface EscalationExplainerInput {
  requestId: string;
  constraints: IntentConstraints;
  attempts: EscalationAttempt[];
}

export interface EscalationExplanation {
  requestId: string;
  explanation: string;
  attemptedOptions: ServiceCandidate[];
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
