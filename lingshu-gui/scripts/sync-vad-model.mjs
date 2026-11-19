import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(guiRoot, '..');
const targetFile = path.join(guiRoot, 'src-tauri', 'resources', 'vad', 'silero_vad.onnx');

const sourceCandidates = [
  path.join(repoRoot, '.lingshu', 'models', 'vad', 'silero_vad.onnx'),
  path.join(repoRoot, 'models', 'vad', 'silero_vad.onnx'),
];

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

let sourceFile = null;
for (const candidate of sourceCandidates) {
  if (await exists(candidate)) {
    sourceFile = candidate;
    break;
  }
}

if (!sourceFile) {
  console.error('[sync:vad] 找不到 silero_vad.onnx');
  console.error('[sync:vad] 请放到以下任一位置后重试:');
  for (const candidate of sourceCandidates) {
    console.error(`  - ${candidate}`);
  }
  process.exit(1);
}

await mkdir(path.dirname(targetFile), { recursive: true });
await copyFile(sourceFile, targetFile);
const sizeMb = (await stat(targetFile)).size / 1024 / 1024;
console.log(`[sync:vad] ${sourceFile}`);
console.log(`[sync:vad] -> ${targetFile} (${sizeMb.toFixed(2)} MB)`);
