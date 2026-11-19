import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeDir } from "../runtimePaths.js";

function getKey(): Buffer {
  const target = path.join(getRuntimeDir(), "secret.key");
  if (fs.existsSync(target)) {
    const existing = Buffer.from(fs.readFileSync(target, "utf-8").trim(), "base64");
    if (existing.length === 32) return existing;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(target, key.toString("base64"), { encoding: "utf-8", mode: 0o600 });
  return key;
}

export function encryptSecret(value: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string | null | undefined): string {
  const [ivRaw, tagRaw, dataRaw] = String(value || "").split(":");
  if (!ivRaw || !tagRaw || !dataRaw) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivRaw, "base64"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw, "base64")),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return "";
  }
}
