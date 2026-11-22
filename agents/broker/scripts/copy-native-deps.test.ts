// L11: the sharp Linux binaries must survive `npm install`, and a failed copy must not
// leave a half-built bundle that the stale-bundle guard (L7) would accept.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { missingNativePackages, failBuild, NATIVE_PACKAGES } = require("./copy-native-deps.js");

describe("copy-native-deps (WP4 L11)", () => {
  it("pins the sharp Linux binaries to the versions in package.json", () => {
    const pkg = require("../package.json");
    expect(NATIVE_PACKAGES).toEqual(pkg.optionalDependencies);
  });

  it("lists only the native packages missing from node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "sage-native-"));
    try {
      mkdirSync(join(root, "@img", "sharp-linux-x64"), { recursive: true });
      writeFileSync(join(root, "@img", "sharp-linux-x64", "package.json"), "{}");
      // An empty folder left by an interrupted fetch still counts as missing.
      mkdirSync(join(root, "@img", "sharp-libvips-linux-x64"), { recursive: true });
      expect(missingNativePackages(root)).toEqual([["@img/sharp-libvips-linux-x64", NATIVE_PACKAGES["@img/sharp-libvips-linux-x64"]]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a failed build deletes dist/index.js so no half-built bundle can be deployed", () => {
    const dist = mkdtempSync(join(tmpdir(), "sage-dist-"));
    try {
      writeFileSync(join(dist, "index.js"), "// bundle");
      mkdirSync(join(dist, "node_modules"));
      expect(() => failBuild(dist, new Error("boom"))).toThrow(/boom/);
      expect(existsSync(join(dist, "index.js"))).toBe(false);
      expect(existsSync(join(dist, "node_modules"))).toBe(false);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
