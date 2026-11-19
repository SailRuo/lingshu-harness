import { randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { getUserProfile } from "./userService.js";
import type {
  GroupMember,
  GroupMessage,
  GroupSession,
  GroupUserIdentity,
} from "./groupChatTypes.js";

export class GroupChatError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "GroupChatError";
    this.statusCode = statusCode;
  }
}

export const MIN_GROUP_MEMBERS = 2;

function createId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function parseGroupMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapGroupSession(row: any): GroupSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    description: String(row.description ?? ""),
    status: row.status === "archived" ? "archived" : "active",
    unreadCount: Math.max(0, Number(row.unread_count ?? 0)),
    lastMessageText: row.last_message_text ? String(row.last_message_text) : null,
    lastMessageAt: row.last_message_at ? String(row.last_message_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    memberCount: row.member_count === undefined ? undefined : Number(row.member_count ?? 0),
  };
}

function mapGroupMember(row: any): GroupMember {
  return {
    groupSessionId: String(row.group_session_id),
    agentId: Number(row.agent_id),
    status: row.status === "removed" ? "removed" : "active",
    joinedAt: String(row.joined_at),
    updatedAt: String(row.updated_at),
    name: String(row.agent_name || row.name || `成员${row.agent_id}`),
    displayName: String(row.agent_display_name || row.display_name || row.agent_name || `成员${row.agent_id}`),
    avatar: row.agent_avatar ? String(row.agent_avatar) : null,
    color: row.agent_color ? String(row.agent_color) : null,
    roleSetting: String(row.agent_role_setting || ""),
    speakingStyle: String(row.agent_speaking_style || ""),
  };
}

