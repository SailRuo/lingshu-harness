# Native 契约层（M0）

本目录把 APP 正式包（`lingshu-app-local`）的 native 共享契约镜像到桌面版 Node 后端，供后续记忆内核按 APP 语义对齐时直接引用。

**只镜像契约，不镜像运行时。** 这里没有数据库访问、embedding、调度或 prompt 组装逻辑；它只提供常量、闭集、JSON Schema 与 prompt 文本。

## 1. 来源版本

| 契约模块 | APP 源文件 | APP `META.version` | 复制时 SHA-256 |
|---|---|---:|---|
| `nativeDigestContract` | `shared/native-digest/source.mjs` | 2 | `38a122afdd8f4c5248654069a4239a02ea1163fe7c377eccbd84097862234f4e` |
| `nativeChatContract` | `shared/native-chat/source.mjs` | 50 | `1e686aa30eaf99e78db3805f6736e1c8e4a1cabb3383838e87e534f8a57fb783` |

- APP 参考仓库 revision：`e0e85f4`（2026-11-14）。
- 桌面复制日期：2026-11-15。
- 相关但未镜像的契约：`shared/native-schema/tables.sql`（`SCHEMA_VERSION 65`）。表结构映射见 `local-docs/memory/app-desktop-memory-mapping.md`，下一版增量 SQL 见 `local-docs/memory/migration-draft.md`。

## 2. 目录结构

```
contracts/native/
├── generated/
│   ├── nativeDigestSource.generated.ts   # APP source.mjs 的逐字节副本（只改扩展名）
│   ├── nativeDigestSource.sha256
│   ├── nativeChatSource.generated.ts     # APP source.mjs 的逐字节副本（只改扩展名）
│   └── nativeChatSource.sha256
├── nativeDigestContract.ts               # 类型声明 + 具名导出
├── nativeChatContract.ts                 # 类型声明 + 具名导出
├── index.ts                              # 统一 re-export
└── README.md
```

`generated/*.ts` 是**只读产物**：内容必须与 APP 的 `source.mjs` 完全一致（包括注释、字符串拼接和顺序）。不要手改；需要变更时从 APP 同步。

## 3. 为什么复制成 `.ts`，而不是 `.d.ts` 或改 `allowJs`

`backend-node/tsconfig.json` 的关键约束：

- `"include": ["src/**/*.ts"]` —— 只编译 `src` 下的 `.ts`；
- `"rootDir": "src"` —— 引入 `src` 之外的文件会破坏输出目录结构；
- 未开启 `allowJs` —— 不能直接 `import` APP 的 `.mjs`；
- `"moduleResolution": "Bundler"` + `"type": "module"` —— 运行时要能解析实际模块。

因此本目录采用：

1. **把 `source.mjs` 原样复制为 `.ts`**（APP 源文件本身是纯 ESM、无 JSX、无 TS 不兼容语法，`tsc --strict` 可直接通过）；
2. 在 `*Contract.ts` 中**只加 `import` / `interface` / `export const` 类型标注**，不复制、不改写字符串；
3. 不修改全局 `tsconfig.json`，不引入 `allowJs` / `rootDirs` / 路径别名等构建风险。

这样运行时拿到的是真实值（不是 `.d.ts` 的纯类型），类型检查也能在 APP 契约形状变化时第一时间报错（具名接口要求键齐全）。

## 4. 同步方式（APP 更新后）

前置：两个仓库在同一台机器上，APP 仓库路径为 `/Users/haozhen/Project/lingshu-app-local/lingshu-app-local`（可通过参数覆盖）。

### 4.1 一键同步（推荐）

```bash
cd /Users/haozhen/Project/lingshu-desktop
node backend-node/scripts/sync-native-contracts.mjs \
  --app-root /Users/haozhen/Project/lingshu-app-local/lingshu-app-local
```

脚本会：

1. 复制 `shared/native-digest/source.mjs` → `src/contracts/native/generated/nativeDigestSource.generated.ts`；
2. 复制 `shared/native-chat/source.mjs` → `src/contracts/native/generated/nativeChatSource.generated.ts`；
3. 重写对应的 `.sha256` 文件；
4. 打印 APP 侧的 `META.version`。

同步后必须跑：

```bash
cd backend-node
npm run typecheck
```

若 APP 契约删除/改名了导出键，`nativeDigestContract.ts` / `nativeChatContract.ts` 里的接口会报错；新增键不会自动报错（结构性赋值允许多余属性），需要按 `.sha256` 漂移提示人工补接口。无论哪种情况，都**不要改 `generated/` 里的字符串**。

只检查是否漂移、不写文件：

```bash
node backend-node/scripts/sync-native-contracts.mjs --check \
  --app-root /Users/haozhen/Project/lingshu-app-local/lingshu-app-local
```

### 4.2 手工同步

