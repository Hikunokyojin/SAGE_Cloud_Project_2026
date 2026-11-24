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
// Spike (RT4): --spike-rps N --spike-at S --spike-for D raises the rate to N between S and S+D.
const spikeRps = Number(args["spike-rps"] || 0);
const spikeAt = Number(args["spike-at"] || 0);
const spikeFor = Number(args["spike-for"] || 0);
const dueTimes = [];
for (let t = 0; t < seconds; ) {
  dueTimes.push(t);
  const inSpike = spikeRps > 0 && t >= spikeAt && t < spikeAt + spikeFor;
  t += 1 / (inSpike ? spikeRps : rps);
}
const total = dueTimes.length;
const windowSec = Number(args.window || 0); // soak (RT3): report each window and check drift
const outFile = args.out; // optional JSON result file

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
    results.push({ at: (started - t0) / 1000, ms: performance.now() - started, http: res.status, status });
  } catch (err) {
    results.push({ at: (started - t0) / 1000, ms: performance.now() - started, http: 0, status: `network: ${err.message}` });
  }
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

console.log(`Load test: ${total} requests at ${rps}/s for ${seconds}s against ${base}`);
const t0 = performance.now();
const inflight = [];
for (let i = 0; i < total; i++) {
  const due = t0 + dueTimes[i] * 1000;
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

const ok = (r) => r.http && r.http < 500;
const summary = {
  url: base, rps, seconds, requests: results.length, elapsedSec: +elapsed.toFixed(1),
  completedRps: +(results.length / elapsed).toFixed(1),
  p50: Math.round(pct(ms, 50)), p95: Math.round(pct(ms, 95)), p99: Math.round(pct(ms, 99)), max: Math.round(ms[ms.length - 1]),
  errorRate: +(results.filter((r) => !ok(r)).length / results.length).toFixed(4), outcomes: mix,
};
let pass = summary.errorRate === 0;
if (windowSec > 0) {
  const windows = [];
  for (let w = 0; w * windowSec < seconds; w++) {
    const inW = results.filter((r) => r.at >= w * windowSec && r.at < (w + 1) * windowSec);
    if (!inW.length) continue;
    const wm = inW.map((r) => r.ms).sort((a, b) => a - b);
    windows.push({ fromSec: w * windowSec, n: inW.length, p50: Math.round(pct(wm, 50)), p95: Math.round(pct(wm, 95)), errors: inW.filter((r) => !ok(r)).length });
  }
  windows.forEach((w) => console.log(`  t+${w.fromSec}s: n ${w.n}, p50 ${w.p50}, p95 ${w.p95}, errors ${w.errors}`));
  // Drift: the last window's p95 may not exceed 1.5x the first's (a leak or queue build-up shows here).
  const drift = windows.length > 1 ? +(windows[windows.length - 1].p95 / Math.max(1, windows[0].p95)).toFixed(2) : 1;
  console.log(`p95 drift (last / first window): ${drift}`);
  Object.assign(summary, { windowSec, windows, p95Drift: drift });
  pass = pass && drift <= 1.5;
}
summary.pass = pass;
if (outFile) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), ...summary }, null, 2));
  console.log(`Wrote ${outFile}`);
}
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
