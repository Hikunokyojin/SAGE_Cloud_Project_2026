// WP3.5 L7: the Lambdas deploy from agents/<name>/dist, which is only refreshed by a build.
// A stale bundle makes `cdk diff` report "no differences" and `cdk deploy` ship old code
// without any warning. This finds bundles older than the source they are built from: the
// agent's own src/ and every shared package's src/ (esbuild inlines them).
import * as fs from "fs";
import * as path from "path";

function newestSource(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") newest = Math.max(newest, newestSource(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

/** Names of agents whose dist/index.js is missing or older than its sources. */
export function staleBundles(repoRoot: string, agents: string[]): string[] {
  const packagesDir = path.join(repoRoot, "packages");
  const shared = fs.existsSync(packagesDir)
    ? Math.max(0, ...fs.readdirSync(packagesDir).map((p) => newestSource(path.join(packagesDir, p, "src"))))
    : 0;
  return agents.filter((name) => {
    const bundle = path.join(repoRoot, "agents", name, "dist", "index.js");
    if (!fs.existsSync(bundle)) return true;
    const built = fs.statSync(bundle).mtimeMs;
    return Math.max(shared, newestSource(path.join(repoRoot, "agents", name, "src"))) > built;
  });
}

/** Throws with the fix when any bundle is stale. Skipped under vitest, whose placeholders stand in for bundles. */
export function assertFreshBundles(repoRoot: string, agents: string[]): void {
  if (process.env.VITEST || process.env.SAGE_SKIP_DIST_CHECK === "1") return;
  const stale = staleBundles(repoRoot, agents);
  if (stale.length) {
    throw new Error(
      `Stale Lambda bundles: ${stale.join(", ")}. Their dist/ is older than the source, so cdk would deploy old code.\n` +
        `Rebuild first:  npm run build:agents   (from the repo root; set SAGE_SKIP_DIST_CHECK=1 to override)`
    );
  }
}
