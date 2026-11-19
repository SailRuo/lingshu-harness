import { createHash } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import type { MemoryScope } from "./memoryScope.js";

/**
 * APP-compatible shared relationship continuity.
 *
 * `continuity` used to be forced into the retired desktop "心事线"
 * (`hippocampus_threads` / `hippocampus_touchpoints`). M1 follow-up moves it to
 * the APP's `relationship_threads` / `relationship_thread_nodes` model. These
 * tables are storage-only here: they are not injected into chat prompts and are
 * not rendered by any old MemoryFlowView.
 */

const NODE_EXCERPT_MAX = 500;
const THREAD_TITLE_MAX = 60;
const THREAD_NOTE_MAX = 240;
const CARRY_NOTE_MAX = 160;

export interface RelationshipThreadCandidate {
  id: string;
  title: string;
  summary: string;
  status: string;
  last_at: string;
}

export interface RelationshipContinuityNode {
  index: number;
  messageId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface RelationshipContinuityItem {
  title: string;
  note: string;
  carriesIndex: number;
  carryNote: string;
  nodes: RelationshipContinuityNode[];
}

export interface RelationshipContinuityResult {
  threadsCreated: number;
  threadsUpdated: number;
  nodesWritten: number;
}

function clamp(value: string, max: number): string {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function collapseWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function digest24(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function threadIdFor(agentId: number, userId: string, scopeKey: string): string {
  return `rel-thread-${digest24(`${agentId}|${userId}|${scopeKey}`)}`;
}

function nodeIdFor(threadId: string, messageId: string): string {
  return `rel-node-${digest24(`${threadId}|${messageId}`)}`;
}

export function listRelationshipThreadCandidates(
  scope: MemoryScope,
  limit = 12,
): RelationshipThreadCandidate[] {
  const cap = Math.max(1, Math.min(limit, 50));
  return getDb()
    .prepare(
      `SELECT t.id, t.title, t.summary, t.status, t.last_at
       FROM relationship_threads t
       WHERE t.agent_id = ? AND t.user_id = ?
         AND t.status IN ('active','candidate')
         AND EXISTS (
           SELECT 1 FROM relationship_thread_nodes n
           WHERE n.thread_id = t.id AND n.agent_id = t.agent_id AND n.user_id = t.user_id
         )
       ORDER BY t.last_at DESC, t.id DESC LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, cap) as RelationshipThreadCandidate[];
}

function threadHasUsableEvidence(scope: MemoryScope, threadId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM relationship_threads t
       WHERE t.id = ? AND t.agent_id = ? AND t.user_id = ?
         AND t.status IN ('active','candidate')
         AND EXISTS (
           SELECT 1 FROM relationship_thread_nodes n
           JOIN chat_messages m ON CAST(m.id AS TEXT) = n.message_id
           WHERE n.thread_id = t.id AND n.agent_id = t.agent_id AND n.user_id = t.user_id
         )
       LIMIT 1`,
    )
    .get(threadId, scope.agentId, scope.userId);
  return Boolean(row);
}

/**
 * Apply extractor `continuity` items. Deterministic thread/node ids make a
 * retried digest idempotent. New rows start as `candidate`; only a carried
 * thread with a genuinely later node is promoted to `active`, mirroring APP.
 */
export function applyRelationshipContinuity(
  scope: MemoryScope,
  items: RelationshipContinuityItem[],
  candidates: RelationshipThreadCandidate[],
  batchKey: string,
  guard?: () => boolean,
): RelationshipContinuityResult {
  const result: RelationshipContinuityResult = {
    threadsCreated: 0,
    threadsUpdated: 0,
    nodesWritten: 0,
  };
  if (!items.length) return result;
  const db = getDb();
  const now = new Date().toISOString();

  for (const item of items) {
    if (guard && !guard()) break;
    const title = clamp(item.title, THREAD_TITLE_MAX);
    if (!title) continue;
    const note = clamp(item.note, THREAD_NOTE_MAX);
    const picked = [...item.nodes]
      .filter(
        (node) =>
          Number.isInteger(node.index) &&
          Number(node.messageId) > 0 &&
          String(node.content || "").trim(),
      )
      .sort((left, right) => left.index - right.index);
    if (!picked.length) continue;

    const firstRow = picked[0];
    const lastRow = picked[picked.length - 1];
    const firstMessageId = String(firstRow.messageId);
    const lastMessageId = String(lastRow.messageId);
    const firstAt = firstRow.createdAt || now;
    const lastAt = lastRow.createdAt || now;

    const carries = Number(item.carriesIndex);
    let threadId: string | null = null;
    let carryNote = "";
    if (Number.isInteger(carries) && carries >= 0 && carries < candidates.length) {
      const candidate = candidates[carries];
      if (candidate?.id && threadHasUsableEvidence(scope, candidate.id)) {
        threadId = candidate.id;
        carryNote = clamp(item.carryNote, CARRY_NOTE_MAX);
      }
    }
    const carriedExisting = Boolean(threadId);
    let newThread = false;
    if (!threadId) {
      threadId = threadIdFor(scope.agentId, scope.userId, firstMessageId);
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO relationship_threads
            (id, agent_id, user_id, title, summary, status, first_message_id, first_at,
             last_message_id, last_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          scope.agentId,
          scope.userId,
          title,
          note,
          firstMessageId,
          firstAt,
          lastMessageId,
          lastAt,
          now,
          now,
        );
      newThread = info.changes > 0;
    }

    let addedNodes = 0;
    let carryAssigned = false;
    for (const node of picked) {
      if (guard && !guard()) break;
      const messageId = String(node.messageId);
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO relationship_thread_nodes
            (id, thread_id, agent_id, user_id, message_id, role, excerpt, occurred_at,
             carry_note, batch_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nodeIdFor(threadId!, messageId),
          threadId,
          scope.agentId,
          scope.userId,
          messageId,
          node.role,
          clamp(collapseWhitespace(node.content), NODE_EXCERPT_MAX),
          node.createdAt || now,
          carryAssigned ? "" : carryNote,
          batchKey,
          now,
        );
      if (info.changes > 0) {
        addedNodes += 1;
        carryAssigned = true;
      }
    }
    if (addedNodes === 0 && newThread) continue;

    const existing = db
      .prepare("SELECT last_at FROM relationship_threads WHERE id = ? AND agent_id = ? AND user_id = ?")
      .get(threadId, scope.agentId, scope.userId) as { last_at?: string } | undefined;
    const existingLast = String(existing?.last_at || "");
    const hasLaterEvidence = addedNodes > 0 && (!existingLast || lastAt >= existingLast);
    const update = db
      .prepare(
        `UPDATE relationship_threads
         SET summary = ?, updated_at = ?,
             status = CASE WHEN ? = 1 THEN 'active' ELSE status END,
             last_message_id = CASE WHEN ? = 1 THEN ? ELSE last_message_id END,
             last_at = CASE WHEN ? = 1 THEN ? ELSE last_at END
         WHERE id = ? AND agent_id = ? AND user_id = ?`,
      )
      .run(
        note,
        now,
        carriedExisting && hasLaterEvidence ? 1 : 0,
        !existingLast || lastAt >= existingLast ? 1 : 0,
        lastMessageId,
        !existingLast || lastAt >= existingLast ? 1 : 0,
        lastAt,
        threadId,
        scope.agentId,
        scope.userId,
      );
    result.threadsCreated += newThread ? 1 : 0;
    result.threadsUpdated += newThread ? 0 : update.changes > 0 ? 1 : 0;
    result.nodesWritten += addedNodes;
  }
  return result;
}
