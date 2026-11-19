import { getApiBaseUrl } from '../utils/apiConfig';

export interface SessionChatEventPayload extends Record<string, unknown> {
  type?: string;
  requestId?: string;
  detail?: string;
  content?: string;
  messageId?: string | null;
  metadata?: Record<string, unknown>;
}

type ChatSendPayload = Record<string, unknown>;

interface PendingChatRequest {
  onEvent: (payload: SessionChatEventPayload) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

function getClientUserId(): string {
  const storageKey = 'lingshu_user_id';
  const fixedUserId = 'default_user';
  localStorage.setItem(storageKey, fixedUserId);
  return fixedUserId;
}

function buildWsUrl(): string {
  const url = new URL('/api/v1/chat/thread-duplex', getApiBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function normalizeSessionId(sessionId: number | string | null | undefined): number | null {
  if (sessionId == null || sessionId === '') return null;
  const value = Number(sessionId);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeAgentId(agentId: number | string | null | undefined): number | null {
  if (agentId == null || agentId === '') return null;
  const value = Number(agentId);
  return Number.isFinite(value) && value > 0 ? value : null;
}

class SessionChatWsClient {
  private socket: WebSocket | null = null;
  private ready = false;
  private boundSessionId: number | null = null;
  private boundAgentId: number | null = null;
  private dirtyTyping = false;
  private pending = new Map<string, PendingChatRequest>();
  private pushHandler: ((payload: SessionChatEventPayload) => void) | null = null;
  private cancelHandler: (() => void) | null = null;
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private typingTimer: number | null = null;
  private pingTimer: number | null = null;
  /**
   * The backend restarts on its own in development (and can crash in
   * production). Without a reconnect the chat stays dead until the whole app
   * is restarted, so an unexpected close schedules a reconnect with backoff.
   */
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;

  setPushHandler(handler: ((payload: SessionChatEventPayload) => void) | null) {
    this.pushHandler = handler;
  }

  setCancelHandler(handler: (() => void) | null) {
    this.cancelHandler = handler;
  }

  isBoundTo(sessionId: number | string | null | undefined, agentId?: number | string | null) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedAgentId = normalizeAgentId(agentId);
    return (
      normalizedSessionId != null
      && normalizedSessionId === this.boundSessionId
      && normalizedAgentId === this.boundAgentId
      && this.socket != null
      && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    );
  }

  bindSession(sessionId: number | string | null, agentId: number | string | null) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedAgentId = normalizeAgentId(agentId);

    if (normalizedSessionId == null) {
      this.disconnect();
      return;
    }

    if (this.isBoundTo(normalizedSessionId, normalizedAgentId)) {
      return;
    }

    const sameBinding =
      normalizedSessionId === this.boundSessionId
      && normalizedAgentId === this.boundAgentId;

    if (!sameBinding) {
      this.disconnect();
    } else {
      this.closeSocketSilently();
    }

    this.boundSessionId = normalizedSessionId;
    this.boundAgentId = normalizedAgentId;
    this.ready = false;
    this.openSocket(normalizedSessionId, normalizedAgentId);
  }

  markTypingDirty() {
    this.dirtyTyping = true;
  }

  private clearTimers() {
    if (this.typingTimer != null) {
      window.clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.pingTimer != null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Try to come back after an unexpected close. The delay grows with every
   * failed attempt so a backend that is down does not get hammered.
   */
  private scheduleReconnect() {
    if (this.intentionalClose) return;
    if (this.reconnectTimer != null) return;
    if (this.boundSessionId == null) return;
    const attempt = Math.min(this.reconnectAttempts, 5);
    const delay = Math.min(15000, 500 * 2 ** attempt);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;
      const sessionId = this.boundSessionId;
      if (sessionId == null) return;
      try {
        this.openSocket(sessionId, this.boundAgentId);
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private closeSocketSilently() {
    this.clearTimers();
    const socket = this.socket;
    if (!socket) {
      this.ready = false;
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    if (this.socket === socket) {
      this.socket = null;
    }
    this.ready = false;
  }

  private openSocket(sessionId: number, agentId: number | null) {
    this.intentionalClose = false;
    this.clearReconnectTimer();
    const socket = new WebSocket(buildWsUrl());
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      socket.send(
        JSON.stringify({
          type: 'thread.bind',
          payload: {
            sessionId,
            userId: getClientUserId(),
            agentId,
            modality: 'text',
          },
        }),
      );
    };

    socket.onmessage = (event) => {
      let payload: SessionChatEventPayload;
      try {
        payload = JSON.parse(String(event.data)) as SessionChatEventPayload;
      } catch {
        return;
      }
      this.handleMessage(payload);
    };

    socket.onerror = () => {
      console.warn('[sessionChatWs] websocket error');
    };

    socket.onclose = () => {
      this.ready = false;
      this.clearTimers();
      if (this.socket === socket) {
        this.socket = null;
      }
      const error = new Error('聊天连接已断开，正在自动重连，请稍后重发这条消息');
      for (const [, pending] of this.pending) {
        pending.reject(error);
      }
      this.pending.clear();
      for (const waiter of this.readyWaiters.splice(0)) {
        waiter.reject(error);
      }
      // An unexpected close (backend restart, network blip) reconnects on its
      // own; an intentional one does not.
      this.scheduleReconnect();
    };

    this.typingTimer = window.setInterval(() => {
      if (!this.dirtyTyping) return;
      this.dirtyTyping = false;
      this.sendJson({
        type: 'typing.heartbeat',
        payload: {
          kind: 'user_active',
          source: 'typing',
          sessionId,
          userId: getClientUserId(),
        },
      });
    }, 500);

    this.pingTimer = window.setInterval(() => {
      this.sendJson({ type: 'ping' });
    }, 25000);
  }

  private sendJson(payload: Record<string, unknown>) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.ready) return;
    socket.send(JSON.stringify(payload));
  }

  private handleMessage(payload: SessionChatEventPayload) {
    const type = String(payload.type || '');
    if (type === 'thread.ready' || type === 'session.ready') {
      this.ready = true;
      for (const waiter of this.readyWaiters.splice(0)) {
        waiter.resolve();
      }
      return;
    }
    if (type === 'pong') return;
    if (type === 'chat.proactive') {
      this.pushHandler?.(payload);
      return;
    }
    if (type === 'followup.cancel') {
      this.cancelHandler?.();
      return;
    }

    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const pending = requestId ? this.pending.get(requestId) : undefined;

    if (type === 'chat.error') {
      if (pending) {
        // A transport-level failure still belongs to the assistant placeholder
        // created for this request. Route it through the normal chat event
        // pipeline so the store turns that placeholder into a visible failed
        // message, rather than leaving it blank while only rejecting the
        // request promise.
        pending.onEvent({
          ...payload,
          type: 'error',
          content: String(payload.detail || 'chat error'),
          metadata: {
            ...(payload.metadata || {}),
            transportError: true,
            ...(payload.statusCode ? { statusCode: payload.statusCode } : {}),
          },
        });
        pending.resolve();
        this.pending.delete(requestId);
      }
      return;
    }

    const meta = payload.metadata;
    const isFollowUpPush =
      Boolean(meta?.follow_up)
      || Boolean(meta?.followUp)
      || Boolean(meta?.server_initiated)
      || Boolean(meta?.serverInitiated);

    if (pending && !isFollowUpPush) {
      pending.onEvent(payload);
      if (type === 'chat.finished') {
        pending.resolve();
        this.pending.delete(requestId);
      }
      return;
    }

    if (isFollowUpPush) {
      this.pushHandler?.(payload);
      return;
    }

    const isServerPush = !requestId;
    if (isServerPush) {
      this.pushHandler?.(payload);
    }
  }

  private waitReady(timeoutMs = 20000): Promise<void> {
    if (this.ready) return Promise.resolve();
    // Nothing is connected right now: start reconnecting so the caller can
    // wait for the backend to come back instead of failing straight away.
    if (!this.socket) this.scheduleReconnect();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          window.clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      };
      const timer = window.setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter);
        if (index >= 0) this.readyWaiters.splice(index, 1);
        reject(new Error('聊天连接超时，请检查后端服务是否启动或地址是否正确'));
      }, timeoutMs);
      this.readyWaiters.push(waiter);
    });
  }

  async sendChat(
    payload: ChatSendPayload,
    options: {
      requestId: string;
      onEvent: (payload: SessionChatEventPayload) => void;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    if (this.boundSessionId == null) {
      throw new Error('session chat websocket is not bound');
    }
    await this.waitReady();

    const { requestId, onEvent, signal } = options;
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        this.sendJson({ type: 'chat.cancel', requestId });
        this.pending.delete(requestId);
        reject(new DOMException('Aborted', 'AbortError'));
      };

      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      this.pending.set(requestId, {
        onEvent,
        resolve: () => {
          signal?.removeEventListener('abort', abortHandler);
          resolve();
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abortHandler);
          reject(error);
        },
      });

      this.sendJson({
        type: 'chat.send',
        requestId,
        payload,
      });
    });
  }

  disconnect() {
    // An explicit disconnect must not trigger the reconnect loop.
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.clearTimers();
    this.closeSocketSilently();
    this.boundSessionId = null;
    this.boundAgentId = null;
    for (const [, pending] of this.pending) {
      pending.reject(new Error('session websocket disconnected'));
    }
    this.pending.clear();
    for (const waiter of this.readyWaiters.splice(0)) {
      waiter.reject(new Error('session websocket disconnected'));
    }
  }
}

export const sessionChatWs = new SessionChatWsClient();
