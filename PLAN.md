# LingShu Harness Node Backend — 全量迁移计划

## 目标
用 Node.js/TypeScript 重写 LingShu Python 后端，最终打包不再携带 Python 服务；减轻安装包体积。

## 技术取舍
- 图谱/关系：纯 SQLite（不用 Kuzu）
- 向量检索：@huggingface/transformers + sqlite-vec（对齐 app-local）；ONNX 模型为硬依赖，未就绪时记忆接口返回 503，不降级、不写伪向量
- SER：不接入
- ASR/VAD：sherpa-onnx
- LLM：OpenAI 兼容 SDK + provider 适配

## 阶段
0. 依赖映射与路由清单 ✅
1. 路由壳（155 HTTP + 4 WS） ✅
2. 配置与元数据 ✅
3. 传输层与工具 ✅
4. 语音 ✅
5. 记忆与人格 ✅
6. 任务编排：不做（范围外，仅保留接口兼容）；打包与体积优化 ⏳

## 当前进度
- Agent / Settings / Legal / User / Logs / System ✅
- Chat SSE + thread-duplex + voice-duplex ✅
- 线程/消息/历史/导入/上传/删除 ✅
- 工具、原生工具、MCP、审批 ✅；Task checkpoint/resume、审批中断、事件持久化 ✅
- MCP 基础集成 ✅（CRUD/导入/三传输/工具发现与调用/审批/启动连接/退出关闭）
- 技能动态绑定 ✅（SKILL.md 扫描、会话级绑定、system prompt 注入、技能元工具、技能 API）
- 记忆 P0 主链路对齐 ✅（主 prompt 记忆/人格块、digest/召回/AKIN、proactive 动力学、baseline/self-state/affect、seed/witness、schema v14）
- 记忆语义层与行为一致性 ✅（实体/预约语义召回、retrospect 拆分、seed 草稿与角色润色、时区统一、seed 真 ANN 与真实 salience、json_schema、prompt 补齐、schema v15）
- TTS 情绪标签链路 ✅（展示/落库剥离标签，Fish 与小米 MiMo 在 TTS 网线保留标签，其它 provider 剥离）
- 记忆逐模块审计收口 ✅（revisit 语义修正、约定提醒时机、工具使用策略、query 向量缓存、召回可观测性、内置政策技能、prompt 零散差异）
- 证书 / HTTPS 清理 ✅（Node 无 TLS 监听，桌面本机走 HTTP；移除 generate-cert、证书面板、Tauri 安装命令）
- 记忆全部路由 ✅（SQLite + 向量/词面召回；45s 批量 digest、真实 import job、AKIN LLM judge/2-hop、seed 传播、witness/arc/frozen、threads/touchpoints、baseline/self-state）
- TTS（OpenAI 兼容/火山/阿里云/小米/Fish）+ ASR + 声纹 ✅
- Agent Transfer / 微信扫码+入站 / QQBot 网关+媒体 ✅
- Proactive pool / 后台 tick / 每日 arc / 约定提醒 ✅
- Usage / 日志查看器 ✅

## 范围边界
- 不做任务类型编排（planner、skill 图、task intent、completion validation）；现有 task 接口仅保持兼容。
- 产品能力聚焦基础 MCP 工具集成与技能动态绑定。

## 残余项
见 `local-docs/development-plan.md`「已知残余项」：
打包与体积优化、QQ 语音 SILK 转码、微信/QQ typing 指示、真实语音凭据与 sherpa 模型打包。