function mapGroupMessage(row: any): GroupMessage {
  const metadataJson = row.metadata_json ? String(row.metadata_json) : null;
  const speakerType =
    row.speaker_type === "assistant" || row.speaker_type === "system" ? row.speaker_type : "user";
  return {
    id: String(row.id),
    groupSessionId: String(row.group_session_id),
    userId: String(row.user_id),
    speakerType,
    speakerId: String(row.speaker_id),
    turnId: String(row.turn_id),
    content: String(row.content ?? ""),
    metadataJson,
    metadata: parseGroupMetadata(metadataJson),
    status:
      row.status === "streaming" || row.status === "error" ? row.status : "completed",
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

export function normalizeMemberAgentIds(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
}

function loadActiveAgents(agentIds: number[]) {
  if (!agentIds.length) return [];
  const placeholders = agentIds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT id, name, display_name, avatar, color, is_active
       FROM agent_configs WHERE id IN (${placeholders})`,
    )
    .all(...agentIds) as {
    id: number;
    name: string;
    display_name: string;
    avatar: string | null;
    color: string | null;
    is_active: number;
  }[];
}

function assertExistingActiveAgents(agentIds: number[], minimum: number) {
  if (agentIds.length < minimum) {
    throw new GroupChatError(400, `群聊至少需要 ${minimum} 位智能体成员`);
  }
  const agents = loadActiveAgents(agentIds);
  if (agents.length !== agentIds.length) {
    throw new GroupChatError(400, "群成员包含不存在的智能体");
  }
  const inactive = agents.filter((agent) => Number(agent.is_active) === 0);
  if (inactive.length) {
    throw new GroupChatError(400, `智能体已停用：${inactive.map((agent) => agent.name).join("、")}`);
  }
  return agents;
}

export function readGroupUserIdentity(userId = "default_user"): GroupUserIdentity {
  const profile = getUserProfile(userId);
  return {
    userId,
    name: (profile.nickname || "").trim() || "用户",
    age: Number(profile.age) || 0,
    gender: (profile.gender || "").trim(),
    bio: (profile.bio || "").trim(),
  };
}

export function renderGroupUserIdentity(identity: GroupUserIdentity): string {
  const lines = [`姓名：${identity.name}`];
  if (identity.age > 0) lines.push(`年龄：${identity.age}`);
  if (identity.gender && identity.gender !== "保密") lines.push(`性别：${identity.gender}`);
  if (identity.bio) lines.push(`身份介绍：${identity.bio}`);
  return lines.join("\n");
}

function insertSystemEvent(input: {
  groupSessionId: string;
  userId: string;
  content: string;
  eventType: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  turnId?: string;
}): GroupMessage {
  return appendGroupMessage({
    groupSessionId: input.groupSessionId,
    userId: input.userId,
    speakerType: "system",
    speakerId: "system",
    turnId: input.turnId || createId("group-event"),
    content: input.content,
    metadataJson: JSON.stringify({ event_type: input.eventType, ...(input.metadata || {}) }),
    status: "completed",
    createdAt: input.createdAt,
  });
}

export function appendGroupMessage(input: {
  groupSessionId: string;
  userId?: string;
  speakerType: GroupMessage["speakerType"];
  speakerId: string;
  turnId: string;
  content: string;
  metadataJson?: string | null;
  status?: GroupMessage["status"];
  id?: string;
  createdAt?: string;
  completedAt?: string | null;
}): GroupMessage {
  const db = getDb();
  const id = input.id || createId("group-message");
  const createdAt = input.createdAt || nowIso();
  const userId = input.userId || "default_user";
  const status = input.status || "completed";
  db.prepare(
    `INSERT INTO group_messages
      (id, group_session_id, user_id, speaker_type, speaker_id, turn_id,
       content, metadata_json, status, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.groupSessionId,
    userId,
    input.speakerType,
    input.speakerId,
    input.turnId,
    input.content,
    input.metadataJson ?? null,
    status,
    createdAt,
    input.completedAt ?? (status === "completed" ? createdAt : null),
  );

  const preview = input.content.trim();
  if (preview) {
    db.prepare(
      `UPDATE group_sessions
       SET last_message_text = ?, last_message_at = ?, updated_at = ?,
           unread_count = unread_count + ?
       WHERE id = ?`,
    ).run(
      preview.slice(0, 200),
      createdAt,
      createdAt,
      input.speakerType === "assistant" && status === "completed" ? 1 : 0,
      input.groupSessionId,
    );
  }
  const row = db.prepare("SELECT * FROM group_messages WHERE id = ?").get(id);
  return mapGroupMessage(row);
}

export function updateGroupMessage(
  messageId: string,
  patch: {
    content?: string;
    status?: GroupMessage["status"];
    metadataJson?: string | null;
    completedAt?: string | null;
  },
) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM group_messages WHERE id = ?").get(messageId) as any;
  if (!existing) return null;
  const content = patch.content ?? String(existing.content ?? "");
  const status = patch.status ?? String(existing.status ?? "completed");
  const completedAt =
    patch.completedAt !== undefined
      ? patch.completedAt
      : status === "completed"
        ? nowIso()
        : existing.completed_at;
  db.prepare(
    `UPDATE group_messages
     SET content = ?, status = ?, metadata_json = ?, completed_at = ?
     WHERE id = ?`,
  ).run(
    content,
    status,
    patch.metadataJson !== undefined ? patch.metadataJson : existing.metadata_json,
    completedAt,
    messageId,
  );
  if (status === "completed" && content.trim()) {
    db.prepare(
      `UPDATE group_sessions
       SET last_message_text = ?, last_message_at = ?, updated_at = ?
       WHERE id = ? AND (last_message_at IS NULL OR last_message_at <= ?)`,
    ).run(content.trim().slice(0, 200), completedAt || nowIso(), nowIso(), existing.group_session_id, existing.created_at);
    if (String(existing.status || "") !== "completed") {
      db.prepare(
        "UPDATE group_sessions SET unread_count = unread_count + 1 WHERE id = ?",
      ).run(existing.group_session_id);
    }
  }
  const row = db.prepare("SELECT * FROM group_messages WHERE id = ?").get(messageId);
  return row ? mapGroupMessage(row) : null;
}

export function deleteGroupMessage(messageId: string) {
  getDb().prepare("DELETE FROM group_messages WHERE id = ?").run(messageId);
}

export function getGroupMessage(messageId: string): GroupMessage | null {
  const row = getDb().prepare("SELECT * FROM group_messages WHERE id = ?").get(messageId);
  return row ? mapGroupMessage(row) : null;
}

export function createGroupSession(input: {
  title: string;
  description?: string;
  memberAgentIds: number[];
  userId?: string;
}): GroupSession {
  const db = getDb();
  const userId = input.userId || "default_user";
  const title = String(input.title || "").trim().slice(0, 60);
  if (!title) throw new GroupChatError(400, "群聊名称不能为空");
  const description = String(input.description || "").trim().slice(0, 240);
  const agentIds = normalizeMemberAgentIds(input.memberAgentIds);
  const agents = assertExistingActiveAgents(agentIds, MIN_GROUP_MEMBERS);
  const id = createId("group");
  const now = nowIso();
  const identity = readGroupUserIdentity(userId);
  const names = agentIds.map((agentId) => {
    const agent = agents.find((item) => Number(item.id) === agentId);
    return String(agent?.display_name || agent?.name || `成员${agentId}`);
  });

  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO group_sessions
        (id, user_id, title, description, status, unread_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 0, ?, ?)`,
    ).run(id, userId, title, description, now, now);
    const insertMember = db.prepare(
      `INSERT INTO group_members (group_session_id, agent_id, status, joined_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    );
    for (const agentId of agentIds) insertMember.run(id, agentId, now, now);
    insertSystemEvent({
      groupSessionId: id,
      userId,
      eventType: "group_created",
      content: `${identity.name}创建了「${title}」，邀请${names.join("、")}加入。`,
      metadata: { participant_agent_ids: agentIds },
      createdAt: now,
    });
  });
  transaction();
  return getGroupSession(id, userId)!;
}

