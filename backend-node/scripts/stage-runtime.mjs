#!/usr/bin/env node
/**
 * Stage the Node backend, a Node runtime, production node_modules and the local
 * speech models into the Tauri resources directory.
 *
 * The output directory is build output only and must stay git-ignored:
 *   lingshu-gui/src-tauri/resources/backend/
 *
 * Usage:
 *   node backend-node/scripts/stage-runtime.mjs --dry-run
 *   node backend-node/scripts/stage-runtime.mjs
 *   node backend-node/scripts/stage-runtime.mjs --build
 *   node backend-node/scripts/stage-runtime.mjs --bytecode
 *   node backend-node/scripts/stage-runtime.mjs --target aarch64-apple-darwin
 *
 * Common overrides:
 *   LINGSHU_MODEL_SOURCE   model root (default: ../lingshu-app-local/.lingshu/models)
 *   LINGSHU_NODE_BINARY    Node executable to bundle (default: the Node running this script)
 *   LINGSHU_ASR_MODEL_NAME preferred ASR model directory name
 *   LINGSHU_STAGE_BYTECODE set to 1/true to enable bytecode staging (same as --bytecode;
 *                          0/false disables an inherited value)
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BACKEND_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");
const DEFAULT_DEST = path.join(REPO_ROOT, "lingshu-gui", "src-tauri", "resources", "backend");
const DEFAULT_MODEL_SOURCE = path.join(REPO_ROOT, "..", "lingshu-app-local", ".lingshu", "models");
const DEFAULT_ASR_MODEL = "sherpa-onnx-streaming-paraformer-zh";
const EMBEDDING_MODEL = "Xenova__bge-base-zh-v1.5";
const ASR_MODEL_CANDIDATES = [DEFAULT_ASR_MODEL];
// ASR 权重默认不再打进安装包；用户首次使用时在「设置 → 语音识别」里下载或导入 zip。
const ASR_DOWNLOAD_URL =
  process.env.LINGSHU_ASR_MODEL_URL ||
  "https://github.com/SailRuo/lingshu-harness/releases/latest/download/sherpa-onnx-streaming-paraformer-zh.zip";

const TARGETS = new Map([
  ["aarch64-apple-darwin", { platform: "darwin", arch: "arm64", libc: null }],
  ["x86_64-apple-darwin", { platform: "darwin", arch: "x64", libc: null }],
  ["x86_64-pc-windows-msvc", { platform: "win32", arch: "x64", libc: null }],
  ["aarch64-pc-windows-msvc", { platform: "win32", arch: "arm64", libc: null }],
  ["i686-pc-windows-msvc", { platform: "win32", arch: "ia32", libc: null }],
  ["x86_64-unknown-linux-gnu", { platform: "linux", arch: "x64", libc: "gnu" }],
  ["aarch64-unknown-linux-gnu", { platform: "linux", arch: "arm64", libc: "gnu" }],
  ["x86_64-unknown-linux-musl", { platform: "linux", arch: "x64", libc: "musl" }],
  ["aarch64-unknown-linux-musl", { platform: "linux", arch: "arm64", libc: "musl" }],
]);

const TARGET_ALIASES = new Map([
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["win32-x64", "x86_64-pc-windows-msvc"],
  ["win32-arm64", "aarch64-pc-windows-msvc"],
  ["linux-x64", "x86_64-unknown-linux-gnu"],
  ["linux-arm64", "aarch64-unknown-linux-gnu"],
]);

function usage() {
  console.log(`LingShu desktop runtime staging

Usage:
  node backend-node/scripts/stage-runtime.mjs [options]

Options:
  --dry-run                Print the plan and missing inputs without writing.
  --build                  Run "npm run build" in backend-node before staging.
  --bytecode               Compile dist to V8 bytecode (bytenode) before staging:
                           dist keeps only index.js (launcher) + app/index.jsc +
                           data/, so no readable business JS ships in the package.
                           Bytecode is tied to the Node version used to compile it —
                           the bundled runtime must be the same Node major.
  --no-bytecode            Force bytecode off (overrides LINGSHU_STAGE_BYTECODE).
  --dest <dir>             Output directory (default: lingshu-gui/src-tauri/resources/backend).
  --target <triple>        Tauri target triple (default: host target).
  --model-source <dir>     Model root containing embeddings/, sherpa-*/, vad/, voiceprint/.
  --asr-model <name>       ASR model directory name used by --with-asr (default: ${DEFAULT_ASR_MODEL}).
  --with-asr               Bundle the ASR weights (~226MB). Off by default: users download
                           or import the model from Settings → 语音识别 instead.
  --node-binary <file>     Node executable to copy (default: the current Node).
  --no-node                Skip the Node runtime (development-only staging).
  --no-models              Skip model staging (development-only staging).
  -h, --help               Show this help.

