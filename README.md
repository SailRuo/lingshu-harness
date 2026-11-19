# LingShu Harness — 灵枢桌面端

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

> 以长期记忆为基座的桌面端智能体——探索 AI 作为「长期的生活伙伴」，能给人的生活带来哪些真实的帮助。

## 项目定位

灵枢（LingShu）是一个以**长期记忆**为基座的桌面端智能体项目，想认真回答一个问题：当智能体真的记得你、陪伴你足够长的时间，它能成为怎样的生活伙伴？

- **长期记忆为基座**：对话、事件与人格状态持续沉淀——记忆分块、召回、人格块、记忆回声，让对话不必每次从零开始。
- **长期尺度下的对话体验**：围绕个人知识库与长期上下文，打磨以月、年为单位的使用体验，而不是单次会话的质量。
- **参与真实生活**：语音对话、主动关怀、约定提醒、MCP 工具与技能扩展，让智能体融入日常，而不只是问答。
- **学习交流**：本项目以学习交流为目的开源（AGPL-3.0），欢迎研究与讨论。

## 目录结构

```
lingshu-harness/
├── backend-node/          # Node.js/TypeScript 后端（Fastify）
│   ├── src/
│   │   ├── index.ts       # 入口：健康检查 + 路由注册
│   │   ├── config.ts      # 环境变量与迁移开关
│   │   ├── routes/        # 已实现路由 + generated.ts 兜底
│   │   ├── services/      # 记忆 / 语音 / MCP / 技能 / 调度
│   │   └── tools/         # 原生工具与 MCP 工具注册
│   └── package.json
├── docs/                    # 公开文档
├── local-docs/              # 本地文档（不入库，已 gitignore）
│   ├── development-plan.md # 开发计划
│   └── migration/
│       ├── node-backend-dependency-map.md  # 依赖映射与技术取舍
│       └── routes-manifest.json            # Python 后端路由清单（155 条）
├── LICENSE                  # AGPL-3.0 协议全文
├── CLA.md                   # 贡献者许可协议
└── README.md
```

## 当前能力

- 155 个 HTTP 端点 + 4 个 WebSocket 端点已全部落地，没有 501 占位；`npm run typecheck` 与 `npm run build` 通过。
- 记忆、语音、MCP、技能动态绑定、桌面打包均已完成；任务类型编排按产品决策不做，仅保留接口兼容。
- **MCP**：server CRUD、Claude Desktop 格式导入、stdio / SSE / streamableHttp 三种传输、工具发现与调用、审批流；启动自动连接 active server，退出统一关闭。
- **技能**：扫描 `SKILL.md`、会话级绑定、system prompt 注入、`skills_list/activate/deactivate/active` 元工具，以及 `/api/v1/skills` 管理 API。
- **记忆对齐**：主对话 prompt 记忆/人格块、digest/召回/AKIN、proactive 动力学、baseline/self-state/affect、seed/witness 已完成 P0 主链路对齐；schema 升到 v14。
- **证书**：Node 后端没有 TLS 监听，桌面本机只走 `http://127.0.0.1:8600`；证书生成、GUI 证书面板和 Tauri 安装命令已移除。

## 快速开始

```bash
./dev.sh             # 后端 + Tauri 桌面窗口（默认）
./dev.sh --web       # 后端 + Vite 开发服务器（端口自动探测）
./dev.sh --help      # 全部参数
```

脚本会检查 Node 版本、自动补装依赖、等后端 `/health` 就绪再起前端，Ctrl-C 时一并回收子进程；日志写在 `.dev-logs/`。

端口默认 8600（后端）/ 1420（前端），被占用时自动顺延到下一个空闲端口：后端换端口会通过 `VITE_API_BASE_URL` 同步给前端，Tauri 模式还会用 `--config` 把 `devUrl` 和 `beforeDevCommand` 一起改写，所以窗口不会连到别人的 dev server。想钉死端口就用 `--port 8601` / `--gui-port 1421`（指定后不再顺延）。

也可以分别启动：

```bash
cd backend-node
npm install
npm run dev          # 默认端口 8600
```

环境变量：`PORT`、`HOST`、`BACKEND_MODE`（python/node/hybrid）、`PYTHON_BACKEND_URL`、`LOG_LEVEL`。

## 开发计划

见 `local-docs/development-plan.md`（本地文档，不入库）。

## 参考

