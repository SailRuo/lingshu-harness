/**
 * Session-level WebSocket hub: keeps the live sockets bound to one chat
 * session so server-initiated events (主动消息 / 渠道回合同步 / 打断续聊) can be
 * pushed to every connection of that session.
 *
 * Mirrors backend/core/presence/session_hub.py. The Python hub keys connection
 * identity by the `send_json` callable object; here every socket owns a
 * connection id instead, which survives re-binding to another session.
 */

export type SessionModality = "text" | "voice";

export interface SessionBinding {
  userId: string;
  sessionId: number;
  modality: SessionModality;
  agentId: number | null;
  vrmAvatar: boolean;
}

export type SendJson = (payload: Record<string, unknown>) => void;

interface HubConnection {
  connectionId: string;
  binding: SessionBinding;
  sendJson: SendJson;
  closed: boolean;
}

interface ClosableSocket {
  close?: (code?: number, reason?: string) => void;
}

function bindingKey(userId: string, sessionId: number) {
  return `${userId}:${sessionId}`;
}

class SessionHub {
  private connections = new Map<number, HubConnection[]>();
  private bindings = new Map<string, SessionBinding>();
  private activeSockets = new Set<ClosableSocket>();

  /** Track a raw socket so a shutdown can close it with code 1001. */
  registerSocket(socket: ClosableSocket) {
    this.activeSockets.add(socket);
  }

  unregisterSocket(socket: ClosableSocket) {
    this.activeSockets.delete(socket);
  }

  register(connectionId: string, binding: SessionBinding, sendJson: SendJson) {
    const key = bindingKey(binding.userId, binding.sessionId);
    this.bindings.set(key, binding);
    const bucket = this.connections.get(binding.sessionId) ?? [];
    // 同一连接重复 bind 时踢掉旧记录，避免同一 socket 在列表里出现两次
    const remaining = bucket.filter((conn) => conn.connectionId !== connectionId);
    remaining.push({ connectionId, binding, sendJson, closed: false });
    this.connections.set(binding.sessionId, remaining);
  }

  /** Remove one connection; when the session bucket empties its binding goes too. */
  unregister(sessionId: number, connectionId: string): SessionBinding | null {
    const bucket = this.connections.get(sessionId);
    if (!bucket) return null;
    let removed: SessionBinding | null = null;
    const remaining: HubConnection[] = [];
    for (const conn of bucket) {
      if (conn.connectionId === connectionId) {
        removed = conn.binding;
        conn.closed = true;
      } else {
        remaining.push(conn);
      }
    }
    if (remaining.length) {
      this.connections.set(sessionId, remaining);
    } else {
      this.connections.delete(sessionId);
      if (removed) this.bindings.delete(bindingKey(removed.userId, removed.sessionId));
    }
    return removed;
  }

  getBinding(userId: string, sessionId: number): SessionBinding | null {
    return this.bindings.get(bindingKey(String(userId), Number(sessionId))) ?? null;
  }

  getModality(userId: string, sessionId: number): SessionModality {
    return this.getBinding(userId, sessionId)?.modality ?? "text";
  }

  /** Push a payload to every live connection of the session; returns the sent count. */
  broadcastJson(sessionId: number, payload: Record<string, unknown>): number {
    const targets = (this.connections.get(Number(sessionId)) ?? []).filter((conn) => !conn.closed);
    let sent = 0;
    for (const conn of targets) {
      try {
        conn.sendJson(payload);
        sent += 1;
      } catch (error) {
        // 单个连接失败（socket 已关闭）不影响其它连接
        console.warn(
          `[SESSION_HUB] push failed session=${sessionId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return sent;
  }

  /** 打断续聊：通知客户端停止 TTS / 正在播放的续聊消息。 */
  cancelFollowupStreams(sessionId: number): number {
    return this.broadcastJson(Number(sessionId), {
      type: "followup.cancel",
      sessionId: Number(sessionId),
    });
  }

  closeAllWebSockets() {
    const sockets = [...this.activeSockets];
    for (const socket of sockets) {
      try {
        socket.close?.(1001);
      } catch (error) {
        console.warn(
          "[SESSION_HUB] error closing websocket:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    this.activeSockets.clear();
    this.connections.clear();
    this.bindings.clear();
  }
}

export const sessionHub = new SessionHub();