Environment:
  LINGSHU_MODEL_SOURCE, LINGSHU_ASR_MODEL_NAME, LINGSHU_ASR_MODEL_URL, LINGSHU_NODE_BINARY

The staged layout is consumed by src-tauri/src/backend.rs:
  dist/ package.json node_modules/ runtime/node models/ backend-manifest.json
`);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    build: false,
    bytecode: null,
    includeNode: true,
    includeModels: true,
    includeAsr: false,
    dest: DEFAULT_DEST,
    target: null,
    modelSource: null,
    asrModel: null,
    nodeBinary: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [flag, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      const next = argv[index];
      if (!next || next.startsWith("--")) {
        throw new Error(`${flag} 需要一个值`);
      }
      return next;
    };

    switch (flag) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--build":
        options.build = true;
        break;
      case "--bytecode":
        if (inlineValue === undefined) {
          options.bytecode = true;
        } else {
          // 支持 --bytecode=0 / =false / =no 显式关闭
          const parsed = String(inlineValue).trim().toLowerCase();
          options.bytecode = parsed !== "0" && parsed !== "false" && parsed !== "no";
        }
        break;
      case "--no-bytecode":
        options.bytecode = false;
        break;
      case "--dest":
        options.dest = path.resolve(value());
        break;
      case "--target":
        options.target = value();
        break;
      case "--model-source":
        options.modelSource = path.resolve(value());
        break;
      case "--asr-model":
        options.asrModel = value();
        break;
      case "--with-asr":
        options.includeAsr = true;
        break;
      case "--node-binary":
        options.nodeBinary = path.resolve(value());
        break;
      case "--no-node":
        options.includeNode = false;
        break;
      case "--no-models":
        options.includeModels = false;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数: ${raw}`);
    }
  }

  return options;
}

function hostTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "aarch64-pc-windows-msvc";
    if (process.arch === "ia32") return "i686-pc-windows-msvc";
    return "x86_64-pc-windows-msvc";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  throw new Error(`不支持的构建主机平台: ${process.platform}-${process.arch}`);
}

function targetFromTauriEnv() {
  const explicitTriple = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  if (explicitTriple) return explicitTriple;

  const platform = process.env.TAURI_ENV_PLATFORM?.trim().toLowerCase();
  const arch = process.env.TAURI_ENV_ARCH?.trim().toLowerCase();
  if (!platform || !arch) return null;

  const normalizedArch = arch === "arm64" ? "aarch64" : arch;
  if (platform === "darwin" || platform === "macos") {
    if (normalizedArch === "aarch64") return "aarch64-apple-darwin";
    if (normalizedArch === "x86_64") return "x86_64-apple-darwin";
  }
  if (platform === "windows" || platform === "win32") {
    if (normalizedArch === "x86_64") return "x86_64-pc-windows-msvc";
    if (normalizedArch === "aarch64") return "aarch64-pc-windows-msvc";
    if (normalizedArch === "i686") return "i686-pc-windows-msvc";
  }
  if (platform === "linux") {
    if (normalizedArch === "x86_64") return "x86_64-unknown-linux-gnu";
    if (normalizedArch === "aarch64") return "aarch64-unknown-linux-gnu";
  }
  return null;
}

function resolveTarget(input) {
  const triple = input || targetFromTauriEnv() || hostTriple();
  const normalized = TARGET_ALIASES.get(triple) || triple;
  if (normalized === "universal-apple-darwin") {
    throw new Error("暂不支持 universal-apple-darwin，请分别构建 arm64 / x64 包");
  }
  const profile = TARGETS.get(normalized);
  if (!profile) {
    throw new Error(`不支持的 target: ${triple}（支持: ${[...TARGETS.keys()].join(", ")}）`);
  }
  const host = hostTriple();
  return {
    ...profile,
    triple: normalized,
    isHost: normalized === host,
    nodeExe: profile.platform === "win32" ? "node.exe" : "node",
    sherpaPackage: `sherpa-onnx-${profile.platform === "win32" ? "win" : profile.platform}-${profile.arch}`,
    sqlitePackage: `sqlite-vec-${profile.platform === "win32" ? "windows" : profile.platform}-${profile.arch}`,
    sharpPackage: `sharp-${profile.platform}-${profile.arch}`,
    sharpLibvipsPackage: `sharp-libvips-${profile.platform}-${profile.arch}`,
    onnxArch: profile.arch,
    onnxPlatform: profile.platform,
    vecExtension: profile.platform === "win32" ? "dll" : profile.platform === "darwin" ? "dylib" : "so",
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

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
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
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(target).size;
        } catch {
          // ignore files disappearing during size calculation
        }
      }
    }
  }
  return total;
}

