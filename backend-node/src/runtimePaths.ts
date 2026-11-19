import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function getDataRoot(): string {
  if (process.env.LINGSHU_DATA_DIR) return process.env.LINGSHU_DATA_DIR;
  const pointer = path.join(os.homedir(), ".lingshu", "data-path");
  try {
    const configured = fs.readFileSync(pointer, "utf-8").trim();
    if (configured && fs.existsSync(configured)) return configured;
  } catch {
    // no persisted override
  }
  return path.join(os.homedir(), ".lingshu");
}

export function getRuntimeDir(): string {
  const dir = path.join(getDataRoot(), "runtime");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getModelsDir(): string {
  return path.join(getDataRoot(), "models");
}

export function getChatUploadDir(): string {
  const dir = path.join(getRuntimeDir(), "chat_uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAudioCacheDir(): string {
  const dir = path.join(getRuntimeDir(), "audio_cache");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getVoiceSegmentDir(): string {
  const dir = path.join(os.tmpdir(), "lingshu_voice_segments");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getLicenseDir(): string {
  const dir = path.join(getRuntimeDir(), "license");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getVoiceprintDir(): string {
  return path.join(getModelsDir(), "voiceprint");
}

export function getWechatDir(): string {
  const dir = path.join(getRuntimeDir(), "wechat");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
