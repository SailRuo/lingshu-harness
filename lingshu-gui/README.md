# Tauri + Vue + TypeScript

This template should help get you started developing with Vue 3 and TypeScript in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## 桌面打包与后端字节码
- `npm run desktop:build`：走 `scripts/desktop-build.mjs` → tauri build → beforeBuildCommand（`npm run build && npm run stage:desktop:build`）。该脚本会注入 `LINGSHU_STAGE_BYTECODE=1`，后端 dist 自动编译为 V8 字节码（bytenode），安装包内不含明文业务 JS。
- `npm run desktop:build:mac` / `desktop:build:win` 直调 `tauri build`，beforeBuildCommand 同样会执行 staging（会清空并重写 resources/backend，因此手动预 stage 会被覆盖）。要让这两条链路也带字节码，请在命令前显式设置环境变量：
  ```bash
  LINGSHU_STAGE_BYTECODE=1 npm run desktop:build:mac
  ```
- 字节码绑定编译用 Node 的 V8 版本：staging 默认打包当前 Node 为 `runtime/node`，两者天然一致；跨机器/跨平台构建时请用 `LINGSHU_NODE_BINARY` 指定与编译机同主版本的 Node。
- 仅 staging 后端（不打包安装包）时：`cd backend-node && npm run stage:desktop -- --bytecode`，开发调试可省略该开关（明文 dist）。
