import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WebSocket } from "ws";
import {
  asrStatus,
  buildAsrFinalPayload,
  createAsrSession,
  recognizeWavBytesAsync,
  type AsrSession,
} from "../services/asrService.js";
import {
  ASR_DEFAULTS,
  asrConfigSnapshot,
} from "../services/cloudAsrService.js";
import {
  asrDownloadLimit,
  cancelAsrModelDownload,
  getAsrModelStatus,
  installAsrModelZip,
  removeAsrModel,
  startAsrModelDownload,
} from "../services/asrModelManager.js";
import {
  buildTtsEvents,
  findMessageAudio,
  getSegment,
  listTtsVoices,
  startTtsStream,
  streamTtsSegment,
  synthesizeText,
} from "../services/ttsService.js";
import {
  getLiveTtsSegment,
  readLiveTtsSegment,
} from "../services/liveTtsStore.js";
import {
  clearVoiceprint,
  enrollVoiceprint,
  verifyVoiceprint,
} from "../services/voiceprintService.js";
import { getSettings, saveSettings } from "../services/settingsService.js";
import { streamChat, ChatRequestError, isAbortError } from "../services/chatStreamService.js";
import { normalizeImages, parseChatRequest } from "./chat.js";
import { getChatUploadDir, getRuntimeDir } from "../runtimePaths.js";
import { readStoredImageSummary } from "../services/imageSummaryService.js";

