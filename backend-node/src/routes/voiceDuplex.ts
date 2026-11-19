import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  asrStatus,
  buildAsrFinalPayload,
  createAsrSession,
  pcm16ToWav,
  type AsrSession,
} from "../services/asrService.js";
import { streamChat, ChatRequestInput, isAbortError } from "../services/chatStreamService.js";
import { ensureThread, getThread } from "../services/chatThreadService.js";
import { getSettings } from "../services/settingsService.js";
import { storeSegment } from "../services/ttsService.js";
import { VoiceCallTtsCoordinator } from "../services/voiceCallTtsCoordinator.js";
import { verifyVoiceprint } from "../services/voiceprintService.js";
import { getUserProfile } from "../services/userService.js";
import { sessionHub } from "../services/sessionHub.js";
import { beginVoiceCall, endVoiceCall } from "../services/voiceCallPresence.js";

interface VoiceBinding {
  threadId: number;
  agentId: number | null;
  userId: string;
  vrmAvatar: boolean;
  clientHints: Record<string, unknown>;
}

interface AsrContext {
  messageId?: string;
  sessionId?: number;
  agentId?: number;
  userId?: string;
  platform?: string;
  clientEndpointing?: string;
  clientHints?: Record<string, unknown>;
  vrmAvatar?: boolean;
  isGuest?: boolean;
}

const activeControllers = new Map<number, AbortController>();

function cancelStream(threadId: number) {
  const controller = activeControllers.get(threadId);
  if (!controller) return null;
  activeControllers.delete(threadId);
  controller.abort(new DOMException("voice_cancel", "AbortError"));
  return controller;
}

function parseBinding(payload: Record<string, unknown>): VoiceBinding | null {
  const userId = String(payload.userId ?? payload.user_id ?? "");
  const agentRaw = payload.agentId ?? payload.agent_id;
  const agentId =
    agentRaw === null || agentRaw === undefined || agentRaw === ""
      ? null
      : Number(agentRaw);
  if (agentId !== null && (!Number.isInteger(agentId) || agentId <= 0)) return null;
  const sessionId = Number(payload.threadId ?? payload.sessionId ?? payload.session_id ?? 0);
  let threadId: number;
  if (agentId !== null) {
    threadId = ensureThread(userId, agentId).id;
  } else {
    if (!Number.isInteger(sessionId) || sessionId <= 0) return null;
    if (!getThread(sessionId)) return null;
    threadId = sessionId;
  }
  const hints =
    payload.clientHints && typeof payload.clientHints === "object"
      ? (payload.clientHints as Record<string, unknown>)
      : {};
  return {
    threadId,
    agentId,
    userId,
    vrmAvatar: Boolean(hints.vrmAvatar || hints.vrm_avatar),
    clientHints: hints,
  };
}

