import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";
import { getModelsDir, getRuntimeDir } from "../runtimePaths.js";
import { ASR_MODEL_ID, DEFAULT_ASR_MODEL_URL } from "./asrModelConstants.js";
import { asrStatus, discoveredAsrModel, resetAsrRuntime } from "./asrService.js";

export type AsrInstallPhase = "idle" | "downloading" | "installing" | "done" | "failed";

export interface AsrModelStatus {
  phase: AsrInstallPhase;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
  installed: boolean;
  model: string;
  installDir: string;
  sizeBytes: number;
  downloadUrl: string;
  /** Bytes already downloaded by an interrupted attempt that can be resumed. */
  resumableBytes: number;
  runtimeReady: boolean;
  runtimeMessage: string;
}

interface ManagerState {
  phase: AsrInstallPhase;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
}

const state: ManagerState = {
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: 0,
  error: "",
};

let controller: AbortController | null = null;
let activeJob: Promise<void> | null = null;
let installing = false;
let sizeCache: { dir: string; size: number } | null = null;
let staleCleaned = false;
let resumableBytes = 0;

const ASR_DIR_NAME = "asr";
const ZIP_MAX_BYTES = 1024 * 1024 * 1024;
// Release CDN throttles per connection but punishes too much concurrency:
// 8 x 1MB benchmarked best and sustains better than 16/24 streams.
const DOWNLOAD_CONNECTIONS = 8;
const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;
const DOWNLOAD_RETRIES = 3;
const CHUNK_TIMEOUT_MS = 60_000;
const DOWNLOAD_PART_FILE = "asr-download.zip.part";
const DOWNLOAD_STATE_FILE = "asr-download.json";
const RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const requireFromHere = createRequire(import.meta.url);

export function asrModelsRoot(): string {
  return path.join(getModelsDir(), ASR_DIR_NAME);
}

export function getAsrModelStatus(): AsrModelStatus {
  const discovered = discoveredAsrModel();
  const runtime = asrStatus();
  return {
    phase: state.phase,
    downloadedBytes: state.downloadedBytes,
    totalBytes: state.totalBytes,
    error: state.error,
    installed: Boolean(discovered),
    model: discovered?.name || "",
    installDir: discovered?.dir || "",
    sizeBytes: discovered ? cachedDirSize(discovered.dir) : 0,
    downloadUrl: DEFAULT_ASR_MODEL_URL,
    resumableBytes: state.phase === "downloading" ? 0 : resumableBytes,
    runtimeReady: runtime.ready,
    runtimeMessage: runtime.message,
  };
}

/** Begin a background download; resolves as soon as the download is started. */
export function startAsrModelDownload(url?: string): AsrModelStatus {
  if (activeJob || installing) return getAsrModelStatus();
  const target = normalizeUrl(url);
  state.phase = "downloading";
  state.downloadedBytes = 0;
  state.totalBytes = 0;
  state.error = "";
  controller = new AbortController();
  const signal = controller.signal;
  activeJob = runDownload(target, signal).finally(() => {
    activeJob = null;
    controller = null;
  });
  return getAsrModelStatus();
}

export function cancelAsrModelDownload(): AsrModelStatus {
  if (controller && !controller.signal.aborted) controller.abort();
  if (state.phase === "downloading") {
    state.phase = "idle";
    state.downloadedBytes = 0;
    state.totalBytes = 0;
    state.error = "";
  }
  return getAsrModelStatus();
}

/** Install a zip supplied by the user (already written to a temp file). */
export async function installAsrModelZip(zipPath: string): Promise<AsrModelStatus> {
  if (activeJob || installing) {
    throw Object.assign(new Error("已有模型任务正在进行，请稍后再试"), { statusCode: 409 });
  }
  installing = true;
  state.phase = "installing";
  state.error = "";
  try {
    await installFromZip(zipPath);
    return getAsrModelStatus();
  } catch (error) {
    state.phase = "failed";
    state.error = errorMessage(error);
    throw Object.assign(new Error(state.error), { statusCode: 400 });
  } finally {
    installing = false;
  }
}