function sendJson(socket: WebSocket, payload: Record<string, unknown>) {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function sendSse(res: any, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeAsrLanguage(value: unknown, fallback = "auto"): "auto" | "zh" | "en" {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "auto" || normalized === "zh" || normalized === "en"
    ? normalized
    : (fallback as "auto" | "zh" | "en");
}

function normalizeBaseUrl(value: unknown, fallback: string): string {
  const raw = String(value ?? "").trim();
  return (raw || fallback).replace(/\/+$/, "");
}

export async function registerVoiceRoutes(app: FastifyInstance) {
  // ASR 模型 ZIP 走原始流上传，避免和 chatExtra 里已注册的 multipart 插件冲突。
  app.addContentTypeParser("application/zip", (_request, payload, done) => {
    done(null, payload);
  });

  app.get("/api/tts/voices", async (req, reply) => {
    const query = req.query as Record<string, any>;
    const result = await listTtsVoices({
      baseUrl: query.baseUrl ? String(query.baseUrl) : undefined,
      apiKey: query.apiKey ? String(query.apiKey) : undefined,
    });
    reply.code(result.statusCode).send(result.body);
  });

  // 设置页「测试连通」：用当前表单（含未保存的修改）真实合成一次并返回音频，
  // 前端直接播放，确认服务能用且真的出声。
  app.post("/api/tts/test", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const text =
      String(body.text || "").trim().slice(0, 200) ||
      "你好，我是灵枢。这是一次声音复刻的连通性测试。";
    const overrides: Record<string, any> = {};
    for (const [key, value] of Object.entries((body.settings ?? {}) as Record<string, any>)) {
      if (/^tts[A-Z]/.test(key)) overrides[key] = value;
    }
    try {
      const startedAt = Date.now();
      const result = await synthesizeText(text, {
        provider: body.provider ? String(body.provider) : undefined,
        settingsOverride: overrides,
        recordUsage: false,
      });
      reply
        .header("content-type", result.mimeType)
        .header("cache-control", "no-store")
        .header("x-tts-provider", result.provider)
        .header("x-tts-format", result.format)
        .header("x-tts-latency-ms", String(Date.now() - startedAt))
        .send(result.data);
    } catch (error: any) {
      reply.code(error?.statusCode || 502).send({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/tts/stream", async (req, reply) => {
    const settings = getSettings() as Record<string, any>;
    const body = (req.body ?? {}) as Record<string, any>;
    const text = String(body.text || "").trim();
    const messageId = body.messageId ? String(body.messageId) : null;
    const sessionId = body.sessionId ? Number(body.sessionId) : null;
    const agentId = body.agentId ? Number(body.agentId) : null;
    if (!text) {
      reply.code(200).send("");
      return;
    }
    if (!settings.ttsEnabled) {
      reply.code(400).send({ detail: "TTS is not enabled" });
      return;
    }
    const cached = messageId ? findMessageAudio(messageId) : null;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const sendStop = () => {
      sendSse(res, {
        type: "tts_stop",
        eventId: randomUUID(),
        sessionId,
        eventSequence: 2,
        timestamp: new Date().toISOString(),
        content: null,
        metadata: {},
        messageId,
      });
    };

    if (cached) {
      try {
        const data = fs.readFileSync(cached.path);
        const segment = {
          segmentId: `cache-${messageId}`,
          path: cached.path,
          audioUrl: `/api/voice/tts/messages/${messageId}/audio`,
          mimeType: cached.mimeType,
          format: cached.path.split(".").pop() || "mp3",
          text,
          seq: 1,
          sampleRate: 24000,
          createdAt: Date.now(),
        };
        const { segmentEvent } = buildTtsEvents({
          segment,
          sessionId,
          messageId,
          cached: true,
          text,
        });
        segmentEvent.metadata.audioBase64 = data.toString("base64");
        sendSse(res, segmentEvent);
        sendStop();
      } catch (error: any) {
        sendSse(res, {
          type: "error",
          eventId: randomUUID(),
          sessionId,
          content: error?.message || String(error),
          metadata: {},
          eventSequence: 0,
          timestamp: new Date().toISOString(),
        });
        sendStop();
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        controller.abort(new DOMException("client_disconnected", "AbortError"));
      }
    });
    try {
      const handle = await startTtsStream(text, { signal: controller.signal, agentId, sessionId });
      const iterator = streamTtsSegment(handle, { text, seq: 1, messageId });
      let next = await iterator.next();
      if (!next.done) {
        const segment = next.value.segment;
        sendSse(res, {
          type: "tts_segment",
          eventId: randomUUID(),
          sessionId,
          eventSequence: 1,
          timestamp: new Date().toISOString(),
          content: null,
          metadata: {
            segmentId: segment.id,
            audioUrl: `/api/voice/tts/segments/${segment.id}`,
            mimeType: segment.mimeType,
            format: segment.format,
            seq: segment.seq,
            text: segment.text,
            sampleRate: segment.sampleRate,
          },
          messageId,
        });
      }
      let result = next;
      while (!result.done) result = await iterator.next();
      sendStop();
    } catch (error: any) {
      if (!controller.signal.aborted) {
        sendSse(res, {
          type: "error",
          eventId: randomUUID(),
          sessionId,
          content: error?.message || String(error),
          metadata: {},
          eventSequence: 0,
          timestamp: new Date().toISOString(),
        });
        sendStop();
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  app.get("/api/tts/segments/:segmentId", async (req, reply) => {
    return serveSegment(req, reply);
  });
  app.get("/api/voice/tts/segments/:segmentId", async (req, reply) => {
    return serveSegment(req, reply);
  });
  app.get("/api/voice/segments/:segmentId", async (req, reply) => {
    return serveSegment(req, reply);
  });

  app.get("/api/tts/messages/:messageId/audio", async (req, reply) => {
    const messageId = String((req.params as any).messageId || "");
    const cached = findMessageAudio(messageId);
    if (!cached) {
      reply.code(404).send({ detail: "Message audio not found" });
      return;
    }
    return reply.type(cached.mimeType).send(fs.createReadStream(cached.path));
  });
  app.get("/api/voice/tts/messages/:messageId/audio", async (req, reply) => {
    const messageId = String((req.params as any).messageId || "");
    const cached = findMessageAudio(messageId);
    if (!cached) {
      reply.code(404).send({ detail: "Message audio not found" });
      return;
    }
    return reply.type(cached.mimeType).send(fs.createReadStream(cached.path));
  });

  app.get("/api/v1/asr/status", async (_req, reply) => {
    return asrStatus();
  });

  app.get("/api/v1/asr/model/status", async (_req, reply) => {
    return getAsrModelStatus();
  });

  app.post("/api/v1/asr/model/download", async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Record<string, any>;
      return startAsrModelDownload(body.url ? String(body.url) : undefined);
    } catch (error: any) {
      reply.code(error?.statusCode || 400).send({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/v1/asr/model/cancel", async (_req, reply) => {
    return cancelAsrModelDownload();
  });

  app.post("/api/v1/asr/model/import", { bodyLimit: asrDownloadLimit() }, async (req, reply) => {
    const stream = req.body as NodeJS.ReadableStream | undefined;
    if (!stream || typeof (stream as any).pipe !== "function") {
      reply.code(400).send({ detail: "请上传 application/zip 格式的模型压缩包" });
      return;
    }
    const zipPath = path.join(getRuntimeDir(), `asr-upload-${randomUUID()}.zip`);
    try {
      await pipeline(stream as any, fs.createWriteStream(zipPath));
      const stats = await fsp.stat(zipPath);
      if (!stats.size) throw new Error("模型压缩包为空");
      const header = Buffer.alloc(4);
      const handle = await fsp.open(zipPath, "r");
      try {
        await handle.read(header, 0, 4, 0);
      } finally {
        await handle.close();
      }
      if (header.toString("hex") !== "504b0304" && header.toString("hex") !== "504b0506") {
        throw new Error("文件不是有效的 ZIP 压缩包");
      }
      return await installAsrModelZip(zipPath);
    } catch (error: any) {
      reply.code(error?.statusCode || 400).send({ detail: error?.message || String(error) });
    } finally {
      await fsp.rm(zipPath, { force: true }).catch(() => {});
    }
  });

  app.delete("/api/v1/asr/model", async (_req, reply) => {
    try {
      return await removeAsrModel();
    } catch (error: any) {
      reply.code(error?.statusCode || 400).send({ detail: error?.message || String(error) });
    }
  });

  app.get("/api/v1/asr/config", async (_req, reply) => {
    return asrConfigSnapshot();
  });

  app.post("/api/v1/asr/config", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const patch: Record<string, any> = {};

    const provider = String(body.provider || "").trim().toLowerCase();
    if (provider) {
      if (provider !== "local" && provider !== "xiaomi" && provider !== "aliyun") {
        reply.code(400).send({ detail: "不支持的语音识别服务商" });
        return;
      }
      patch.asrProvider = provider;
    }
    if (body.language !== undefined) patch.asrLanguage = normalizeAsrLanguage(body.language);

    const xiaomi = (body.xiaomi ?? {}) as Record<string, any>;
    if (xiaomi.baseUrl !== undefined) patch.asrXiaomiBaseUrl = normalizeBaseUrl(xiaomi.baseUrl, ASR_DEFAULTS.xiaomiBaseUrl);
    if (xiaomi.apiKey !== undefined) patch.asrXiaomiApiKey = String(xiaomi.apiKey ?? "").trim();
    if (xiaomi.model !== undefined) patch.asrXiaomiModel = String(xiaomi.model ?? "").trim() || ASR_DEFAULTS.xiaomiModel;
    if (xiaomi.language !== undefined) patch.asrXiaomiLanguage = normalizeAsrLanguage(xiaomi.language);

    const aliyun = (body.aliyun ?? {}) as Record<string, any>;
    if (aliyun.httpBaseUrl !== undefined) patch.asrAliyunHttpBaseUrl = normalizeBaseUrl(aliyun.httpBaseUrl, ASR_DEFAULTS.aliyunHttpBaseUrl);
    if (aliyun.wsUrl !== undefined) patch.asrAliyunWsUrl = String(aliyun.wsUrl ?? "").trim() || ASR_DEFAULTS.aliyunWsUrl;
    if (aliyun.apiKey !== undefined) patch.asrAliyunApiKey = String(aliyun.apiKey ?? "").trim();
    if (aliyun.model !== undefined) patch.asrAliyunModel = String(aliyun.model ?? "").trim() || ASR_DEFAULTS.aliyunModel;
    if (aliyun.language !== undefined) patch.asrAliyunLanguage = normalizeAsrLanguage(aliyun.language);

    try {
      saveSettings(patch);
      return asrConfigSnapshot();
    } catch (error: any) {
      reply.code(400).send({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/v1/asr/test", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const audio = String(body.audioBase64 || "");
    if (!audio) {
      reply.code(400).send({ detail: "缺少 audioBase64" });
      return;
    }
    const status = asrStatus();
    if (!status.ready) {
      reply.code(503).send({ detail: status.message });
      return;
    }
    const startedAt = Date.now();
    try {
      const result = await recognizeWavBytesAsync(Buffer.from(audio, "base64"));
      return {
        ok: true,
        text: result.text,
        model: result.model,
        provider: status.provider,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      reply.code(502).send({
        ok: false,
        provider: status.provider,
        detail: error?.message || String(error),
        latencyMs: Date.now() - startedAt,
      });
    }
  });

  app.post("/api/v1/asr/recognize", async (req, reply) => {
    const status = asrStatus();
    if (!status.ready) {
      reply.code(503).send({ detail: status.message });
      return;
    }
    const body = (req.body ?? {}) as Record<string, any>;
    try {
      const buffer = Buffer.from(String(body.audioBase64 || ""), "base64");
      return await recognizeWavBytesAsync(buffer);
    } catch (error: any) {
      reply.code(error?.statusCode || 400).send({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/v1/asr/emotion", async (_req, reply) => {
    reply.code(501).send({
      error: "not_implemented_in_node_backend",
      detail: "SER is not part of the Node backend migration",
    });
  });

  app.post("/api/asr/recognize", async (_req, reply) => {
    reply.code(410).send({
      detail:
        "Legacy /voice/stream endpoint is deprecated. Use /api/v1/asr/stream for server-side streaming ASR.",
    });
  });

  app.get("/api/v1/asr/stream", { websocket: true }, (socket: WebSocket) => {
    const status = asrStatus();
    if (!status.ready) {
      sendJson(socket, { type: "error", detail: status.message });
      socket.close(1013);
      return;
    }
    let session: AsrSession | null = null;
    try {
      session = createAsrSession({
        partial: (text, utteranceId) => {
          sendJson(socket, { type: "asr_partial", text, utteranceId });
        },
        final: (payload) => {
          sendJson(
            socket,
            buildAsrFinalPayload({
              text: payload.text,
              rawText: payload.rawText,
              utteranceId: payload.utteranceId,
              durationS: payload.durationS,
              audioPcm: payload.audioPcm,
            }),
          );
        },
      });
    } catch (error: any) {
      sendJson(socket, { type: "error", detail: error?.message || String(error) });
      socket.close(1013);
      return;
    }
    sendJson(socket, {
      type: "ready",
      asrModel: status.model,
      asrProvider: status.provider,
      asrProviderLabel: status.providerLabel,
      sampleRate: 16000,
      transport: "websocket_stream",
    });
    socket.on("message", async (data, isBinary) => {
      if (!session) return;
      if (isBinary) {
        session.acceptPcm(Buffer.from(data as Buffer));
        return;
      }
      try {
        const raw = JSON.parse(data.toString());
        if (raw.type === "flush") {
          await session.flush();
        } else if (raw.type === "close" || raw.type === "stop") {
          try {
            await session.close();
          } catch (error: any) {
            sendJson(socket, { type: "error", detail: error?.message || String(error) });
          } finally {
            socket.close();
          }
        } else {
          sendJson(socket, { type: "error", detail: `Unknown control type: ${raw.type}` });
        }
      } catch (error: any) {
        if (error instanceof SyntaxError) {
          sendJson(socket, { type: "error", detail: "Invalid JSON control frame" });
          return;
        }
        sendJson(socket, { type: "error", detail: error?.message || String(error) });
      }
    });
    socket.on("close", () => {
      void Promise.resolve(session?.close()).catch(() => {
        // ignore
      });
    });
  });

  app.get("/api/voice/stream", { websocket: true }, (socket: WebSocket) => {
    sendJson(socket, {
      type: "voice.error",
      detail:
        "Legacy /voice/stream endpoint is deprecated. Use /api/v1/asr/stream for server-side streaming ASR.",
    });
    socket.close(1008, "backend asr/vad deprecated");
  });

  app.post("/api/v1/chat/voice-completions", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    let message = String(body.message || "").trim();
    let asrText: string | null = null;
    if (!message && body.audioBase64) {
      try {
        const result = await recognizeWavBytesAsync(Buffer.from(String(body.audioBase64), "base64"));
        message = result.text;
        asrText = result.text;
      } catch (error: any) {
        reply.code(error?.statusCode || 400).send({ detail: error?.message || String(error) });
        return;
      }
    }
    const parsed = parseChatRequest({
      message,
      sessionId: body.sessionId,
      agentId: body.agentId,
      userId: body.userId,
      mode: "chat",
      images: body.images,
      clientHints: {
        ...(body.clientHints && typeof body.clientHints === "object" ? body.clientHints : {}),
        interactionMode: body.clientHints?.interactionMode || "voice_message",
        inputKind: body.inputKind || "voice",
        transport: body.transport || "voice_http",
      },
    });
    if (!parsed.ok) {
      reply.code(400).send({ detail: parsed.detail });
      return;
    }
    const controller = new AbortController();
    const iterator = streamChat({ request: parsed.request, signal: controller.signal, controller });
    let first: IteratorResult<any>;
    try {
      first = await iterator.next();
    } catch (error: any) {
      reply.code(error instanceof ChatRequestError ? error.statusCode : 500).send({
        detail: error?.message || String(error),
      });
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new DOMException("client_disconnected", "AbortError"));
    });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    if (asrText) {
      sendSse(res, {
        type: "voice_asr_echo",
        eventId: randomUUID(),
        sessionId: parsed.request.sessionId ?? null,
        content: asrText,
        metadata: {},
        eventSequence: 0,
        timestamp: new Date().toISOString(),
      });
    }
    try {
      if (!first.done) sendSse(res, first.value);
      while (!first.done) {
        const next = await iterator.next();
        if (next.done) break;
        sendSse(res, next.value);
      }
    } catch (error) {
      if (!isAbortError(error)) {
        sendSse(res, {
          type: "error",
          eventId: randomUUID(),
          content: error instanceof Error ? error.message : String(error),
          metadata: {},
          eventSequence: 0,
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  app.post("/api/v1/user/voiceprint/enroll", async (req, reply) => {
    const userId = String((req.query as any).user_id || "default_user");
    const body = (req.body ?? {}) as Record<string, any>;
    try {
      return enrollVoiceprint(userId, String(body.audioBase64 || ""), Boolean(body.append));
    } catch (error: any) {
      reply.code(error?.statusCode || 500).send({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/v1/user/voiceprint/verify", async (req, reply) => {
    const userId = String((req.query as any).user_id || "default_user");
    const body = (req.body ?? {}) as Record<string, any>;
    try {
      return verifyVoiceprint(
        userId,
        String(body.audioBase64 || ""),
        body.threshold !== undefined ? Number(body.threshold) : undefined,
      );
    } catch (error: any) {
      reply.code(error?.statusCode || 500).send({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/v1/user/voiceprint/clear", async (req, reply) => {
    const userId = String((req.query as any).user_id || "default_user");
    try {
      return clearVoiceprint(userId);
    } catch (error: any) {
      reply.code(error?.statusCode || 500).send({ detail: error?.message || String(error) });
    }
  });
}

async function serveSegment(req: any, reply: any) {
  const segmentId = String((req.params as any).segmentId || "");
  const live = getLiveTtsSegment(segmentId);
  if (live) {
    return serveLiveSegment(segmentId, live, reply);
  }
  const segment = getSegment(segmentId);
  if (!segment || !fs.existsSync(segment.path)) {
    reply.code(404).send({ detail: "Segment not found" });
    return;
  }
  const stat = fs.statSync(segment.path);
  const range = String(req.headers?.range || "");
  if (range.startsWith("bytes=")) {
    const [startRaw, endRaw] = range.slice(6).split("-");
    const start = Number(startRaw || 0);
    const end = endRaw ? Math.min(Number(endRaw), stat.size - 1) : stat.size - 1;
    if (!Number.isFinite(start) || start >= stat.size) {
      reply.code(416).header("content-range", `bytes */${stat.size}`).send();
      return;
    }
    reply.code(206);
    reply.header("content-range", `bytes ${start}-${end}/${stat.size}`);
    reply.header("accept-ranges", "bytes");
    reply.type(segment.mimeType);
    return reply.send(fs.createReadStream(segment.path, { start, end }));
  }
  reply.header("accept-ranges", "bytes");
  reply.header("cache-control", "no-cache");
  return reply.type(segment.mimeType).send(fs.createReadStream(segment.path));
}

async function serveLiveSegment(
  segmentId: string,
  meta: { mimeType: string },
  reply: any,
) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": meta.mimeType,
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    await pipeline(Readable.from(readLiveTtsSegment(segmentId, controller.signal)), res);
  } catch {
    if (!res.writableEnded) res.destroy();
  }
}