function countFiles(dir) {
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
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) total += 1;
    }
  }
  return total;
}

function runNpmBuild() {
  console.log("> npm run build (backend-node)");
  const npmCli = process.env.npm_execpath;
  const args = ["run", "build"];
  let result;
  if (npmCli && isFile(npmCli) && /\.c?js$/.test(npmCli)) {
    result = spawnSync(process.execPath, [npmCli, ...args], {
      cwd: BACKEND_ROOT,
      stdio: "inherit",
    });
  } else {
    result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: BACKEND_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`backend-node npm run build 失败（exit ${result.status}）`);
  }
}

function bytecodeRequested(options) {
  if (options.bytecode !== null) return options.bytecode;
  const raw = String(process.env.LINGSHU_STAGE_BYTECODE ?? "").trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false";
}

function runBytecodeCompile() {
  console.log("> node scripts/compile-bytecode.mjs (backend-node)");
  const result = spawnSync(
    process.execPath,
    [path.join(BACKEND_ROOT, "scripts", "compile-bytecode.mjs")],
    { cwd: BACKEND_ROOT, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`backend-node bytecode 编译失败（exit ${result.status}）`);
  }
}

function listProductionPackages() {
  const npmCli = process.env.npm_execpath;
  const args = ["ls", "--omit=dev", "--all", "--parseable"];
  let result;
  if (npmCli && isFile(npmCli) && /\.c?js$/.test(npmCli)) {
    result = spawnSync(process.execPath, [npmCli, ...args], {
      cwd: BACKEND_ROOT,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } else {
    result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: BACKEND_ROOT,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === "win32",
    });
  }
  if (result.error) throw result.error;
  // npm exits non-zero when it sees extraneous/empty optional packages, but the
  // parseable list on stdout is still valid. Only fail when stdout is empty.
  if (!result.stdout || !result.stdout.trim()) {
    throw new Error(`npm ls 没有返回依赖列表: ${(result.stderr || "").trim()}`);
  }

  const packages = new Map();
  const skipped = [];
  const prefix = `${BACKEND_ROOT}${path.sep}`;
  for (const line of result.stdout.split(/\r?\n/)) {
    const absolute = path.normalize(line.trim());
    if (!absolute.startsWith(prefix)) continue;
    const relative = path.relative(BACKEND_ROOT, absolute);
    const segments = relative.split(path.sep);
    if (segments[0] !== "node_modules") continue;

    let packageRelative;
    if (segments[1] && segments[1].startsWith("@")) {
      if (segments.length !== 3) continue;
      packageRelative = segments.join(path.sep);
    } else {
      if (segments.length !== 2) continue;
      packageRelative = segments.join(path.sep);
    }
    if (path.basename(packageRelative).startsWith(".")) continue;

    if (!isFile(path.join(absolute, "package.json"))) {
      skipped.push(packageRelative);
      continue;
    }
    packages.set(packageRelative, absolute);
  }

  return { packages, skipped };
}

function resolveNode(options, target) {
  if (!options.includeNode) return null;
  const binary = options.nodeBinary
    || (process.env.LINGSHU_NODE_BINARY ? path.resolve(process.env.LINGSHU_NODE_BINARY) : null)
    || process.execPath;

  if (!isFile(binary)) {
    throw new Error(`Node 运行时不存在: ${binary}`);
  }
  if (!target.isHost && !options.nodeBinary && !process.env.LINGSHU_NODE_BINARY) {
    throw new Error(
      `跨平台打包 ${target.triple} 时必须用 --node-binary / LINGSHU_NODE_BINARY 指定目标平台的 Node 可执行文件`,
    );
  }

  let version = "unknown";
  if (target.isHost) {
    const check = spawnSync(binary, ["-p", "process.versions.node + ' ' + process.platform + '-' + process.arch"], {
      encoding: "utf-8",
      timeout: 15_000,
    });
    if (check.error || check.status !== 0) {
      throw new Error(`无法执行 Node 运行时 ${binary}: ${check.error?.message || check.stderr || `exit ${check.status}`}`);
    }
    const [reportedVersion, reportedPlatform] = check.stdout.trim().split(/\s+/);
    version = reportedVersion;
    const expectedPlatform = `${target.platform}-${target.arch}`;
    if (reportedPlatform !== expectedPlatform) {
      throw new Error(
        `Node 运行时平台不匹配: ${binary} 是 ${reportedPlatform}，目标需要 ${expectedPlatform}`,
      );
    }
  } else {
    console.warn(`[warn] 跨平台目标 ${target.triple}：跳过 Node 可执行文件的版本/架构探测`);
  }

  let license = null;
  const binaryDir = path.dirname(binary);
  for (const candidate of [
    path.join(binaryDir, "LICENSE"),
    path.join(binaryDir, "LICENSE.md"),
    path.join(binaryDir, "LICENSE.txt"),
    path.join(binaryDir, "..", "LICENSE"),
    path.join(binaryDir, "..", "LICENSE.md"),
    path.join(binaryDir, "..", "LICENSE.txt"),
  ]) {
    if (isFile(candidate)) {
      license = candidate;
      break;
    }
  }
  if (!license) console.warn(`[warn] 未找到 Node LICENSE，随包分发前请人工补一份: ${binaryDir}`);

  return {
    binary,
    version,
    license,
    relative: path.posix.join("runtime", target.nodeExe),
  };
}