export async function removeAsrModel(): Promise<AsrModelStatus> {
  if (activeJob || installing) {
    throw Object.assign(new Error("下载或安装进行中，无法删除模型"), { statusCode: 409 });
  }
  const root = path.resolve(asrModelsRoot());
  const discovered = discoveredAsrModel();
  if (!discovered) return getAsrModelStatus();
  const target = path.resolve(discovered.dir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw Object.assign(new Error("当前模型不在可删除的模型目录内（可能来自安装包或开发目录）"), {
      statusCode: 400,
    });
  }
  await fsp.rm(target, { recursive: true, force: true });
  await removeEmptyDir(root);
  resetAsrRuntime();
  sizeCache = null;
  // 与安装完成路径一致：让下一次语音请求不必同步加载模型。
  setImmediate(() => {
    try {
      asrStatus();
    } catch {
      /* status surfaces load errors on its own */
    }
  });
  state.phase = "idle";
  state.downloadedBytes = 0;
  state.totalBytes = 0;
  state.error = "";
  return getAsrModelStatus();
}

export function asrDownloadLimit(): number {
  return ZIP_MAX_BYTES;
}

interface DownloadResumeState {
  version: 1;
  url: string;
  etag: string;
  totalBytes: number;
  chunkBytes: number;
  done: number[];
  updatedAt: string;
}

function downloadPaths(): { dir: string; part: string; meta: string } {
  const dir = getRuntimeDir();
  return {
    dir,
    part: path.join(dir, DOWNLOAD_PART_FILE),
    meta: path.join(dir, DOWNLOAD_STATE_FILE),
  };
}

async function readDownloadState(): Promise<DownloadResumeState | null> {
  try {
    const raw = await fsp.readFile(downloadPaths().meta, "utf-8");
    return parseDownloadState(raw);
  } catch {
    return null;
  }
}

function readDownloadStateSync(): DownloadResumeState | null {
  try {
    return parseDownloadState(fs.readFileSync(downloadPaths().meta, "utf-8"));
  } catch {
    return null;
  }
}

function parseDownloadState(raw: string): DownloadResumeState | null {
  const parsed = JSON.parse(raw) as DownloadResumeState;
  if (
    parsed?.version !== 1 ||
    typeof parsed.totalBytes !== "number" ||
    typeof parsed.chunkBytes !== "number" ||
    !Array.isArray(parsed.done)
  ) {
    return null;
  }
  return parsed;
}

