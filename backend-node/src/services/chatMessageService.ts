import { getDb } from "../db/sqlite.js";
import {
  ChatThreadRow,
  normalizeUserId,
  updateThreadSummary,
} from "./chatThreadService.js";
import {
  invalidateSelfPortraitBlockCache,
} from "./selfPortraitCache.js";
import { memoryScope } from "./memoryScope.js";
import { forgetChatUsage } from "./chatUsageState.js";

export interface ChatImagePayload {
  uploadId: string;
  url: string;
  mimeType: string;
  fileName?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  summaryText?: string;
}

export interface ChatMessageRow {
  id: number;
  thread_id: number;
  user_id: string;
  agent_id: number;
  role: string;
  message_kind: string;
  content: string;
  reply_to_message_id: number | null;
  turn_pair_id: number | null;
  task_id: string | null;
  user_images_json: string | null;
  assistant_images_json: string | null;
  input_metadata: string | null;
  assistant_read_at: string | null;
  assistant_unspoken: string | null;
  status: string;
  error_message: string | null;
  emotional_analysis: string | null;
  retrieved_facts: string | null;
  created_at: string;
  completed_at: string | null;
  digested_at: string | null;
  purge_at: string | null;
}

export interface ChatTurnHistoryItem {
  id: number;
  userMessage: string | null;
  assistantMessage: string;
  status: string;
  errorMessage: string | null;
  timestamp: string;
  taskId: string | null;
  userImages: ChatImagePayload[];
  assistantImages: ChatImagePayload[];
  input: Record<string, unknown> | null;
  retrievedFacts: Record<string, unknown> | null;
  role: string | null;
  messageKind: string | null;
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  /** Present on replayed tool exchanges. */
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export interface ThreadAnchorContext {
  summary: string;
  coveredAt: string;
  coveredMessageId: number | null;
  updatedAt: string;
}

export interface ThreadContext {
  anchor: ThreadAnchorContext | null;
  messages: HistoryMessage[];
  usedTokens: number;
}

export interface LoadThreadHistoryOptions {
  /** Prompt budget in tokens; callers read it from settings (default 128K). */
  budgetTokens?: number;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseImages(raw: unknown): ChatImagePayload[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is ChatImagePayload => !!item && typeof item === "object");
}

const IMAGE_SUMMARY_LINE_RE = /^\[图片\d+\]\s/;

export function userMessageForDisplay(
  content: string | null | undefined,
  images: ChatImagePayload[] | null | undefined,
): string {
  const text = (content || "").trim();
  if (!text || !(images || []).length) return text;
  return text
    .split("\n")
    .filter((line) => !IMAGE_SUMMARY_LINE_RE.test(line.trim()))
    .join("\n")
    .trim();
}

export function userMessageForLlm(
  content: string | null | undefined,
  images: ChatImagePayload[] | null | undefined,
): string {
  const text = (content || "").trim();
  const list = images || [];
  if (!list.length) return text;
  const lines = text ? [text] : [];
  list.forEach((image, index) => {
    const summary = (image.summaryText || "").trim() || "用户发送了一张图片。";
    lines.push(`[图片${index + 1}] ${summary}`);
  });
  return lines.join("\n").trim();
}

export function assistantMessageForLlm(content: string | null | undefined): string {
  return (content || "").trim();
}

/**
 * Marker prefix the image policy uses as proof that a photo really was sent:
 * "历史里仅 [我发出的照片N] 才算真发过，无标记=没发过".
 *
 * Without it the agent has no way to tell that it already showed a picture, so
 * on the next turn it denies the photo ("那张图我这边没能给你出来"). Every
 * picture the agent produced therefore gets a marker line plus a one-line
 * description of what the picture shows.
 */
export const SENT_PHOTO_MARKER_PREFIX = "[我发出的照片";

export function sentPhotoMarker(index: number): string {
  return `${SENT_PHOTO_MARKER_PREFIX}${index}]`;
}

/**
 * Flatten a vision summary into one short line. The summary is written by a
 * model, so it can arrive as markdown bullets or several paragraphs — the
 * marker line has to stay readable inside the chat history.
 */
export function condenseImageDescription(summary: string | null | undefined, maxChars = 140): string {
  const text = String(summary || "")
    .replace(/[*_`#>]/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*·•]\s*/, "").trim())
    .filter(Boolean)
    .join("；")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Build the history line for a picture the agent sent.
 * Returns an empty string when there is nothing worth marking.
 */
export function assistantPhotoMarkerLine(
  image: ChatImagePayload,
  index: number,
): string {
  const description = condenseImageDescription(image.summaryText);
  const marker = sentPhotoMarker(index);
  if (!description) return marker;
  return `${marker} ${description}`;
}

/**
 * Render an assistant message for the LLM, appending one marker line per
 * picture the agent sent in that turn.
 */
export function assistantMessageWithPhotosForLlm(
  content: string | null | undefined,
  images: ChatImagePayload[] | null | undefined,
): string {
  const text = assistantMessageForLlm(content);
  const list = images || [];
  if (!list.length) return text;
  const markers = list
    .map((image, index) => assistantPhotoMarkerLine(image, index + 1))
    .filter(Boolean);
  if (!markers.length) return text;
  return [text, ...markers].filter(Boolean).join("\n").trim();
}

/**
 * A tool round-trip: the assistant message that carried `tool_calls` plus the
 * matching `role: "tool"` results.
 *
 * These are stored verbatim on the assistant message so the next request can
 * replay them exactly. Providers key their prompt cache on the byte-identical
 * request prefix — when the tool exchange is dropped, the prefix diverges and
 * the cache hit collapses to zero. It also costs the model the record of what
 * it called and what came back.
 */
export interface ToolRoundTripMessage {
  role: "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export function parseToolRoundTrip(raw: unknown): ToolRoundTripMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is ToolRoundTripMessage =>
      !!item &&
      typeof item === "object" &&
      ((item as any).role === "assistant" || (item as any).role === "tool"),
  );
}

export interface AppendTurnOptions {
  userContent: string;
  assistantContent: string;
  userImages?: ChatImagePayload[];
  assistantImages?: ChatImagePayload[];
  /** Exact text sent to the LLM for the user turn (replayed verbatim). */
  userLlmContent?: string | null;
  /** Tool exchange of this turn, replayed verbatim on the next request. */
  toolMessages?: ToolRoundTripMessage[];
  inputMetadata?: Record<string, unknown> | null;
  startedAt: string;
  taskId?: string | null;
}

export interface AppendTurnResult {
  userMessageId: number | null;
  assistantMessageId: number;
}

export function appendTurn(thread: ChatThreadRow, options: AppendTurnOptions): AppendTurnResult {
  const db = getDb();
  const userId = normalizeUserId(thread.user_id);
  const completedAt = new Date().toISOString();
  const storedUserContent = (options.userContent || "").trim();
  const storedAssistantContent = (options.assistantContent || "").trim();
  const userImages = options.userImages?.length ? options.userImages : null;
  const assistantImages = options.assistantImages?.length ? options.assistantImages : null;
  const toolMessages = options.toolMessages?.length ? JSON.stringify(options.toolMessages) : null;

  const run = db.transaction((): AppendTurnResult => {
    let userMessageId: number | null = null;
    if (storedUserContent || userImages) {
      const userInfo = db
        .prepare(
          `INSERT INTO chat_messages
            (thread_id, user_id, agent_id, role, message_kind, content, user_images_json,
             llm_content, input_metadata, task_id, created_at, completed_at)
           VALUES (?, ?, ?, 'user', 'user_text', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          thread.id,
          userId,
          thread.agent_id,
          storedUserContent,
          userImages ? JSON.stringify(userImages) : null,
          options.userLlmContent || null,
          options.inputMetadata ? JSON.stringify(options.inputMetadata) : null,
          options.taskId ?? null,
          options.startedAt,
          options.startedAt,
        );
      userMessageId = Number(userInfo.lastInsertRowid);
      db.prepare("UPDATE chat_messages SET turn_pair_id = ? WHERE id = ?").run(
        userMessageId,
        userMessageId,
      );
    }

    const assistantInfo = db
      .prepare(
        `INSERT INTO chat_messages
          (thread_id, user_id, agent_id, role, message_kind, content, reply_to_message_id,
           turn_pair_id, assistant_images_json, tool_messages_json, input_metadata, task_id,
           assistant_read_at, status, created_at, completed_at)
         VALUES (?, ?, ?, 'assistant', 'reply', ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
      )
      .run(
        thread.id,
        userId,
        thread.agent_id,
        storedAssistantContent,
        userMessageId,
        userMessageId,
        assistantImages ? JSON.stringify(assistantImages) : null,
        toolMessages,
        options.inputMetadata ? JSON.stringify(options.inputMetadata) : null,
        options.taskId ?? null,
        completedAt,
        completedAt,
        completedAt,
      );
    const assistantMessageId = Number(assistantInfo.lastInsertRowid);
    if (userMessageId === null) {
      db.prepare("UPDATE chat_messages SET turn_pair_id = ? WHERE id = ?").run(
        assistantMessageId,
        assistantMessageId,
      );
    }

    updateThreadSummary(thread.id, storedAssistantContent, "reply", completedAt);
    return { userMessageId, assistantMessageId };
  });

  return run();
}

export function markMessagesDigested(ids: number[]) {
  const values = ids.filter((id) => Number.isInteger(id) && id > 0);
  if (!values.length) return 0;
  return getDb()
    .prepare(
      `UPDATE chat_messages SET digested_at = ?
       WHERE id IN (${values.map(() => "?").join(",")}) AND digested_at IS NULL`,
    )
    .run(new Date().toISOString(), ...values).changes;
}

export function completeAssistantMessage(
  thread: ChatThreadRow,
  messageId: number,
  options: {
    content: string;
    inputMetadata?: Record<string, unknown> | null;
    taskId?: string | null;
    /** Pictures produced by tools during the turn (stored in assistant_images_json). */
    assistantImages?: ChatImagePayload[] | null;
    /** Tool exchange of the turn, stored verbatim for the next request. */
    toolMessages?: ToolRoundTripMessage[] | null;
  },
): ChatMessageRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const content = (options.content || "").trim();
  const assistantImages = options.assistantImages?.length ? options.assistantImages : null;
  const toolMessages = options.toolMessages?.length
    ? JSON.stringify(options.toolMessages)
    : null;
  const info = db
    .prepare(
      `UPDATE chat_messages SET
         content = ?, input_metadata = COALESCE(?, input_metadata),
         task_id = COALESCE(?, task_id), status = 'completed',
         completed_at = ?, digested_at = NULL, assistant_read_at = ?,
         assistant_images_json = COALESCE(?, assistant_images_json),
         tool_messages_json = COALESCE(?, tool_messages_json)
       WHERE id = ? AND thread_id = ? AND role = 'assistant'`,
    )
    .run(
      content,
      options.inputMetadata ? JSON.stringify(options.inputMetadata) : null,
      options.taskId ?? null,
      now,
      now,
      assistantImages ? JSON.stringify(assistantImages) : null,
      toolMessages,
      messageId,
      thread.id,
    );
  if (!info.changes) return null;
  updateThreadSummary(thread.id, content, "reply", now);
  return getMessageById(messageId);
}

const DEFAULT_CONTEXT_BUDGET_TOKENS = 128 * 1024;
const HISTORY_ROW_CAP = 8000;
const CONTEXT_TRIGGER_MARGIN_TOKENS = 5000;

function estimateHistoryRowTokens(content: string, toolMessages: string | null): number {
  const text = `${content || ""}${toolMessages || ""}`;
  if (!text) return 1;
  const chars = text.length;
  const bytes = Buffer.byteLength(text, "utf8");
  const cjk = Math.max(0, Math.floor((bytes - chars) / 2));
  const other = Math.max(0, chars - cjk);
  return Math.max(1, cjk + Math.floor(other / 4));
}

/**
 * Load the prompt history for a thread.
 *
 * Preferred path (M4): a committed `conversation_anchors` row supplies a system
 * summary; the raw tail starts after `covered_at` and is filled newest-first up
 * to the token budget (上下文大小). Without an anchor the legacy
 * `llm_anchor_message_id` window remains as a compatibility fallback.
 */
export function loadThreadHistory(
  threadId: number,
  options: LoadThreadHistoryOptions = {},
): ThreadContext {
  const db = getDb();
  const thread = db
    .prepare("SELECT agent_id, user_id FROM chat_threads WHERE id = ?")
    .get(threadId) as { agent_id: number; user_id: string } | undefined;
  if (!thread) return { anchor: null, messages: [], usedTokens: 0 };

  const budgetTokens =
    Number(options.budgetTokens) > 0 ? Number(options.budgetTokens) : DEFAULT_CONTEXT_BUDGET_TOKENS;
  const fillCeiling = Math.max(1, budgetTokens - CONTEXT_TRIGGER_MARGIN_TOKENS);

  const rawAnchor = db
    .prepare("SELECT * FROM conversation_anchors WHERE agent_id = ? AND user_id = ?")
    .get(thread.agent_id, thread.user_id) as
    | {
        summary: string;
        covered_at: string;
        covered_message_id: number | null;
        updated_at: string;
      }
    | undefined;

  let anchor: ThreadAnchorContext | null = null;
  let coveredAt = "";
  let coveredMessageId = 0;
  if (rawAnchor && String(rawAnchor.summary || "").trim() && String(rawAnchor.covered_at || "").trim()) {
    // The anchor is keyed by the whole private scope (agent_id + user_id), so
    // "the rows it covers" means every private message of the scope — not just
    // this thread. Desktop keeps one thread per scope (UNIQUE(user_id,
    // agent_id)), and the front-end keeps rendering this thread's raw tail:
    // after the anchor, only this thread's rows after covered_at are replayed.
    // If a scope ever owned several threads, the covered rows could sit in an
    // older thread's segment of chat_messages — the ghost check therefore also
    // looks at the scope, so a cross-thread cut is not mistaken for a ghost and
    // deleted.
    const backed = db
      .prepare(
        `SELECT 1 FROM chat_messages
         WHERE agent_id = ? AND user_id = ? AND created_at <= ? LIMIT 1`,
      )
      .get(thread.agent_id, thread.user_id, rawAnchor.covered_at) as { 1?: number } | undefined;
    if (backed) {
      anchor = {
        summary: String(rawAnchor.summary || "").trim(),
        coveredAt: String(rawAnchor.covered_at || ""),
        coveredMessageId:
          rawAnchor.covered_message_id == null ? null : Number(rawAnchor.covered_message_id) || null,
        updatedAt: String(rawAnchor.updated_at || ""),
      };
      coveredAt = anchor.coveredAt;
      coveredMessageId = Number(anchor.coveredMessageId || 0) || 0;
    } else {
      // Ghost anchor: the messages it claims to cover are gone (thread cleared
      // or imported DB lost the rows). Drop it instead of hiding the whole tail.
      db.prepare("DELETE FROM conversation_anchors WHERE agent_id = ? AND user_id = ?").run(
        thread.agent_id,
        thread.user_id,
      );
      invalidateSelfPortraitBlockCache(thread.agent_id, thread.user_id);
    }
  }

  const clauses = ["thread_id = ?", "role IN ('user', 'assistant')"];
  const args: unknown[] = [threadId];
  // Raw tail stays per-thread on purpose: the GUI renders one conversation. The
  // anchor cut itself is scope-wide (see above); if the scope ever owned several
  // threads, each thread would replay only its own rows after the same cut and
  // the summary carries whatever the compaction merged from the whole scope.
  if (coveredAt) {
    clauses.push("(created_at > ? OR (created_at = ? AND id > ?))");
    args.push(coveredAt, coveredAt, coveredMessageId);
  } else {
    // Compatibility fallback for databases written before conversation anchors:
    // honor the old cut if it exists. Do not move it forward here — the token
    // budget below is the only row limit.
    const legacy = db
      .prepare("SELECT llm_anchor_message_id FROM chat_threads WHERE id = ?")
      .get(threadId) as { llm_anchor_message_id: number | null } | undefined;
    const legacyAnchor = Number(legacy?.llm_anchor_message_id || 0) || 0;
    if (legacyAnchor > 0) {
      clauses.push("id >= ?");
      args.push(legacyAnchor);
    }
  }

  const rows = db
    .prepare(
      `SELECT id, role, content, user_images_json, assistant_images_json, tool_messages_json,
              llm_content, created_at
       FROM chat_messages
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...args, HISTORY_ROW_CAP) as (Pick<
    ChatMessageRow,
    "id" | "role" | "content" | "user_images_json" | "assistant_images_json"
  > & {
    tool_messages_json: string | null;
    llm_content: string | null;
    created_at: string;
  })[];

  // Newest-first fill; stop before the oldest row that would cross the ceiling.
  // At least one row is kept so a single huge message cannot empty the window.
  const selected: typeof rows = [];
  let usedTokens = 0;
  for (const row of rows) {
    const rowTokens = estimateHistoryRowTokens(row.content, row.tool_messages_json);
    if (selected.length > 0 && usedTokens + rowTokens > fillCeiling) break;
    selected.push(row);
    usedTokens += rowTokens;
  }
  selected.reverse();

  const history: HistoryMessage[] = [];
  for (const row of selected) {
    if (row.role === "user") {
      // Replay exactly what was sent last time; fall back to rebuilding it
      // for rows written before the column existed.
      const stored = (row.llm_content || "").trim();
      const text = stored
        ? stored
        : userMessageForLlm(row.content, parseImages(parseJson(row.user_images_json, [])));
      if (text) history.push({ role: "user", content: text });
    } else if (row.role === "assistant") {
      // Replay the tool exchange first, exactly as it was sent: the assistant
      // message with its `tool_calls`, then the matching tool results. The
      // final reply of the turn follows. Skipping this changes the request
      // prefix and breaks the provider's prompt cache.
      for (const message of parseToolRoundTrip(parseJson(row.tool_messages_json, []))) {
        history.push(message as HistoryMessage);
      }
      const text = assistantMessageWithPhotosForLlm(
        row.content,
        parseImages(parseJson(row.assistant_images_json, [])),
      );
      if (text) history.push({ role: "assistant", content: text });
    }
  }
  return { anchor, messages: history, usedTokens };
}

export function buildTurnHistoryItem(
  assistant: ChatMessageRow,
  user: ChatMessageRow | undefined,
): ChatTurnHistoryItem {
  const userImages = parseImages(parseJson(user?.user_images_json ?? null, []));
  const assistantImages = parseImages(parseJson(assistant.assistant_images_json, [])).map(
    (image) => ({ ...image, summaryText: undefined }),
  );
  const retrievedFacts = parseJson<Record<string, unknown> | null>(
    assistant.retrieved_facts,
    null,
  );
  return {
    id: assistant.id,
    userMessage: user ? userMessageForDisplay(user.content, userImages) : null,
    assistantMessage: assistant.content || "",
    status: assistant.status || "completed",
    errorMessage: assistant.error_message,
    timestamp: assistant.created_at,
    taskId: assistant.task_id,
    userImages,
    assistantImages,
    input:
      retrievedFacts && typeof retrievedFacts.input === "object"
        ? (retrievedFacts.input as Record<string, unknown>)
        : null,
    retrievedFacts,
    role: assistant.role,
    messageKind: assistant.message_kind,
  };
}

export function listTurns(
  threadId: number,
  size: number,
  beforeTurnId?: number | null,
): ChatTurnHistoryItem[] | null {
  const db = getDb();
  const limit = Math.max(1, Math.min(size, 200));

  if (beforeTurnId) {
    const cursor = db
      .prepare("SELECT id, thread_id FROM chat_messages WHERE id = ?")
      .get(beforeTurnId) as { id: number; thread_id: number } | undefined;
    if (!cursor || cursor.thread_id !== threadId) return null;
  }

  const pairRows = db
    .prepare(
      `SELECT COALESCE(turn_pair_id, id) AS pair_key, MAX(id) AS last_id
       FROM chat_messages
       WHERE thread_id = ? AND role = 'assistant'
         ${beforeTurnId ? "AND id < ?" : ""}
       GROUP BY COALESCE(turn_pair_id, id)
       ORDER BY last_id DESC
       LIMIT ?`,
    )
    .all(...(beforeTurnId ? [threadId, beforeTurnId, limit] : [threadId, limit])) as {
    pair_key: number;
    last_id: number;
  }[];
  if (!pairRows.length) return [];

  const pairKeys = pairRows.map((row) => row.pair_key);
  const placeholders = pairKeys.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE thread_id = ? AND COALESCE(turn_pair_id, id) IN (${placeholders})
       ORDER BY id ASC`,
    )
    .all(threadId, ...pairKeys) as ChatMessageRow[];

  const usersById = new Map<number, ChatMessageRow>();
  const assistantsByPair = new Map<number, ChatMessageRow[]>();
  for (const row of rows) {
    if (row.role === "user") usersById.set(row.id, row);
    if (row.role === "assistant") {
      const key = row.turn_pair_id || row.id;
      const list = assistantsByPair.get(key) || [];
      list.push(row);
      assistantsByPair.set(key, list);
    }
  }

  const items: ChatTurnHistoryItem[] = [];
  for (const pairKey of pairKeys) {
    const assistants = assistantsByPair.get(pairKey);
    if (!assistants?.length) continue;
    const anchor = assistants[0];
    const user = anchor.reply_to_message_id
      ? usersById.get(anchor.reply_to_message_id)
      : undefined;
    items.push(buildTurnHistoryItem(anchor, user));
  }

  const systemRows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE thread_id = ? AND role = 'system'
       ORDER BY id ASC`,
    )
    .all(threadId) as ChatMessageRow[];
  for (const row of systemRows) {
    items.push({
      id: row.id,
      userMessage: null,
      assistantMessage: row.content || "",
      status: "completed",
      errorMessage: null,
      timestamp: row.created_at,
      taskId: null,
      userImages: [],
      assistantImages: [],
      input: null,
      retrievedFacts: null,
      role: "system",
      messageKind: row.message_kind,
    });
  }

  items.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return items;
}

export function getFirstAssistantMessage(threadId: number): ChatMessageRow | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM chat_messages WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get(threadId) as ChatMessageRow | undefined;
  return row ?? null;
}