function resolveModelSource(options) {
  const requested = options.modelSource
    || (process.env.LINGSHU_MODEL_SOURCE ? path.resolve(process.env.LINGSHU_MODEL_SOURCE) : null)
    || DEFAULT_MODEL_SOURCE;
  if (!isDir(requested)) {
    throw new Error(
      `模型源不存在: ${requested}\n  用 --model-source 或 LINGSHU_MODEL_SOURCE 指向包含 embeddings/, sherpa-*/, vad/, voiceprint/ 的目录`,
    );
  }
  if (path.basename(requested) !== "models" && isDir(path.join(requested, "models"))) {
    return path.join(requested, "models");
  }
  return requested;
}

function hasAsrFiles(dir) {
  if (!isFile(path.join(dir, "tokens.txt"))) return false;
  const hasEncoder = ["encoder.int8.onnx", "encoder.onnx", path.join("onnx", "encoder.int8.onnx"), path.join("onnx", "encoder.onnx")]
    .some((name) => isFile(path.join(dir, name)));
  const hasDecoder = ["decoder.int8.onnx", "decoder.onnx", path.join("onnx", "decoder.int8.onnx"), path.join("onnx", "decoder.onnx")]
    .some((name) => isFile(path.join(dir, name)));
  const hasModel = ["model.int8.onnx", "model.onnx", "model_quantized.onnx"].some((name) => isFile(path.join(dir, name)));
  return (hasEncoder && hasDecoder) || hasModel;
}

function planAsrModel(modelSource, options) {
  const requested = options.asrModel
    || (process.env.LINGSHU_ASR_MODEL_NAME ? process.env.LINGSHU_ASR_MODEL_NAME : null);
  const candidates = [];
  if (requested) {
    candidates.push(path.join(modelSource, requested));
  } else {
    for (const name of ASR_MODEL_CANDIDATES) candidates.push(path.join(modelSource, name));
    if (isDir(modelSource)) {
      for (const entry of fs.readdirSync(modelSource, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        candidates.push(path.join(modelSource, entry.name));
      }
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (hasAsrFiles(resolved)) {
      return {
        kind: "asr",
        source: resolved,
        relative: path.posix.join("models", "asr", path.basename(resolved)),
        label: `ASR (${path.basename(resolved)})`,
      };
    }
  }

  throw new Error(
    `未找到可用的 Sherpa-ONNX 流式 ASR 模型${requested ? `: ${requested}` : `（尝试过 ${ASR_MODEL_CANDIDATES.join(", ")}）`}`,
  );
}

function planEmbeddingModel(modelSource) {
  const roots = [
    path.join(modelSource, "embeddings", EMBEDDING_MODEL),
    path.join(modelSource, "embeddings", EMBEDDING_MODEL.replace("__", "/")),
    path.join(modelSource, EMBEDDING_MODEL),
  ];
  for (const root of roots) {
    const modelFile = ["onnx/model_quantized.onnx", "onnx/model_q8.onnx", "onnx/model.onnx"]
      .map((name) => path.join(root, name))
      .find(isFile);
    if (modelFile) {
      return {
        kind: "embeddings",
        source: root,
        relative: path.posix.join("models", "embeddings", EMBEDDING_MODEL),
        label: "Embedding (bge-base-zh-v1.5)",
      };
    }
  }
  throw new Error(`未找到 bge embedding 模型: ${path.join(modelSource, "embeddings", EMBEDDING_MODEL)}`);
}

function walkFiles(root, maxDepth, predicate) {
  const result = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (entry.isFile() && predicate(target)) result.push(target);
    }
  };
  visit(root, 0);
  return result;
}

