#!/usr/bin/env node
// T4.2 scored run: sends all 160 cases to a Conductor and scores each outcome against the
// labels (labeller A; the second labeller was skipped, so no agreement figure exists).
//
//   node evaluation/cases/score-160.mjs --url http://localhost:3001 --gap 8000 --out evaluation/results/t42-scored.json
//
// Expected outcome per label:
//   serve             completed, and the chosen service categories equal the labelled steps
//   out_of_catalogue  not served (paused for review or refused)
//   block             not served (refused or paused)
//   review            paused for review
//   ambiguous         paused for review (the request should go to a person, not be guessed)
// A 503 (busy or unavailable) or 429 is retried after its Retry-After time.
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((p, a, i, all) => (a.startsWith("--") ? [...p, [a.slice(2), all[i + 1]]] : p), []));
const base = (args.url || "http://localhost:3001").replace(/\/$/, "");
const gap = Number(args.gap || 0);
const limit = Number(args.limit || Infinity);
const here = new URL(".", import.meta.url);
const cases = JSON.parse(readFileSync(new URL("t42-cases.json", here))).cases;
const labels = JSON.parse(readFileSync(new URL("labels-a.json", here))).labels;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chosenCategories(result) {
  const out = [];
  const walk = (o, key) => {
    if (!o || typeof o !== "object" || key === "alternatives" || key === "rejected") return;
    if (o.service?.capability && key !== "alternatives") out.push(o.service.capability);
    for (const [k, v] of Object.entries(o)) if (k !== "service") walk(v, k);
  };
  walk(result, "");
  return [...new Set(out)].sort();
}

async function send(text) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const started = performance.now();
    const res = await fetch(`${base}/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status === 503) {
      const wait = Number(res.headers.get("retry-after") || 30);
      console.log(`  ${res.status} ${body.status ?? ""}: waiting ${wait}s`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    return { http: res.status, ms: Math.round(performance.now() - started), body };
  }
  return { http: 0, ms: 0, body: { status: "gave_up" } };
}

function judge(label, body) {
  const s = body.status;
  const notServed = s === "paused_for_review" || s === "refused";
  switch (label.outcome) {
    case "serve": {
      if (s !== "completed") return { pass: false, why: `expected served, got ${s}` };
      const got = chosenCategories(body.result);
      const want = [...new Set(label.steps)].sort();
      const ok = JSON.stringify(got) === JSON.stringify(want);
      return { pass: ok, why: ok ? "" : `categories ${got.join("+")} vs ${want.join("+")}` };
    }
    case "out_of_catalogue":
    case "block":
      return { pass: notServed, why: notServed ? "" : `expected not served, got ${s}` };
    default: // review, ambiguous
      return { pass: s === "paused_for_review", why: s === "paused_for_review" ? "" : `expected review, got ${s}` };
  }
}

const rows = [];
for (const c of cases.slice(0, limit)) {
  const label = labels[c.id];
  const { http, ms, body } = await send(c.text);
  const verdict = judge(label, body);
  rows.push({ id: c.id, type: c.type, label: label.outcome, status: body.status, http, ms, kind: body.review?.reason?.split(":")[0] ?? body.category, ...verdict });
  console.log(`${verdict.pass ? "pass" : "FAIL"} ${c.id} [${label.outcome}] ${body.status}${verdict.why ? ` (${verdict.why})` : ""}`);
  if (gap) await sleep(gap);
}
const group = (key) => Object.fromEntries([...new Set(rows.map((r) => r[key]))].map((g) => {
  const s = rows.filter((r) => r[key] === g);
  return [g, `${s.filter((r) => r.pass).length}/${s.length}`];
}));
const passed = rows.filter((r) => r.pass).length;
const summary = { date: new Date().toISOString(), url: base, labels: "labeller A only (no agreement figure)", cases: rows.length, passed, accuracy: +(passed / rows.length).toFixed(3), byLabel: group("label"), byType: group("type"), rows };
console.log(`T4.2: ${passed}/${rows.length} = ${(100 * summary.accuracy).toFixed(1)}%`, summary.byLabel);
if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