export function getMessageById(id: number): ChatMessageRow | null {
  const row = getDb().prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as
    | ChatMessageRow
    | undefined;
  return row ?? null;
}

export function appendAssistantOnly(
  thread: ChatThreadRow,
  content: string,
  messageKind = "greeting",
  inputMetadata: Record<string, unknown> | null = null,
): ChatMessageRow {
  const db = getDb();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_messages
        (thread_id, user_id, agent_id, role, message_kind, content, input_metadata,
         assistant_read_at, status, created_at, completed_at)
       VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, 'completed', ?, ?)`,
    )
    .run(
      thread.id,
      normalizeUserId(thread.user_id),
      thread.agent_id,
      messageKind,
      (content || "").trim(),
      inputMetadata ? JSON.stringify(inputMetadata) : null,
      now,
      now,
      now,
    );
  updateThreadSummary(thread.id, (content || "").trim(), messageKind, now);
  return getMessageById(Number(info.lastInsertRowid))!;
}

export function appendSystemMessage(
  thread: ChatThreadRow,
  content: string,
  messageKind = "system_event",
  inputMetadata: Record<string, unknown> | null = null,
): ChatMessageRow {
  const db = getDb();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_messages
        (thread_id, user_id, agent_id, role, message_kind, content, input_metadata, status, created_at, completed_at)
       VALUES (?, ?, ?, 'system', ?, ?, ?, 'completed', ?, ?)`,
    )
    .run(
      thread.id,
      normalizeUserId(thread.user_id),
      thread.agent_id,
      messageKind,
      (content || "").trim(),
      inputMetadata ? JSON.stringify(inputMetadata) : null,
      now,
      now,
    );
  updateThreadSummary(thread.id, (content || "").trim(), messageKind, now);
  return getMessageById(Number(info.lastInsertRowid))!;
}

