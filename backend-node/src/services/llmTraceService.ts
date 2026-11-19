import { randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import {
  inputCacheHitRate,
  outputCacheHitRate,
  parseProviderUsage,
  type ParsedUsage,
} from "./usageService.js";

/**
 * Per-call request / response log.
 *
 * The chat stream writes one row per LLM call and one per tool call; the GUI
 * drawer reads them back as the "调用记录" panel. The rows carry the raw
 * payload (sanitised + truncated) so the user can inspect exactly what went
 * out on the wire, together with the provider's usage counters.
 */

/** Longest string kept verbatim in a stored payload. */
const MAX_STRING_CHARS = 4000;
/** Longest stored payload per column. */
const MAX_PAYLOAD_CHARS = 200_000;

const SECRET_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
  "access_token",
  "secret",
  "password",
]);

export interface CallTrace {
  id: string;
  threadId: number;
  turnId: string | null;
  kind: "llm" | "tool";
  model: string | null;
  provider: string | null;
  toolName: string | null;
  request: unknown;
  response: unknown;
  usage: ParsedUsage | null;
  error: string | null;
  createdAt: string;
  /** Input cache hit rate (0..1); null when the provider reported nothing. */
  inputCacheHitRate: number | null;
  /** Output cache hit rate (0..1); null when the provider does not report it. */
  outputCacheHitRate: number | null;
}

function nowIso() {
  return new Date().toISOString();
}

function redactString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value;
  return `${value.slice(0, MAX_STRING_CHARS)}…[已截断，共 ${value.length} 字符]`;
}

