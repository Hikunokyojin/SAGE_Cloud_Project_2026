// RT11 (T4.1f): send 30 multi-service requests to the live pipeline, run each approved chain
// against sandbox endpoints in dependency order, and check the end-to-end limits.
//
//   npm run rt11 --workspace=evaluation -- [--api https://.../prod] [--only rt11-01,rt11-02]
//
// The sandbox endpoints are a local stub server, one endpoint per catalogue category, that
// accepts the step's inputs and returns an output for the next step. They stand in for the
// providers' own sandboxes or test modes (which need accounts you create); this is the
// cheaper plan, and real provider sandboxes can be swapped in per category later.
// Requests that are refused send the usual human-review email.
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RT11_CASES } from "./cases";
import { checkCase, executeChain, type PipelineOutcome } from "./check";

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((p, a, i, all) => (a.startsWith("--") ? [...p, [a.slice(2), all[i + 1]]] : p), [])
);
const API = (args.api || process.env.SAGE_API_BASE || "https://hiz4sheyl5.execute-api.ap-south-1.amazonaws.com/prod").replace(/\/$/, "");
const only = args.only ? new Set(args.only.split(",")) : undefined;
const GAP_MS = Number(args.gap || 20000); // Groq free tier: 8,000 tokens a minute (a 4 s gap hit 429s)

const sandboxCalls: { category: string; inputs: string[] }[] = [];

function startSandbox(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const m = /^\/sandbox\/([a-z-]+)$/.exec(req.url ?? "");
    if (req.method !== "POST" || !m) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { inputs } = JSON.parse(body) as { inputs: string[] };
        sandboxCalls.push({ category: m[1], inputs });
        const output = `${m[1]}:${createHash("sha256").update(inputs.join("|")).digest("hex").slice(0, 8)}`;
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ output }));
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` });
    })
  );
}

async function main() {
  const { server, base } = await startSandbox();
  const cases = RT11_CASES.filter((c) => !only || only.has(c.id));
  const rows = [];
  for (const [i, c] of cases.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS));
    const started = Date.now();
    let outcome: PipelineOutcome & { requestId?: string; error?: string } = {};
    try {
      const res = await fetch(`${API}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: c.text }),
      });
      outcome = (await res.json()) as typeof outcome;
      if (!res.ok && !outcome.status) outcome.status = `http_${res.status}`;
    } catch (err) {
      outcome = { status: "network_error", error: String(err) };
    }
    const chain = outcome.result?.chain;
    const run = chain
      ? await executeChain(chain, async (category, inputs) => {
          const r = await fetch(`${base}/sandbox/${category}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inputs }),
          });
          const j = (await r.json().catch(() => ({}))) as { output?: string };
          return { ok: r.ok, output: j.output ?? "" };
        })
      : undefined;
    const verdict = checkCase(c, outcome, run);
    rows.push({
      id: c.id,
      expect: c.expect ?? "approved",
      requestId: outcome.requestId,
      status: outcome.status,
      ms: Date.now() - started,
      steps: chain?.steps.map((s) => ({ capability: s.chosen.service.capability ?? s.capability, service: s.chosen.service.name, price: s.chosen.service.price, uptime: s.chosen.service.uptime, latencyMs: s.chosen.service.latencyMs })),
      totals: chain?.totals,
      limits: c.limits,
      sandbox: run?.steps.map((s) => ({ step: s.step, ok: s.ok, error: s.error })),
      ...verdict,
    });
    console.log(`${c.id} ${verdict.pass ? "PASS" : "FAIL"} ${outcome.status ?? ""} ${verdict.problems.join("; ")}`);
  }
  server.close();

  const passed = rows.filter((r) => r.pass).length;
  const summary = { ranAt: new Date().toISOString(), api: API, cases: rows.length, passed, sandboxCalls: sandboxCalls.length, rows };
  const dir = join(__dirname, "..", "..", "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rt11-results.json"), JSON.stringify(summary, null, 2));
  const md = [
    "# RT11: multi-service composition (T4.1f)",
    "",
    `Run ${summary.ranAt} against the live API. ${passed} of ${rows.length} cases passed; ${sandboxCalls.length} sandbox calls.`,
    "",
    "Sandbox endpoints are a local stub per catalogue category (stand-ins for provider test modes).",
    "",
    "| Case | Expected | Status | Steps | Total price | Uptime | Latency | Result |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${r.id} | ${r.expect} | ${r.status} | ${r.steps?.map((s) => s.service).join(" > ") ?? "-"} | ${r.totals ? `$${r.totals.price}` : "-"} | ${r.totals ? `${r.totals.uptime}%` : "-"} | ${r.totals?.latencyMs ?? "-"} | ${r.pass ? "pass" : `FAIL: ${r.problems.join("; ")}`} |`
    ),
  ].join("\n");
  writeFileSync(join(dir, "rt11-report.md"), md + "\n");
  console.log(`\nRT11: ${passed}/${rows.length} passed. Results in evaluation/results/rt11-report.md`);
  process.exitCode = passed === rows.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