export function deleteThreadRecords(threadId: number): number {
  const db = getDb();
  const thread = db
    .prepare("SELECT agent_id, user_id FROM chat_threads WHERE id = ?")
    .get(threadId) as { agent_id: number; user_id: string } | undefined;
  const count = db
    .prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE thread_id = ?")
    .get(threadId) as { c: number };
  const deleteTx = db.transaction(() => {
    db.prepare(
      "DELETE FROM task_events WHERE task_id IN (SELECT task_id FROM task_runs WHERE thread_id = ?)",
    ).run(threadId);
    db.prepare("DELETE FROM task_checkpoints WHERE task_id IN (SELECT task_id FROM task_runs WHERE thread_id = ?)").run(threadId);
    db.prepare("DELETE FROM task_runs WHERE thread_id = ?").run(threadId);
    db.prepare("DELETE FROM chat_messages WHERE thread_id = ?").run(threadId);
    db.prepare("DELETE FROM chat_threads WHERE id = ?").run(threadId);
    if (thread) {
      db.prepare("DELETE FROM conversation_anchors WHERE agent_id = ? AND user_id = ?").run(
        thread.agent_id,
        thread.user_id,
      );
      // The recorded usage describes the deleted request history; the fresh
      // thread must re-measure from the next reported request.
      forgetChatUsage(memoryScope(thread.agent_id, thread.user_id));
    }
  });
  deleteTx();
  if (thread) invalidateSelfPortraitBlockCache(thread.agent_id, thread.user_id);
  return Number(count.c || 0);
}

