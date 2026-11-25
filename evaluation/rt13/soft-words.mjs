#!/usr/bin/env node
// RT13: soft-word requests ("cheapest", "fast", "reliable") should pick the expert's choice in
// at least 85% of cases. The expert rule: among the valid services SAGE returned (chosen plus
// alternatives, all already re-priced at the request's volume), the best one on the named
// dimension (lowest monthly price, lowest latency, highest uptime); ties all count.
//
//   node evaluation/rt13/soft-words.mjs --url http://localhost:3001 --out evaluation/results/rt13-soft-words.json
//
// Run against a Conductor started with LLM_MODE=stub so no model quota is used; preferences
// are read deterministically from the words, so stub mode tests the same code path.
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((p, a, i, all) => (a.startsWith("--") ? [...p, [a.slice(2), all[i + 1]]] : p), []));
const base = (args.url || "http://localhost:3001").replace(/\/$/, "");

const SUBJECTS = [
  "email delivery service", "object storage", "image resizing API", "user authentication with SSO",
  "geolocation lookup by IP", "full-text search", "PDF document generation", "compute instances",
  "SMS messaging", "payment processing", "message queue",
];
const WORDS = [
  { phrase: "the cheapest", field: "price", better: "min" },
  { phrase: "a cheap", field: "price", better: "min" },
  { phrase: "the fastest", field: "latencyMs", better: "min" },
  { phrase: "a low-latency", field: "latencyMs", better: "min" },
  { phrase: "the most reliable", field: "uptime", better: "max" },
  { phrase: "a dependable", field: "uptime", better: "max" },
];

const rows = [];
for (const s of SUBJECTS) {
  for (const w of WORDS) {
    const text = `I need ${w.phrase} ${s}`;
    const res = await fetch(`${base}/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    const body = await res.json().catch(() => ({}));
    const row = { text, field: w.field, status: body.status };
    if (body.status === "completed" && body.result?.chosen) {
      const pool = [body.result.chosen, ...(body.result.alternatives ?? [])].map((c) => c.service);
      const vals = pool.map((x) => x[w.field]).filter((v) => typeof v === "number");
      const best = w.better === "min" ? Math.min(...vals) : Math.max(...vals);
      const chosen = body.result.chosen.service;
      Object.assign(row, { chosen: chosen.name, chosenValue: chosen[w.field], best, candidates: pool.length, pass: chosen[w.field] === best });
    } else {
      row.pass = null; // not a selection (escalated or out of scope): excluded from the rate
    }
    rows.push(row);
    console.log(`${row.pass === null ? "skip" : row.pass ? "pass" : "FAIL"}  ${text}  ${row.chosen ?? row.status}${row.pass === false ? ` (${row.chosenValue} vs best ${row.best})` : ""}`);
  }
}
const scored = rows.filter((r) => r.pass !== null);
const passed = scored.filter((r) => r.pass).length;
const byField = Object.fromEntries(["price", "latencyMs", "uptime"].map((f) => {
  const s = scored.filter((r) => r.field === f);
  return [f, `${s.filter((r) => r.pass).length}/${s.length}`];
}));
const rate = scored.length ? passed / scored.length : 0;
const summary = { date: new Date().toISOString(), url: base, cases: rows.length, scored: scored.length, passed, rate: +rate.toFixed(3), byField, target: 0.85, pass: rate >= 0.85, rows };
console.log(`RT13: ${passed}/${scored.length} = ${(rate * 100).toFixed(1)}% (target 85%), by field ${JSON.stringify(byField)}; ${rows.length - scored.length} not scored`);
if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
process.exit(summary.pass ? 0 : 1);
