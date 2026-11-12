import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { staleBundles } from "../lib/dist-freshness";

// WP3.5 L7: cdk diff/deploy must refuse a stale agents/<name>/dist instead of silently
// reporting "no differences" for code that was never rebuilt.

let root: string;

function touch(file: string, when: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  fs.utimesSync(file, when / 1000, when / 1000);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sage-dist-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("staleBundles", () => {
  it("passes when every bundle is newer than its sources", () => {
    touch(path.join(root, "agents/broker/src/index.ts"), 1_000_000);
    touch(path.join(root, "packages/shared-types/src/index.ts"), 1_000_000);
    touch(path.join(root, "agents/broker/dist/index.js"), 2_000_000);
    expect(staleBundles(root, ["broker"])).toEqual([]);
  });

  it("flags an agent whose own source changed after its bundle", () => {
    touch(path.join(root, "agents/broker/dist/index.js"), 1_000_000);
    touch(path.join(root, "agents/broker/src/index.ts"), 2_000_000);
    expect(staleBundles(root, ["broker"])).toEqual(["broker"]);
  });

  it("flags an agent when a shared package changed after its bundle", () => {
    touch(path.join(root, "agents/negotiator/src/index.ts"), 1_000_000);
    touch(path.join(root, "agents/negotiator/dist/index.js"), 2_000_000);
    touch(path.join(root, "packages/shared-types/src/catalogueReferences.ts"), 3_000_000);
    expect(staleBundles(root, ["negotiator"])).toEqual(["negotiator"]);
  });

  it("flags a missing bundle and ignores test files", () => {
    touch(path.join(root, "agents/intent/src/index.ts"), 1_000_000);
    touch(path.join(root, "agents/explainer/src/index.ts"), 1_000_000);
    touch(path.join(root, "agents/explainer/dist/index.js"), 2_000_000);
    touch(path.join(root, "agents/explainer/src/index.test.ts"), 3_000_000);
    expect(staleBundles(root, ["intent", "explainer"])).toEqual(["intent"]);
  });
});
