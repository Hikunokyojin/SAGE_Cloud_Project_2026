// esbuild --bundle can't inline onnxruntime-node's native .node/.so binaries or
// @huggingface/transformers' own asset-relative requires into one JS file, so both are
// marked --external in the build script and copied into dist/node_modules/ here instead,
// alongside the bundled dist/index.js, so Lambda's require() resolves them normally at
// runtime.
//
// onnxruntime-node ships every platform's prebuilt binary in one npm install (confirmed
// by inspecting node_modules/onnxruntime-node/bin after installing on Windows -- the
// linux/x64 binary Lambda needs was already present). Pruned here to just linux/x64
// (~34MB) instead of shipping darwin+win32+arm64 too (~211MB total), since Lambda's
// deployment package has a real size ceiling and only ever runs on linux/x64.
//
// sharp: turned out NOT to be lazy after all -- confirmed via a real deployed-Lambda
// error (Runtime.ImportModuleError: Cannot find module 'sharp') that
// @huggingface/transformers' dist/transformers.node.cjs requires it unconditionally at
// module load time, not only on image-processing code paths as first assumed. It needs
// its own platform-specific native binary too (@img/sharp-linux-x64 +
// @img/sharp-libvips-linux-x64), which npm's optionalDependencies resolution only
// installs for the machine's own platform -- so these were force-installed for linux/x64
// explicitly via `npm install @img/sharp-linux-x64@<version> @img/sharp-libvips-linux-x64@<version> --force`
// even though this is built on Windows (see broker/package.json's explicit dependency on
// both). onnxruntime-web remains genuinely unused (transformers' Node entrypoint has no
// reference to it at all, unlike sharp).
const fs = require("fs");
const path = require("path");

// npm workspaces hoists shared dependencies to the repo root's node_modules -- confirmed
// by checking (there is no broker/node_modules/@huggingface or /onnxruntime-node at all).
// Resolve each package's real on-disk location via require.resolve instead of assuming a
// fixed relative path, so this keeps working regardless of hoisting decisions.
function packageDir(pkgName) {
  // Some packages' "exports" field blocks resolving "<pkg>/package.json" directly
  // (confirmed: onnxruntime-common throws ERR_PACKAGE_PATH_NOT_EXPORTED for it) even
  // though the file exists on disk. Resolve the package's real entry file instead, then
  // walk up to the nearest ancestor directory containing a package.json whose "name"
  // matches -- that's the actual package root regardless of what "exports" exposes.
  //
  // Some other packages (the @img/sharp-* native-binary-asset packages) block resolving
  // both the bare specifier AND "<pkg>/package.json" via their "exports" field entirely
  // (confirmed: both throw ERR_PACKAGE_PATH_NOT_EXPORTED). There is no importable entry
  // point to resolve from at all -- fall back to locating the hoisted node_modules root
  // via a package that DOES resolve normally (onnxruntime-common, always copied first)
  // and looking for a sibling directory there, since npm workspaces hoists everything to
  // one shared root.
  let entryPoint;
  try {
    entryPoint = require.resolve(pkgName);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND" && err.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw err;
    const hoistedRoot = path.dirname(packageDir("onnxruntime-common"));
    const candidate = path.join(hoistedRoot, ...pkgName.split("/"));
    if (!fs.existsSync(candidate)) {
      throw new Error(`Could not locate package root for ${pkgName} (looked in ${candidate})`);
    }
    return candidate;
  }
  let dir = path.dirname(entryPoint);
  while (true) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, "utf8")).name === pkgName) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate package root for ${pkgName}`);
    dir = parent;
  }
}

const DIST_NODE_MODULES = path.join(__dirname, "..", "dist", "node_modules");

function copyDir(src, dest, { exclude = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, { exclude });
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  fs.rmSync(DIST_NODE_MODULES, { recursive: true, force: true });

  // onnxruntime-common: onnxruntime-node's only real runtime dependency (confirmed via
  // grep of its own dist/*.js require() calls -- global-agent/tar are install-time-only,
  // used to download prebuilds we don't need since the binary is already local).
  copyDir(packageDir("onnxruntime-common"), path.join(DIST_NODE_MODULES, "onnxruntime-common"));

  // onnxruntime-node, pruned to linux/x64 only.
  copyDir(packageDir("onnxruntime-node"), path.join(DIST_NODE_MODULES, "onnxruntime-node"), {
    exclude: ["test", "script"],
  });
  const binDir = path.join(DIST_NODE_MODULES, "onnxruntime-node", "bin", "napi-v3");
  for (const platform of fs.readdirSync(binDir)) {
    if (platform !== "linux") {
      fs.rmSync(path.join(binDir, platform), { recursive: true, force: true });
      continue;
    }
    for (const arch of fs.readdirSync(path.join(binDir, platform))) {
      if (arch !== "x64") {
        fs.rmSync(path.join(binDir, platform, arch), { recursive: true, force: true });
      }
    }
  }

  // @huggingface/transformers, including its .cache (pre-populated by download-model.js)
  // so the deployed Lambda never needs live internet access to huggingface.co.
  copyDir(packageDir("@huggingface/transformers"), path.join(DIST_NODE_MODULES, "@huggingface", "transformers"), {
    exclude: ["test"],
  });

  // sharp itself, its pure-JS dependencies, and the linux/x64-only native binary packages.
  copyDir(packageDir("sharp"), path.join(DIST_NODE_MODULES, "sharp"), { exclude: ["test"] });
  copyDir(packageDir("@img/colour"), path.join(DIST_NODE_MODULES, "@img", "colour"));
  copyDir(packageDir("detect-libc"), path.join(DIST_NODE_MODULES, "detect-libc"));
  copyDir(packageDir("semver"), path.join(DIST_NODE_MODULES, "semver"));
  copyDir(packageDir("@img/sharp-linux-x64"), path.join(DIST_NODE_MODULES, "@img", "sharp-linux-x64"));
  copyDir(
    packageDir("@img/sharp-libvips-linux-x64"),
    path.join(DIST_NODE_MODULES, "@img", "sharp-libvips-linux-x64")
  );

  const cacheDir = path.join(DIST_NODE_MODULES, "@huggingface", "transformers", ".cache");
  if (!fs.existsSync(cacheDir) || fs.readdirSync(cacheDir).length === 0) {
    console.warn(
      "WARNING: no cached model weights found under node_modules/@huggingface/transformers/.cache -- " +
        "run `node scripts/download-model.js` before building, or the deployed Lambda will have no " +
        "model to load (TRANSFORMERS_OFFLINE=1 blocks any live download attempt)."
    );
  }

  console.log("Copied native dependencies into dist/node_modules/");
}

main();
