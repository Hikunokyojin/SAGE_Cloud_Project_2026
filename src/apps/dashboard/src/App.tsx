import { useState } from "react";
import "./App.css";

interface AuditStep {
  agent: string;
  timestamp: string;
  reasoning?: string;
  input?: unknown;
  output?: unknown;
}

interface PipelineResponse {
  requestId: string;
  status?: "completed" | "paused_for_review" | "failed";
  result?: { explanation: string; chosen: { service: { name: string; price: number; uptime: number } } };
  escalation?: { explanation: string };
  error?: string;
}

const DEFAULT_API_BASE = "https://hiz4sheyl5.execute-api.ap-south-1.amazonaws.com/prod";
const API_BASE_STORAGE_KEY = "sage-dashboard-api-base";

function loadApiBase(): string {
  try {
    return localStorage.getItem(API_BASE_STORAGE_KEY) || DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <details className="json-block">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function Trace({ requestId, steps }: { requestId: string; steps: AuditStep[] }) {
  if (steps.length === 0) {
    return <p className="empty">No audit records found for {requestId} yet.</p>;
  }
  return (
    <ol className="trace">
      {steps.map((step, i) => (
        <li key={i} className="trace-step">
          <div className="trace-step-header">
            <span className="agent-badge">{step.agent}</span>
            <span className="timestamp">{formatTimestamp(step.timestamp)}</span>
          </div>
          {step.reasoning && <p className="reasoning">{step.reasoning}</p>}
          <div className="json-blocks">
            <JsonBlock label="input" value={step.input} />
            <JsonBlock label="output" value={step.output} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function App() {
  const [apiBase, setApiBase] = useState(loadApiBase);
  const [requestText, setRequestText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<PipelineResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [lookupRequestId, setLookupRequestId] = useState("");
  const [traceSteps, setTraceSteps] = useState<AuditStep[]>([]);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);

  function persistApiBase(value: string) {
    setApiBase(value);
    try {
      localStorage.setItem(API_BASE_STORAGE_KEY, value);
    } catch {
      // localStorage unavailable (private browsing, etc.) -- non-fatal, just won't persist.
    }
  }

  async function loadTrace(requestId: string) {
    setTraceLoading(true);
    setTraceError(null);
    setActiveRequestId(requestId);
    try {
      const res = await fetch(`${apiBase.replace(/\/$/, "")}/audit/${requestId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTraceSteps(data.steps ?? []);
    } catch (err) {
      setTraceError(err instanceof Error ? err.message : "Unknown error");
      setTraceSteps([]);
    } finally {
      setTraceLoading(false);
    }
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    setPipelineResult(null);
    try {
      const res = await fetch(`${apiBase.replace(/\/$/, "")}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: requestText }),
      });
      const data: PipelineResponse = await res.json();
      setPipelineResult(data);
      await loadTrace(data.requestId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  async function lookupPastRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!lookupRequestId.trim()) return;
    setPipelineResult(null);
    await loadTrace(lookupRequestId.trim());
  }

  return (
    <div className="dashboard">
      <header>
        <h1>SAGE Observability Dashboard</h1>
        <p className="subtitle">
          Step-by-step, "time-travel debugging" view of the SAGE agent pipeline, sourced from the{" "}
          <code>agent_decisions</code> DynamoDB audit trail via Conductor's <code>GET /audit/:requestId</code>.
        </p>
        <label className="api-base">
          Conductor API base URL:
          <input value={apiBase} onChange={(e) => persistApiBase(e.target.value)} />
        </label>
      </header>

      <section className="panel">
        <h2>Submit a request</h2>
        <form onSubmit={submitRequest}>
          <textarea
            placeholder='e.g. "I need a cheap image resizing service under $0.05 with 99% uptime"'
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            rows={3}
          />
          <button type="submit" disabled={submitting || !requestText.trim()}>
            {submitting ? "Submitting..." : "Submit request"}
          </button>
        </form>
        {submitError && <p className="error">Error: {submitError}</p>}
        {pipelineResult && (
          <div className="result">
            <p>
              <strong>Request ID:</strong> {pipelineResult.requestId} &nbsp;
              <strong>Status:</strong> {pipelineResult.status}
            </p>
            {pipelineResult.result && (
              <p>
                Chosen: <strong>{pipelineResult.result.chosen.service.name}</strong> (
                {pipelineResult.result.chosen.service.price}, {pipelineResult.result.chosen.service.uptime}% uptime)
                <br />
                {pipelineResult.result.explanation}
              </p>
            )}
            {pipelineResult.escalation && (
              <p className="escalated">Escalated to Human-in-the-Loop: {pipelineResult.escalation.explanation}</p>
            )}
            {pipelineResult.error && <p className="error">{pipelineResult.error}</p>}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Look up a past request</h2>
        <form onSubmit={lookupPastRequest}>
          <input
            placeholder="requestId"
            value={lookupRequestId}
            onChange={(e) => setLookupRequestId(e.target.value)}
          />
          <button type="submit" disabled={traceLoading || !lookupRequestId.trim()}>
            Load trace
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Agent decision trace {activeRequestId && <span className="request-id">({activeRequestId})</span>}</h2>
        {traceLoading && <p>Loading...</p>}
        {traceError && <p className="error">Error: {traceError}</p>}
        {!traceLoading && !traceError && activeRequestId && <Trace requestId={activeRequestId} steps={traceSteps} />}
        {!activeRequestId && <p className="empty">Submit a request or look one up above to see its trace.</p>}
      </section>
    </div>
  );
}
