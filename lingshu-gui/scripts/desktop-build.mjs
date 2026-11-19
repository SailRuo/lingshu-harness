import { spawnSync } from "node:child_process";
import path from "node:path";

const tauri = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const args = ["build"];
// macOS needs the app/dmg targets plus entitlements; Windows keeps the base
// NSIS target from tauri.conf.json.
if (process.platform === "darwin") {
  args.push("--config", "src-tauri/tauri.macos.conf.json");
}

// The backend stage step runs via tauri.conf.json's beforeBuildCommand
// (npm run stage:desktop:build), so we can't pass --bytecode through argv.
// LINGSHU_STAGE_BYTECODE is inherited by the beforeBuildCommand shell and read
// by backend-node/scripts/stage-runtime.mjs, shipping the backend as V8
// bytecode (bytenode) instead of readable JS. desktop:build:mac / desktop:build:win
// invoke tauri directly without this script — prefix them with
// LINGSHU_STAGE_BYTECODE=1 (see lingshu-gui/README.md) or stage manually first.
const env = { ...process.env, LINGSHU_STAGE_BYTECODE: "1" };

const result = spawnSync(tauri, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});
process.exit(result.status ?? 1);
