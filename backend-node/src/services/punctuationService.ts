import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { getModelsDir } from "../runtimePaths.js";

const require = createRequire(import.meta.url);

/** Mirrors Python PUNCT_MODEL_NAME in backend/core/services/asr_service.py. */
export const PUNCT_MODEL_NAME = "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8";

const MODEL_FILE_NAMES = ["model.int8.onnx", "model.onnx"];

export interface PunctuationStatus {
  ready: boolean;
  model: string;
  modelPath: string;
  message: string;
}

let punctuator: any = null;
let attempted = false;
let initError: string | null = null;
let resolvedModelPath: string | null = null;

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Model roots, highest priority first: explicit env override, user models
 * directory, packaged/resources models, project-local .lingshu/models, and the
 * sibling app-local project used during development.
 */
function punctuationModelRoots(): string[] {
  const executableDir = path.dirname(process.execPath);
  const roots = [
    process.env.LINGSHU_PUNCT_MODEL_DIR || "",
    getModelsDir(),
    path.join(executableDir, "models"),
    path.join(executableDir, "resources", "models"),
    path.join(process.cwd(), "models"),
    path.join(process.cwd(), ".lingshu", "models"),
    path.join(os.homedir(), ".lingshu", "models"),
    path.resolve(process.cwd(), "..", "..", "lingshu-app-local", ".lingshu", "models"),
    path.join(os.homedir(), "Project", "lingshu-app-local", ".lingshu", "models"),
  ];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const normalized = path.resolve(root);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function findModelInRoot(root: string, allowDirect: boolean): string | null {
  // The env override may point directly at an .onnx file or the model dir.
  if (isFile(root) && root.toLowerCase().endsWith(".onnx")) return root;
  if (allowDirect) {
    for (const name of MODEL_FILE_NAMES) {
      const direct = path.join(root, name);
      if (isFile(direct)) return direct;
    }
  }
  // Standard layout: <root>/<PUNCT_MODEL_NAME>/model[.int8].onnx
  for (const name of MODEL_FILE_NAMES) {
    const candidate = path.join(root, PUNCT_MODEL_NAME, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function findPunctuationModel(): string | null {
  const envRoot = process.env.LINGSHU_PUNCT_MODEL_DIR
    ? path.resolve(process.env.LINGSHU_PUNCT_MODEL_DIR)
    : "";
  if (envRoot) {
    const found = findModelInRoot(envRoot, true);
    if (found) return found;
  }
  for (const root of punctuationModelRoots()) {
    if (root === envRoot) continue;
    const found = findModelInRoot(root, false);
    if (found) return found;
  }
  return null;
}

// The native addon aborts the whole process (instead of throwing) when
// onnxruntime cannot parse the file, so reject obviously broken downloads
// before calling into it. Valid ONNX models are protobuf files whose first
// field (ir_version, tag 0x08) comes first and are far larger than this.
const MIN_MODEL_BYTES = 1024 * 1024;

function validateModelFile(modelPath: string): string | null {
  try {
    const stat = fs.statSync(modelPath);
    if (!stat.isFile()) return "不是文件";
    if (stat.size < MIN_MODEL_BYTES) return "文件过小或不完整";
    const fd = fs.openSync(modelPath, "r");
    try {
      const header = Buffer.alloc(1);
      fs.readSync(fd, header, 0, 1, 0);
      if (header[0] !== 0x08) return "不是有效的 ONNX 模型";
    } finally {
      fs.closeSync(fd);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function loadPunctuation(): void {
  const modelPath = findPunctuationModel();
  if (!modelPath) {
    initError = `未找到标点模型 ${PUNCT_MODEL_NAME}`;
    return;
  }
  const invalidReason = validateModelFile(modelPath);
  if (invalidReason) {
    initError = `标点模型不可用 (${invalidReason}): ${modelPath}`;
    return;
  }
  try {
    const sherpa = require("sherpa-onnx-node") as any;
    if (typeof sherpa?.OfflinePunctuation !== "function") {
      initError = "当前 sherpa-onnx-node 不支持 OfflinePunctuation";
      return;
    }
    punctuator = new sherpa.OfflinePunctuation({
      model: {
        ctTransformer: modelPath,
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
    });
    resolvedModelPath = modelPath;
    initError = null;
  } catch (error) {
    punctuator = null;
    resolvedModelPath = null;
    initError = error instanceof Error ? error.message : String(error);
    console.warn(`[ASR] 标点模型加载失败，将不使用标点增强: ${initError}`);
  }
}

/** Loads the optional punctuation model once; never throws. */
export function ensurePunctuator(): { punctuator: any; modelPath: string } | null {
  if (!attempted) {
    attempted = true;
    loadPunctuation();
  }
  return punctuator ? { punctuator, modelPath: resolvedModelPath || "" } : null;
}

export function punctuationStatus(): PunctuationStatus {
  const state = ensurePunctuator();
  if (state) {
    return {
      ready: true,
      model: PUNCT_MODEL_NAME,
      modelPath: state.modelPath,
      message: `标点模型已就绪 (${PUNCT_MODEL_NAME})`,
    };
  }
  return {
    ready: false,
    model: "",
    modelPath: "",
    message: initError || `未找到标点模型 ${PUNCT_MODEL_NAME}`,
  };
}

/**
 * Adds punctuation when the optional model is available. On any failure the
 * cleaned original text is returned, so ASR output is never blocked.
 */
export function punctuateText(text: string): string {
  const clean = String(text || "").trim();
  if (!clean) return clean;
  const state = ensurePunctuator();
  if (!state) return clean;
  try {
    const punctuated = String(state.punctuator.addPunct(clean) || "").trim();
    return punctuated || clean;
  } catch (error) {
    console.warn(
      `[ASR] 标点失败，返回原文: ${error instanceof Error ? error.message : String(error)}`,
    );
    return clean;
  }
}
