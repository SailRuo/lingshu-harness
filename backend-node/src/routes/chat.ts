import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ChatImagePayload,
  ChatMessageRow,
  listThreadMessages,
  listTurns,
  parseImages,
  userMessageForDisplay,
} from "../services/chatMessageService.js";
import {
  ensureThread,
  getThreadForAgent,
  listInbox,
  markReadThrough,
  toInboxItem,
} from "../services/chatThreadService.js";
import {
  ChatRequestError,
  ChatRequestInput,
  isAbortError,
  streamChat,
} from "../services/chatStreamService.js";

const optionalNumber = z.preprocess(
  (value) => (value === null || value === undefined || value === "" ? undefined : Number(value)),
  z.number().int().positive().optional(),
);

const ChatRequestSchema = z
  .object({
    message: z.string().optional().default(""),
    sessionId: optionalNumber,
    turnId: z.union([z.string(), z.number()]).nullish(),
    taskId: z.string().nullish(),
    agentId: optionalNumber,
    userId: z.string().nullish(),
    mode: z.enum(["auto", "task", "chat"]).optional().default("auto"),
    verbose: z.boolean().optional(),
    images: z.array(z.unknown()).optional().default([]),
    ephemeralVisionDataUrl: z.string().nullish(),
    clientHints: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export function normalizeImages(raw: unknown[]): ChatImagePayload[] {
  const images: ChatImagePayload[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const image = item as Record<string, unknown>;
    const uploadId = String(image.uploadId ?? image.upload_id ?? "").trim();
    const url = String(image.url ?? "").trim();
    if (!uploadId || !url) continue;
    const mimeType = String(image.mimeType ?? image.mime_type ?? "image/png").trim();
    const summaryTextRaw = image.summaryText ?? image.summary_text;
    images.push({
      uploadId,
      url,
      mimeType,
      ...(image.fileName ?? image.file_name
        ? { fileName: String(image.fileName ?? image.file_name) }
        : {}),
      ...(image.sizeBytes ?? image.size_bytes
        ? { sizeBytes: Number(image.sizeBytes ?? image.size_bytes) }
        : {}),
      ...(image.width !== undefined && image.width !== null
        ? { width: Number(image.width) }
        : {}),
      ...(image.height !== undefined && image.height !== null
        ? { height: Number(image.height) }
        : {}),
      ...(summaryTextRaw ? { summaryText: String(summaryTextRaw) } : {}),
    });
  }
  return images;
}

export function parseChatRequest(
  body: unknown,
): { ok: true; request: ChatRequestInput } | { ok: false; detail: string } {
  const parsed = ChatRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return { ok: false, detail: parsed.error.issues.map((i) => i.message).join("; ") || "invalid payload" };
  }
  const data = parsed.data;
  return {
    ok: true,
    request: {
      message: data.message,
      sessionId: data.sessionId ?? null,
      turnId: data.turnId ?? null,
      taskId: data.taskId ?? null,
      agentId: data.agentId ?? null,
      userId: data.userId ?? null,
      mode: data.mode,
      verbose: data.verbose,
      images: normalizeImages(data.images),
      ephemeralVisionDataUrl: data.ephemeralVisionDataUrl ?? null,
      clientHints: (data.clientHints as Record<string, unknown> | null) ?? null,
    },
  };
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toMessageItem(row: ChatMessageRow) {
  const userImages = parseImages(parseJson(row.user_images_json, []));
  return {
    id: row.id,
    role: row.role,
    messageKind: row.message_kind,
    content:
      row.role === "user"
        ? userMessageForDisplay(row.content, userImages)
        : row.content || "",
    createdAt: row.created_at,
    taskId: row.task_id,
    replyToMessageId: row.reply_to_message_id,
    turnPairId: row.turn_pair_id,
    userImages,
    input: parseJson<Record<string, unknown> | null>(row.input_metadata, null),
    assistantReadAt: row.assistant_read_at,
    status: row.status || "completed",
    errorMessage: row.error_message,
    retrievedFacts: parseJson<Record<string, unknown> | null>(row.retrieved_facts, null),
  };
}

export async function registerChatRoutes(app: FastifyInstance) {
  app.post("/api/v1/chat/completions", async (req, reply) => {
    const parsed = parseChatRequest(req.body);
    if (!parsed.ok) {
      reply.code(400).send({ detail: parsed.detail });
      return;
    }

    const controller = new AbortController();
    const res = reply.raw;
    const onClientClose = () => {
      if (!res.writableEnded) controller.abort(new DOMException("client_disconnected", "AbortError"));
    };
    res.on("close", onClientClose);

    const iterator = streamChat({
      request: parsed.request,
      signal: controller.signal,
      controller,
    });
    let first: IteratorResult<any>;
    try {
      first = await iterator.next();
    } catch (error) {
      res.off("close", onClientClose);
      const statusCode = Number((error as any)?.statusCode);
      if (error instanceof ChatRequestError || (Number.isFinite(statusCode) && statusCode >= 400)) {
        reply
          .code(error instanceof ChatRequestError ? error.statusCode : statusCode)
          .send({ detail: error instanceof Error ? error.message : String(error) });
        return;
      }
      reply.code(500).send({ detail: error instanceof Error ? error.message : String(error) });
      return;
    }

    reply.hijack();
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    try {
      if (!first.done) {
        res.write(`data: ${JSON.stringify(first.value)}\n\n`);
      }
      while (!first.done) {
        if (controller.signal.aborted) break;
        const next = await iterator.next();
        if (next.done) break;
        res.write(`data: ${JSON.stringify(next.value)}\n\n`);
      }
    } catch (error) {
      if (!isAbortError(error) && !controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        const sessionId = parsed.request.sessionId ?? 0;
        res.write(
          `data: ${JSON.stringify({
            type: "error",
            eventId: randomUUID(),
            sessionId,
            turnId: null,
            eventSequence: 0,
            timestamp: new Date().toISOString(),
            content: detail,
            metadata: { run_status: "failed" },
          })}\n\n`,
        );
      }
    } finally {
      res.off("close", onClientClose);
      if (!res.writableEnded) res.end();
    }
  });

  app.get("/api/v1/chat/inbox", async (req) => {
    const query = req.query as Record<string, unknown>;
    return listInbox(String(query.userId ?? "")).map(toInboxItem);
  });

  app.post("/api/v1/chat/agents/:agentId/open", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      reply.code(400).send({ detail: "invalid agentId" });
      return;
    }
    const userId = String((req.query as any).userId ?? "");
    const thread = ensureThread(userId, agentId);
    return toInboxItem(thread);
  });

  app.post("/api/v1/chat/agents/:agentId/mark-read", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const readThrough = Number(body.readThroughMessageId);
    if (!Number.isInteger(agentId) || agentId <= 0 || !Number.isInteger(readThrough)) {
      reply.code(400).send({ detail: "invalid request" });
      return;
    }
    const thread = markReadThrough(String(body.userId ?? ""), agentId, readThrough);
    if (!thread) {
      reply.code(404).send({ detail: "Thread not found" });
      return;
    }
    return toInboxItem(thread);
  });

  app.get("/api/v1/chat/agents/:agentId/messages", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      reply.code(400).send({ detail: "invalid agentId" });
      return;
    }
    if (!getThreadForAgent(String((req.query as any).userId ?? ""), agentId)) {
      return [];
    }
    return listThreadMessages(agentId, String((req.query as any).userId ?? "")).map(toMessageItem);
  });

  app.get("/api/v1/chat/turns", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const sessionId = Number(query.sessionId);
    const size = query.size === undefined ? 20 : Number(query.size);
    const beforeTurnId =
      query.beforeTurnId === undefined || query.beforeTurnId === ""
        ? null
        : Number(query.beforeTurnId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      reply.code(400).send({ detail: "invalid sessionId" });
      return;
    }
    if (!Number.isFinite(size) || size < 1 || size > 200) {
      reply.code(400).send({ detail: "invalid size" });
      return;
    }
    if (beforeTurnId !== null && (!Number.isInteger(beforeTurnId) || beforeTurnId < 1)) {
      reply.code(400).send({ detail: "invalid beforeTurnId" });
      return;
    }
    const items = listTurns(sessionId, Math.floor(size), beforeTurnId);
    if (items === null) {
      reply.code(404).send({ detail: "Cursor turn not found" });
      return;
    }
    return items;
  });
}
