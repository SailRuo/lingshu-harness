# lingshu-backend-node

Node.js/TypeScript 后端，替代 `LingShu-Agent/backend`（Python/FastAPI）。未实现端点不再回退 Python。

## 当前状态
- 路由清单全覆盖：155 HTTP + 4 WS，无 501 占位（按决策保留 SER 501）。
- Chat：SSE completions、thread-duplex、voice-duplex、线程/消息/历史/导入/上传/删除。
- Tools：原生工具、MCP CRUD/连接/调用、审批、Task 模式与任务事件/取消/恢复。
- Memory：SQLite streams/seeds/entities/facts/edges/threads/touchpoints/tick-log/recall traces/portraits；45s 批量 digest 与真实 import job；AKIN judge + 两跳召回；seed 激活传播；witness/arc/frozen/mirror；baseline/self-state；后台 tick。
- Voice：TTS（OpenAI 兼容、火山引擎、阿里云 CosyVoice、小米 MIMO、Fish Audio）、sherpa-onnx ASR/声纹、火山音色克隆。
- 外围：Agent Transfer、微信扫码+入站轮询+媒体、QQBot 网关+媒体、Usage、Logs、Proactive Pool（实际投递）、系统设置。

## 运行
```bash
cd backend-node
npm install
npm run dev
```

默认端口 8600。冒烟或与 Python 并存时建议用 `PORT=8601`。

## 环境变量
见 `src/config.ts`：`PORT`, `HOST`, `BACKEND_MODE`, `PYTHON_BACKEND_URL`, `LOG_LEVEL`, `DB_PATH`。
Embedding 模型可通过 `LINGSHU_EMBEDDING_MODEL` 指定（默认 `Xenova/bge-base-zh-v1.5`），模型不可用时自动降级。

## 打包：V8 字节码（bytenode）

桌面安装包里的后端业务逻辑默认编译为 V8 字节码，不再随包分发明文 JS：

```bash
cd backend-node
node scripts/compile-bytecode.mjs          # 只编译字节码产物到 dist/
node scripts/stage-runtime.mjs --bytecode  # staging 时编译并拷入 src-tauri/resources/backend
```

产物布局（入口仍是 `dist/index.js`，`backend.rs` 无需改动）：

```
dist/index.js        # ESM 启动器：createRequire → require("bytenode") → require("./app/index.jsc")
dist/app/index.jsc   # esbuild 单文件 CJS bundle 编译出的 V8 字节码（brotli 压缩）
dist/data/           # 法律文档与 settings-defaults.json（明文资源，不含代码）
```

- `stage-runtime.mjs` 加 `--bytecode`（或 `LINGSHU_STAGE_BYTECODE=1`）后自动调用 `compile-bytecode.mjs`；`lingshu-gui` 的 `npm run desktop:build` 已默认开启。
- 管线：`tsc` → 入口 ESM 顶层 `await` 包进 async IIFE → esbuild（format=cjs，`import.meta.url` 定义为 bundle 自身 URL，动态 import 降级为 require）→ bytenode `compileFile` → 清理全部 tsc 明文产物。
- esbuild external（不进字节码，从 staged 生产 `node_modules` 原样加载）：`better-sqlite3`、`sherpa-onnx-node`、`onnxruntime-node`、`sqlite-vec`、`silk-wasm`、`@huggingface/transformers`（原生模块/按自身路径加载 wasm 资源）以及 ws 的可选原生依赖 `bufferutil`、`utf-8-validate`。
- `import.meta.url` 处理：esbuild 在 CJS 输出中不 shim 它，脚本用 `banner + define` 注入 `pathToFileURL(__filename)`；bundle 放在 `dist/app/` 使 `new URL("../data/...", import.meta.url)` 仍指向 `dist/data/`，`createRequire(...).resolve()` 的 node_modules 向上查找链不变。
- 限制与代价：
  - `.jsc` 绑定编译时的 Node/V8 版本；staging 打包的 runtime/node 必须与执行编译的 Node 主版本一致（默认两者同为当前 Node），跨机器构建时须用 `LINGSHU_NODE_BINARY` 指定与编译机一致的运行时，否则启动时 `cachedDataRejected`。
  - 报错堆栈指向 `index.jsc`，无行级信息；调试可 `node scripts/compile-bytecode.mjs --keep-cjs` 保留明文 `dist/app/index.cjs` 直接运行（禁止用于分发）。
  - `npm test` / `npm run dev` 走 `src/`，不受影响；`npm run build` 仍产出明文 dist，重新跑一次 `compile-bytecode.mjs` 即可覆盖。

## 已知残余项
见 `../local-docs/development-plan.md`「已知残余项」：Task planner/skill 图深度、打包与体积优化、QQ 语音 SILK 转码、微信出站图片/typing、真实语音凭据与 sherpa 模型打包。
