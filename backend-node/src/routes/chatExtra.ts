import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgent } from "../services/agentService.js";
import {
  appendAssistantOnly,
  appendSystemMessage,
  buildTurnHistoryItem,
  clearThreadHistory,
  deleteMessages,
  deleteThreadRecords,
  getFirstAssistantMessage,
  getMessageById,
  messageDeleteImpact,
} from "../services/chatMessageService.js";
import {
  ChatThreadRow,
  getThread,
  listInbox,
  normalizeUserId,
} from "../services/chatThreadService.js";
import {
  createImportDigestJob,
  getImportDigestJob,
  importChatHistory,
  importDigestJobSnapshot,
  importDigestTerminalStatuses,
  prepareImportDigestRetry,
} from "../services/chatImportService.js";
import { getChatUploadDir } from "../runtimePaths.js";
import {
  IMAGE_SUMMARY_PLACEHOLDER,
  summarizeImage,
} from "../services/imageSummaryService.js";
import { guessMime, guessSuffix } from "../services/generatedImageService.js";
import { clearCallTraces, listCallTraces } from "../services/llmTraceService.js";
import { createOpenAIClient, getLLMConfig } from "../services/llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "../services/thinkingEffort.js";
import { getDb } from "../db/sqlite.js";
import { invalidateMemoryTasks } from "../services/memoryTaskToken.js";
import { deleteScopeVecRows } from "../services/embeddingService.js";

const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

const IMPORT_RANGE_DAYS: Record<string, number> = {
  recent_1_week: 7,
  recent_1_month: 30,
  recent_3_months: 90,
  recent_6_months: 180,
};

function importSince(range: unknown): string | null {
  const days = IMPORT_RANGE_DAYS[String(range || "recent_3_months")];
  return days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
}

// `guessMime` / `guessSuffix` live in `services/generatedImageService.ts` so
// that uploaded pictures and tool generated pictures are stored with the very
// same naming and mime rules.
function requireThread(agentId: number, threadId: number, userId?: string): ChatThreadRow | null {
  const thread = getThread(threadId);
  if (!thread || thread.agent_id !== agentId) return null;
  if (userId && normalizeUserId(userId) !== thread.user_id) return null;
  return thread;
}

