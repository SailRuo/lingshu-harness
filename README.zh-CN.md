# LingShu Harness — 灵枢桌面端

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

[English](./README.md) | 简体中文

> 以长期记忆为基座的桌面端智能体——探索 AI 作为「长期的生活伙伴」，能给人的生活带来哪些真实的帮助。

## 项目定位

灵枢（LingShu）是一个以**长期记忆**为基座的桌面端智能体项目，想认真回答一个问题：当智能体真的记得你、陪伴你足够长的时间，它能成为怎样的生活伙伴？

- **长期记忆为基座**：对话、事件与人格状态持续沉淀——记忆分块、召回、人格块、记忆回声，让对话不必每次从零开始。
- **人格演化（核心研究方向）**：记忆如何反哺人格？影响（affect）、自我状态（self-state）、基线（baseline）、种子与见证（seed/witness）在长期相处中持续作用，让智能体的性格发生**可观察、可追溯**的演化，而不是一张固定不变的人设卡。
- **长期尺度下的对话体验**：围绕个人知识库与长期上下文，打磨以月、年为单位的使用体验，而不是单次会话的质量。
- **参与真实生活**：语音对话、主动关怀、约定提醒、MCP 工具与技能扩展，让智能体融入日常，而不只是问答。

## 当前能力

- 155 个 HTTP 端点 + 4 个 WebSocket 端点已全部落地，没有占位；`npm run typecheck` 与 `npm run build` 通过。
- 记忆：完整召回管线（digest / AKIN / 语义召回）、proactive 动力学、baseline / self-state / affect、seed 与 witness；本地 SQLite + 向量检索。
- 语音：TTS（多 provider，情绪标签链路）+ 流式 ASR + 声纹。
- MCP：server CRUD、Claude Desktop 格式导入、stdio / SSE / streamableHttp 三种传输、工具发现与调用、审批流。
- 技能：`SKILL.md` 扫描、会话级绑定、system prompt 注入、技能元工具。
- Tauri 桌面打包；后端仅监听 `127.0.0.1`。

## 目录结构

```
lingshu-harness/
├── backend-node/          # Node.js/TypeScript 后端（Fastify）
│   ├── src/
│   │   ├── index.ts       # 入口：健康检查 + 路由注册
│   │   ├── config.ts      # 环境变量配置
│   │   ├── routes/        # 已实现路由 + generated 兜底
│   │   ├── services/      # 记忆 / 语音 / MCP / 技能 / 调度
│   │   └── tools/         # 原生工具与 MCP 工具注册
│   └── package.json
├── lingshu-gui/           # Vue 3 + Tauri 2 桌面 GUI
├── docs/                  # 公开文档
├── local-docs/            # 本地开发文档（已 gitignore，不入库）
├── LICENSE                # AGPL-3.0 协议全文
├── CLA.md                 # 贡献者许可协议
└── README.md
```

## 快速开始

```bash
./dev.sh             # 后端 + Tauri 桌面窗口（默认）
./dev.sh --web       # 后端 + Vite 开发服务器（端口自动探测）
./dev.sh --help      # 全部参数
```

脚本会检查 Node 版本、自动补装依赖、等后端 `/health` 就绪再起前端，Ctrl-C 时一并回收子进程；日志写在 `.dev-logs/`。

端口默认 8600（后端）/ 1420（前端），被占用时自动顺延到下一个空闲端口并同步给前端。想钉死端口就用 `--port 8601` / `--gui-port 1421`。

单独启动后端：

```bash
cd backend-node
npm install
npm run dev          # 默认端口 8600
```

环境变量：`PORT`、`HOST`、`LOG_LEVEL`、`DB_PATH` 等，见 `backend-node/src/config.ts`。

## 开源协议

本项目代码以 **[GNU AGPL-3.0](./LICENSE)** 协议开源，版权所有 © 2026 灵枢（LingShu）作者。

简而言之（不构成法律意见，以协议原文为准）：

- **允许商用**：任何人可以自由使用、修改、再分发，包括商业用途，但须遵守适用法律。
- **传染性开源**：分发修改后的版本（含打包成品）时，必须以 AGPL-3.0 开放完整对应源码；将本项目后端部署为网络服务对外提供时，同样必须向服务使用者提供源码（AGPL 第 13 条）。
- **声明保留**：再分发时须保留版权与许可声明。
- 项目作者自身可另行提供商业授权（dual licensing），如有需要请联系作者。

### 商标与项目名

"灵枢 / LingShu" 项目名称、logo 与品牌视觉**不随代码授权**。衍生项目对外发布时必须更换名称与品牌素材，不得暗示与本项目官方存在关联。

### 项目性质

灵枢 Harness 是一个**实验性的个人研究项目**（研究方向：长期记忆与智能体人格演化），以学习交流为目的开源，不是成熟产品。

- **本地优先**：智能体完全运行在用户自己的设备上，模型服务由用户自行配置 API 接入。项目作者不运营任何服务端，不提供托管服务。
- 智能体的全部回复均为 **AI 生成内容**，请自行辨别；不构成医疗、心理、法律等专业意见，也不应作为其替代。
- 拟人化交互（人格设定、情感表达、主动消息、长期记忆）本身是本项目的实验内容，请理性使用。
- 任何人基于本项目**面向公众提供服务**的，即成为该服务的运营方，须自行遵守其司法辖区（包括中国大陆在内）的全部适用法规，包括 AI 服务备案、内容标识、未成年人保护等存在此类要求的事项。

### 米家（MIoT）集成声明

本项目的米家（MIoT）功能使用小米**非官方接口**，与小米公司无任何隶属、认可或授权关系。该集成可能违反小米服务条款，由此产生的账号限制等一切后果由使用者自行承担。

### 第三方组件与素材

各第三方依赖沿用其自身协议（以 MIT / Apache-2.0 为主），其中需要特别说明的：

- **Twemoji**（`lingshu-gui` 内嵌 emoji 图形）：[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) —— *Twemoji by Twitter, licensed under CC-BY 4.0*。
- **Silero VAD**（`silero_vad.onnx`）：MIT。
- **sherpa-onnx streaming paraformer ASR 模型**：Apache-2.0 系（发布前以模型随附声明为准逐一核对）。
- **米家（MIoT）云集成**（`backend-node/src/services/mijiaService.ts`）：基于 [Do1e/mijia-api](https://github.com/Do1e/mijia-api)（GPL-3.0）移植为 TypeScript 并有增删改动，依 GPL-3.0 保留原项目版权声明；该部分并入后整体按本仓库 AGPL-3.0 授权（GPLv3 §13 兼容）。

发布前建议用 `npx license-checker --summary` 复核完整依赖清单。

## 贡献

欢迎 Issue 与 Pull Request。**首次提交 PR 即视为接受 [CLA.md](./CLA.md)**（贡献者许可协议）：贡献的版权仍归贡献者所有，但需授予项目维护者一份包含商业/闭源场景的使用与再授权许可——这是本项目在保持 AGPL-3.0 开源的同时保留未来商业授权自由的前提。

仓库公开后建议启用 [CLA-assistant](https://github.com/cla-assistant/cla-assistant) 自动化签署流程：安装 GitHub App → 绑定本仓库 → 指定 `CLA.md` 为协议文本与一个专用分支存储签署记录，未签署的 PR 会被自动拦截提醒。