export async function registerVoiceDuplexRoutes(app: FastifyInstance) {
  app.get("/api/v1/chat/voice-duplex", { websocket: true }, (socket: WebSocket) => {
    const send = (payload: Record<string, unknown>) => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // ignore
      }
    };

    let binding: VoiceBinding | null = null;
    let asrContext: AsrContext = {};
    let asrSession: AsrSession | null = null;
    let asrAutoEndpointFinal = true;
    let asrUnavailableNotified = false;
    let closed = false;
    const connectionId = randomUUID();

    const unregisterBinding = () => {
      sessionHub.unregisterSocket(socket);
      if (!binding) return;
      sessionHub.unregister(binding.threadId, connectionId);
    };

    sessionHub.registerSocket(socket);

    send({ type: "voice.session_ready" });

    const ensureAsrSession = () => {
      // clientEndpointing=vad_flush：端侧 VAD 负责断句，ASR 只在显式
      // voice.asr_flush / voice.asr_stop 时 final，不做自动 endpoint。
      const autoEndpointFinal = asrContext.clientEndpointing !== "vad_flush";
      if (asrSession && asrAutoEndpointFinal !== autoEndpointFinal) {
        void Promise.resolve(asrSession.close()).catch(() => {
          // ignore
        });
        asrSession = null;
      }
      if (asrSession) return asrSession;
      const status = asrStatus();
      if (!status.ready) {
        if (!asrUnavailableNotified) {
          asrUnavailableNotified = true;
          send({ type: "voice.asr_error", detail: status.message });
        }
        return null;
      }
      try {
        asrSession = createAsrSession({
          partial: (text, utteranceId) => {
            send({
              type: "voice.asr_partial",
              text,
              utteranceId,
              messageId: asrContext.messageId,
              transport: "voice_duplex_asr",
            });
          },
          final: (payload) => {
            const userId = asrContext.userId || binding?.userId || "default_user";
            let profile: Record<string, any> | null = null;
            let voiceprint:
              | { enrolled: boolean; matched: boolean; score: number; threshold: number; message: string }
              | null = null;
            try {
              profile = getUserProfile(userId) as Record<string, any>;
            } catch {
              profile = null;
            }
            if (profile) {
              try {
                voiceprint = verifyVoiceprint(
                  userId,
                  pcm16ToWav(payload.audioPcm).toString("base64"),
                  profile.voiceprintThreshold,
                );
              } catch {
                voiceprint = null;
              }
            }
            const guest = Boolean(voiceprint?.enrolled && !voiceprint.matched);
            const strictReject = Boolean(profile?.voiceprintEnabled && guest);
            const segment = storeSegment({
              data: pcm16ToWav(payload.audioPcm),
              format: "wav",
              mimeType: "audio/wav",
              text: payload.text,
              seq: 1,
              sampleRate: 16000,
            });
            const finalPayload = buildAsrFinalPayload({
              ...payload,
              voiceprint: voiceprint
                ? {
                    voiceprintScore: voiceprint.score,
                    voiceprintPassed: voiceprint.matched,
                    isGuest: guest,
                  }
                : undefined,
            });
            delete (finalPayload as any).audioBase64;
            if (strictReject) {
              finalPayload.text = "";
              finalPayload.rawText = "";
              finalPayload.punctuatedText = "";
            }
            send({
              ...finalPayload,
              type: "voice.asr_final",
              audioSegmentId: segment.segmentId,
              audioUrl: `/api/voice/segments/${segment.segmentId}`,
              transport: "voice_duplex_asr",
              messageId: asrContext.messageId,
            });
            if (strictReject) {
              send({
                type: "voice.voiceprint_rejected",
                messageId: asrContext.messageId,
                score: voiceprint?.score ?? 0,
                threshold: voiceprint?.threshold ?? 0,
                detail: "检测为旁人或背景音，已自动过滤",
              });
              return;
            }
            if (payload.text.trim() && binding) {
              startVoiceTurn(payload.text, asrContext.messageId, { ...asrContext, isGuest: guest });
            }
          },
        }, { autoEndpointFinal });
        asrAutoEndpointFinal = autoEndpointFinal;
        send({
          type: "voice.asr_ready",
          asrModel: status.model,
          sampleRate: 16000,
          transport: "voice_duplex_asr",
        });
        return asrSession;
      } catch (error: any) {
        send({ type: "voice.asr_error", detail: error?.message || String(error) });
        return null;
      }
    };

    const startVoiceTurn = (message: string, messageId: string | undefined, context: AsrContext) => {
      if (!binding) return;
      const activeBinding = binding;
      // 新 turn 开始：先掐断上一轮的 LLM 流和 TTS 协调器，旧片段不再下发。
      cancelStream(activeBinding.threadId);
      const controller = new AbortController();
      activeControllers.set(activeBinding.threadId, controller);
      const request: ChatRequestInput = {
        message,
        sessionId: activeBinding.threadId,
        agentId: activeBinding.agentId ?? undefined,
        userId: activeBinding.userId,
        mode: "chat",
        images: [],
        clientHints: {
          ...activeBinding.clientHints,
          ...(context.clientHints || {}),
          ...(context.isGuest ? { isGuest: true } : {}),
          voiceCall: true,
          surface: "guiv1_pc",
          interactionMode: "voice_call",
          inputKind: "voice",
          outputMode: "tts_live",
          transport: "voice_duplex_asr",
          platform: context.platform,
          ...(activeBinding.vrmAvatar || context.vrmAvatar ? { vrmAvatar: true } : {}),
        },
        taskId: null,
      };

      void (async () => {
        let lastTurnId: string | null = null;
        let lastIncomingSequence = 0;
        let ttsEventSequence = 0;
        let ttsFinishPromise: Promise<void> | null = null;
        const nextTtsEventSequence = () => {
          ttsEventSequence = Math.max(ttsEventSequence, lastIncomingSequence) + 1;
          return ttsEventSequence;
        };
        const settings = getSettings() as Record<string, any>;
        const ttsCoordinator = settings.ttsEnabled
          ? new VoiceCallTtsCoordinator({
              agentId: activeBinding.agentId,
              sessionId: activeBinding.threadId,
              messageId: messageId || null,
              signal: controller.signal,
              onSegment: (segment) => {
                if (controller.signal.aborted) return;
                send({
                  type: "tts_segment",
                  eventId: randomUUID(),
                  sessionId: activeBinding.threadId,
                  turnId: lastTurnId,
                  taskId: null,
                  eventSequence: nextTtsEventSequence(),
                  timestamp: new Date().toISOString(),
                  content: null,
                  metadata: {
                    segmentId: segment.segmentId,
                    audioUrl: segment.audioUrl,
                    mimeType: segment.mimeType,
                    format: segment.format,
                    seq: segment.seq,
                    text: segment.text,
                    sampleRate: segment.sampleRate,
                  },
                  messageId: messageId || null,
                });
              },
              onStop: () => {
                if (controller.signal.aborted) return;
                send({
                  type: "tts_stop",
                  eventId: randomUUID(),
                  sessionId: activeBinding.threadId,
                  turnId: lastTurnId,
                  taskId: null,
                  eventSequence: nextTtsEventSequence(),
                  timestamp: new Date().toISOString(),
                  content: null,
                  metadata: {},
                  messageId: messageId || null,
                });
              },
            })
          : null;

        try {
          for await (const event of streamChat({
            request,
            signal: controller.signal,
            controller,
          })) {
            if (controller.signal.aborted) break;
            lastTurnId = event.turnId ?? lastTurnId;
            lastIncomingSequence = Math.max(lastIncomingSequence, Number(event.eventSequence) || 0);
            const metaTtsText = event.metadata?.ttsText;
            const deltaTtsText =
              typeof metaTtsText === "string" && metaTtsText ? metaTtsText : "";
            const deltaText = typeof event.content === "string" ? event.content : "";
            if (event.type === "text_delta" && (deltaText || deltaTtsText)) {
              // 文本增量边到边喂给 TTS：按句切分、串行合成、首包即下发。
              // 与 Python 一致：如果事件带 ttsText（Fish 情绪标签等），TTS 读 ttsText。
              ttsCoordinator?.ingest(deltaTtsText || deltaText);
            }
            const outgoing: Record<string, unknown> = {
              ...event,
              ...(messageId ? { messageId } : {}),
            };
            send(outgoing);
            if (event.type === "done" && ttsCoordinator) {
              // done 之后再 flush 尾句，保证 tts_stop 一定晚于 done/text_delta。
              ttsFinishPromise = ttsCoordinator.finish();
            }
          }
          if (ttsFinishPromise) await ttsFinishPromise;
        } catch (error) {
          if (!isAbortError(error) && !controller.signal.aborted) {
            send({
              type: "voice.error",
              detail: error instanceof Error ? error.message : String(error),
              messageId,
            });
          }
        } finally {
          // 流已结束（完成或打断）后不再允许任何迟到 TTS 回调。
          ttsCoordinator?.cancel();
          if (activeControllers.get(activeBinding.threadId) === controller) {
            activeControllers.delete(activeBinding.threadId);
          }
        }
      })();
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const session = ensureAsrSession();
        session?.acceptPcm(Buffer.from(data as Buffer));
        return;
      }
      let raw: Record<string, any>;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        send({ type: "voice.error", detail: "invalid json payload" });
        return;
      }
      const type = String(raw.type || "");
      const payload =
        raw.payload && typeof raw.payload === "object" ? (raw.payload as Record<string, any>) : raw;

      if (type === "ping") {
        send({ type: "pong" });
        return;
      }
      if (type === "thread.bind") {
        const next = parseBinding(payload);
        if (!next) {
          send({ type: "voice.error", detail: "invalid thread.bind payload" });
          return;
        }
        if (binding && binding.threadId !== next.threadId) {
          cancelStream(binding.threadId);
          // 换绑到别的 session 时摘掉旧登记，否则旧 session 的广播会推给这个 socket
          sessionHub.unregister(binding.threadId, connectionId);
        }
        binding = next;
        if (Number.isInteger(next.agentId) && Number(next.agentId) > 0) {
          beginVoiceCall(connectionId, Number(next.agentId));
        } else {
          endVoiceCall(connectionId);
        }
        sessionHub.register(
          connectionId,
          {
            userId: next.userId,
            sessionId: next.threadId,
            modality: "voice",
            agentId: next.agentId,
            vrmAvatar: next.vrmAvatar,
          },
          send,
        );
        asrContext = {
          sessionId: next.threadId,
          agentId: next.agentId ?? undefined,
          userId: next.userId,
          vrmAvatar: next.vrmAvatar,
          clientHints: next.clientHints,
        };
        return;
      }
      if (!binding) {
        send({ type: "voice.error", detail: "send thread.bind first" });
        return;
      }
      if (type === "voice.asr_start") {
        asrContext = {
          messageId: payload.messageId ? String(payload.messageId) : undefined,
          sessionId: payload.sessionId ? Number(payload.sessionId) : binding.threadId,
          agentId: payload.agentId ? Number(payload.agentId) : binding.agentId ?? undefined,
          userId: payload.userId ? String(payload.userId) : binding.userId,
          platform: payload.platform ? String(payload.platform) : undefined,
          clientEndpointing: payload.clientEndpointing ? String(payload.clientEndpointing) : undefined,
          clientHints:
            payload.clientHints && typeof payload.clientHints === "object"
              ? payload.clientHints
              : undefined,
          vrmAvatar: Boolean(payload.vrmAvatar),
        };
        ensureAsrSession();
        return;
      }
      if (type === "voice.asr_flush") {
        if (asrSession) {
          void Promise.resolve(asrSession.flush()).catch((error: any) => {
            send({ type: "voice.asr_error", detail: error?.message || String(error) });
          });
        } else {
          send({ type: "voice.asr_final", text: "", transport: "voice_duplex_asr", messageId: asrContext.messageId });
        }
        return;
      }
      if (type === "voice.asr_stop" || type === "voice.asr_close") {
        const session = asrSession;
        asrSession = null;
        if (session) {
          // vad_flush 模式下端点由端侧负责：停止时把尾包 final 掉，不丢最后一句。
          if (!asrAutoEndpointFinal) {
            void Promise.resolve(session.flush()).catch(() => {
              // ignore
            });
          }
          void Promise.resolve(session.close()).catch(() => {
            // ignore
          });
        }
        asrAutoEndpointFinal = true;
        asrContext = {};
        return;
      }
      if (type === "voice.input") {
        const message = String(payload.message || "").trim();
        if (!message) {
          send({ type: "voice.error", detail: "message is required", messageId: payload.messageId });
          return;
        }
        startVoiceTurn(message, payload.messageId ? String(payload.messageId) : undefined, {
          ...asrContext,
          clientHints:
            payload.clientHints && typeof payload.clientHints === "object" ? payload.clientHints : asrContext.clientHints,
          vrmAvatar: Boolean(payload.vrmAvatar) || asrContext.vrmAvatar,
          platform: payload.platform ? String(payload.platform) : asrContext.platform,
        });
        return;
      }
      if (type === "voice.cancel") {
        cancelStream(binding.threadId);
        send({ type: "voice.cancelled", messageIds: [], cancelReason: "client_cancel" });
        return;
      }
      if (type === "voice.session_end") {
        cancelStream(binding.threadId);
        closed = true;
        try {
          asrSession?.close();
        } catch {
          // ignore
        }
        socket.close();
        return;
      }
      if (type === "presence.report" || type === "typing.heartbeat" || type.startsWith("presence.")) {
        return;
      }
      send({ type: "voice.error", detail: `Unsupported message type: ${type || "unknown"}` });
    });

    socket.on("close", () => {
      closed = true;
      endVoiceCall(connectionId);
      unregisterBinding();
      if (binding) cancelStream(binding.threadId);
      try {
        asrSession?.close();
      } catch {
        // ignore
      }
    });
    socket.on("error", () => {
      closed = true;
      endVoiceCall(connectionId);
      unregisterBinding();
      if (binding) cancelStream(binding.threadId);
    });
  });
}
