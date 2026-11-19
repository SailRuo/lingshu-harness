import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

/**
 * Package the streaming paraformer ASR weights into a distributable zip for
 * in-app download/import (the desktop bundle no longer ships ASR weights).
 *
 * Layout (matches the mobile app release package):
 *   manifest.json
 *   sherpa-onnx-streaming-paraformer-zh/encoder.int8.onnx
 *   sherpa-onnx-streaming-paraformer-zh/decoder.int8.onnx
 *   sherpa-onnx-streaming-paraformer-zh/tokens.txt
 *
 * Usage: npm run package:asr-model
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendRoot, "..");
const home = process.env.HOME || process.env.USERPROFILE || "";

const modelId = process.env.LINGSHU_ASR_MODEL_NAME || "sherpa-onnx-streaming-paraformer-zh";
const assets = ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"];

async function allExist(dir) {
  for (const asset of assets) {
    try {
      const info = await stat(path.join(dir, asset));
      if (!info.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

const roots = [
  process.env.LINGSHU_MODEL_SOURCE,
  path.join(home, "Project", "lingshu-app-local", ".lingshu", "models"),
  path.join(repoRoot, "..", "lingshu-app-local", ".lingshu", "models"),
  path.join(repoRoot, ".lingshu", "models"),
  path.join(repoRoot, "models"),
  path.join(backendRoot, "models"),
].filter(Boolean);

let sourceRoot = null;
for (const root of roots) {
  const candidate = path.join(root, modelId);
  if (await allExist(candidate)) {
    sourceRoot = candidate;
    break;
  }
}
if (!sourceRoot) {
  console.error(
    `[package:asr-model] 找不到 ASR 模型文件（期望 <模型根>/${modelId} 下包含 ${assets.join(", ")}）`,
  );
  process.exit(1);
}

const files = {};
for (const asset of assets) {
  const filePath = path.join(sourceRoot, asset);
  const info = statSync(filePath);
  process.stdout.write(`[package:asr-model] sha256 ${asset} (${(info.size / 1048576).toFixed(1)} MB)…\r`);
  files[asset] = { size: info.size, sha256: await sha256(filePath) };
}
console.log("[package:asr-model] sha256 计算完成");

const manifest = {
  formatVersion: 1,
  modelId,
  createdAt: new Date().toISOString(),
  files,
};

const zip = new AdmZip();
zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
for (const asset of assets) {
  zip.addLocalFile(path.join(sourceRoot, asset), modelId);
}

const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const releasesRoot = path.join(backendRoot, "releases");
await mkdir(releasesRoot, { recursive: true });
const zipPath = path.join(releasesRoot, `lingshu-asr-model-${modelId}-${dateTag}.zip`);
zip.writeZip(zipPath);

const size = statSync(zipPath).size;
console.log(
  `[package:asr-model] 已生成 ${zipPath} (${(size / 1048576).toFixed(1)} MB)`,
);
console.log("[package:asr-model] 上传后把地址写进 LINGSHU_ASR_MODEL_URL，或更新后端默认下载地址。");
