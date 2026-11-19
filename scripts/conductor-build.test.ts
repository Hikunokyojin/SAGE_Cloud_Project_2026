import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// @ts-expect-error plain ESM script without types
import { fingerprint, compareBuild } from "./conductor-build.mjs";

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

describe("L18: Conductor build fingerprint", () => {
  const base = { "services/conductor/src/index.ts": "a", "packages/audit/src/index.ts": "b" };

  it("changes when Conductor or shared source changes, not when a test changes", () => {
    const fp = fingerprint(tree(base));
    expect(fingerprint(tree(base))).toBe(fp);
    expect(fingerprint(tree({ ...base, "services/conductor/src/index.ts": "a2" }))).not.toBe(fp);
    expect(fingerprint(tree({ ...base, "packages/audit/src/index.ts": "b2" }))).not.toBe(fp);
    expect(fingerprint(tree({ ...base, "services/conductor/src/x.test.ts": "t" }))).toBe(fp);
  });

  it("reports a live Conductor that is older than the source", () => {
    expect(compareBuild("abc", { build: "abc" }).ok).toBe(true);
    const stale = compareBuild("abc", { build: "old" });
    expect(stale.ok).toBe(false);
    expect(stale.message).toMatch(/RUNBOOK/);
    expect(compareBuild("abc", { status: "ok" }).ok).toBe(false);
  });
});