export function clearThreadHistory(threadId: number): number {
  const db = getDb();
  const thread = db
    .prepare("SELECT agent_id, user_id FROM chat_threads WHERE id = ?")
    .get(threadId) as { agent_id: number; user_id: string } | undefined;
  const count = db
    .prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE thread_id = ?")
    .get(threadId) as { c: number };
  const tx = db.transaction(() => {
    db.prepare(
      "DELETE FROM task_events WHERE task_id IN (SELECT task_id FROM task_runs WHERE thread_id = ?)",
    ).run(threadId);
    db.prepare("DELETE FROM task_checkpoints WHERE task_id IN (SELECT task_id FROM task_runs WHERE thread_id = ?)").run(threadId);
    db.prepare("DELETE FROM task_runs WHERE thread_id = ?").run(threadId);
    db.prepare("DELETE FROM chat_messages WHERE thread_id = ?").run(threadId);
    if (thread) {
      // A cleared conversation has no covered history left; the summary and the
      // self portrait it produced must not leak into the fresh thread.
      db.prepare("DELETE FROM conversation_anchors WHERE agent_id = ? AND user_id = ?").run(
        thread.agent_id,
        thread.user_id,
      );
      // Same for the usage signal: it described the cleared request history.
      forgetChatUsage(memoryScope(thread.agent_id, thread.user_id));
    }
    db.prepare(
      `UPDATE chat_threads SET last_message_text = NULL, last_message_at = NULL,
        last_message_kind = NULL, unread_count = 0, pending_task_context = NULL,
        llm_anchor_message_id = NULL,
        updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), threadId);
  });
  tx();
  if (thread) invalidateSelfPortraitBlockCache(thread.agent_id, thread.user_id);
  return Number(count.c || 0);
}

export interface DeleteScope {
  /** Every message that goes away: the selected ones plus their paired turn. */
  messages: ChatMessageRow[];
  /** Ids of the assistant messages in the scope — the recall-trace / snapshot key. */
  assistantIds: number[];
}

/**
 * Group the messages of a thread into user/assistant pairs.
 *
 * A turn is one exchange: the user message and the assistant reply that
 * answers it. Deleting one half of a turn leaves a dangling half behind
 * (an orphan reply that no user message introduced, or a user message the
 * agent never answered), so the whole pair has to go.
 */
function groupThreadMessages(threadId: number): Map<number, ChatMessageRow[]> {
  const rows = getDb()
    .prepare("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id ASC")
    .all(threadId) as ChatMessageRow[];
  const assistantsByUser = new Map<number, number>();
  for (const row of rows) {
    if (row.role === "assistant" && row.reply_to_message_id) {
      assistantsByUser.set(Number(row.reply_to_message_id), Number(row.turn_pair_id || row.id));
    }
  }
  const groups = new Map<number, ChatMessageRow[]>();
  for (const row of rows) {
    let key: number | null = null;
    if (row.role === "assistant") {
      key = Number(row.turn_pair_id || row.id);
    } else if (row.role === "user") {
      key =
        row.turn_pair_id != null
          ? Number(row.turn_pair_id)
          : (assistantsByUser.get(Number(row.id)) ?? null);
    }
    // System messages carry no turn pair and are not part of any exchange.
    if (key === null) continue;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Expand the selected ids to the full turns they belong to.
 */
export function resolveDeleteScope(threadId: number, messageIds: number[]): DeleteScope {
  const selected = new Set(
    messageIds.filter((id) => Number.isInteger(id) && id > 0).map((id) => Number(id)),
  );
  if (!selected.size) return { messages: [], assistantIds: [] };
  const groups = groupThreadMessages(threadId);
  const messages: ChatMessageRow[] = [];
  for (const group of groups.values()) {
    if (!group.some((row) => selected.has(Number(row.id)))) continue;
    messages.push(...group);
  }
  const assistantIds = messages
    .filter((row) => row.role === "assistant")
    .map((row) => Number(row.id));
  return { messages, assistantIds };
}

interface AffectedStream {
  id: string;
  narrative: string;
  rawStart: number | null;
  rawEnd: number | null;
}

/**
 * A stream covers the turns between `raw_start` and `raw_end`, so it is
 * affected when that range touches one of the deleted assistant turns.
 */
function streamOverlapsTurns(
  rawStart: number | null,
  rawEnd: number | null,
  assistantIds: Set<number>,
): boolean {
  if (!assistantIds.size) return false;
  if (rawStart != null && assistantIds.has(rawStart)) return true;
  if (rawEnd != null && assistantIds.has(rawEnd)) return true;
  if (rawStart != null && rawEnd != null) {
    const low = Math.min(Number(rawStart), Number(rawEnd));
    const high = Math.max(Number(rawStart), Number(rawEnd));
    for (const id of assistantIds) {
      if (id >= low && id <= high) return true;
    }
  }
  return false;
}

function findAffectedStreams(
  agentId: number,
  userId: string,
  assistantIds: number[],
): AffectedStream[] {
  if (!assistantIds.length) return [];
  const ids = new Set(assistantIds.map((id) => Number(id)));
  const rows = getDb()
    .prepare(
      `SELECT id, narrative, raw_start, raw_end FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND archived = 0
         AND COALESCE(origin_scope, '') <> 'group_public'
       ORDER BY created_at DESC LIMIT 2000`,
    )
    .all(agentId, userId) as {
    id: string;
    narrative: string;
    raw_start: number | null;
    raw_end: number | null;
  }[];
  return rows
    .filter((row) => streamOverlapsTurns(row.raw_start, row.raw_end, ids))
    .map((row) => ({
      id: row.id,
      narrative: row.narrative || "",
      rawStart: row.raw_start ?? null,
      rawEnd: row.raw_end ?? null,
    }));
}

/**
 * Remove a stream together with the edges that pointed at it — otherwise the
 * graph keeps dangling references to a stream that no longer exists.
 */
function deleteStreamRow(agentId: number, userId: string, streamId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM hippocampus_streams WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(streamId, agentId, userId);
  if (!row) return false;
  db.prepare(
    `DELETE FROM hippocampus_edges
     WHERE (source_id = ? OR target_id = ?) AND edge_type IN ('AKIN', 'EVOKES')`,
  ).run(streamId, streamId);
  db.prepare("DELETE FROM hippocampus_streams WHERE id = ?").run(streamId);
  try {
    db.prepare("DELETE FROM stream_vec WHERE stream_id = ?").run(streamId);
  } catch {
    // the vector index is optional
  }
  return true;
}

/**
 * Refresh the thread preview so the conversation list shows the newest
 * surviving message instead of the one that was just deleted.
 */
function refreshThreadSummary(threadId: number) {
  const db = getDb();
  const now = new Date().toISOString();
  const last = db
    .prepare(
      `SELECT id, content, message_kind, created_at FROM chat_messages
       WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(threadId) as
    | { id: number; content: string; message_kind: string; created_at: string }
    | undefined;
  if (!last) {
    db.prepare(
      `UPDATE chat_threads SET last_message_text = NULL, last_message_at = NULL,
        last_message_kind = NULL, unread_count = 0, updated_at = ?
       WHERE id = ?`,
    ).run(now, threadId);
    return;
  }
  db.prepare(
    `UPDATE chat_threads SET last_message_text = ?, last_message_at = ?, last_message_kind = ?,
      updated_at = ? WHERE id = ?`,
  ).run(last.content || "", last.created_at, last.message_kind, now, threadId);
}

export interface DeleteMessagesOptions {
  agentId: number;
  userId: string;
  includeMemory?: boolean;
}

export interface DeleteMessagesResult {
  deletedMessages: number;
  deletedStreams: number;
  memoryDeleted: boolean;
}

export function deleteMessages(
  threadId: number,
  messageIds: number[],
  options: DeleteMessagesOptions,
): DeleteMessagesResult {
  const db = getDb();
  const scope = resolveDeleteScope(threadId, messageIds);
  if (!scope.messages.length) {
    return { deletedMessages: 0, deletedStreams: 0, memoryDeleted: false };
  }
  const deleteIds = scope.messages.map((row) => Number(row.id));
  const placeholders = deleteIds.map(() => "?").join(",");
  const includeMemory = options.includeMemory !== false;

  let deletedStreams = 0;
  const tx = db.transaction(() => {
    if (includeMemory && scope.assistantIds.length) {
      const affected = findAffectedStreams(options.agentId, options.userId, scope.assistantIds);
      for (const stream of affected) {
        if (deleteStreamRow(options.agentId, options.userId, stream.id)) deletedStreams += 1;
      }
      const tracePlaceholders = scope.assistantIds.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM hippocampus_recall_traces
         WHERE agent_id = ? AND user_id = ? AND turn_id IN (${tracePlaceholders})`,
      ).run(options.agentId, options.userId, ...scope.assistantIds);
      db.prepare(
        `DELETE FROM hippocampus_affect_points
         WHERE agent_id = ? AND user_id = ? AND turn_id IN (${tracePlaceholders})`,
      ).run(options.agentId, options.userId, ...scope.assistantIds);
      db.prepare(
        `DELETE FROM hippocampus_self_state
         WHERE agent_id = ? AND user_id = ? AND turn_id IN (${tracePlaceholders})`,
      ).run(options.agentId, options.userId, ...scope.assistantIds);
    }

    const taskIds = [
      ...new Set(
        scope.messages.map((row) => row.task_id).filter((taskId): taskId is string => !!taskId),
      ),
    ];
    if (taskIds.length) {
      const taskPlaceholders = taskIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM task_events WHERE task_id IN (${taskPlaceholders})`).run(...taskIds);
      db.prepare(`DELETE FROM task_checkpoints WHERE task_id IN (${taskPlaceholders})`).run(
        ...taskIds,
      );
      db.prepare(
        `DELETE FROM task_runs
         WHERE message_id IN (${placeholders}) OR task_id IN (${taskPlaceholders})`,
      ).run(...deleteIds, ...taskIds);
    }

    db.prepare(`DELETE FROM chat_messages WHERE id IN (${placeholders})`).run(...deleteIds);
    refreshThreadSummary(threadId);
  });
  tx();

  return {
    deletedMessages: deleteIds.length,
    deletedStreams,
    memoryDeleted: includeMemory && Boolean(scope.assistantIds.length),
  };
}

export function messageDeleteImpact(threadId: number, messageIds: number[]) {
  const empty = {
    turnCount: 0,
    messageCount: 0,
    digestedTurnCount: 0,
    streamCount: 0,
    streams: [] as AffectedStream[],
    recallTraceCount: 0,
    hasMemoryAssociation: false,
  };
  if (!messageIds.length) return empty;
  const db = getDb();
  const thread = db
    .prepare("SELECT agent_id, user_id FROM chat_threads WHERE id = ?")
    .get(threadId) as { agent_id: number; user_id: string } | undefined;
  if (!thread) return empty;
  const agentId = Number(thread.agent_id);
  const userId = thread.user_id;

  const scope = resolveDeleteScope(threadId, messageIds);
  if (!scope.messages.length) return empty;

  const turnPairs = new Set<number>();
  let digested = 0;
  for (const row of scope.messages) {
    if (row.role !== "assistant") continue;
    turnPairs.add(Number(row.turn_pair_id || row.id));
    if (row.digested_at) digested += 1;
  }

  // The recall trace is written per assistant turn, not per pair key.
  const traceCount = scope.assistantIds.length
    ? (db
        .prepare(
          `SELECT COUNT(*) AS c FROM hippocampus_recall_traces
           WHERE agent_id = ? AND user_id = ? AND turn_id IN (${scope.assistantIds
             .map(() => "?")
             .join(",")})`,
        )
        .get(agentId, userId, ...scope.assistantIds) as { c: number }).c
    : 0;

  const affectedStreams = findAffectedStreams(agentId, userId, scope.assistantIds);
  const streams = affectedStreams.slice(0, 8).map((stream) => ({
    id: stream.id,
    narrative: (stream.narrative || "").slice(0, 160),
    rawStart: stream.rawStart,
    rawEnd: stream.rawEnd,
  }));

  return {
    turnCount: turnPairs.size,
    messageCount: scope.messages.length,
    digestedTurnCount: digested,
    streamCount: affectedStreams.length,
    streams,
    recallTraceCount: Number(traceCount || 0),
    hasMemoryAssociation:
      digested > 0 || Number(traceCount || 0) > 0 || affectedStreams.length > 0,
  };
}

export function listThreadMessages(
  agentId: number,
  userId: string | null | undefined,
  limit?: number,
): ChatMessageRow[] {
  const db = getDb();
  const sql = `SELECT * FROM chat_messages
    WHERE user_id = ? AND agent_id = ?
    ORDER BY created_at ASC, id ASC
    ${limit ? "LIMIT ?" : ""}`;
  const params: (string | number)[] = [normalizeUserId(userId), agentId];
  if (limit) params.push(Math.max(1, limit));
  return db.prepare(sql).all(...params) as ChatMessageRow[];
}
