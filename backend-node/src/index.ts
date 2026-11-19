import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config, isHybridMode } from "./config.js";
import { pushLogEvent } from "./services/logService.js";

const app = Fastify({ logger: { level: config.LOG_LEVEL } });

// JSON body 解析：body 为空时按 `{}` 处理。GUI 的 fetch 助手给所有 POST/PATCH 都带
// `Content-Type: application/json`（含无 body 的动作型请求，如一键绑定/解绑），
// Fastify 默认会对这种请求抛 FST_ERR_CTP_EMPTY_JSON_BODY，这里统一放宽。
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  const raw = String(body ?? "").trim();
  if (!raw) {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(raw));
  } catch (error) {
    done(error as Error);
  }
});

// Hijacked SSE responses bypass Fastify's normal CORS headers. Set them on the
// raw response early so every writeHead-stream inherits them.
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (!origin) return;
  reply.raw.setHeader("access-control-allow-origin", origin);
  reply.raw.setHeader("access-control-allow-credentials", "true");
  reply.raw.setHeader("vary", "Origin");
});

app.addHook("onResponse", async (req, reply) => {
  pushLogEvent({
    level: reply.statusCode >= 500 ? 50 : reply.statusCode >= 400 ? 40 : 30,
    time: Date.now(),
    msg: `${req.method} ${req.url} ${reply.statusCode}`,
    session_id: (req.headers["x-session-id"] as string) || null,
    component: "http",
    kind: "request",
    presentation: { category: "http", title: `${req.method} ${req.url}` },
  });
});

await app.register(cors, { origin: true, credentials: true });
await app.register(websocket);

// Surface explicit service-unavailable errors (e.g. missing ONNX embedding)
// instead of turning them into generic 500s.
app.setErrorHandler((error, _req, reply) => {
  const statusCode = Number((error as any)?.statusCode) || 500;
  reply
    .code(statusCode)
    .send({ detail: error instanceof Error ? error.message : String(error) });
});

// 健康检查（迁移期：Node 侧存活探针）
app.get("/health", async () => ({
  status: "ok",
  mode: config.BACKEND_MODE,
  service: "lingshu-backend-node",
  version: "0.1.0",
}));

