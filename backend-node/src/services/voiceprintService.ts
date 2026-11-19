import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { getDb } from "../db/sqlite.js";
import { getModelsDir, getVoiceprintDir } from "../runtimePaths.js";
import { parseWav, resample } from "./asrService.js";
import { getUserProfile } from "./userService.js";

const require = createRequire(import.meta.url);

function walk(root: string, maxDepth = 4): string[] {
  const result: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".onnx")) result.push(target);
    }
  };
  visit(root, 0);
  return result;
}

let modelPath: string | null | undefined;
let initError: string | null = null;

function discoverModel(): string | null {
  if (modelPath !== undefined) return modelPath;
  const executableDir = path.dirname(process.execPath);
  const roots = [
    ...(process.env.LINGSHU_VOICEPRINT_MODEL_DIR ? [process.env.LINGSHU_VOICEPRINT_MODEL_DIR] : []),
    getVoiceprintDir(),
    getModelsDir(),
    path.join(executableDir, "models"),
    path.join(executableDir, "resources", "models"),
    path.join(process.cwd(), "models"),
    path.join(process.cwd(), ".lingshu", "models"),
    path.join(os.homedir(), ".lingshu", "models"),
    // Dev fallback: sibling lingshu-app-local project keeps the bundled models.
    path.resolve(process.cwd(), "..", "..", "lingshu-app-local", ".lingshu", "models"),
    path.join(os.homedir(), "Project", "lingshu-app-local", ".lingshu", "models"),
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    if (path.basename(path.resolve(root)).toLowerCase() === "embeddings") continue;
    candidates.push(...walk(root));
  }
  const preferred = candidates
    .filter((candidate) => {
      // Match the file name only: the word "embeddings" also appears in the
      // bge text-embedding directory path and must not be treated as a speaker model.
      const base = path.basename(candidate).toLowerCase();
      return /campplus|eres2net|3dspeaker|speaker/.test(base);
    })
    .sort((left, right) => {
      const leftInt8 = path.basename(left).toLowerCase().includes(".int8.") ? 1 : 0;
      const rightInt8 = path.basename(right).toLowerCase().includes(".int8.") ? 1 : 0;
      return leftInt8 - rightInt8;
    });
  modelPath = preferred[0] || null;
  if (!modelPath) initError = "声纹识别深度模型 (CAM++) 未就绪";
  return modelPath;
}

export function voiceprintStatus() {
  return {
    ready: Boolean(discoverModel()),
    model: modelPath || "",
    message: modelPath ? "声纹模型已就绪" : initError || "声纹模型未就绪",
  };
}

function extractEmbedding(audioBase64: string): number[] {
  const model = discoverModel();
  if (!model) throw Object.assign(new Error(initError || "声纹模型未就绪"), { statusCode: 503 });
  let buffer: Buffer;
  try {
    buffer = Buffer.from(audioBase64, "base64");
  } catch {
    throw Object.assign(new Error("Invalid audioBase64 payload"), { statusCode: 400 });
  }
  if (buffer.length < 1600) {
    throw Object.assign(new Error("录音时长过短，请至少说一秒钟"), { statusCode: 400 });
  }
  const wav = parseWav(buffer);
  if (!wav) throw Object.assign(new Error("音频必须是 WAV 格式"), { statusCode: 400 });
  const samples = resample(wav.samples, wav.sampleRate);
  try {
    const sherpa = require("sherpa-onnx-node") as any;
    const extractor = new sherpa.SpeakerEmbeddingExtractor({
      model,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    });
    const stream = extractor.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    const embedding = extractor.compute(stream) as Float32Array;
    if (!embedding?.length) {
      throw new Error("声纹特征为空");
    }
    return Array.from(embedding);
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
      statusCode: 500,
    });
  }
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function loadEmbedding(userId: string): number[] {
  const row = getDb()
    .prepare("SELECT voiceprint_embedding FROM user_profiles WHERE user_id = ?")
    .get(userId) as { voiceprint_embedding: string } | undefined;
  if (!row?.voiceprint_embedding) return [];
  try {
    const parsed = JSON.parse(row.voiceprint_embedding);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

export function enrollVoiceprint(userId: string, audioBase64: string, append = false) {
  getUserProfile(userId);
  const embedding = normalize(extractEmbedding(audioBase64));
  if (!embedding.length) {
    throw Object.assign(new Error("未能提取声纹特征"), { statusCode: 500 });
  }
  const existing = loadEmbedding(userId);
  const merged =
    append && existing.length === embedding.length
      ? normalize(existing.map((value, index) => value * 0.7 + embedding[index] * 0.3))
      : embedding;
  const db = getDb();
  const row = db
    .prepare("SELECT voiceprint_sample_count FROM user_profiles WHERE user_id = ?")
    .get(userId) as { voiceprint_sample_count: number };
  const sampleCount = append && existing.length ? Number(row.voiceprint_sample_count) + 1 : 1;
  db.prepare(
    `UPDATE user_profiles SET voiceprint_embedding = ?, voiceprint_sample_count = ?,
      updated_at = datetime('now') WHERE user_id = ?`,
  ).run(JSON.stringify(merged), sampleCount, userId);
  return {
    success: true,
    sampleCount,
    dim: merged.length,
    message: "声纹特征录入成功",
  };
}

export function verifyVoiceprint(userId: string, audioBase64: string, threshold?: number) {
  const profile = getUserProfile(userId);
  const effectiveThreshold = threshold ?? profile.voiceprintThreshold ?? 0.65;
  const existing = loadEmbedding(userId);
  if (!existing.length) {
    return {
      enrolled: false,
      matched: true,
      score: 1,
      threshold: effectiveThreshold,
      message: "尚未录入声纹，默认放行",
    };
  }
  let embedding: number[] = [];
  try {
    embedding = normalize(extractEmbedding(audioBase64));
  } catch {
    return {
      enrolled: true,
      matched: false,
      score: 0,
      threshold: effectiveThreshold,
      message: "声纹提取失败",
    };
  }
  const raw = cosine(existing, embedding);
  const score = Math.round(Math.max(0, Math.min(1, (raw + 1) / 2)) * 10000) / 10000;
  return {
    enrolled: true,
    matched: score >= effectiveThreshold,
    score,
    threshold: effectiveThreshold,
    message: score >= effectiveThreshold ? "声纹匹配通过" : "声纹不匹配",
  };
}

export function clearVoiceprint(userId: string) {
  getUserProfile(userId);
  getDb()
    .prepare(
      `UPDATE user_profiles SET voiceprint_embedding = '', voiceprint_sample_count = 0,
        voiceprint_enabled = 0, updated_at = datetime('now') WHERE user_id = ?`,
    )
    .run(userId);
  return { success: true, message: "声纹特征已清除" };
}