async function writeDownloadState(next: DownloadResumeState): Promise<void> {
  const { meta } = downloadPaths();
  const tmp = `${meta}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next));
  await fsp.rename(tmp, meta);
}

async function clearDownloadState(): Promise<void> {
  const { part, meta } = downloadPaths();
  await Promise.all([
    fsp.rm(part, { force: true }).catch(() => {}),
    fsp.rm(meta, { force: true }).catch(() => {}),
    fsp.rm(`${meta}.tmp`, { force: true }).catch(() => {}),
  ]);
  resumableBytes = 0;
}

function clearDownloadStateSync(): void {
  const { part, meta } = downloadPaths();
  for (const target of [part, meta, `${meta}.tmp`]) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* ignore */
    }
  }
  resumableBytes = 0;
}

function chunkCount(totalBytes: number, chunkBytes: number): number {
  return Math.max(0, Math.ceil(totalBytes / chunkBytes));
}

function chunkBounds(index: number, chunkBytes: number, totalBytes: number): [number, number] {
  const start = index * chunkBytes;
  return [start, Math.min(totalBytes - 1, start + chunkBytes - 1)];
}

function completedBytes(state: DownloadResumeState): number {
  let total = 0;
  for (const index of state.done) {
    const [start, end] = chunkBounds(index, state.chunkBytes, state.totalBytes);
    if (end >= start) total += end - start + 1;
  }
  return Math.min(total, state.totalBytes);
}

/**
 * Runs synchronously at module load so a status request issued right after a
 * restart already reports the resumable byte count (no async race).
 * A valid `.part` + state file is kept; orphans and stale state are removed.
 */
function initializeDownloadState(): void {
  if (staleCleaned) return;
  staleCleaned = true;
  const { dir, part } = downloadPaths();
  let state: DownloadResumeState | null = null;
  try {
    state = readDownloadStateSync();
  } catch {
    state = null;
  }

  let resumable = false;
  if (state) {
    try {
      const stats = fs.statSync(part);
      const age = state.updatedAt ? Date.now() - Date.parse(state.updatedAt) : Infinity;
      resumable =
        stats.isFile() &&
        stats.size === state.totalBytes &&
        Number.isFinite(age) &&
        age < RESUME_MAX_AGE_MS;
    } catch {
      resumable = false;
    }
  }
  if (resumable && state) {
    resumableBytes = completedBytes(state);
  } else {
    clearDownloadStateSync();
  }

  try {
    // Remove old random-name parts from previous versions and stale uploads.
    for (const name of fs.readdirSync(dir)) {
      if (/^asr-download-.*\.zip\.part$/.test(name) || /^asr-upload-.*\.zip$/.test(name)) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* runtime dir may not exist yet */
  }
}

initializeDownloadState();

async function runDownload(url: string, signal: AbortSignal): Promise<void> {
  const zipPath = downloadPaths().part;
  let keepForResume = false;
  try {
    initializeDownloadState();
    await fsp.mkdir(asrModelsRoot(), { recursive: true });
    await downloadToFile(url, zipPath, signal);
    const written = await fsp.stat(zipPath);
    if (!state.totalBytes) state.totalBytes = written.size;
    state.downloadedBytes = written.size;
    state.phase = "installing";
    await installFromZip(zipPath);
  } catch (error) {
    if (isAbort(error)) {
      state.phase = "idle";
      state.error = "";
    } else {
      state.phase = "failed";
      state.error = errorMessage(error);
      // Keep the part + state so the next attempt resumes instead of restarting.
      keepForResume = true;
    }
  } finally {
    if (!keepForResume) {
      await clearDownloadState();
    } else {
      const saved = await readDownloadState();
      if (saved) resumableBytes = completedBytes(saved);
    }
  }
}

/**
 * Download the zip with several parallel Range requests.
 *
 * The release CDN (Cloudflare) throttles each TCP connection to a few hundred
 * KB/s and the speed varies a lot per connection, so a single stream takes
 * hours for 200MB. Browsers are fast because they use multiple connections;
 * we do the same with a small dynamic chunk queue. Falls back to one stream
 * when the server does not support ranges.
 */
async function downloadToFile(url: string, zipPath: string, signal: AbortSignal): Promise<void> {
  const probe = await fetch(url, {
    signal: chunkSignal(signal),
    redirect: "follow",
    headers: {
      range: "bytes=0-0",
      accept: "application/zip,application/octet-stream,*/*",
      "accept-encoding": "identity",
    },
  });
  const contentRange = probe.headers.get("content-range") || "";
  const total = Number(contentRange.split("/").at(-1)) || 0;
  const supportsRange = probe.status === 206 && total > 0;
  await probe.body?.cancel().catch(() => {});

  if (!supportsRange) {
    await clearDownloadState();
    await downloadSingleStream(url, zipPath, signal);
    return;
  }

  state.totalBytes = total;
  // Prefer ETag/Last-Modified; fall back to size so servers without validators
  // (local test servers, simple buckets) can still resume.
  const etag = probe.headers.get("etag") || probe.headers.get("last-modified") || `size:${total}`;

  const existing = await readDownloadState();
  const partStats = await fsp.stat(zipPath).catch(() => null);
  const canResume = Boolean(
    existing &&
      existing.url === url &&
      existing.etag === etag &&
      existing.totalBytes === total &&
      existing.chunkBytes > 0 &&
      partStats?.isFile() &&
      partStats.size === total,
  );

  let resume: DownloadResumeState;
  if (canResume && existing) {
    resume = existing;
    state.downloadedBytes = completedBytes(resume);
  } else {
    await clearDownloadState();
    const handle = await fsp.open(zipPath, "w");
    try {
      await handle.truncate(total);
    } finally {
      await handle.close();
    }
    resume = {
      version: 1,
      url,
      etag,
      totalBytes: total,
      chunkBytes: DOWNLOAD_CHUNK_BYTES,
      done: [],
      updatedAt: new Date().toISOString(),
    };
    await writeDownloadState(resume);
    state.downloadedBytes = 0;
  }

  const done = new Set(resume.done);
  const totalChunks = chunkCount(total, resume.chunkBytes);
  const pending: number[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    if (!done.has(index)) pending.push(index);
  }

  // Serialize state writes: several workers finish chunks concurrently and the
  // temp-file + rename must not overlap.
  let persistChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    resume.done = [...done].sort((a, b) => a - b);
    resume.updatedAt = new Date().toISOString();
    const snapshot: DownloadResumeState = { ...resume, done: [...resume.done] };
    persistChain = persistChain.then(() => writeDownloadState(snapshot)).catch(() => {});
    return persistChain;
  };

  let nextChunk = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (!signal.aborted && !failure && nextChunk < pending.length) {
      const index = pending[nextChunk];
      nextChunk += 1;
      const [start, end] = chunkBounds(index, resume.chunkBytes, total);
      try {
        await downloadChunk(url, zipPath, start, end, signal);
        done.add(index);
        await persist();
      } catch (error) {
        failure = failure ?? error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_CONNECTIONS }, worker));

  if (failure) {
    await persist().catch(() => {});
    throw failure;
  }
  if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  if (done.size < totalChunks) throw new Error("下载未完成，请重试");
  const stats = await fsp.stat(zipPath);
  if (stats.size !== total) throw new Error(`下载不完整：${stats.size}/${total} 字节`);
}

function chunkSignal(signal: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CHUNK_TIMEOUT_MS);
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
}

async function downloadChunk(
  url: string,
  zipPath: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<void> {
  const expected = end - start + 1;
  for (let attempt = 0; ; attempt += 1) {
    let attemptBytes = 0;
    try {
      const response = await fetch(url, {
        signal: chunkSignal(signal),
        redirect: "follow",
        headers: {
          range: `bytes=${start}-${end}`,
          accept: "application/zip,*/*",
          "accept-encoding": "identity",
        },
      });
      if (response.status !== 206 || !response.body) {
        throw new Error(`分片下载失败：HTTP ${response.status}`);
      }
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          attemptBytes += chunk.length;
          state.downloadedBytes += chunk.length;
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as any),
        counter,
        fs.createWriteStream(zipPath, { flags: "r+", start }),
      );
      if (attemptBytes !== expected) throw new Error(`分片长度不符（${attemptBytes}/${expected}）`);
      return;
    } catch (error) {
      // Roll back progress from the failed attempt before retrying.
      state.downloadedBytes = Math.max(0, state.downloadedBytes - attemptBytes);
      if (signal.aborted || isAbort(error)) throw error;
      if (attempt >= DOWNLOAD_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

async function downloadSingleStream(url: string, zipPath: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, {
    signal,
    redirect: "follow",
    headers: { accept: "application/zip,application/octet-stream,*/*" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }
  state.totalBytes = Number(response.headers.get("content-length") || 0) || 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      state.downloadedBytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as any), counter, fs.createWriteStream(zipPath));
}

async function installFromZip(zipPath: string): Promise<void> {
  const root = asrModelsRoot();
  await fsp.mkdir(root, { recursive: true });
  const staging = path.join(root, `.install-${randomUUID()}`);
  const backups: string[] = [];
  try {
    const stats = await fsp.stat(zipPath);
    if (!stats.isFile() || stats.size === 0) throw new Error("模型压缩包为空");
    await extractZipSafe(zipPath, staging);

    const modelRoot = findModelRoot(staging);
    if (!modelRoot) {
      throw new Error("压缩包里没有找到语音识别模型（需要 tokens.txt + encoder/decoder）");
    }
    const manifest =
      (await readManifest(path.join(staging, "manifest.json"))) ??
      (await readManifest(path.join(modelRoot, "manifest.json"))) ??
      (await readManifest(path.join(path.dirname(modelRoot), "manifest.json")));
    await verifyManifest(manifest, modelRoot);
    // Loading a corrupt ONNX file aborts the process inside onnxruntime, so the
    // model is smoke-tested in a child process before it replaces a good copy.
    await verifyModelLoads(modelRoot);

    const targetName =
      path.resolve(modelRoot) === path.resolve(staging)
        ? ASR_MODEL_ID
        : path.basename(modelRoot);
    const target = path.join(root, targetName);

    if (path.resolve(target) === path.resolve(modelRoot)) {
      throw new Error("模型安装路径异常，请重试");
    }

    if (fs.existsSync(target)) {
      const backup = path.join(root, `.backup-${targetName}-${Date.now()}`);
      await fsp.rename(target, backup);
      backups.push(backup);
    }
    try {
      await fsp.rename(modelRoot, target);
    } catch (error) {
      const backup = backups.pop();
      if (backup && !fs.existsSync(target)) await fsp.rename(backup, target).catch(() => {});
      throw error;
    }

    // The archive has been fully extracted by now, so the resume files can go
    // before the UI sees `done` (avoids a poll landing between the two).
    await clearDownloadState();
    resetAsrRuntime();
    sizeCache = null;
    state.phase = "done";
    state.downloadedBytes = state.totalBytes || state.downloadedBytes;
    state.error = "";
    // Warm the recognizer in the background so the next voice request is fast.
    setImmediate(() => {
      try {
        asrStatus();
      } catch {
        /* status surfaces load errors on its own */
      }
    });
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    for (const backup of backups) {
      await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function extractZipSafe(zipPath: string, dest: string): Promise<void> {
  const zip = new AdmZip(zipPath);
  const root = path.resolve(dest);
  await fsp.mkdir(root, { recursive: true });
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, "/");
    if (name.startsWith("__MACOSX/") || name.endsWith("/.DS_Store") || name === ".DS_Store") continue;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`模型压缩包包含非法路径：${entry.entryName}`);
    }
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`模型压缩包包含非法路径：${entry.entryName}`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, entry.getData());
  }
}

function findModelRoot(root: string, maxDepth = 3): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (isModelDir(dir)) return dir;
    if (depth >= maxDepth) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return null;
}

function isModelDir(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, "tokens.txt"))) return false;
  const has = (names: string[]) =>
    names.some((name) => fs.existsSync(path.join(dir, name))) ||
    names.some((name) => fs.existsSync(path.join(dir, "onnx", name)));
  const hasEncoder = has(["encoder.int8.onnx", "encoder.onnx"]);
  const hasDecoder = has(["decoder.int8.onnx", "decoder.onnx"]);
  return hasEncoder && hasDecoder;
}

interface ZipManifestEntry {
  size?: number;
  sha256?: string;
}

interface ZipManifest {
  formatVersion?: number;
  modelId?: string;
  files?: Record<string, ZipManifestEntry>;
}

async function readManifest(file: string): Promise<ZipManifest | null> {
  try {
    const raw = await fsp.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ZipManifest) : null;
  } catch {
    return null;
  }
}

async function verifyManifest(manifest: ZipManifest | null, modelRoot: string): Promise<void> {
  const files = manifest?.files;
  if (!files || typeof files !== "object") return;
  for (const [name, meta] of Object.entries(files)) {
    const file = await findFileByBasename(modelRoot, path.basename(name));
    if (!file) throw new Error(`模型文件缺失：${name}`);
    const stats = await fsp.stat(file);
    if (typeof meta?.size === "number" && stats.size !== meta.size) {
      throw new Error(`模型文件大小不匹配：${name}`);
    }
    if (typeof meta?.sha256 === "string" && meta.sha256) {
      const digest = await sha256(file);
      if (digest.toLowerCase() !== meta.sha256.toLowerCase()) {
        throw new Error(`模型文件校验失败：${name}`);
      }
    }
  }
}

async function findFileByBasename(root: string, basename: string): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    const direct = path.join(dir, basename);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    if (depth >= 3) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return null;
}

/**
 * Smoke-test the model in a child process.
 *
 * onnxruntime aborts the whole process on a malformed model (the exception is
 * C++, not catchable from JS), so a corrupt zip imported by the user would kill
 * the backend. Loading it here first turns that into a normal install error.
 */
async function verifyModelLoads(modelRoot: string): Promise<void> {
  let sherpaPath: string;
  try {
    sherpaPath = requireFromHere.resolve("sherpa-onnx-node");
  } catch {
    throw new Error("当前运行环境缺少 sherpa-onnx-node，无法校验模型");
  }
  const script = `
const fs = require('node:fs');
const path = require('node:path');
const sherpa = require(${JSON.stringify(sherpaPath)});
const dir = process.argv[1];
function pick(names) {
  for (const name of names) {
    for (const candidate of [path.join(dir, name), path.join(dir, 'onnx', name)]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}
const tokens = path.join(dir, 'tokens.txt');
const encoder = pick(['encoder.int8.onnx', 'encoder.onnx']);
const decoder = pick(['decoder.int8.onnx', 'decoder.onnx']);
const joiner = pick(['joiner.int8.onnx', 'joiner.onnx']);
const model = pick(['model.int8.onnx', 'model.onnx', 'model_quantized.onnx']);
const featConfig = { sampleRate: 16000, featureDim: 80 };
if (encoder && decoder) {
  const modelConfig = joiner
    ? { transducer: { encoder, decoder, joiner }, tokens, numThreads: 1, provider: 'cpu', debug: 0 }
    : { paraformer: { encoder, decoder }, tokens, numThreads: 1, provider: 'cpu', debug: 0 };
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig,
    modelConfig,
    decodingMethod: 'greedy_search',
  });
  recognizer.createStream();
} else if (model) {
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig,
    modelConfig: { paraformer: { model }, tokens, numThreads: 1, provider: 'cpu', debug: 0 },
  });
  recognizer.createStream();
} else {
  process.exit(3);
}
process.exit(0);
`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, modelRoot], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("模型加载校验超时，请检查模型文件是否完整"));
    }, 120_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`模型加载校验失败：${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split("\n").filter(Boolean).pop() || "";
      reject(
        new Error(
          `模型文件无法加载（可能不是有效的 ONNX 模型）${detail ? `：${detail}` : ""}`,
        ),
      );
    });
  });
}

function sha256(file: string): Promise<string> {  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function cachedDirSize(dir: string): number {
  if (sizeCache?.dir === dir) return sizeCache.size;
  const size = dirSizeSync(dir);
  sizeCache = { dir, size };
  return size;
}

function dirSizeSync(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(target).size;
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  }
  return total;
}

async function removeEmptyDir(dir: string): Promise<void> {
  try {
    const entries = await fsp.readdir(dir);
    if (entries.length === 0) await fsp.rmdir(dir);
  } catch {
    /* not empty or already gone */
  }
}

function normalizeUrl(raw?: string): string {
  const value = String(raw || "").trim() || DEFAULT_ASR_MODEL_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("下载地址无效"), { statusCode: 400 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw Object.assign(new Error("下载地址必须是 http(s)"), { statusCode: 400 });
  }
  return url.toString();
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as any).code === "ABORT_ERR")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
