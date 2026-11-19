import { getDb } from "../db/sqlite.js";

export const SINGLE_USER_ID = "default_user";

export function normalizeUserId(_userId: string | null | undefined): string {
  return SINGLE_USER_ID;
}

export interface ChatThreadRow {
  id: number;
  user_id: string;
  agent_id: number;
  last_message_text: string | null;
  last_message_at: string | null;
  last_message_kind: string | null;
  unread_count: number;
  last_read_message_id: number | null;
  last_read_at: string | null;
  active_skills: string | null;
  thread_skills: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatInboxItem {
  threadId: number;
  agentId: number;
  userId: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageKind: string | null;
  unreadCount: number;
}

const PROACTIVE_KINDS = ["proactive_outreach", "appointment_reminder", "follow_up"];

export function toInboxItem(thread: ChatThreadRow): ChatInboxItem {
  return {
    threadId: thread.id,
    agentId: thread.agent_id,
    userId: thread.user_id,
    lastMessage: thread.last_message_text,
    lastMessageAt: thread.last_message_at,
    lastMessageKind: thread.last_message_kind,
    unreadCount: thread.unread_count || 0,
  };
}

export function ensureThread(userId: string | null | undefined, agentId: number): ChatThreadRow {
  const db = getDb();
  const normalizedUserId = normalizeUserId(userId);
  const existing = db
    .prepare("SELECT * FROM chat_threads WHERE user_id = ? AND agent_id = ?")
    .get(normalizedUserId, agentId) as ChatThreadRow | undefined;
  if (existing) return existing;

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_threads (user_id, agent_id, unread_count, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    )
    .run(normalizedUserId, agentId, now, now);
  return getThread(Number(info.lastInsertRowid))!;
}

/**
 * 外部渠道（QQ 群）专用：保留原始 user_id 建线程，不归并到 default_user。
 *
 * 一个 QQ 群 = 一个独立线程（user_id = 群会话键），群聊记忆、系统提示词里的
 * 记忆召回都按 (agentId, user_id) 隔离，不会污染私聊历史。
 * 这类线程不会出现在 default_user 的 GUI 收件箱里（inbox 按 user_id 过滤）。
 */
export function ensureExternalThread(rawUserId: string, agentId: number): ChatThreadRow {
  const userId = String(rawUserId || "").trim();
  if (!userId) return ensureThread(SINGLE_USER_ID, agentId);
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM chat_threads WHERE user_id = ? AND agent_id = ?")
    .get(userId, agentId) as ChatThreadRow | undefined;
  if (existing) return existing;
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_threads (user_id, agent_id, unread_count, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    )
    .run(userId, agentId, now, now);
  return getThread(Number(info.lastInsertRowid))!;
}

export function getThread(threadId: number): ChatThreadRow | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(threadId) as
    | ChatThreadRow
    | undefined;
  return row ?? null;
}

export function getThreadForAgent(
  userId: string | null | undefined,
  agentId: number,
): ChatThreadRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM chat_threads WHERE user_id = ? AND agent_id = ?")
    .get(normalizeUserId(userId), agentId) as ChatThreadRow | undefined;
  return row ?? null;
}

export function listInbox(userId: string | null | undefined): ChatThreadRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM chat_threads
       WHERE user_id = ?
       ORDER BY COALESCE(last_message_at, updated_at) DESC, updated_at DESC`,
    )
    .all(normalizeUserId(userId)) as ChatThreadRow[];
}

export function updateThreadSummary(
  threadId: number,
  lastMessageText: string,
  lastMessageKind: string,
  at: string,
) {
  const db = getDb();
  db.prepare(
    `UPDATE chat_threads
     SET last_message_text = ?, last_message_at = ?, last_message_kind = ?, updated_at = ?
     WHERE id = ?`,
  ).run(lastMessageText, at, lastMessageKind, at, threadId);
}

export function recalculateUnreadCount(threadId: number): number {
  const db = getDb();
  const placeholders = PROACTIVE_KINDS.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM chat_messages
       WHERE thread_id = ? AND role = 'assistant'
         AND assistant_read_at IS NULL
         AND message_kind IN (${placeholders})`,
    )
    .get(threadId, ...PROACTIVE_KINDS) as { c: number };
  const count = Number(row?.c || 0);
  db.prepare("UPDATE chat_threads SET unread_count = ? WHERE id = ?").run(count, threadId);
  return count;
}

export function markReadThrough(
  userId: string | null | undefined,
  agentId: number,
  readThroughMessageId: number,
): ChatThreadRow | null {
  const thread = getThreadForAgent(userId, agentId);
  if (!thread) return null;
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE chat_messages SET assistant_read_at = ?
     WHERE thread_id = ? AND role = 'assistant'
       AND id <= ? AND assistant_read_at IS NULL`,
  ).run(now, thread.id, readThroughMessageId);
  db.prepare(
    "UPDATE chat_threads SET last_read_message_id = ?, last_read_at = ?, updated_at = ? WHERE id = ?",
  ).run(readThroughMessageId, now, now, thread.id);
  recalculateUnreadCount(thread.id);
  return getThread(thread.id);
}
