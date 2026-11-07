import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { ReviewPage } from "./ReviewPage";
import { parseReviewHash } from "./review";
import {
  initiateAuthRequest, parseAuthResponse, isValid, requestUrl, requestHeaders,
  loadSession, saveSession, type Session,
} from "./auth";

// Set at build time (VITE_COGNITO_CLIENT_ID); without it the pilot sign-in is hidden.
const COGNITO = {
  region: (import.meta.env.VITE_COGNITO_REGION as string | undefined) ?? "ap-south-1",
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined,
};

function PilotSignIn({ session, onChange }: { session: Session | null; onChange: (s: Session | null) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!COGNITO.clientId) return null;

  if (isValid(session)) {
    return (
      <div className="pilot-signin">
        Signed in as <strong>{session.email}</strong> (pilot route).{" "}
        <button type="button" onClick={() => onChange(null)}>Sign out</button>
      </div>
    );
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { url, init } = initiateAuthRequest({ region: COGNITO.region, clientId: COGNITO.clientId! }, email, password);
      const res = await fetch(url, init);
      onChange(parseAuthResponse(res.status, await res.json(), email));
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="pilot-signin" onSubmit={signIn}>
      <span>Pilot users:</span>
      <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button type="submit" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

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

// The API address can be set at build time (VITE_API_BASE) so the same dashboard build works
// on any host, such as GitHub Pages; the field in the page still overrides it per browser.
const DEFAULT_API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ||
  "https://hiz4sheyl5.execute-api.ap-south-1.amazonaws.com/prod";
const REPO_URL = "https://github.com/Hikunokyojin/SAGE_Cloud_Project_2026";
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

type BackendStatus = "checking" | "online" | "paused";

// The live backend (EC2 + Lambda) can be switched off to save cost. The dashboard is hosted
// separately and stays up, so it checks /health and explains the state instead of failing.
function useBackendStatus(apiBase: string): { status: BackendStatus; recheck: () => void } {
  const [status, setStatus] = useState<BackendStatus>("checking");
  const [tick, setTick] = useState(0);
  const recheck = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    setStatus("checking");
    fetch(`${apiBase.replace(/\/$/, "")}/health`, { signal: controller.signal })
      .then((res) => setStatus(res.ok ? "online" : "paused"))
      .catch(() => setStatus("paused"))
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [apiBase, tick]);

  return { status, recheck };
}

function StatusBanner({ status, recheck }: { status: BackendStatus; recheck: () => void }) {
  if (status === "checking") return <p className="status status-checking">Checking the live backend&hellip;</p>;
  if (status === "online") return <p className="status status-online">&#9679; Live backend online</p>;
  return (
    <div className="status status-paused">
      <strong>The live demo backend is paused to save cost.</strong> The dashboard is still up, and everything works
      again as soon as the backend is switched back on. You can read how it works and see results in the{" "}
      <a href={REPO_URL} target="_blank" rel="noreferrer">
        project repository
      </a>
      , or run it yourself from there.{" "}
      <button type="button" className="link-button" onClick={recheck}>
        Check again
      </button>
    </div>
  );
}

export function App() {
  const [apiBase, setApiBase] = useState(loadApiBase);
  const { status: backendStatus, recheck } = useBackendStatus(apiBase);
  // A review link from an alert email opens the human review page above the dashboard.
  const [reviewLink] = useState(() => parseReviewHash(window.location.hash));
  const [session, setSessionState] = useState<Session | null>(loadSession);
  const setSession = (s: Session | null) => {
    saveSession(s);
    setSessionState(s);
  };
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
      const res = await fetch(requestUrl(apiBase, session), {
        method: "POST",
        headers: requestHeaders(session),
        body: JSON.stringify({ text: requestText }),
      });
      if (res.status === 429) throw new Error("Too many requests right now; wait a few seconds and try again.");
      if (res.status === 401) {
        setSession(null);
        throw new Error("Your pilot sign-in has expired; sign in again.");
      }
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
        <StatusBanner status={backendStatus} recheck={recheck} />
        <PilotSignIn session={session} onChange={setSession} />
      </header>
      {reviewLink && <ReviewPage apiBase={apiBase} link={reviewLink} />}

      <section className="panel">
        <h2>Submit a request</h2>
        <form onSubmit={submitRequest}>
          <textarea
            placeholder='e.g. "I need a cheap image resizing service under $0.05 with 99% uptime"'
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            rows={3}
          />
          <button type="submit" disabled={submitting || !requestText.trim() || backendStatus === "paused"}>
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