app.get("/ready", async (_req, reply) => {
  try {
    const { getDb } = await import("./db/sqlite.js");
    getDb().prepare("SELECT 1").get();
    const { embeddingStatus } = await import("./services/embeddingService.js");
    const embedding = embeddingStatus();
    if (!embedding.ready) {
      return reply.code(503).send({
        status: "not_ready",
        service: "lingshu-backend-node",
        embedding,
      });
    }
    return { status: "ready", service: "lingshu-backend-node", embedding };
  } catch (error) {
    return reply.code(503).send({
      status: "not_ready",
      service: "lingshu-backend-node",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

// 迁移状态：前端/运维可查询当前覆盖进度
app.get("/api/v1/_migration/status", async () => ({
  backendMode: config.BACKEND_MODE,
  implemented: [
    "health",
    "migration/status",
    "agents",
    "settings",
    "chat-models",
    "user-profile",
    "logs",
    "system",
    "chat-sse",
    "chat-thread-duplex",
    "group-chat",
    "chat-voice-duplex",
    "chat-threads",
    "tools",
    "mcp",
    "skills",
    "tasks",
    "memory",
    "tts",
    "asr",
    "voice",
    "wechat",
    "qqbot",
    "usage",
    "proactive",
  ],
  pending:
    "residual: qq typing indicator, real voice credential regression, memory parity follow-ups",
  hybridProxyTarget: isHybridMode() ? config.PYTHON_BACKEND_URL : null,
}));

// Agent 路由（阶段 2：真实实现）
import { registerAgentRoutes } from "./routes/agents.js";
await registerAgentRoutes(app);

// 设置路由（阶段 2：真实实现）
import { registerSettingsRoutes } from "./routes/settings.js";
await registerSettingsRoutes(app);

// 模型列表路由
import { registerChatModelsRoutes } from "./routes/chatModels.js";
await registerChatModelsRoutes(app);

// 用户路由
import { registerUserRoutes } from "./routes/user.js";
await registerUserRoutes(app);

// 系统扩展路由
import { registerSystemExtraRoutes } from "./routes/systemExtra.js";
await registerSystemExtraRoutes(app);

// 日志路由
import { registerLogsRoutes } from "./routes/logs.js";
await registerLogsRoutes(app);

// Chat 传输层：SSE completions + 线程/历史路由
import { registerChatRoutes } from "./routes/chat.js";
await registerChatRoutes(app);

// Chat 传输层：thread-duplex WebSocket
import { registerChatDuplexRoutes } from "./routes/chatDuplex.js";
await registerChatDuplexRoutes(app);

// 多智能体群聊：独立群会话 / 公开事件流 / 导演 / 群记忆
import { registerGroupChatRoutes } from "./routes/groupChat.js";
await registerGroupChatRoutes(app);

// Chat 其余端点：上传、greeting、导入、删除、system-message
import { registerChatExtraRoutes } from "./routes/chatExtra.js";
await registerChatExtraRoutes(app);

// 任务与工具
import { registerTaskRoutes } from "./routes/tasks.js";
await registerTaskRoutes(app);
import { registerToolsRoutes } from "./routes/tools.js";
await registerToolsRoutes(app);
import { registerPluginRoutes } from "./routes/plugins.js";
await registerPluginRoutes(app);
import { registerSkillRoutes } from "./routes/skills.js";
await registerSkillRoutes(app);
import { startActiveMcpServers, stopAllMcpServers } from "./services/mcpService.js";
void startActiveMcpServers().catch(() => undefined);

// 记忆子系统
import { registerMemoryRoutes } from "./routes/memory.js";
await registerMemoryRoutes(app);
import { embeddingStatus, warmupEmbeddings } from "./services/embeddingService.js";
void (async () => {
  await warmupEmbeddings();
  const status = embeddingStatus();
  if (!status.ready) {
    console.error("[memory] ONNX embedding model unavailable:", status.error);
    return;
  }
  try {
    const { ensureMemoryEmbeddingModel } = await import("./services/memoryService.js");
    const result = await ensureMemoryEmbeddingModel(status.model);
    if (!result.skipped) {
      console.info("[memory] embeddings rebuilt for model", result);
    }
  } catch (error) {
    console.warn("[memory] embedding rebuild failed", error);
  }
})();

// 语音：TTS / ASR / 声纹 / voice-completions
import { registerVoiceRoutes } from "./routes/voice.js";
await registerVoiceRoutes(app);
import { registerVoiceDuplexRoutes } from "./routes/voiceDuplex.js";
await registerVoiceDuplexRoutes(app);
import { asrStatus } from "./services/asrService.js";
// 首次 asrStatus() 会同步加载 sherpa-onnx 识别与标点模型（数百 MB，秒级），
// 期间事件循环被堵死，用户首次按麦就会卡在“正在打开麦克风”数秒。
// 启动后错峰预热一次，模型删除/重装路径各自已有预热。
const asrWarmupTimer = setTimeout(() => {
  try {
    asrStatus();
  } catch {
    /* 加载失败会在状态端点里如实返回 */
  }
}, 1_500);
asrWarmupTimer.unref?.();

// 模型服务商管理
import { registerModelProviderRoutes } from "./routes/modelProviders.js";
await registerModelProviderRoutes(app);

// Agent 转移、第三方绑定
import { registerAgentTransferRoutes } from "./routes/agentTransfer.js";
await registerAgentTransferRoutes(app);
import { registerWechatQqbotRoutes } from "./routes/wechatQqbot.js";
await registerWechatQqbotRoutes(app);
import { startWechatRunnerIfBound, stopWechatRunner } from "./services/wechatService.js";
import { startAllQqBotRunners, stopAllQqBotRunners } from "./services/qqbotGateway.js";
startWechatRunnerIfBound();
startAllQqBotRunners();

import { startInnerLifeScheduler, stopInnerLifeScheduler } from "./services/innerLifeScheduler.js";
import { shutdownDigestScheduler } from "./services/digestScheduler.js";
import { recoverGroupPresenceDigests } from "./services/groupPresenceDigest.js";
startInnerLifeScheduler();
// Group chat is local-first: after a restart, give recent public group events
// that were not digested another chance. The service logs per-member failures.
const groupRecoveryTimer = setTimeout(() => {
  void recoverGroupPresenceDigests()
    .then((count) => {
      if (count) console.info(`[group-chat] recovered presence digest for ${count} group(s)`);
    })
    .catch((error) => console.warn("[group-chat] presence digest recovery failed", error));
}, 3_000);
groupRecoveryTimer.unref?.();
app.addHook("onClose", async () => {
  stopInnerLifeScheduler();
  shutdownDigestScheduler();
  await stopWechatRunner();
  stopAllQqBotRunners();
  await stopAllMcpServers();
});

// 系统运维、用量、Agents 收尾
import { registerSystemOpsRoutes } from "./routes/systemOps.js";
await registerSystemOpsRoutes(app);
import { registerUsageRoutes } from "./routes/usage.js";
await registerUsageRoutes(app);
import { registerAgentExtraRoutes } from "./routes/agentExtra.js";
await registerAgentExtraRoutes(app);

// 路由壳：从 Python 契约生成的 HTTP 占位端点 + WS 占位端点（全部返回 501 / error）
import { registerGeneratedRoutes } from "./routes/generated.js";
await registerGeneratedRoutes(app);

const start = async () => {
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// The desktop launcher stops the backend with SIGTERM. Without a signal
// handler Node exits immediately and Fastify's `onClose` hook never runs, so
// the schedulers, the gateway runners and the MCP servers are left running
// and the SQLite WAL is not checkpointed. Handling the signal lets the app
// close cleanly first.
let shuttingDown = false;
const handleSignal = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[backend] received ${signal}, shutting down`);
  app
    .close()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[backend] shutdown failed:", error);
      process.exit(1);
    });
};
process.on("SIGTERM", handleSignal);
process.on("SIGINT", handleSignal);

start();