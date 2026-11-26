// L35/L36 check of the Intent stage alone, with the real model: predicts whether each request
// would be served, asked about (clarify) or refused (no category), before anything is deployed.
//   npx tsx evaluation/t42/intent-check.mts --gap 2500 --out evaluation/results/l35-l36-intent.json
import { readFileSync, writeFileSync } from "node:fs";
import { handler } from "../../agents/intent/src/index.ts";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const gap = Number(arg("--gap", "2500"));
const out = arg("--out", "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = new URL("../", import.meta.url);
const t42 = JSON.parse(readFileSync(new URL("cases/t42-cases.json", root), "utf8")).cases as { id: string; text: string }[];
const labels = JSON.parse(readFileSync(new URL("cases/labels-a.json", root), "utf8")).labels as Record<string, { outcome: string; steps?: string[] }>;
const held = JSON.parse(readFileSync(new URL("t42/heldout-intent.json", root), "utf8")).cases as { id: string; text: string; outcome: string; category?: string }[];

type Row = { set: string; id: string; text: string; want: string; wantCat?: string; got: string; category?: string; clarify?: string; pass: boolean };
const items = [
  ...t42.filter((c) => ["serve", "out_of_catalogue", "ambiguous"].includes(labels[c.id]?.outcome))
    .map((c) => ({ set: "t42", id: c.id, text: c.text, want: labels[c.id].outcome, wantCat: labels[c.id].steps?.length === 1 ? labels[c.id].steps![0] : undefined, chain: (labels[c.id].steps?.length ?? 0) > 1 })),
  ...held.filter((c) => c.outcome !== "skip").map((c) => ({ set: "heldout", id: c.id, text: c.text, want: c.outcome, wantCat: c.category, chain: false })),
];
const only = arg("--only", "").split(",").filter(Boolean);
if (only.length) items.splice(0, items.length, ...items.filter((i) => only.includes(i.id)));
const rows: Row[] = [];
for (const it of items) {
  let intent;
  for (let a = 0; ; a++) {
    try { intent = await handler({ requestId: `l35-${it.id}`, rawInput: it.text }); break; }
    catch (e) { if (a >= 4) throw e; console.log(`  retry ${it.id}: ${String(e).slice(0, 80)}`); await sleep(20000); }
  }
  const chain = (intent.steps?.length ?? 0) >= 2;
  const unknown = chain ? intent.steps!.some((s) => !s.category) : !intent.category;
  const got = !chain && intent.clarify ? "ambiguous" : unknown ? "out_of_catalogue" : "serve";
  const pass = it.want === "serve" ? got === "serve" && (!it.wantCat || intent.category === it.wantCat) : got !== "serve";
  rows.push({ set: it.set, id: it.id, text: it.text, want: it.want, wantCat: it.wantCat, got, category: intent.category, clarify: intent.clarify, pass });
  console.log(`${pass ? "ok  " : "MISS"} ${it.id} want=${it.want} got=${got} cat=${intent.category ?? "-"}${intent.clarify ? ` ask="${intent.clarify}"` : ""}`);
  await sleep(gap);
}
const summary: Record<string, string> = {};
for (const set of ["t42", "heldout"]) for (const w of ["serve", "ambiguous", "out_of_catalogue"]) {
  const r = rows.filter((x) => x.set === set && x.want === w);
  if (r.length) summary[`${set}/${w}`] = `${r.filter((x) => x.pass).length}/${r.length}`;
}
console.log(summary);
if (out) writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), note: "Intent stage only, real model; not-served counts asked (clarify) or refused (no category) as correct.", summary, rows }, null, 2));