- 项目文档：`docs/`（公开文档）；`local-docs/`（本地开发文档，不入库）
- 第三方组件与许可：见下方「开源协议」章节的「第三方组件与素材」

## 开源协议

本项目代码以 **[GNU AGPL-3.0](./LICENSE)** 协议开源，版权所有 © 2026 灵枢（LingShu）作者。

简而言之（不构成法律意见，以协议原文为准）：

- **允许商用**：任何人可以自由使用、修改、再分发，包括商业用途，但须遵守所在国家/地区的法律法规。
- **传染性开源**：分发修改后的版本（含打包成品）时，必须以 AGPL-3.0 开放完整对应源码；将本项目后端部署为网络服务对外提供时，同样必须向服务使用者提供源码（AGPL 第 13 条）。
- **声明保留**：再分发时须保留版权与许可声明。
- 本项目作者自身可另行提供商业授权（dual licensing），如有需要请联系作者。

### 商标与项目名

“灵枢 / LingShu” 项目名称、logo 与品牌视觉**不随代码授权**。衍生项目对外发布时必须更换名称与品牌素材，不得暗示与本项目官方存在关联。

### 项目性质与合规定位

- 本项目是**个人学习与研究性质的实验性项目**，处于持续探索阶段，不构成成熟产品或服务承诺。
- 项目作者**不向公众提供生成式人工智能服务**，不以本项目运营任何面向公众的 AI 服务；作者未进行亦无需进行生成式人工智能服务备案、算法备案或相关安全评估。
- 本项目的智能体采用**拟人化**交互设计（人格设定、情感表达、主动消息与长期记忆），其全部输出均为 AI 生成内容，请用户知悉并自行辨别；智能体输出不构成医疗、心理、法律等专业意见，不得作为替代。
- 任何人基于本项目在中华人民共和国境内**面向公众提供服务**的，该服务提供者应自行履行届时适用的全部监管义务，包括但不限于生成式人工智能服务备案、AI 生成合成内容标识、未成年人保护与防沉迷措施、数据与个人信息合规。

### 合规与免责

使用者须自行承担使用本软件的全部风险，并遵守所在地法律法规（包括但不限于内容合规、个人信息保护、生成式 AI 与语音服务相关规定）。本项目按“现状”提供，不含任何明示或默示担保；作者不对任何人使用本软件的方式及后果承担责任（详见 LICENSE 第 15、16 条）。

**关于米家集成**：本项目的米家（MIoT）功能使用小米**非官方接口**，与小米公司无任何隶属关系，未获小米官方认可或授权。该集成可能违反小米服务条款，由此产生的账号限制、封禁等一切风险由使用者自行承担。

### 第三方组件与素材

各第三方依赖沿用其自身协议（以 MIT / Apache-2.0 为主），其中需要特别说明的：

- **Twemoji**（`lingshu-gui` 内嵌 emoji 图形，`scripts/sync-twemoji-assets.mjs` 同步）：图形资产采用 [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)，在此署名致谢 —— *Twemoji by Twitter, licensed under CC-BY 4.0*。
- **Silero VAD**（`silero_vad.onnx`）：MIT。
- **sherpa-onnx streaming paraformer ASR 模型**：Apache-2.0 系（以模型文件随附声明为准，发布前逐一核对）。
- **米家（MIoT）云集成**（`backend-node/src/services/mijiaService.ts`）：基于 [Do1e/mijia-api](https://github.com/Do1e/mijia-api)（GPL-3.0）移植为 TypeScript 并有增删改动，依 GPL-3.0 保留原项目版权声明；该部分并入后整体按本仓库 AGPL-3.0 授权（GPLv3 §13 兼容）。

发布前建议用 `npx license-checker --summary` 复核完整依赖清单。

## 贡献

欢迎 Issue 与 Pull Request。**首次提交 PR 即视为接受 [CLA.md](./CLA.md)**（贡献者许可协议）：贡献的版权仍归贡献者所有，但需授予项目维护者一份包含商业/闭源场景的使用与再授权许可——这是本项目在保持 AGPL-3.0 开源的同时保留未来商业授权自由的前提。

仓库公开后建议启用 [CLA-assistant](https://github.com/cla-assistant/cla-assistant) 自动化签署流程：安装 GitHub App → 绑定本仓库 → 指定 `CLA.md` 为协议文本与一个专用分支存储签署记录，未签署的 PR 会被自动拦截提醒。