```bash
APP=/Users/haozhen/Project/lingshu-app-local/lingshu-app-local
DST=/Users/haozhen/Project/lingshu-desktop/backend-node/src/contracts/native/generated

cp "$APP/shared/native-digest/source.mjs" "$DST/nativeDigestSource.generated.ts"
cp "$APP/shared/native-chat/source.mjs"   "$DST/nativeChatSource.generated.ts"

cd "$DST"
shasum -a 256 nativeDigestSource.generated.ts nativeChatSource.generated.ts
```

把输出的哈希写回同名 `.sha256` 文件（格式：`<hash>  <filename>`），并同步更新本文第 1 节的表格。

校验副本未被手改：

```bash
cd backend-node/src/contracts/native/generated
shasum -a 256 -c nativeDigestSource.sha256
shasum -a 256 -c nativeChatSource.sha256
```

## 5. 导出结构

### `nativeDigestContract`

| 导出 | 说明 |
|---|---|
| `META` | APP digest 契约版本（当前 2） |
| `CONSTANTS` | idle / LLM timeout / AKIN / digest lookback / 心笺长度等阈值 |
| `SETS` | `FACT_RELATIONS`、`PLACEHOLDER_ENTITIES`、`EXTERNAL_ABOUT`、`SELF_ABOUT`、`ME_SUBJECTS`、`SELF_SUBJECTS` |
| `RESPONSE_SCHEMAS` | 12 个结构化输出 schema：`EXTRACTOR`、`WRITE_FIELD`、`SEED_REVIEW`、`AKIN_JUDGE`、`AKIN_JUDGE_SINGLE`、`PORTRAIT`、`PORTRAIT_REVIEW`、`PORTRAIT_REWRITE`、`CONVERSATION_ANCHOR`、`DAILY_REFLECTION`、`DAILY_REVIEW`、`GROUP_PRESENCE` |
| `PROMPTS` | 静态 prompt 正文（日回顾规则、写场、自我演化、AKIN 判连、会话锚点、自画像、JSON 系统句） |
| `TEMPLATES` | 带占位符的模板（抽取人设卡、抽取规则、角色标识、心笺 system/user/retry） |
| `PRIVATE_DIGEST_STEPS` | 私有 digest 步骤顺序（文档/日志用） |
| `DIGEST_CONTRACT_SOURCE` | 源路径、APP revision、SHA-256、同步日期 |

### `nativeChatContract`

| 导出 | 说明 |
|---|---|
| `META` | APP chat 契约版本（当前 50） |
| `SEED` | 种子候选/影响/激活阈值、候选池、各 boost/suppress cap、prompt 取用上限 |
| `STREAM` | 直接召回双池（私有/公开）、rank1/tail floor、AKIN hop、总上限、当前句排序加权 |
| `STATE` | 状态通道：字数上限、72h 窗口、权重下限、冷却、语气词/状态词闭集 |
| `NEAR_WINDOW` | 近窗召回说话人标注与窗口条数 |
| `EMBEDDING` | BGE 中文检索契约（query 前缀 / document 前缀） |
| `MEMORY_SEARCH` | `search_memory` 时间窗、扫描/返回上限、RRF/BM25 参数 |
| `RELATIONSHIP` | 亲近度刻度、趋势阈值、冷启动上限、关系层级阈值 |
| `PROMPT` | 私聊 prompt 全部 section 标题与正文（含 `HARD_DONTS`、`DIALOGUE_STRATEGY`、多气泡协议、工具契约） |
| `CALL` | 通话开场 prompt / fallback / 技能目录 |
| `THEATER` | 剧场记忆来源标签（仅 memory 相关的一条） |
| `TIANJI_TOOLS` | 天机工具 ID 列表与 WebBridge 超时 |
| `CHAT_CONTRACT_SOURCE` | 源路径、APP revision、SHA-256、同步日期 |
| `APP_ONLY_EXPORTS` | APP 源文件里**有意未镜像**的灵境导出清单 |

## 6. 有意排除的范围

- `LINGJING`、`LINGJING_SPEECH`、`LINGJING_SCENE_BACKDROP`、`LINGJING_MEMORY`：灵境是独立子系统（`lingjing_*` 表、独立角色认知），不属于本次桌面记忆对齐范围。
- 时光回溯、用户印象日窗、印象变化账本、心笺：本次不改造。`CONSTANTS` / `RESPONSE_SCHEMAS` 中与它们相关的常量与 schema 仍**原样保留**，以保证契约完整；桌面端是否使用由后续阶段决定。
- 群聊记忆：归群聊任务，本契约层不提供群聊运行时；`GROUP_PRESENCE` schema 与 `PROMPT.SECTION_GROUP_PRIVATE` 仅作为 APP 契约的一部分镜像。

## 7. 使用约定

- 只能 `import { ... } from "../contracts/native/index.js"` 或直接引用具体模块；不要从 `generated/` 深层路径取值（除了同步工具和契约自检）。
- 不要在本目录里写业务逻辑。
- 不要用字符串字面量重新抄一遍 prompt / 闭集；一律引用这里。
- 若桌面实现需要与 APP 不同的措辞，**新建桌面自己的常量**，不要改契约镜像，否则后续无法判断是「APP 变了」还是「桌面改过」。
