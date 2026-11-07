import { useEffect, useState } from "react";
import {
  resolveRequest,
  viewRequest,
  type Constraint,
  type PausedRequest,
  type ResolveBody,
  type ReviewLink,
} from "./review";

const OPERATOR_WORDS: Record<Constraint["operator"], string> = {
  lt: "below",
  lte: "at most",
  gt: "above",
  gte: "at least",
  eq: "exactly",
};
const FIELD_LABEL: Record<Constraint["field"], string> = { price: "Price ($)", uptime: "Uptime (%)", latencyMs: "Latency (ms)" };

// The page a human reviewer opens from the alert email (T2.3).
export function ReviewPage({ apiBase, link }: { apiBase: string; link: ReviewLink }) {
  const [paused, setPaused] = useState<PausedRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [note, setNote] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [constraints, setConstraints] = useState<Constraint[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    fetch(viewRequest(apiBase, link).url)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setPaused(body);
        setConstraints(body.intent.constraints);
        setServiceId(body.candidates[0]?.serviceId ?? "");
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load the request."));
  }, [apiBase, link]);

  async function submit(body: Omit<ResolveBody, "reviewer" | "note">) {
    if (!reviewer.trim()) {
      setActionError("Please enter your name first; it is recorded with the decision.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const { url, init } = resolveRequest(apiBase, link, { ...body, reviewer, note: note || undefined });
      const res = await fetch(url, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setOutcome(data);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "The decision could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <section className="review">
        <h2>Human review</h2>
        <p className="error">{loadError}</p>
      </section>
    );
  }
  if (!paused) return <section className="review"><p>Loading request...</p></section>;

  const done = paused.status !== "pending" || outcome !== null;
  return (
    <section className="review">
      <h2>Human review: request {paused.requestId}</h2>
      <p><strong>The user asked:</strong> {paused.intent.rawInput}</p>
      <p><strong>Why it stopped:</strong> {paused.reason}</p>
      <p><strong>What the user was told:</strong> {paused.escalation.explanation}</p>

      {paused.status !== "pending" && paused.resolution && (
        <p className="resolved">
          Already resolved: {paused.resolution.action} by {paused.resolution.reviewer} at {paused.resolution.resolvedAt}.
        </p>
      )}

      {outcome !== null && (
        <div className="resolved">
          <p>Decision saved and recorded in the audit trail.</p>
          <pre>{JSON.stringify(outcome, null, 2)}</pre>
        </div>
      )}

      {!done && (
        <>
          <label>
            Your name (recorded with the decision)
            <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
          </label>
          <label>
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>

          {paused.candidates.length > 0 && (
            <fieldset>
              <legend>Approve one of the services that were found</legend>
              {paused.candidates.map((c) => (
                <label key={c.serviceId} className="option">
                  <input type="radio" name="svc" checked={serviceId === c.serviceId} onChange={() => setServiceId(c.serviceId)} />
                  {c.name}: ${c.price}, {c.uptime}% uptime{c.latencyMs !== undefined ? `, ${c.latencyMs} ms` : ""}
                </label>
              ))}
              <button disabled={busy || !serviceId} onClick={() => submit({ action: "approve", serviceId })}>
                Approve selected service
              </button>
            </fieldset>
          )}

          <fieldset>
            <legend>Relax the requirements and try again</legend>
            {constraints.length === 0 && <p>No numeric requirements were given.</p>}
            {constraints.map((c, i) => (
              <label key={`${c.field}-${i}`} className="option">
                {FIELD_LABEL[c.field]} {OPERATOR_WORDS[c.operator]}
                <input
                  type="number"
                  step="any"
                  value={c.value}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    setConstraints((all) => all.map((k, j) => (j === i ? { ...k, value } : k)));
                  }}
                />
                {c.mandatory ? "(must)" : "(preferred)"}
              </label>
            ))}
            <button disabled={busy} onClick={() => submit({ action: "relax", constraints })}>
              Re-run with these requirements
            </button>
          </fieldset>

          <fieldset>
            <legend>Close the request</legend>
            <button disabled={busy} onClick={() => submit({ action: "reject" })}>Reject</button>
          </fieldset>

          {actionError && <p className="error">{actionError}</p>}
        </>
      )}
    </section>
  );
}