export function listGroupSessions(userId = "default_user"): GroupSession[] {
  const rows = getDb()
    .prepare(
      `SELECT s.*, (
         SELECT COUNT(*) FROM group_members m
         WHERE m.group_session_id = s.id AND m.status = 'active'
       ) AS member_count
       FROM group_sessions s
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY COALESCE(s.last_message_at, s.created_at) DESC, s.created_at DESC`,
    )
    .all(userId) as any[];
  return rows.map(mapGroupSession);
}

export function getGroupSession(groupId: string, userId = "default_user"): GroupSession | null {
  const row = getDb()
    .prepare(
      `SELECT s.*, (
         SELECT COUNT(*) FROM group_members m
         WHERE m.group_session_id = s.id AND m.status = 'active'
       ) AS member_count
       FROM group_sessions s
       WHERE s.id = ? AND s.user_id = ?`,
    )
    .get(groupId, userId) as any;
  return row ? mapGroupSession(row) : null;
}

export function listGroupMembers(groupId: string, includeRemoved = false): GroupMember[] {
  const rows = getDb()
    .prepare(
      `SELECT m.*,
         a.name AS agent_name, a.display_name AS agent_display_name,
         a.avatar AS agent_avatar, a.color AS agent_color,
         a.role_setting AS agent_role_setting, a.speaking_style AS agent_speaking_style
       FROM group_members m
       LEFT JOIN agent_configs a ON a.id = m.agent_id
       WHERE m.group_session_id = ?
         ${includeRemoved ? "" : "AND m.status = 'active'"}
       ORDER BY m.joined_at ASC, m.agent_id ASC`,
    )
    .all(groupId) as any[];
  return rows.map(mapGroupMember);
}

