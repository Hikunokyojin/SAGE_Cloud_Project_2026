#!/usr/bin/env node
// Live trial for RT7 (selection stability) and RT10 (cost per 1,000 requests).
//
//   node scripts/live-trial.mjs --url https://<api>/prod --repeats 5 --gap 3000 --out evaluation/results/rt7-raw.json
//
// Sends each request below `repeats` times to the deployed API, one at a time with a pause
// between calls (the stage is throttled and the language model is on a free tier), and writes
// every response's outcome and chosen services. The requestIds are then read back from the
// audit trail by scripts/trial-cost.py to work out the cost per request.

import { writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith("--") ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), [])
);
const base = (args.url || "").replace(/\/$/, "");
if (!base) throw new Error("--url is required");
const repeats = Number(args.repeats || 5);
const gap = Number(args.gap || 3000);
const out = args.out || "evaluation/results/rt7-raw.json";

const REQUESTS = [
  "I need a reliable email delivery service",
  "cheap object storage",
  "user authentication with SSO",
  "geolocation lookup by IP",
  "compute instances with 99.9% uptime",
  "full-text search with typo tolerance",
  "PDF generation from HTML",
  "Translate around 2 million characters of support tickets into English each month, budget $100.",
  "Take card payments for our shop and send an email receipt after each payment. Combined uptime of at least 99.5%.",
  "Store user-uploaded photos in object storage and resize each one into thumbnails. Keep the total under $100 a month.",
];

function chosenIds(body) {
  const r = body.result;
  if (!r) return [];
  if (r.chain?.steps) return r.chain.steps.map((s) => s.chosen.service.serviceId);
  return r.chosen ? [r.chosen.service.serviceId] : [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runs = [];
for (let rep = 0; rep < repeats; rep++) {
  for (const [i, text] of REQUESTS.entries()) {
    const started = performance.now();
    let status = 0, body = {};
    try {
      const res = await fetch(`${base}/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      status = res.status;
      body = await res.json().catch(() => ({}));
    } catch (err) {
      body = { error: String(err) };
    }
    const row = { case: i, repeat: rep, httpStatus: status, requestId: body.requestId ?? null, outcome: body.status ?? null, chosen: chosenIds(body), ms: Math.round(performance.now() - started) };
    runs.push(row);
    console.log(JSON.stringify(row));
    await sleep(gap);
  }
}
writeFileSync(out, JSON.stringify({ base, repeats, requests: REQUESTS, at: new Date().toISOString(), runs }, null, 1) + "\n");
console.log(`wrote ${out}`);
