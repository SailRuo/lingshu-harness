import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";

export interface LogEvent {
  id: string;
  timestamp: string;
  level: string;
  levelLabel: string;
  kind: string;
  message: string;
  renderLine: string;
  logger: string | null;
  name: string;
  function: string | null;
  line: number | null;
  module: string | null;
  process: number;
  thread: number;
  sessionId: string | null;
  session_id: string | null;
  turnId: string | null;
  taskId: string | null;
  task_id: string | null;
  userId: string | null;
  component: string | null;
  eventSequence: number | null;
  event_sequence: number | null;
  logType: string;
  exception: string | null;
  extra: Record<string, unknown>;
  presentation: {
    category: string;
    memoryLogLayer: string | null;
    memoryLogLayerLabel: string | null;
    sourceLabel: string;
    title: string;
    summary: string;
    chips: unknown[];
    details: unknown;
    searchText: string;
    searchIndex: string;
  };
}

const MAX_EVENTS = 1200;
const buffer: LogEvent[] = [];
const listeners = new Set<(event: LogEvent) => void>();

const LEVELS: Record<number, { level: string; label: string }> = {
  10: { level: "trace", label: "TRACE" },
  20: { level: "debug", label: "DEBUG" },
  30: { level: "info", label: "INFO" },
  40: { level: "warn", label: "WARN" },
  50: { level: "error", label: "ERROR" },
  60: { level: "fatal", label: "FATAL" },
};

function normalize(raw: Record<string, any>): LogEvent {
  const levelInfo = LEVELS[Number(raw.level)] || { level: "info", label: "INFO" };
  const message = String(raw.msg ?? raw.message ?? "");
  const sessionId = raw.session_id ?? raw.sessionId ?? null;
  const turnId = raw.turnId ?? raw.turn_id ?? null;
  const taskId = raw.task_id ?? raw.taskId ?? null;
  const userId = raw.user_id ?? raw.userId ?? null;
  const timestamp = raw.time
    ? new Date(Number(raw.time)).toISOString()
    : new Date().toISOString();
  const logger = raw.logger ?? null;
  return {
    id: String(raw.id || randomUUID()),
    timestamp,
    level: levelInfo.level,
    levelLabel: levelInfo.label,
    kind: String(raw.kind || "app"),
    message,
    renderLine: `${levelInfo.label} ${message}`,
    logger,
    name: String(raw.name || "lingshu-backend-node"),
    function: raw.function ?? null,
    line: raw.line ?? null,
    module: raw.module ?? null,
    process: Number(raw.pid || process.pid),
    thread: Number(raw.thread || 0),
    sessionId: sessionId === null ? null : String(sessionId),
    session_id: sessionId === null ? null : String(sessionId),
    turnId: turnId === null ? null : String(turnId),
    taskId: taskId === null ? null : String(taskId),
    task_id: taskId === null ? null : String(taskId),
    userId: userId === null ? null : String(userId),
    component: raw.component ?? null,
    eventSequence: raw.event_sequence ?? raw.eventSequence ?? null,
    event_sequence: raw.event_sequence ?? raw.eventSequence ?? null,
    logType: String(raw.logType || "app"),
    exception: raw.err ? String(raw.err.stack || raw.err.message || raw.err) : null,
    extra: raw.extra && typeof raw.extra === "object" ? raw.extra : {},
    presentation: {
      category: String(raw.presentation?.category || "app"),
      memoryLogLayer: raw.presentation?.memoryLogLayer ?? null,
      memoryLogLayerLabel: raw.presentation?.memoryLogLayerLabel ?? null,
      sourceLabel: String(raw.presentation?.sourceLabel || "Node 后端"),
      title: String(raw.presentation?.title || message.slice(0, 80)),
      summary: String(raw.presentation?.summary || message.slice(0, 300)),
      chips: Array.isArray(raw.presentation?.chips) ? raw.presentation.chips : [],
      details: raw.presentation?.details ?? null,
      searchText: `${message} ${sessionId ?? ""} ${taskId ?? ""}`.trim(),
      searchIndex: `${levelInfo.level} ${sessionId ?? ""}`.trim(),
    },
  };
}

export function pushLogEvent(raw: Record<string, any>) {
  const event = normalize(raw);
  buffer.push(event);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore listener failures
    }
  }
}

export function createLogDestination() {
  let pending = "";
  return new Writable({
    write(chunk, _encoding, callback) {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          pushLogEvent(JSON.parse(line));
        } catch {
          pushLogEvent({ level: 30, msg: line, kind: "stdout" });
        }
      }
      callback();
    },
  });
}

export function listLogEvents(filters: {
  sessionId?: string;
  level?: string;
  limit?: number;
}): LogEvent[] {
  const levelOrder = ["trace", "debug", "info", "warn", "error", "fatal"];
  const minIndex = filters.level ? levelOrder.indexOf(filters.level) : 0;
  return buffer
    .filter((event) => {
      if (filters.sessionId && event.sessionId !== filters.sessionId) return false;
      if (filters.level) {
        const index = levelOrder.indexOf(event.level);
        if (index < minIndex) return false;
      }
      return true;
    })
    .slice(-Math.max(1, Math.min(filters.limit || 300, 1200)));
}

export function subscribeLogs(listener: (event: LogEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