export function addGroupMember(groupId: string, agentId: number, userId = "default_user") {
  const db = getDb();
  const group = getGroupSession(groupId, userId);
  if (!group) throw new GroupChatError(404, "群聊不存在");
  const [agent] = assertExistingActiveAgents([agentId], 1);
  const existing = db
    .prepare("SELECT status FROM group_members WHERE group_session_id = ? AND agent_id = ?")
    .get(groupId, agentId) as { status: string } | undefined;
  if (existing?.status === "active") return { added: false, message: null as GroupMessage | null };
  const now = nowIso();
  const identity = readGroupUserIdentity(userId);
  let message: GroupMessage | null = null;
  db.transaction(() => {
    message = insertSystemEvent({
      groupSessionId: groupId,
      userId,
      eventType: "member_added",
      content: `${identity.name}邀请「${agent.display_name || agent.name}」加入群聊。`,
      metadata: { agent_id: agentId },
      createdAt: now,
    });
    if (existing) {
      db.prepare(
        "UPDATE group_members SET status = 'active', joined_at = ?, updated_at = ? WHERE group_session_id = ? AND agent_id = ?",
      ).run(now, now, groupId, agentId);
    } else {
      db.prepare(
        `INSERT INTO group_members (group_session_id, agent_id, status, joined_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`,
      ).run(groupId, agentId, now, now);
    }
    db.prepare("UPDATE group_sessions SET updated_at = ? WHERE id = ?").run(now, groupId);
  })();
  return { added: true, message };
}

export function removeGroupMember(groupId: string, agentId: number, userId = "default_user") {
  const db = getDb();
  if (!getGroupSession(groupId, userId)) throw new GroupChatError(404, "群聊不存在");
  const members = listGroupMembers(groupId);
  if (!members.some((member) => member.agentId === agentId)) {
    throw new GroupChatError(404, "该成员不在群内");
  }
  if (members.length - 1 < MIN_GROUP_MEMBERS) {
    throw new GroupChatError(400, `群聊至少保留 ${MIN_GROUP_MEMBERS} 位成员；如要解散请直接删除群`);
  }
  const member = members.find((item) => item.agentId === agentId)!;
  const now = nowIso();
  const identity = readGroupUserIdentity(userId);
  db.transaction(() => {
    db.prepare(
      "UPDATE group_members SET status = 'removed', updated_at = ? WHERE group_session_id = ? AND agent_id = ?",
    ).run(now, groupId, agentId);
    insertSystemEvent({
      groupSessionId: groupId,
      userId,
      eventType: "member_removed",
      content: `${identity.name}将「${member.displayName || member.name}」移出了群聊。`,
      metadata: { agent_id: agentId },
      createdAt: now,
    });
    db.prepare("UPDATE group_sessions SET updated_at = ? WHERE id = ?").run(now, groupId);
  })();
  return true;
}

export function updateGroupSession(
  groupId: string,
  patch: { title?: string; description?: string },
  userId = "default_user",
) {
  const db = getDb();
  const group = getGroupSession(groupId, userId);
  if (!group) throw new GroupChatError(404, "群聊不存在");
  const now = nowIso();
  const identity = readGroupUserIdentity(userId);
  const nextTitle = patch.title === undefined ? group.title : String(patch.title).trim().slice(0, 60);
  if (!nextTitle) throw new GroupChatError(400, "群聊名称不能为空");
  const nextDescription =
    patch.description === undefined ? group.description : String(patch.description).trim().slice(0, 240);
  db.transaction(() => {
    db.prepare("UPDATE group_sessions SET title = ?, description = ?, updated_at = ? WHERE id = ?").run(
      nextTitle,
      nextDescription,
      now,
      groupId,
    );
    if (nextTitle !== group.title) {
      insertSystemEvent({
        groupSessionId: groupId,
        userId,
        eventType: "group_renamed",
        content: `${identity.name}将群名称改为「${nextTitle}」。`,
        metadata: { previous_title: group.title, title: nextTitle },
        createdAt: now,
      });
    }
  })();
  return getGroupSession(groupId, userId)!;
}