/**
 * Make a payload safe to store and to render: secrets are masked, huge blobs
 * (base64 images) are collapsed and long strings are truncated.
 */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 6) return "[层级过深，已省略]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 200).map((item) => sanitizePayload(item, depth + 1));
    if (value.length > 200) items.push(`[共 ${value.length} 项，已省略其余]`);
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key.toLowerCase())) {
        out[key] = "***";
        continue;
      }
      // A base64 image payload is megabytes of noise in a JSON viewer.
      if (typeof item === "string" && item.length > 20_000) {
        out[key] = `[大字段已省略，共 ${item.length} 字符]`;
        continue;
      }
      out[key] = sanitizePayload(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function stringify(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  try {
    const text = JSON.stringify(payload);
    if (!text) return null;
    return text.length > MAX_PAYLOAD_CHARS
      ? `${text.slice(0, MAX_PAYLOAD_CHARS)}…[已截断]`
      : text;
  } catch {
    return null;
  }
}

/** Keep only the newest N rows of a thread so the table cannot grow forever. */
const MAX_TRACES_PER_THREAD = 200;

function pruneThread(threadId: number) {
  try {
    getDb()
      .prepare(
        `DELETE FROM llm_call_traces
         WHERE thread_id = ? AND id NOT IN (
           SELECT id FROM llm_call_traces WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?
         )`,
      )
      .run(threadId, threadId, MAX_TRACES_PER_THREAD);
  } catch {
    // pruning is best effort
  }
}

export interface RecordLlmCallTraceInput {
  id?: string | null;
  threadId: number | null | undefined;
  turnId?: string | null;
  model?: string | null;
  provider?: string | null;
  request?: unknown;
  response?: unknown;
  usage?: unknown;
  error?: string | null;
}

export function recordLlmCallTrace(input: RecordLlmCallTraceInput): CallTrace | null {
  if (!input.threadId) return null;
  const id = input.id || randomUUID();
  const createdAt = nowIso();
  const usage = parseProviderUsage(input.usage);
  try {
    getDb()
      .prepare(
        `INSERT INTO llm_call_traces
           (id, thread_id, turn_id, kind, model, provider, tool_name,
            request_json, response_json, usage_json, error, created_at)
         VALUES (?, ?, ?, 'llm', ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.turnId || null,
        input.model || null,
        input.provider || null,
        stringify(sanitizePayload(input.request)),
        stringify(sanitizePayload(input.response)),
        usage ? JSON.stringify(usage) : null,
        input.error || null,
        createdAt,
      );
  } catch {
    return null;
  }
  pruneThread(input.threadId);
  return {
    id,
    threadId: input.threadId,
    turnId: input.turnId || null,
    kind: "llm",
    model: input.model || null,
    provider: input.provider || null,
    toolName: null,
    request: input.request ?? null,
    response: input.response ?? null,
    usage,
    error: input.error || null,
    createdAt,
    inputCacheHitRate: inputCacheHitRate(usage),
    outputCacheHitRate: outputCacheHitRate(usage),
  };
}

/**
 * Fill in the response side of an existing LLM trace (usage counters, finish
 * reason, chunk count) once the stream is done.
 */
export function updateLlmCallTrace(
  id: string,
  input: { response?: unknown; usage?: unknown; error?: string | null },
): void {
  try {
    const usage = parseProviderUsage(input.usage);
    getDb()
      .prepare(
        `UPDATE llm_call_traces
         SET response_json = COALESCE(?, response_json),
             usage_json = COALESCE(?, usage_json),
             error = COALESCE(?, error)
         WHERE id = ?`,
      )
      .run(
        stringify(sanitizePayload(input.response)),
        usage ? JSON.stringify(usage) : null,
        input.error || null,
        id,
      );
  } catch {
    // the trace is a diagnostic aid; losing the update must not break the turn
  }
}

export interface RecordToolCallTraceInput {
  threadId: number | null | undefined;
  turnId?: string | null;
  toolName: string;
  provider?: string | null;
  request?: unknown;
  response?: unknown;
  error?: string | null;
}

export function recordToolCallTrace(input: RecordToolCallTraceInput): CallTrace | null {
  if (!input.threadId) return null;
  const id = randomUUID();
  const createdAt = nowIso();
  try {
    getDb()
      .prepare(
        `INSERT INTO llm_call_traces
           (id, thread_id, turn_id, kind, model, provider, tool_name,
            request_json, response_json, usage_json, error, created_at)
         VALUES (?, ?, ?, 'tool', NULL, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.turnId || null,
        input.provider || null,
        input.toolName,
        stringify(sanitizePayload(input.request)),
        stringify(sanitizePayload(input.response)),
        input.error || null,
        createdAt,
      );
  } catch {
    return null;
  }
  pruneThread(input.threadId);
  return {
    id,
    threadId: input.threadId,
    turnId: input.turnId || null,
    kind: "tool",
    model: null,
    provider: input.provider || null,
    toolName: input.toolName,
    request: input.request ?? null,
    response: input.response ?? null,
    usage: null,
    error: input.error || null,
    createdAt,
    inputCacheHitRate: null,
    outputCacheHitRate: null,
  };
}

function parseJsonColumn(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function listCallTraces(threadId: number, limit = 60): CallTrace[] {
  if (!Number.isFinite(threadId) || threadId <= 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT * FROM llm_call_traces
       WHERE thread_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(threadId, Math.max(1, Math.min(limit, 200))) as Record<string, any>[];

  return rows.map((row) => {
    const usage = row.usage_json ? parseJsonColumn(row.usage_json) : null;
    return {
      id: String(row.id),
      threadId: Number(row.thread_id),
      turnId: row.turn_id ? String(row.turn_id) : null,
      kind: row.kind === "tool" ? ("tool" as const) : ("llm" as const),
      model: row.model ? String(row.model) : null,
      provider: row.provider ? String(row.provider) : null,
      toolName: row.tool_name ? String(row.tool_name) : null,
      request: parseJsonColumn(row.request_json),
      response: parseJsonColumn(row.response_json),
      usage: usage && typeof usage === "object" ? (usage as ParsedUsage) : null,
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at || ""),
      inputCacheHitRate: inputCacheHitRate(usage as ParsedUsage),
      outputCacheHitRate: outputCacheHitRate(usage as ParsedUsage),
    };
  });
}

export function clearCallTraces(threadId: number) {
  getDb().prepare("DELETE FROM llm_call_traces WHERE thread_id = ?").run(threadId);
  return { ok: true };
}
