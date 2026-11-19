#!/usr/bin/env node
/**
 * Compile the backend dist into a single V8-bytecode bundle (bytenode) so the
 * desktop installer ships no readable business JS.
 *
 * Pipeline:
 *   1. Clean dist/ (preserving dist/data if present — tsc never emits it).
 *   2. `tsc -p tsconfig.json` → dist/ (plaintext ESM, transient).
 *   3. Transform dist/index.js: hoist every import declaration to the top and
 *      wrap the module body in an async IIFE. Required because bytenode can
 *      only compile CommonJS source (vm.Script) and CJS has no top-level
 *      await. ESM semantics are preserved: import declarations are hoisted
 *      before any body statement in plain ESM, and esbuild hoists them to the
 *      top of the CJS output as require() calls, so evaluation order matches.
 *   4. esbuild bundle → dist/app/index.cjs (single CJS file).
 *      - format=cjs: bytenode compiles CommonJS via vm.Script.
 *      - The bundle lives in dist/app/ so the paths that used to be relative
 *        to a dist/<module>.js file still resolve identically:
 *          new URL("../data/...", import.meta.url) → dist/data/...
 *          createRequire(import.meta.url).resolve("pkg") walks up dist/app →
 *          dist → resources/backend/node_modules (unchanged lookup chain).
 *      - esbuild shims import.meta.url in CJS output as
 *        pathToFileURL(__filename) → the bundle's own location.
 *   5. bytenode.compileFile → dist/app/index.jsc; delete index.cjs.
 *   6. Overwrite dist/index.js with a tiny ESM launcher (backend.rs starts
 *      resources/backend/dist/index.js with a Node whose cwd/type=module make
 *      it ESM, so the launcher bridges to CJS via createRequire) and delete
 *      every other plaintext JS emitted by tsc.
 *
 * Native/dynamic deps stay external (see EXTERNALS below) and are loaded from
 * the staged production node_modules exactly like today.
 *
 * Usage:
 *   node scripts/compile-bytecode.mjs [--keep-cjs]
 *
 * Flags:
 *   --keep-cjs  Keep dist/app/index.cjs for debugging (NOT distribution-safe;
 *               it contains plaintext source). Never use for staging.
 *
 * Bytecode is V8-version-specific: it must be started with the same Node major
 * the compiler ran under (staging bundles the build host's Node by default).
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import esbuild from "esbuild";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BACKEND_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DIST_DIR = path.join(BACKEND_ROOT, "dist");
const APP_DIR = path.join(DIST_DIR, "app");
const BUNDLE_FILE = path.join(APP_DIR, "index.cjs");
const BYTECODE_FILE = path.join(APP_DIR, "index.jsc");
const LAUNCHER_FILE = path.join(DIST_DIR, "index.js");
// Must sit next to the original dist/index.js: its import specifiers are
// relative to dist/ and esbuild resolves them against the entry file's dir.
const TRANSFORMED_ENTRY = path.join(DIST_DIR, "index.bytecode-entry.js");

// Packages that must NOT be bundled into the bytecode. Everything else (pure
// JS deps) is inlined into dist/app/index.cjs.
const EXTERNALS = [
  // Native modules loaded through createRequire(import.meta.url) at runtime:
  "better-sqlite3",
  "sherpa-onnx-node",
  "sqlite-vec",
  // Native binding required dynamically by @huggingface/transformers:
  "onnxruntime-node",
  // Resolves silk.wasm relative to its own package dir via import.meta.url:
  "silk-wasm",
  // Loads onnx/wasm assets and onnxruntime-node relative to its own package:
  "@huggingface/transformers",
  // Optional native peers of ws. Not installed; ws requires them inside
  // try/catch, so they must stay external for the guarded require to fail
  // (and be skipped) at runtime instead of breaking the esbuild build.
  "bufferutil",
  "utf-8-validate",
];

function parseArgs(argv) {
  return {
    keepCjs: argv.includes("--keep-cjs"),
  };
}

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[power]}`;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  }
  return total;
}

/**
 * Bracket depth across a chunk of source, ignoring content inside string
 * literals, template literals and comments. Robust enough for tsc output.
 */
