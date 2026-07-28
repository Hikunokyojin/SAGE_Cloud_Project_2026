// Core Request/Intent Types

/* Constraints the user attaches to their request */
export interface IntentConstraints {
  maxBudget?: number;        
  minUptime?: number;      
  maxLatencyMs?: number;   
}

/* Structured output of the Intent Agent */
export interface Intent {
  requestId: string;        
  capability: string;        
  constraints: IntentConstraints;
  rawInput: string;       
}

// Marketplace Data Types 

/* A single microservice entry in the catalog */
export interface ServiceCandidate {
  serviceId: string;
  name: string;
  description: string;
  price: number;            
  uptime: number;          
  endpoint: string;
  similarityScore?: number;  
}

// Negotiator/Optimizer Output 

export interface CompositionChoice {
  service: ServiceCandidate;
  score: number;            
  reason: string;            
}

/* Final composition blueprint before explanation is attached */
export interface CompositionBlueprint {
  requestId: string;
  chosen: CompositionChoice;
  alternatives: CompositionChoice[]; 
}

// Explainer Output 

export interface ExplainedBlueprint extends CompositionBlueprint {
  explanation: string;       
}

// Scoped Payloads
// Each agent receives only the fields it needs.

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
  attempt: number;         
}

export interface ExplainerAgentInput {
  requestId: string;
  blueprint: CompositionBlueprint;
}

// Audit Trail

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

// Graph Orchestration

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