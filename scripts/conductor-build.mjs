// L18: `cdk deploy` does not update the Conductor on EC2, and nothing warned when the live
// Conductor was older than the code. The bundle now carries a fingerprint of its source
// (Conductor plus the shared packages esbuild inlines), /health reports it, and `check`
// compares the live value with the local source.
//
//   node scripts/conductor-build.mjs bundle          # writes services/conductor/deploy-bundle.js
//   node scripts/conductor-build.mjs check <baseUrl> # exits 1 when the live Conductor is stale
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

function sources(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") sources(full, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
}

export function fingerprint(root) {
  const files = [];
  sources(path.join(root, "services", "conductor", "src"), files);
  const pk = path.join(root, "packages");
  if (fs.existsSync(pk)) for (const p of fs.readdirSync(pk).sort()) sources(path.join(pk, p, "src"), files);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(path.relative(root, f).split(path.sep).join("/"));
    h.update("\0");
    h.update(fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

export function compareBuild(local, health) {
  const live = health?.build;
  if (live === local) return { ok: true, message: `Conductor is current (build ${local}).` };
  return {
    ok: false,
    message:
      `Conductor is stale: live build ${live ?? "unknown (predates the build field)"}, local source ${local}.\n` +
      `Redeploy it with docs/RUNBOOK.md section 1 step 4.`,
  };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, url] = process.argv.slice(2);
  if (cmd === "bundle") {
    const { build } = await import("esbuild");
    const fp = fingerprint(root);
    await build({
      entryPoints: [path.join(root, "services/conductor/src/index.ts")],
      bundle: true,
      platform: "node",
      target: "node18",
      outfile: path.join(root, "services/conductor/deploy-bundle.js"),
      external: ["@sage/agent-*"],
      define: { "process.env.SAGE_CONDUCTOR_BUILD": JSON.stringify(fp) },
    });
    console.log(`Bundled services/conductor/deploy-bundle.js (build ${fp}).`);
  } else if (cmd === "check" && url) {
    const res = await fetch(new URL("health", url.endsWith("/") ? url : url + "/"));
    const result = compareBuild(fingerprint(root), await res.json());
    console.log(result.message);
    process.exitCode = result.ok ? 0 : 1;
  } else {
    console.error("usage: conductor-build.mjs bundle | check <baseUrl>");
    process.exit(2);
  }
}