function clearMemoryScope(agentId: number, userId: string) {
  const db = getDb();
  // Same generation guard as the memory clear endpoint: an old digest task
  // must not write back into the fresh memory after an import reset.
  invalidateMemoryTasks(agentId, userId);
  // Same vec sweep as clearAllMemory: deleted rows must not stay in the ANN
  // index as ghosts.
  deleteScopeVecRows(agentId, userId);
  const tables = [
    "hippocampus_streams",
    "hippocampus_seeds",
    "hippocampus_seed_versions",
    "hippocampus_entities",
    "hippocampus_facts",
    "hippocampus_edges",
    "hippocampus_threads",
    "hippocampus_constraints",
    "hippocampus_appointments",
    "hippocampus_tick_log",
    "hippocampus_self_state",
    "hippocampus_self_state_daily",
    "hippocampus_baselines",
    "hippocampus_affect_points",
    "hippocampus_affect_daily",
    "hippocampus_retrospect_buckets",
    "hippocampus_portraits",
    "digest_state",
    "conversation_anchors",
    "agent_state_changes",
    "relationship_thread_nodes",
    "relationship_threads",
  ];
  const tx = db.transaction(() => {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table} WHERE agent_id = ? AND user_id = ?`).run(agentId, userId);
    }
    db.prepare(
      `DELETE FROM hippocampus_touchpoints
       WHERE agent_id = ? AND user_id = ?`,
    ).run(agentId, userId);
    db.prepare("DELETE FROM proactive_routes WHERE agent_id = ?").run(agentId);
  });
  tx();
}

async function generateGreeting(thread: ChatThreadRow): Promise<string> {
  const agent = getAgent(thread.agent_id);
  const displayName = agent?.displayName || agent?.name || "助手";
  const role = (agent?.roleSetting || "").trim();
  const style = (agent?.speakingStyle || "").trim();
  const hasMemory = Boolean(
    (getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM hippocampus_streams WHERE agent_id = ? AND user_id = ? AND archived = 0",
      )
      .get(thread.agent_id, thread.user_id) as { c: number }).c,
  );
  const system = `你是「${displayName}」，一个专属于用户的 AI 搭子，原生具备长期记忆能力。${role ? `\n\n# 我是谁\n${role}${style ? `\n\n${style}` : ""}` : ""}`;
  const userPrompt = hasMemory
    ? "用户新开了一个对话窗口，但你对他的长期记忆、好感度和偏好都还在。请根据你们过去的相处继续跟他聊天，1-3 句，口语化。"
    : "用户刚进来、还没说话。请发出开场白：先自我介绍下，然后跟他打个招呼，再自然地俏皮地问问该怎么称呼他。1-3 句，口语化。";
  const cfg = getLLMConfig("chat");
  if (!cfg.model || !cfg.baseUrl) return "嗯，你来了。";
  try {
    const client = createOpenAIClient(cfg);
    const response = await createCompletionWithThinkingFallback(
      client,
      {
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        ...buildThinkingParams(cfg),
      },
      cfg,
    );
    return (response.choices?.[0]?.message?.content || "").trim() || "嗯，你来了。";
  } catch {
    return "嗯，你来了。";
  }
}

export async function registerChatExtraRoutes(app: FastifyInstance) {
  const multipart = (await import("@fastify/multipart")).default;
  await app.register(multipart, { limits: { fileSize: MAX_CHAT_IMAGE_BYTES } });

  app.post("/api/v1/chat/uploads", async (req, reply) => {
    const file = await req.file();
    if (!file) {
      reply.code(400).send({ detail: "No file uploaded" });
      return;
    }
    let mimeType = String(file.mimetype || "").toLowerCase();
    if (!mimeType.startsWith("image/")) {
      const guessed = guessMime(file.filename || "");
      if (guessed.startsWith("image/")) mimeType = guessed;
    }
    if (!mimeType.startsWith("image/")) {
      reply.code(400).send({ detail: "Only image uploads are supported" });
      return;
    }
    const data = await file.toBuffer();
    if (!data.length) {
      reply.code(400).send({ detail: "Uploaded image is empty" });
      return;
    }
    if (data.length > MAX_CHAT_IMAGE_BYTES) {
      reply.code(413).send({ detail: "Image is too large" });
      return;
    }
    const uploadName = `${randomUUID().replace(/-/g, "")}${guessSuffix(mimeType, file.filename)}`;
    const target = path.join(getChatUploadDir(), uploadName);
    fs.writeFileSync(target, data);
    void summarizeImage({ uploadName, mimeType, data }).catch(() => undefined);
    return {
      uploadId: uploadName,
      url: `/api/v1/chat/uploads/${uploadName}`,
      mimeType,
      fileName: file.filename,
      sizeBytes: data.length,
      summaryText: IMAGE_SUMMARY_PLACEHOLDER,
    };
  });

  app.get("/api/v1/chat/uploads/:uploadName", async (req, reply) => {
    const raw = String((req.params as any).uploadName || "");
    const safeName = path.basename(raw);
    const filePath = path.join(getChatUploadDir(), safeName);
    if (safeName !== raw || !fs.existsSync(filePath)) {
      reply.code(404).send({ detail: "Upload not found" });
      return;
    }
    reply.header("content-disposition", `inline; filename="${safeName}"`);
    return reply.type(guessMime(filePath)).send(fs.createReadStream(filePath));
  });

  app.post("/api/v1/chat/agents/:agentId/threads/:threadId/greeting", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    const threadId = Number((req.params as any).threadId);
    const userId = (req.query as any).userId as string | undefined;
    const thread = requireThread(agentId, threadId, userId);
    if (!thread) {
      reply.code(404).send({ detail: "Thread not found" });
      return;
    }
    const first = getFirstAssistantMessage(threadId);
    const total = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE thread_id = ?")
      .get(threadId) as { c: number }).c;
    if (total > 0) {
      return {
        status: "exists",
        threadId,
        turn: first
          ? buildTurnHistoryItem(
              first,
              first.reply_to_message_id ? getMessageById(first.reply_to_message_id) || undefined : undefined,
            )
          : null,
      };
    }
    const text = await generateGreeting(thread);
    const message = appendAssistantOnly(thread, text, "greeting", {
      kind: "session_opening_greeting",
    });
    return {
      status: "created",
      threadId,
      turn: buildTurnHistoryItem(message, undefined),
    };
  });

  app.post("/api/v1/chat/system-message", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const threadId = Number(body.threadId);
    const thread = getThread(threadId);
    if (!thread) {
      reply.code(404).send({ detail: "Thread not found" });
      return;
    }
    const message = appendSystemMessage(
      thread,
      String(body.content || ""),
      String(body.messageKind || "system_event"),
      body.metadata && typeof body.metadata === "object" ? body.metadata : null,
    );
    return { id: message.id, threadId: message.thread_id };
  });

  app.post("/api/v1/chat/agents/:agentId/threads/:threadId/clear-history", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    const threadId = Number((req.params as any).threadId);
    const userId = (req.query as any).userId as string | undefined;
    const thread = requireThread(agentId, threadId, userId);
    if (!thread) {
      reply.code(404).send({ detail: "Thread not found" });
      return;
    }
    const deletedTurns = clearThreadHistory(threadId);
    return {
      status: "success",
      threadId,
      deletedTurns,
      memoryPreserved: true,
    };
  });

  app.delete("/api/v1/chat/agents/:agentId/threads/:threadId", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    const threadId = Number((req.params as any).threadId);
    const thread = requireThread(agentId, threadId);
    if (!thread) {
      reply.code(404).send({ detail: "Thread not found" });
      return;
    }
    deleteThreadRecords(threadId);
    return { status: "success" };
  });

  app.post("/api/v1/chat/agents/:agentId/threads/clear-all", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      reply.code(400).send({ detail: "invalid agentId" });
      return;
    }
    const userId = normalizeUserId(String((req.query as any).userId || "default_user"));
    const threads = listInbox(userId).filter((thread) => thread.agent_id === agentId);
    for (const thread of threads) deleteThreadRecords(thread.id);
    return { status: "success", message: "Cleared all conversations for this agent successfully" };
  });

  // Per-call request / response log of a conversation. The GUI drawer renders
  // it as the "调用记录" panel: the raw LLM payload, the tool payloads and the
  // provider's input / output cache counters.
  app.get("/api/v1/chat/traces", async (req, reply) => {
    const threadId = Number((req.query as any).threadId);
    if (!Number.isInteger(threadId) || threadId <= 0) {
      reply.code(400).send({ detail: "invalid threadId" });
      return;
    }
    const limitRaw = Number((req.query as any).limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 60;
    return { status: "success", traces: listCallTraces(threadId, limit) };
  });

  app.delete("/api/v1/chat/traces", async (req, reply) => {
    const threadId = Number((req.query as any).threadId);
    if (!Number.isInteger(threadId) || threadId <= 0) {
      reply.code(400).send({ detail: "invalid threadId" });
      return;
    }
    clearCallTraces(threadId);
    return { status: "success" };
  });

  app.post(
    "/api/v1/chat/agents/:agentId/threads/:threadId/messages/delete-impact",
    async (req, reply) => {
      const agentId = Number((req.params as any).agentId);
      const threadId = Number((req.params as any).threadId);
      const thread = requireThread(agentId, threadId, (req.query as any).userId);
      if (!thread) {
        reply.code(404).send({ detail: "Thread not found" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, any>;
      const ids = Array.isArray(body.messageIds) ? body.messageIds.map(Number).filter(Number.isInteger) : [];
      if (!ids.length) {
        reply.code(400).send({ detail: "messageIds is required" });
        return;
      }
      return messageDeleteImpact(threadId, ids);
    },
  );

  app.post(
    "/api/v1/chat/agents/:agentId/threads/:threadId/messages/delete",
    async (req, reply) => {
      const agentId = Number((req.params as any).agentId);
      const threadId = Number((req.params as any).threadId);
      const thread = requireThread(agentId, threadId, (req.query as any).userId);
      if (!thread) {
        reply.code(404).send({ detail: "Thread not found" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, any>;
      const ids = Array.isArray(body.messageIds) ? body.messageIds.map(Number).filter(Number.isInteger) : [];
      if (!ids.length) {
        reply.code(400).send({ detail: "messageIds is required" });
        return;
      }
      const includeMemory = body.includeMemory ?? true;
      const result = deleteMessages(threadId, ids, {
        agentId,
        userId: thread.user_id,
        includeMemory,
      });
      return result;
    },
  );

  app.post("/api/v1/chat/agents/:agentId/import-history", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    const agent = getAgent(agentId);
    if (!agent) {
      reply.code(404).send({ detail: "Agent not found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, any>;
    const userId = normalizeUserId(String(body.userId || "default_user"));
    const content = String(body.content || "");
    if (!content.trim()) {
      reply.code(422).send({ detail: "content is required" });
      return;
    }
    const memoryReset = Boolean(body.resetMemoryBeforeImport);
    if (memoryReset) clearMemoryScope(agentId, userId);
    try {
      const result = importChatHistory({
        agentId,
        userId,
        content,
        importRange: String(body.importRange || "recent_3_months"),
      });
      const maxDigestTurns = Math.max(1, Math.min(Number(body.maxDigestTurns) || 100, 5000));
      let digestJobId: string | null = null;
      if (body.digestAfterImport !== false && result.lastAssistantMessageId) {
        digestJobId = createImportDigestJob({
          agentId,
          threadId: result.thread.id,
          userId,
          totalTurns: result.turnCount,
          maxTurns: maxDigestTurns,
          since: importSince(body.importRange),
        }).jobId;
      }
      return {
        status: "success",
        threadId: result.thread.id,
        agentId,
        userId,
        importedMessages: result.messageCount,
        importedTurns: result.turnCount,
        userMessages: result.userMessageCount,
        assistantMessages: result.assistantMessageCount,
        skippedOutOfRange: result.skippedOutOfRange,
        digestScheduled: Boolean(digestJobId),
        digestMaxTurns: digestJobId ? maxDigestTurns : 0,
        digestJobId,
        memoryReset,
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (code === "no_importable_messages" || code === "no_messages_in_range") {
        reply.code(422).send({
          detail:
            code === "no_importable_messages"
              ? "未解析到可导入的聊天记录"
              : "所选数据范围内没有可导入的聊天记录",
        });
        return;
      }
      reply.code(400).send({ detail: code });
    }
  });

  app.get(
    "/api/v1/chat/agents/:agentId/import-history/digest/:jobId/stream",
    async (req, reply) => {
      const agentId = Number((req.params as any).agentId);
      const jobId = String((req.params as any).jobId || "");
      const job = getImportDigestJob(jobId);
      if (!job || job.agentId !== agentId) {
        reply.code(404).send({ detail: "Import digest job not found" });
        return;
      }
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      let lastPayload = "";
      try {
        while (!closed) {
          const current = getImportDigestJob(jobId);
          if (!current || current.agentId !== agentId) {
            res.write(
              `event: progress\ndata: ${JSON.stringify({
                jobId,
                status: "missing",
                totalTurns: 0,
                processedTurns: 0,
                pendingTurns: 0,
                totalWork: 0,
                processedWork: 0,
                retrospectTotal: 0,
                retrospectProcessed: 0,
                batches: 0,
                message: "任务不存在",
              })}\n\n`,
            );
            break;
          }
          const snapshot = importDigestJobSnapshot(current);
          const payload = JSON.stringify(snapshot);
          if (payload !== lastPayload) {
            res.write(`event: progress\ndata: ${payload}\n\n`);
            lastPayload = payload;
          }
          if (importDigestTerminalStatuses().includes(current.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } finally {
        if (!res.writableEnded) res.end();
      }
    },
  );

  app.post(
    "/api/v1/chat/agents/:agentId/import-history/digest/:jobId/retry",
    async (req, reply) => {
      const agentId = Number((req.params as any).agentId);
      const jobId = String((req.params as any).jobId || "");
      const job = getImportDigestJob(jobId);
      if (!job || job.agentId !== agentId) {
        reply.code(404).send({ detail: "Import digest job not found" });
        return;
      }
      const next = prepareImportDigestRetry(jobId);
      if (!next) {
        reply.code(404).send({ detail: "Import digest job not found" });
        return;
      }
      return importDigestJobSnapshot(next);
    },
  );
}