function planVoiceprintModel(modelSource) {
  const root = path.join(modelSource, "voiceprint");
  const candidates = walkFiles(root, 3, (file) => {
    const base = path.basename(file).toLowerCase();
    return base.endsWith(".onnx") && /campplus|3dspeaker|eres2net/.test(base);
  });
  if (candidates.length === 0) {
    throw new Error(`未找到 CAM++ 声纹模型: ${root}`);
  }
  const preferred = candidates
    .slice()
    .sort((left, right) => {
      const leftInt8 = path.basename(left).toLowerCase().includes(".int8.") ? 0 : 1;
      const rightInt8 = path.basename(right).toLowerCase().includes(".int8.") ? 0 : 1;
      return leftInt8 - rightInt8;
    })[0];
  const relativePath = path.relative(root, preferred);
  return {
    kind: "voiceprint",
    source: preferred,
    sourceRoot: root,
    relative: path.posix.join("models", "voiceprint", ...relativePath.split(path.sep)),
    label: `Voiceprint (${path.basename(preferred)})`,
  };
}

function planVadModel(modelSource) {
  const candidates = [
    path.join(modelSource, "vad", "silero_vad.onnx"),
    path.join(REPO_ROOT, "lingshu-gui", "src-tauri", "resources", "vad", "silero_vad.onnx"),
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return {
        kind: "vad",
        source: candidate,
        relative: path.posix.join("models", "vad", "silero_vad.onnx"),
        label: "VAD (silero_vad.onnx)",
      };
    }
  }
  throw new Error("未找到 silero_vad.onnx（模型源 vad/ 或 src-tauri/resources/vad/）");
}

