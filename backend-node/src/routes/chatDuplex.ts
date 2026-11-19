import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  ChatRequestError,
  ChatRequestInput,
  isAbortError,
  streamChat,
} from "../services/chatStreamService.js";
import { ensureThread, getThread } from "../services/chatThreadService.js";
import { parseChatRequest } from "./chat.js";
import { sessionHub } from "../services/sessionHub.js";

interface ThreadBinding {
  threadId: number;
  userId: string;
  agentId: number | null;
  vrmAvatar: boolean;
}

interface ActiveStream {
  requestId: string;
  controller: AbortController;
}

const activeStreams = new Map<number, ActiveStream>();

function cancelActiveStream(threadId: number, requestId?: string | null) {
  const active = activeStreams.get(threadId);
  if (!active) return;
  if (requestId && active.requestId !== requestId) return;
  activeStreams.delete(threadId);
  active.controller.abort(new DOMException("client_cancel", "AbortError"));
}

function parseBinding(payload: Record<string, unknown>): ThreadBinding | null {
  const userId = String(payload.userId ?? payload.user_id ?? "");
  const agentIdRaw = payload.agentId ?? payload.agent_id;
  const agentId =
    agentIdRaw === null || agentIdRaw === undefined || agentIdRaw === ""
      ? null
      : Number(agentIdRaw);
  if (agentId !== null && (!Number.isInteger(agentId) || agentId <= 0)) return null;

  const sessionRaw = payload.threadId ?? payload.sessionId ?? payload.session_id ?? 0;
  const sessionId = Number(sessionRaw);

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
      : payload.client_hints && typeof payload.client_hints === "object"
        ? (payload.client_hints as Record<string, unknown>)
        : null;

  return {
    threadId,
    userId,
    agentId,
    vrmAvatar: Boolean(hints?.vrmAvatar || hints?.vrm_avatar),
  };
}

function withThreadClientHints(request: ChatRequestInput, vrmAvatar: boolean): ChatRequestInput {
  const hints: Record<string, unknown> = { ...(request.clientHints || {}) };
  if (!String(hints.surface || "").trim()) hints.surface = "guiv1_pc";
  if (!String(hints.interactionMode || "").trim()) hints.interactionMode = "text_chat";
  if (!String(hints.inputKind || "").trim()) hints.inputKind = "text";
  if (!String(hints.outputMode || "").trim()) hints.outputMode = "text_bubble";
  if (!String(hints.transport || "").trim()) hints.transport = "thread_duplex";
  if (vrmAvatar) hints.vrmAvatar = true;
  return { ...request, clientHints: hints };
}

