#!/usr/bin/env node
// Load test for the SAGE Conductor (T2.8).
//
//   npm run load-test -- --url http://localhost:3001 --rps 25 --seconds 20
//
// Sends POST /request at a steady rate for a fixed time and reports throughput, latency
// percentiles and the outcome mix. Run it against a Conductor started with LLM_MODE=stub
// (and AGENT_INVOKE_MODE=local) so no free language-model quota is used:
//
//   LLM_MODE=stub AGENT_INVOKE_MODE=local npm run dev --workspace=services/conductor
//
// Do not point it at the production API: the stage is throttled to 5 req/s (T2.1), so a
// load test there mostly measures HTTP 429, and it still exercises Qdrant and MongoDB.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith("--") ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), [])
);
const base = (args.url || "http://localhost:3001").replace(/\/$/, "");
const rps = Number(args.rps || 25);
const seconds = Number(args.seconds || 20);
const total = Math.round(rps * seconds);

const PHRASES = [
  "I need a reliable email delivery service",
  "fast image resizing under 0.05 dollars",
  "cheap object storage",
  "user authentication with SSO",
  "geolocation lookup by IP",
  "compute instances with 99.9% uptime",
  "full-text search with typo tolerance",
  "PDF generation from HTML",
];

const results = [];
async function one(i) {
  const started = performance.now();
  try {
    const res = await fetch(`${base}/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${PHRASES[i % PHRASES.length]} (load ${i})` }),
    });
    let status = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.status) status = body.status;
    } catch {
      // non-JSON body (for example a gateway error page)
    }
    results.push({ ms: performance.now() - started, http: res.status, status });
  } catch (err) {
    results.push({ ms: performance.now() - started, http: 0, status: `network: ${err.message}` });
  }
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

console.log(`Load test: ${total} requests at ${rps}/s for ${seconds}s against ${base}`);
const t0 = performance.now();
const inflight = [];
for (let i = 0; i < total; i++) {
  const due = t0 + (i * 1000) / rps;
  const wait = due - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  inflight.push(one(i));
}
await Promise.all(inflight);
const elapsed = (performance.now() - t0) / 1000;

const ms = results.map((r) => r.ms).sort((a, b) => a - b);
const mix = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
console.log(`Finished in ${elapsed.toFixed(1)}s: ${(results.length / elapsed).toFixed(1)} req/s completed`);
console.log(`Latency ms: p50 ${pct(ms, 50).toFixed(0)}, p95 ${pct(ms, 95).toFixed(0)}, p99 ${pct(ms, 99).toFixed(0)}, max ${ms[ms.length - 1].toFixed(0)}`);
console.log("Outcomes:", mix);
process.exit(results.every((r) => r.http && r.http < 500) ? 0 : 1);