function validateNativeModules(packages, target) {
  const missing = [];
  const packagePath = (name) => packages.get(path.posix.join("node_modules", name));

  const sherpa = packagePath(target.sherpaPackage);
  if (!sherpa) missing.push(`node_modules/${target.sherpaPackage}（sherpa-onnx-node 的平台二进制）`);
  else if (!isFile(path.join(sherpa, "sherpa-onnx.node"))) {
    missing.push(`${target.sherpaPackage}/sherpa-onnx.node（空包，需在目标平台执行 npm ci）`);
  }

  const onnx = packagePath("onnxruntime-node");
  if (!onnx) missing.push("node_modules/onnxruntime-node");
  else {
    const binding = path.join(onnx, "bin", "napi-v6", target.onnxPlatform, target.onnxArch, "onnxruntime_binding.node");
    if (!isFile(binding)) missing.push(path.relative(BACKEND_ROOT, binding));
  }

  const sqliteVec = packagePath(target.sqlitePackage);
  if (!sqliteVec) missing.push(`node_modules/${target.sqlitePackage}`);
  else if (!isFile(path.join(sqliteVec, `vec0.${target.vecExtension}`))) {
    missing.push(`${target.sqlitePackage}/vec0.${target.vecExtension}（空包，需在目标平台执行 npm ci）`);
  }

  const betterSqlite = packagePath("better-sqlite3");
  if (!betterSqlite) missing.push("node_modules/better-sqlite3");
  else {
    const prebuildName = target.platform === "linux" && target.libc === "musl"
      ? `linuxmusl-${target.arch}.node`
      : `${target.platform}-${target.arch}.node`;
    if (!isFile(path.join(betterSqlite, "prebuilds", prebuildName))) {
      missing.push(`better-sqlite3/prebuilds/${prebuildName}`);
    }
  }

  if (!packagePath("sherpa-onnx-node")) missing.push("node_modules/sherpa-onnx-node");
  if (!packagePath("@huggingface/transformers")) missing.push("node_modules/@huggingface/transformers");
  if (!packagePath("fastify")) missing.push("node_modules/fastify");

  return missing;
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneNodeModules(nodeModulesDir, target) {
  const removed = [];
  const remove = (relative) => {
    const full = path.join(nodeModulesDir, relative);
    if (!exists(full)) return;
    removePath(full);
    removed.push(relative);
  };

  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isDirectory()) continue;
    if (name.startsWith("sherpa-onnx-") && name !== "sherpa-onnx-node" && name !== target.sherpaPackage) {
      remove(name);
    } else if (name.startsWith("sqlite-vec-") && name !== target.sqlitePackage) {
      remove(name);
    } else if (name === "onnxruntime-web") {
      // Browser-only wasm backend. The backend always runs on onnxruntime-node;
      // transformers.js resolves the wasm build only in web bundles (verified:
      // the embedding service loads and produces identical vectors without it).
      remove(name);
    } else if (name.startsWith(".")) {
      remove(name);
    } else if (name === "@img") {
      const imgDir = path.join(nodeModulesDir, "@img");
      for (const imgEntry of fs.readdirSync(imgDir, { withFileTypes: true })) {
        if (!imgEntry.isDirectory()) continue;
        const isKeep = imgEntry.name === "colour"
          || imgEntry.name === target.sharpPackage
          || imgEntry.name === target.sharpLibvipsPackage;
        if (!isKeep) remove(path.join("@img", imgEntry.name));
      }
    }
  }

  const onnxBin = path.join(nodeModulesDir, "onnxruntime-node", "bin", "napi-v6");
  if (isDir(onnxBin)) {
    for (const platformEntry of fs.readdirSync(onnxBin, { withFileTypes: true })) {
      if (!platformEntry.isDirectory()) continue;
      const platformDir = path.join(onnxBin, platformEntry.name);
      for (const archEntry of fs.readdirSync(platformDir, { withFileTypes: true })) {
        if (!archEntry.isDirectory()) continue;
        if (platformEntry.name !== target.onnxPlatform || archEntry.name !== target.onnxArch) {
          remove(path.relative(nodeModulesDir, path.join(platformDir, archEntry.name)));
        }
      }
    }
    const keptDir = path.join(onnxBin, target.onnxPlatform, target.onnxArch);
    if (isDir(keptDir)) {
      for (const file of fs.readdirSync(keptDir)) {
        if (/^libonnxruntime\.\d+(?:\.\d+)*\.dylib$/.test(file) && file !== "libonnxruntime.1.dylib") {
          remove(path.relative(nodeModulesDir, path.join(keptDir, file)));
        }
      }
    }
  }

  const betterPrebuilds = path.join(nodeModulesDir, "better-sqlite3", "prebuilds");
  if (isDir(betterPrebuilds)) {
    const keep = new Set([`${target.platform}-${target.arch}.node`]);
    if (target.platform === "linux") keep.add(`linuxmusl-${target.arch}.node`);
    for (const file of fs.readdirSync(betterPrebuilds)) {
      if (file.endsWith(".node") && !keep.has(file)) {
        remove(path.relative(nodeModulesDir, path.join(betterPrebuilds, file)));
      }
    }
  }

  // openai v7 ships its full TypeScript sources (~6MB) plus ~1.7k source maps
  // (~10MB). The runtime entry (index.js / index.mjs) never requires src/, and
  // no export subpath points at it, so both are dead weight in the bundle.
  const openaiDir = path.join(nodeModulesDir, "openai");
  if (isDir(openaiDir)) {
    remove(path.join("openai", "src"));
    for (const file of walkFiles(openaiDir, 8, (name) => name.endsWith(".map"))) {
      remove(path.relative(nodeModulesDir, file));
    }
  }

  // better-sqlite3 keeps the SQLite amalgamation and C++ sources for building
  // from scratch. Runtime loading goes straight to prebuilds/<platform>.node,
  // so those only matter when the target has no prebuild.
  const betterDir = path.join(nodeModulesDir, "better-sqlite3");
  if (isDir(betterDir)) {
    const prebuildDir = path.join(betterDir, "prebuilds");
    const prebuildNames = [`${target.platform}-${target.arch}.node`];
    if (target.platform === "linux") prebuildNames.push(`linuxmusl-${target.arch}.node`);
    const hasPrebuild = isDir(prebuildDir)
      && fs.readdirSync(prebuildDir).some((name) => prebuildNames.includes(name));
    if (hasPrebuild) {
      remove(path.join("better-sqlite3", "deps"));
      remove(path.join("better-sqlite3", "src"));
      remove(path.join("better-sqlite3", "build"));
    }
  }

  return removed;
}

function copyDirectory(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== ".DS_Store" && base !== ".git";
    },
  });
}

function copyFile(source, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (mode !== undefined && process.platform !== "win32") fs.chmodSync(destination, mode);
}

