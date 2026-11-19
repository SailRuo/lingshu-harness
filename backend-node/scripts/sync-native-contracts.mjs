#!/usr/bin/env node
/**
 * Sync the APP native contract sources into the desktop backend.
 *
 * Copies, byte for byte:
 *   <app>/shared/native-digest/source.mjs  -> src/contracts/native/generated/nativeDigestSource.generated.ts
 *   <app>/shared/native-chat/source.mjs    -> src/contracts/native/generated/nativeChatSource.generated.ts
 *
 * The copy only changes the file extension: the APP sources are plain ESM and
 * compile as TypeScript, which is what lets the desktop keep `allowJs: false`.
 * The wrapper modules add types; this script never edits them.
 *
 * Usage:
 *   node scripts/sync-native-contracts.mjs --app-root /path/to/lingshu-app-local
 *   node scripts/sync-native-contracts.mjs --check --app-root /path/to/lingshu-app-local
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const desktopRoot = path.resolve(backendRoot, "..");
const defaultAppRoot = path.resolve(
  desktopRoot,
  "..",
  "lingshu-app-local",
  "lingshu-app-local",
);

function usage() {
  console.log(
    [
      "Usage: node scripts/sync-native-contracts.mjs [--check] [--app-root <path>]",
      "",
      "  --check             compare hashes only; write nothing; exit 1 on drift",
      "  --app-root <path>   lingshu-app-local repository root",
      `                      (default: ${defaultAppRoot})`,
    ].join("\n"),
  );
}

function parseArgs(argv) {
  let check = false;
  let appRoot = process.env.LINGSHU_APP_ROOT || defaultAppRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--app-root") {
      appRoot = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--app-root=")) {
      appRoot = arg.slice("--app-root=".length);
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }
  if (!appRoot) {
    console.error("--app-root must not be empty");
    process.exit(2);
  }
  return { check, appRoot: path.resolve(appRoot) };
}

const targets = [
  {
    label: "native-digest",
    source: "shared/native-digest/source.mjs",
    target: "src/contracts/native/generated/nativeDigestSource.generated.ts",
    hash: "src/contracts/native/generated/nativeDigestSource.sha256",
  },
  {
    label: "native-chat",
    source: "shared/native-chat/source.mjs",
    target: "src/contracts/native/generated/nativeChatSource.generated.ts",
    hash: "src/contracts/native/generated/nativeChatSource.sha256",
  },
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readHashFile(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return text.trim().split(/\s+/)[0] || "";
  } catch {
    return "";
  }
}

async function main() {
  const { check, appRoot } = parseArgs(process.argv.slice(2));
  let failed = false;

  for (const item of targets) {
    const sourcePath = path.join(appRoot, item.source);
    const targetPath = path.resolve(backendRoot, item.target);
    const hashPath = path.resolve(backendRoot, item.hash);

    let sourceBuffer;
    try {
      sourceBuffer = await readFile(sourcePath);
    } catch (error) {
      console.error(`[missing] ${item.label}: cannot read ${sourcePath}`);
      console.error(`          ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      failed = true;
      continue;
    }

    const sourceHash = sha256(sourceBuffer);
    const targetHash = await readHashFile(hashPath);

    if (check) {
      let currentBuffer;
      try {
        currentBuffer = await readFile(targetPath);
      } catch {
        console.error(`[drift] ${item.label}: generated copy is missing`);
        process.exitCode = 1;
        failed = true;
        continue;
      }
      const currentHash = sha256(currentBuffer);
      if (currentHash !== sourceHash) {
        console.error(
          `[drift] ${item.label}: expected ${sourceHash} (APP), found ${currentHash} (desktop)`,
        );
        process.exitCode = 1;
        failed = true;
      } else if (targetHash !== sourceHash) {
        console.error(
          `[drift] ${item.label}: copy matches but ${item.hash} says ${targetHash || "<empty>"}`,
        );
        process.exitCode = 1;
        failed = true;
      } else {
        console.log(`[ok] ${item.label}: ${sourceHash}`);
      }
      continue;
    }

    await writeFile(targetPath, sourceBuffer);
    await writeFile(hashPath, `${sourceHash}  ${path.basename(targetPath)}\n`, "utf8");
    console.log(`[synced] ${item.label}: ${item.source} -> ${item.target}`);
    console.log(`         sha256 ${sourceHash}`);
  }

  if (!check && !failed) {
    for (const item of targets) {
      const moduleUrl = pathToFileURL(path.join(appRoot, item.source)).href;
      const mod = await import(moduleUrl);
      const version = mod?.META?.version;
      console.log(`[version] ${item.label}: META.version=${version ?? "unknown"}`);
    }
    console.log("\nNext: cd backend-node && npm run typecheck");
  }

  if (check && failed) {
    console.error("\nContract copies are out of sync with the APP source.");
  }
}

await main();