export function deleteGroupSession(groupId: string, userId = "default_user") {
  const db = getDb();
  if (!getGroupSession(groupId, userId)) throw new GroupChatError(404, "群聊不存在");
  db.transaction(() => {
    const ids = db
      .prepare("SELECT id FROM hippocampus_streams WHERE origin_group_session_id = ?")
      .all(groupId) as { id: string }[];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      try {
        db.prepare(`DELETE FROM stream_vec WHERE stream_id IN (${placeholders})`).run(
          ...ids.map((row) => row.id),
        );
      } catch {
        // sqlite-vec is optional at runtime.
      }
      db.prepare(
        `DELETE FROM hippocampus_edges
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      ).run(...ids.map((row) => row.id), ...ids.map((row) => row.id));
    }
    db.prepare("DELETE FROM hippocampus_streams WHERE origin_group_session_id = ?").run(groupId);
    db.prepare("DELETE FROM group_director_turns WHERE group_session_id = ?").run(groupId);
    db.prepare("DELETE FROM group_digest_state WHERE group_session_id = ?").run(groupId);
    db.prepare("DELETE FROM group_conversation_anchors WHERE group_session_id = ?").run(groupId);
    db.prepare("DELETE FROM group_read_state WHERE group_session_id = ?").run(groupId);
    db.prepare("DELETE FROM group_messages WHERE group_session_id = ?").run(groupId);
    db.prepare("DELETE FROM group_members WHERE group_session_id = ?").run(groupId);
    db.prepare("DELETE FROM group_sessions WHERE id = ?").run(groupId);
  })();
}

export function listRecentGroupMessages(groupId: string, limit = 48): GroupMessage[] {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = getDb()
    .prepare(
      `SELECT * FROM group_messages
       WHERE group_session_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(groupId, capped) as any[];
  return rows.map(mapGroupMessage).reverse();
}

export function listGroupMessagesPage(
  groupId: string,
  options: { limit?: number; beforeMessageId?: string } = {},
): { messages: GroupMessage[]; hasMoreOlder: boolean } {
  const db = getDb();
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
  let beforeClause = "";
  let args: unknown[] = [groupId];
  if (options.beforeMessageId) {
    const cursor = db
      .prepare("SELECT created_at, id FROM group_messages WHERE id = ? AND group_session_id = ?")
      .get(options.beforeMessageId, groupId) as { created_at: string; id: string } | undefined;
    if (!cursor) throw new GroupChatError(404, "分页游标不存在");
    beforeClause = " AND (created_at < ? OR (created_at = ? AND id < ?))";
    args = [groupId, cursor.created_at, cursor.created_at, cursor.id];
  }
  args.push(limit + 1);
  const rows = db
    .prepare(
      `SELECT * FROM group_messages WHERE group_session_id = ?${beforeClause}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...args) as any[];
  const hasMoreOlder = rows.length > limit;
  const page = rows.slice(0, limit).map(mapGroupMessage).reverse();
  return { messages: page, hasMoreOlder };
}

export function markGroupRead(
  groupId: string,
  userId = "default_user",
  lastMessageId?: string | null,
) {
  const db = getDb();
  if (!getGroupSession(groupId, userId)) throw new GroupChatError(404, "群聊不存在");
  let messageId = String(lastMessageId || "").trim() || null;
  if (!messageId) {
    const row = db
      .prepare(
        `SELECT id FROM group_messages WHERE group_session_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(groupId) as { id: string } | undefined;
    messageId = row?.id ?? null;
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO group_read_state
      (group_session_id, user_id, last_read_message_id, last_read_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_session_id, user_id) DO UPDATE SET
       last_read_message_id = excluded.last_read_message_id,
       last_read_at = excluded.last_read_at,
       updated_at = excluded.updated_at`,
  ).run(groupId, userId, messageId, now, now);
  db.prepare("UPDATE group_sessions SET unread_count = 0 WHERE id = ?").run(groupId);
  return { lastReadMessageId: messageId, lastReadAt: now };
}

export function recordDirectorTurn(input: {
  groupId: string;
  turnId: string;
  triggerMessageId: string;
  plan: unknown;
  source: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO group_director_turns
        (id, group_session_id, turn_id, trigger_message_id, plan_json, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      createId("group-director"),
      input.groupId,
      input.turnId,
      input.triggerMessageId,
      JSON.stringify(input.plan),
      input.source,
      nowIso(),
    );
}

export interface GroupDigestCursor {
  lastMessageCreatedAt: string | null;
  lastMessageId: string | null;
}

export function readGroupDigestCursor(groupId: string, agentId: number): GroupDigestCursor {
  const row = getDb()
    .prepare(
      `SELECT last_message_created_at, last_message_id
       FROM group_digest_state WHERE group_session_id = ? AND agent_id = ?`,
    )
    .get(groupId, agentId) as any;
  return {
    lastMessageCreatedAt: row?.last_message_created_at ? String(row.last_message_created_at) : null,
    lastMessageId: row?.last_message_id ? String(row.last_message_id) : null,
  };
}

export function advanceGroupDigestCursor(input: {
  groupId: string;
  agentId: number;
  lastMessageCreatedAt: string;
  lastMessageId: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO group_digest_state
        (group_session_id, agent_id, last_message_created_at, last_message_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(group_session_id, agent_id) DO UPDATE SET
         last_message_created_at = excluded.last_message_created_at,
         last_message_id = excluded.last_message_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.groupId,
      input.agentId,
      input.lastMessageCreatedAt,
      input.lastMessageId,
      nowIso(),
    );
}

export function listGroupMessagesAfterCursor(
  groupId: string,
  cursor: GroupDigestCursor,
  limit: number,
): GroupMessage[] {
  const db = getDb();
  const rows = cursor.lastMessageCreatedAt
    ? db
        .prepare(
          `SELECT * FROM group_messages
           WHERE group_session_id = ?
             AND (created_at > ? OR (created_at = ? AND id > ?))
           ORDER BY created_at ASC, id ASC LIMIT ?`,
        )
        .all(
          groupId,
          cursor.lastMessageCreatedAt,
          cursor.lastMessageCreatedAt,
          cursor.lastMessageId || "",
          Math.max(1, Math.min(50, limit)),
        )
    : db
        .prepare(
          `SELECT * FROM group_messages
           WHERE group_session_id = ?
           ORDER BY created_at ASC, id ASC LIMIT ?`,
        )
        .all(groupId, Math.max(1, Math.min(50, limit)));
  return (rows as any[]).map(mapGroupMessage);
}

export function listGroupIdsWithRecentMessages(sinceIso: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT group_session_id AS id FROM group_messages
       WHERE created_at >= ?
       ORDER BY group_session_id`,
    )
    .all(sinceIso) as { id: string }[];
  return rows.map((row) => String(row.id));
}

export function readGroupAnchor(groupId: string): {
  summary: string;
  coveredMessageId: string;
  coveredAt: string;
  updatedAt: string;
} | null {
  const row = getDb()
    .prepare("SELECT * FROM group_conversation_anchors WHERE group_session_id = ?")
    .get(groupId) as any;
  if (!row?.summary || !row?.covered_message_id) return null;
  return {
    summary: String(row.summary),
    coveredMessageId: String(row.covered_message_id),
    coveredAt: String(row.covered_at),
    updatedAt: String(row.updated_at),
  };
}

export function upsertGroupAnchor(input: {
  groupId: string;
  summary: string;
  coveredMessageId: string;
  coveredAt: string;
}) {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO group_conversation_anchors
        (group_session_id, summary, covered_message_id, covered_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(group_session_id) DO UPDATE SET
         summary = excluded.summary,
         covered_message_id = excluded.covered_message_id,
         covered_at = excluded.covered_at,
         updated_at = excluded.updated_at`,
    )
    .run(input.groupId, input.summary, input.coveredMessageId, input.coveredAt, now);
}