function printPlan(plan) {
  console.log("");
  console.log("LingShu desktop staging");
  console.log(`  target : ${plan.target.triple} (${plan.target.platform}/${plan.target.arch}${plan.target.libc ? `/${plan.target.libc}` : ""})`);
  console.log(`  dest   : ${plan.dest}`);
  console.log(`  mode   : ${plan.dryRun ? "dry-run" : "write"}`);
  if (plan.bytecode) {
    console.log(`  bytecode: enabled → dist/index.js (launcher) + dist/app/index.jsc${plan.dryRun ? "（dry-run 不编译）" : ""}`);
  } else {
    console.log("  bytecode: off（明文 dist，加 --bytecode / LINGSHU_STAGE_BYTECODE=1 开启）");
  }
  console.log("");

  console.log(`  [ok] backend dist : ${plan.distDir}`);
  console.log(`  [ok] backend data : ${plan.dataDir || "(dist 已包含，无需复制)"}`);
  if (plan.node) {
    console.log(`  [ok] node runtime : ${plan.node.binary}${plan.node.version !== "unknown" ? ` (v${plan.node.version})` : ""}`);
    console.log(`       license      : ${plan.node.license || "missing"}`);
  } else {
    console.log("  [--] node runtime : skipped (--no-node)");
  }

  if (plan.models.length > 0) {
    for (const model of plan.models) {
      console.log(`  [ok] ${model.label}`);
      console.log(`       ${model.source} -> ${model.relative}`);
    }
  } else {
    console.log("  [--] models       : skipped (--no-models)");
  }

  console.log(`  [ok] node_modules : ${plan.packages.size} 个生产依赖（prune 到 ${plan.target.triple}）`);
  console.log(`  native            : ${plan.target.sherpaPackage}, onnxruntime ${plan.target.onnxPlatform}/${plan.target.onnxArch}, ${plan.target.sqlitePackage}`);
  console.log(`  estimated size    : dist ${formatBytes(plan.distSize)}, node_modules ${formatBytes(plan.nodeModulesSize)}, models ${formatBytes(plan.modelsSize)}, node ${formatBytes(plan.nodeSize)}`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[error] ${error.message}`);
    usage();
    process.exit(1);
  }

  const errors = [];
  const warnings = [];
  const forbiddenDest = new Set([
    path.parse(options.dest).root,
    BACKEND_ROOT,
    REPO_ROOT,
    path.join(REPO_ROOT, "lingshu-gui"),
  ]);
  if (forbiddenDest.has(path.resolve(options.dest))) {
    console.error(`[error] 拒绝使用危险输出目录: ${options.dest}`);
    process.exit(1);
  }

  let target;
  try {
    target = resolveTarget(options.target);
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exit(1);
  }

  const bytecodeEnabled = bytecodeRequested(options);

  // compile-bytecode.mjs cleans dist and runs tsc itself, so when bytecode is
  // enabled it replaces the plain npm build (also covering --build).
  if (bytecodeEnabled && !options.dryRun) {
    try {
      runBytecodeCompile();
    } catch (error) {
      console.error(`[error] ${error.message}`);
      process.exit(1);
    }
  } else if (options.build) {
    try {
      runNpmBuild();
    } catch (error) {
      console.error(`[error] ${error.message}`);
      process.exit(1);
    }
  }

  const distDir = path.join(BACKEND_ROOT, "dist");
  if (!isFile(path.join(distDir, "index.js"))) {
    errors.push("backend-node/dist/index.js 缺失：先运行 npm run build，或给 staging 脚本加 --build");
  } else if (bytecodeEnabled && !options.dryRun && !isFile(path.join(distDir, "app", "index.jsc"))) {
    errors.push("backend-node/dist/app/index.jsc 缺失：bytecode 编译产物不完整");
  }
  const dataDir = path.join(BACKEND_ROOT, "src", "data");
  if (!isDir(dataDir)) {
    errors.push(`backend-node/src/data 缺失：${dataDir}`);
  }
  const packageJsonPath = path.join(BACKEND_ROOT, "package.json");
  if (!isFile(packageJsonPath)) errors.push(`package.json 缺失：${packageJsonPath}`);

  let node = null;
  try {
    node = resolveNode(options, target);
  } catch (error) {
    errors.push(error.message);
  }

  let packages = new Map();
  let skippedPackages = [];
  try {
    const listed = listProductionPackages();
    packages = listed.packages;
    skippedPackages = listed.skipped;
    if (packages.size === 0) errors.push("没有找到生产依赖：请在 backend-node 执行 npm ci");
  } catch (error) {
    errors.push(error.message);
  }
  errors.push(...validateNativeModules(packages, target));

  let models = [];
  if (options.includeModels) {
    try {
      const modelSource = resolveModelSource(options);
      models = [
        ...(options.includeAsr ? [planAsrModel(modelSource, options)] : []),
        planEmbeddingModel(modelSource),
        planVoiceprintModel(modelSource),
        planVadModel(modelSource),
      ];
      if (!options.includeAsr) {
        warnings.push(
          `ASR 模型不随包分发（约 226MB），首次使用请在 设置 → 语音识别 中下载：${ASR_DOWNLOAD_URL}`,
        );
      }
    } catch (error) {
      errors.push(error.message);
    }
  } else {
    warnings.push("已跳过模型（--no-models），安装包内语音能力将不可用");
  }
  if (!options.includeNode) {
    warnings.push("已跳过 Node 运行时（--no-node），安装包需要外部 node 才能启动后端");
  }

  const plan = {
    target,
    dest: options.dest,
    dryRun: options.dryRun,
    bytecode: bytecodeEnabled,
    distDir,
    dataDir,
    node,
    packages,
    models,
    nodeSize: node ? fs.statSync(node.binary).size : 0,
    distSize: dirSize(distDir),
    nodeModulesSize: [...packages.values()].reduce((sum, dir) => sum + dirSize(dir), 0),
    modelsSize: models.reduce((sum, model) => {
      return sum + (isDir(model.source) ? dirSize(model.source) : fs.statSync(model.source).size);
    }, 0),
  };

  printPlan(plan);
  if (skippedPackages.length > 0) {
    console.log(`  [skip] 空的可选平台包: ${skippedPackages.length} 个`);
  }

  if (warnings.length > 0) {
    console.log("");
    for (const warning of warnings) console.warn(`  [warn] ${warning}`);
  }

  if (errors.length > 0) {
    console.error("");
    console.error("staging 失败，缺少以下输入：");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  if (options.dryRun) {
    console.log("");
    console.log("dry-run 完成，未写入任何文件。");
    return;
  }

  if (isDir(options.dest)) removePath(options.dest);
  fs.mkdirSync(options.dest, { recursive: true });

  copyDirectory(distDir, path.join(options.dest, "dist"));
  // tsc only emits JS; legal documents and settings-defaults.json live in src/data.
  copyDirectory(dataDir, path.join(options.dest, "dist", "data"));
  copyFile(packageJsonPath, path.join(options.dest, "package.json"));

  const nodeModulesDest = path.join(options.dest, "node_modules");
  fs.mkdirSync(nodeModulesDest, { recursive: true });
  for (const source of packages.values()) {
    copyDirectory(source, path.join(nodeModulesDest, path.relative(path.join(BACKEND_ROOT, "node_modules"), source)));
  }
  const pruned = pruneNodeModules(nodeModulesDest, target);

  if (node) {
    copyFile(node.binary, path.join(options.dest, node.relative), 0o755);
    if (node.license) copyFile(node.license, path.join(options.dest, "runtime", "LICENSE.node"));
  }

  for (const model of models) {
    const destination = path.join(options.dest, ...model.relative.split("/"));
    if (isDir(model.source)) copyDirectory(model.source, destination);
    else copyFile(model.source, destination);
  }
  // Keep the Tauri resource directory present for cargo/tauri dev runs even
  // after the ignored staging output is cleaned up.
  fs.writeFileSync(path.join(options.dest, ".gitkeep"), "");

  const manifest = {
    formatVersion: 1,
    target: target.triple,
    platform: target.platform,
    arch: target.arch,
    backend: {
      name: readJson(packageJsonPath).name,
      version: readJson(packageJsonPath).version,
      entry: "dist/index.js",
      bytecode: bytecodeEnabled && isFile(path.join(options.dest, "dist", "app", "index.jsc")),
      nodeModulesPackages: packages.size,
      prunedPlatformPackages: pruned.length,
    },
    node: node
      ? { version: node.version, binary: node.relative, license: node.license ? "runtime/LICENSE.node" : null }
      : null,
    native: {
      sherpa: target.sherpaPackage,
      onnxruntime: `${target.onnxPlatform}/${target.onnxArch}`,
      sqliteVec: target.sqlitePackage,
      betterSqlite3: target.platform === "linux"
        ? [`${target.platform}-${target.arch}.node`, `linuxmusl-${target.arch}.node`]
        : [`${target.platform}-${target.arch}.node`],
    },
    models: Object.fromEntries(models.map((model) => [
      model.kind,
      {
        path: model.relative,
        files: isDir(model.source) ? countFiles(model.source) : 1,
        bytes: isDir(model.source) ? dirSize(model.source) : fs.statSync(model.source).size,
      },
    ])),
    sizes: {
      distBytes: dirSize(path.join(options.dest, "dist")),
      nodeModulesBytes: dirSize(nodeModulesDest),
      modelsBytes: models.reduce((sum, model) => sum + dirSize(path.join(options.dest, ...model.relative.split("/"))), 0),
      nodeBytes: node ? fs.statSync(path.join(options.dest, node.relative)).size : 0,
    },
  };
  fs.writeFileSync(
    path.join(options.dest, "backend-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  console.log("");
  console.log(`staging 完成: ${options.dest}`);
  console.log(`  node_modules pruned: ${pruned.length} 个非目标平台包/文件组`);
  console.log(`  total: ${formatBytes(dirSize(options.dest))}`);
  console.log("下一步: npm run tauri build（macOS 额外注意 runtime/node 的签名，见 local-docs/development-plan.md）");
}

main();