function bracketDepthDelta(chunk, startDepth) {
  let depth = startDepth;
  let index = 0;
  const length = chunk.length;
  let pendingBlockComment = false;
  while (index < length) {
    const char = chunk[index];
    const next = index + 1 < length ? chunk[index + 1] : "";
    if (pendingBlockComment) {
      if (char === "*" && next === "/") {
        pendingBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      pendingBlockComment = true;
      index += 2;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < length && chunk[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < length) {
        if (chunk[index] === "\\") {
          index += 2;
          continue;
        }
        if (chunk[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    index += 1;
  }
  return depth;
}

/**
 * Rewrite an ESM entry (tsc output) so it can be bundled to CJS:
 *   - hoist all top-level import declarations above the body
 *   - wrap the remaining statements in an async IIFE
 * Body statements keep their source order; import declarations were hoisted
 * before the body by ESM semantics anyway.
 */
function wrapTopLevelAwait(source, label) {
  const lines = source.split("\n");
  const imports = [];
  const body = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!/^import\b/.test(line)) {
      body.push(line);
      index += 1;
      continue;
    }
    // Accumulate the (possibly multi-line) import declaration until its
    // brackets are balanced and the statement is terminated with ";".
    let statement = line;
    let depth = bracketDepthDelta(statement, 0);
    while (!(depth === 0 && /;\s*$/.test(statement))) {
      index += 1;
      if (index >= lines.length) {
        throw new Error(`${label}: 未闭合的 import 声明: ${statement.slice(0, 80)}...`);
      }
      statement += `\n${lines[index]}`;
      depth = bracketDepthDelta(lines[index], depth);
    }
    if (/^import\b[^"']*\bexport\b/.test(statement) || /export\s+default/.test(statement)) {
      throw new Error(`${label}: 不支持的 export 语法: ${statement.slice(0, 80)}...`);
    }
    imports.push(statement);
    index += 1;
  }

  const joinedBody = body.join("\n");
  if (/(^|\n)\s*export[\s{*]/.test(joinedBody)) {
    throw new Error(`${label}: 入口包含顶层 export，无法编译为字节码（index.ts 不应有 export）`);
  }

  return [
    imports.join("\n"),
    "",
    "// Wrapped by scripts/compile-bytecode.mjs: CommonJS has no top-level await,",
    "// so the module body runs inside an async IIFE. esbuild hoists the import",
    "// statements above to the top of the CJS bundle, matching ESM semantics.",
    "(async () => {",
    joinedBody,
    "})().catch((error) => {",
    "  console.error(error);",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

function runTsc() {
  console.log("> tsc -p tsconfig.json");
  const command = process.platform === "win32"
    ? path.join(BACKEND_ROOT, "node_modules", ".bin", "tsc.cmd")
    : path.join(BACKEND_ROOT, "node_modules", ".bin", "tsc");
  const result = spawnSync(command, ["-p", "tsconfig.json"], {
    cwd: BACKEND_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tsc 失败（exit ${result.status}）`);
  }
}

/**
 * Remove dist/ while preserving dist/data (legal docs / settings defaults) if
 * someone copied it there manually; staging copies src/data itself, so this is
 * just hygiene.
 */
function cleanDist() {
  const keepData = path.join(DIST_DIR, "data");
  let savedData = null;
  if (isDir(keepData)) {
    savedData = path.join(BACKEND_ROOT, ".compile-bytecode-data-keep");
    fs.rmSync(savedData, { recursive: true, force: true });
    fs.renameSync(keepData, savedData);
  }
  try {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  } finally {
    if (savedData) {
      fs.mkdirSync(DIST_DIR, { recursive: true });
      fs.renameSync(savedData, keepData);
    }
  }
}

function deletePlaintextOutputs(keepCjs) {
  const removed = [];
  const keep = new Set([path.join(DIST_DIR, "index.js"), BYTECODE_FILE]);
  if (keepCjs) keep.add(BUNDLE_FILE);
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (target === path.join(DIST_DIR, "data")) continue; // assets, keep
        visit(target);
        if (fs.readdirSync(target).length === 0) {
          fs.rmdirSync(target);
        }
        continue;
      }
      if (keep.has(target)) continue;
      if (/\.(js|cjs|mjs|map|d\.ts)$/.test(entry.name) || entry.name.endsWith(".js.map")) {
        fs.rmSync(target, { force: true });
        removed.push(path.relative(DIST_DIR, target));
      }
    }
  };
  visit(DIST_DIR);
  return removed;
}

function assertNoPlaintext(keepCjs) {
  const offenders = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (target === path.join(DIST_DIR, "data")) continue;
        visit(target);
        continue;
      }
      if (target === LAUNCHER_FILE) continue;
      if (keepCjs && target === BUNDLE_FILE) continue;
      if (/\.(js|cjs|mjs)$/.test(entry.name) || entry.name.endsWith(".map")) {
        offenders.push(path.relative(DIST_DIR, target));
      }
    }
  };
  visit(DIST_DIR);
  if (offenders.length > 0) {
    throw new Error(`dist 仍残留明文 JS: ${offenders.join(", ")}`);
  }
}

function writeLauncher() {
  const launcher = `// V8 bytecode launcher — the only plaintext JS in the package.
// The application lives in app/index.jsc (bytenode-compiled CJS bundle).
// backend.rs starts this file as dist/index.js; with "type": "module" it is
// loaded as ESM, so bridge to CommonJS (required by bytenode) via createRequire.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("bytenode");
require("./app/index.jsc");
`;
  fs.writeFileSync(LAUNCHER_FILE, launcher, "utf-8");
}

async function main() {
  const { keepCjs } = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  if (!isDir(path.join(BACKEND_ROOT, "src"))) {
    throw new Error(`请在 backend-node 目录下运行: ${BACKEND_ROOT}`);
  }

  console.log(`[bytecode] node ${process.versions.node} / v8 ${process.versions.v8}`);

  cleanDist();
  runTsc();

  const entrySource = fs.readFileSync(path.join(DIST_DIR, "index.js"), "utf-8");
  const transformed = wrapTopLevelAwait(entrySource, "dist/index.js");
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(TRANSFORMED_ENTRY, transformed, "utf-8");

  console.log("> esbuild bundle → dist/app/index.cjs");
  // esbuild leaves `import.meta` empty in CJS output (empty-import-meta).
  // Define it to the bundle file's own URL so that:
  //   createRequire(import.meta.url)          → resolves node_modules from
  //                                             dist/app upward (unchanged chain)
  //   new URL("../data/...", import.meta.url) → dist/data/...
  // which is exactly where those assets live in the staged layout.
  const importMetaUrlDefine = `require("node:url").pathToFileURL(__filename).href`;
  await esbuild.build({
    entryPoints: [TRANSFORMED_ENTRY],
    outfile: BUNDLE_FILE,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ["node18"],
    charset: "utf8",
    legalComments: "none",
    sourcemap: false,
    external: EXTERNALS,
    banner: {
      js: `const __bytenode_import_meta_url = ${importMetaUrlDefine};`,
    },
    define: {
      "import.meta.url": "__bytenode_import_meta_url",
    },
    // bytenode executes .jsc via vm.Script.runInThisContext(), which has no
    // importModuleDynamically callback — a real import() inside bytecode throws
    // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING ("A dynamic import callback was
    // not specified"). Downgrade dynamic import to require() so externals
    // (@huggingface/transformers, silk-wasm) load through CommonJS like
    // everything else in the bundle. Externals expose CJS builds, so this is
    // also the node-canonical entry.
    supported: {
      "dynamic-import": false,
    },
    logLevel: "warning",
  });
  fs.rmSync(TRANSFORMED_ENTRY, { force: true });

  const bundleSize = fs.statSync(BUNDLE_FILE).size;
  console.log(`[bytecode] bundle: ${formatBytes(bundleSize)}`);

  console.log("> bytenode compileFile → dist/app/index.jsc");
  const require = createRequire(import.meta.url);
  const bytenode = require("bytenode");
  await bytenode.compileFile({
    filename: BUNDLE_FILE,
    compileAsModule: true,
    compress: true,
    output: BYTECODE_FILE,
  });
  if (!keepCjs) {
    fs.rmSync(BUNDLE_FILE, { force: true });
  }

  const removed = deletePlaintextOutputs(keepCjs);
  writeLauncher();
  assertNoPlaintext(keepCjs);

  if (!isFileOk(BYTECODE_FILE)) throw new Error("dist/app/index.jsc 未生成");
  if (!isFileOk(LAUNCHER_FILE)) throw new Error("dist/index.js 启动器未生成");

  console.log("");
  console.log(`[bytecode] 完成（${Date.now() - startedAt}ms）`);
  console.log(`  dist/index.js        启动器 (ESM → createRequire → bytenode)`);
  console.log(`  dist/app/index.jsc   V8 字节码 ${formatBytes(fs.statSync(BYTECODE_FILE).size)} (源 bundle ${formatBytes(bundleSize)})`);
  console.log(`  清理明文产物: ${removed.length} 个文件`);
  console.log("  注意: .jsc 绑定编译时的 V8 版本，运行必须使用同一 Node 主版本。");
  if (keepCjs) {
    console.log("  [warn] --keep-cjs 已保留明文 dist/app/index.cjs，禁止用于打包分发");
  }
}

function isFileOk(file) {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`[bytecode] 失败: ${error?.message || error}`);
  process.exit(1);
});
