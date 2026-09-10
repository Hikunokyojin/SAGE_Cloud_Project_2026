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

// ── Audit Trail ──────────────────────────────────────────────

export type AgentName =
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
