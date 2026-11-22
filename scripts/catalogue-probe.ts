// Measured QoS probes (T3.3). Run every 6 hours by .github/workflows/qos-probes.yml.
//
//   npm run catalogue:probe
//
// Sends ONE unauthenticated HEAD request to each real service's endpoint (synthetic ones are
// skipped; their example.com endpoints do not exist), records whether it answered and how fast,
// appends the results to data/probes/YYYY-MM.jsonl, and writes a rolling 30-day summary into
// each record's `measured` block in data/services.v2.json.
//
// Etiquette (the plan's terms-of-use risk): one lightweight request per service per run, a
// descriptive User-Agent, no credentials, no retries, and requests to the same host never
// run at the same time.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyProbe, summarise, type ProbeSample, type CatalogueServiceV2 } from "../packages/catalogue/src";

const ROOT = join(__dirname, "..");
const CATALOGUE = join(ROOT, "data", "services.v2.json");
const PROBES = join(ROOT, "data", "probes");
const TIMEOUT_MS = 10_000;
const CONCURRENCY = 8;
const WINDOW_DAYS = 30;
const UA = "SAGE-QoS-probe/1.0 (+https://github.com/Hikunokyojin/SAGE_Cloud_Project_2026; one HEAD request per 6h)";

async function probe(url: string): Promise<{ status?: number; error?: string; ms: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual", headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, ms: Math.round(performance.now() - t0) };
  } catch (e: any) {
    return { error: e?.name === "TimeoutError" ? "timeout" : String(e?.cause?.code ?? e?.message ?? e), ms: Math.round(performance.now() - t0) };
  }
}

async function main() {
  const catalogue: CatalogueServiceV2[] = JSON.parse(readFileSync(CATALOGUE, "utf-8"));
  const real = catalogue.filter((s) => !s.synthetic);
  const at = new Date().toISOString();

  // Group by host so one host is never hit concurrently, then run host groups in parallel.
  const byHost = new Map<string, CatalogueServiceV2[]>();
  for (const s of real) {
    const host = new URL(s.probeUrl ?? s.endpoint).host;
    (byHost.get(host) ?? byHost.set(host, []).get(host)!).push(s);
  }
  const groups = [...byHost.values()];
  const samples: ProbeSample[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < groups.length) {
        for (const s of groups[next++]) {
          const r = await probe(s.probeUrl ?? s.endpoint);
          const ok = classifyProbe(r);
          samples.push({ id: s.serviceId, at, ok, ...(ok ? { ms: r.ms } : {}) });
          if (!ok) console.log(`  down ${s.serviceId}: ${r.error ?? r.status}`);
        }
      }
    })
  );

  mkdirSync(PROBES, { recursive: true });
  appendFileSync(join(PROBES, `${at.slice(0, 7)}.jsonl`), samples.map((x) => JSON.stringify(x)).join("\n") + "\n");

  // Re-summarise the last two monthly files (enough for a 30-day window).
  const files = readdirSync(PROBES).filter((f) => f.endsWith(".jsonl")).sort().slice(-2);
  const history: ProbeSample[] = files.flatMap((f) =>
    readFileSync(join(PROBES, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  );
  const measured = summarise(history, new Date(), WINDOW_DAYS);
  for (const s of catalogue) {
    const m = measured.get(s.serviceId);
    if (m && !s.synthetic) s.measured = m;
  }
  writeFileSync(CATALOGUE, JSON.stringify(catalogue, null, 2) + "\n");

  const up = samples.filter((x) => x.ok).length;
  console.log(`Probed ${samples.length} services on ${byHost.size} hosts: ${up} up, ${samples.length - up} down. History: ${history.length} samples.`);
}

main();