export async function registerChatDuplexRoutes(app: FastifyInstance) {
  // 关闭时清掉 hub 上的连接登记并以 1001 关闭在线连接（Python 的 close_all_websockets）
  app.addHook("preClose", async () => {
    sessionHub.closeAllWebSockets();
  });

  app.get("/api/v1/chat/thread-duplex", { websocket: true }, (socket: WebSocket) => {
    let binding: ThreadBinding | null = null;
    let closed = false;
    const connectionId = randomUUID();

    const safeSend = (payload: Record<string, unknown>) => {
      if (closed || socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // socket may close between the readyState check and send
      }
    };

    const unregisterBinding = () => {
      sessionHub.unregisterSocket(socket);
      if (!binding) return;
      sessionHub.unregister(binding.threadId, connectionId);
    };

    sessionHub.registerSocket(socket);

    const runChat = (requestId: string, request: ChatRequestInput) => {
      if (!binding) return;
      const threadId = binding.threadId;
      cancelActiveStream(threadId, null);

      const controller = new AbortController();
      const active: ActiveStream = { requestId, controller };
      activeStreams.set(threadId, active);

      void (async () => {
        safeSend({ type: "chat.started", requestId });
        try {
          for await (const event of streamChat({
            request,
            signal: controller.signal,
            controller,
          })) {
            if (controller.signal.aborted) break;
            safeSend({ ...event, requestId });
          }
          if (!controller.signal.aborted) {
            safeSend({ type: "chat.finished", requestId });
          }
        } catch (error) {
          if (isAbortError(error) || controller.signal.aborted) return;
          const detail = error instanceof Error ? error.message : String(error);
          safeSend({
            type: "chat.error",
            requestId,
            detail,
            ...(error instanceof ChatRequestError ? { statusCode: error.statusCode } : {}),
          });
        } finally {
          if (activeStreams.get(threadId) === active) {
            activeStreams.delete(threadId);
          }
        }
      })();
    };

    socket.on("message", (data) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        safeSend({ type: "thread.error", detail: "invalid json payload" });
        return;
      }
      const messageType = String(raw.type || "");

      if (messageType === "ping") {
        safeSend({ type: "pong" });
        return;
      }

      if (messageType === "thread.bind") {
        const payload =
          raw.payload && typeof raw.payload === "object"
            ? (raw.payload as Record<string, unknown>)
            : raw;
        const nextBinding = parseBinding(payload);
        if (!nextBinding) {
          safeSend({ type: "thread.error", detail: "invalid thread.bind payload" });
          return;
        }
        if (binding && binding.threadId !== nextBinding.threadId) {
          cancelActiveStream(binding.threadId, null);
          // 换绑到别的 session 时摘掉旧登记，否则旧 session 的广播会推给这个 socket
          sessionHub.unregister(binding.threadId, connectionId);
        }
        binding = nextBinding;
        sessionHub.register(
          connectionId,
          {
            userId: binding.userId,
            sessionId: binding.threadId,
            modality: "text",
            agentId: binding.agentId,
            vrmAvatar: binding.vrmAvatar,
          },
          safeSend,
        );
        safeSend({ type: "thread.ready", threadId: binding.threadId });
        return;
      }

      if (!binding) {
        safeSend({ type: "thread.error", detail: "send thread.bind first" });
        return;
      }

      if (messageType === "chat.send") {
        const payload =
          raw.payload && typeof raw.payload === "object"
            ? (raw.payload as Record<string, unknown>)
            : raw;
        const requestId = String(raw.requestId || payload.requestId || "").trim();
        const parsed = parseChatRequest(payload);
        if (!parsed.ok) {
          safeSend({
            type: "chat.error",
            requestId: requestId || "unknown",
            detail: parsed.detail,
          });
          return;
        }
        const request = parsed.request;
        if (request.sessionId && request.sessionId !== binding.threadId) {
          safeSend({
            type: "chat.error",
            requestId: requestId || "unknown",
            detail: "sessionId mismatch with binding",
          });
          return;
        }
        const resolvedRequestId = requestId || `ws_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        runChat(resolvedRequestId, {
          ...withThreadClientHints(request, binding.vrmAvatar),
          sessionId: binding.threadId,
          userId: request.userId || binding.userId,
        });
        return;
      }

      if (messageType === "chat.cancel") {
        const requestId = String(raw.requestId || "").trim() || null;
        cancelActiveStream(binding.threadId, requestId);
        return;
      }

      if (messageType === "typing.heartbeat") {
        // 用户开始打字 = 打断续聊：通知同 session 的客户端停掉待播的续聊消息
        sessionHub.cancelFollowupStreams(binding.threadId);
        return;
      }

      if (messageType === "presence.report") {
        const inner =
          raw.payload && typeof raw.payload === "object"
            ? (raw.payload as Record<string, unknown>)
            : raw;
        if (String(inner.kind || "") === "user_active") {
          cancelActiveStream(binding.threadId, null);
          sessionHub.cancelFollowupStreams(binding.threadId);
        }
        return;
      }

      safeSend({ type: "thread.error", detail: `unsupported type: ${messageType || "unknown"}` });
    });

    socket.on("close", () => {
      closed = true;
      unregisterBinding();
      if (binding) cancelActiveStream(binding.threadId, null);
    });

    socket.on("error", () => {
      closed = true;
      unregisterBinding();
      if (binding) cancelActiveStream(binding.threadId, null);
    });
  });
}
