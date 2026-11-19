import { createHash } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { embedText, storeStreamEmbedding } from "./embeddingService.js";
import { logTick, memoryScope } from "./memoryScope.js";
import { linkStreamToExistingMemory, requestDigestJson } from "./memoryService.js";
import {
  advanceGroupDigestCursor,
  listGroupIdsWithRecentMessages,
  listGroupMembers,
  listGroupMessagesAfterCursor,
  readGroupDigestCursor,
  readGroupUserIdentity,
} from "./groupChatRepository.js";
import type { GroupMember, GroupMessage } from "./groupChatTypes.js";

/**
 * Group members digest the public event stream 90 seconds after a group falls
 * quiet. Each member writes only its own `hippocampus_streams` rows:
 *
 *   type='group_presence'
 *   origin_scope='group_public'
 *   origin_group_session_id=<group>
 *   participants_json=[...]
 *
 * The digest never writes facts, constraints, seeds or user portraits. Those
 * tables feed the private user impression / daily window pipeline and must not
 * learn from a public group event.
 */
export const GROUP_DIGEST_IDLE_MS = Math.max(
  1_000,
  Number(process.env.LINGSHU_GROUP_DIGEST_DELAY_MS || 90_000),
);
const GROUP_DIGEST_BATCH_LIMIT = 24;
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface PresenceStreamItem {
  narrative?: unknown;
  about?: unknown;
  perspective?: unknown;
}

interface PresenceDigestResult {
  streams?: PresenceStreamItem[];
}

type DigestComplete = (system: string, human: string) => Promise<PresenceDigestResult>;
type DigestEmbed = (text: string) => Promise<number[]>;

export interface DigestOptions {
  complete?: DigestComplete;
  embed?: DigestEmbed;
}

const pendingTimers = new Map<string, NodeJS.Timeout>();
const digesting = new Set<string>();

/**
 * Deterministic stream id from the batch range + model output index, mirroring
 * the private digest (`digest-stream-*`). The cursor only advances after the
 * whole batch is written, so a crash between insert and cursor advance would
 * otherwise re-digest the same batch on the next run — with random ids that
 * retry duplicated every presence stream.
 */
function createId(groupId: string, agentId: number, batchKey: string, index: number) {
  const key = `${groupId}:${agentId}:${batchKey}:${index}`;
  return `group-presence-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function normalizePerspective(value: unknown): "me" | "ta" | "us" | "everyone" {
  const perspective = String(value || "").trim();
  return perspective === "me" || perspective === "ta" || perspective === "us" || perspective === "everyone"
    ? perspective
    : "everyone";
}

function speakerLine(message: GroupMessage, members: GroupMember[], selfAgentId: number, userLabel: string) {
  const names = new Map(
    members.map((member) => [member.agentId, member.displayName || member.name] as const),
  );
  if (message.speakerType === "system") return `系统：${message.content}`;
  if (message.speakerType === "user") return `${userLabel}：${message.content}`;
  const id = Number(message.speakerId);
  const name = names.get(id) || `成员${message.speakerId}`;
  if (id === selfAgentId) return `${name}（我）：${message.content}`;
  return `${name}：${message.content}`;
}

function buildPresenceDigestPrompt(input: {
  members: GroupMember[];
  self: GroupMember;
  userLabel: string;
  messages: GroupMessage[];
}) {
  const selfName = input.self.displayName || input.self.name;
  const others = input.members.filter((member) => member.agentId !== input.self.agentId);
  const participantLines = [
    `- ${input.userLabel}（真实用户）`,
    `- ${selfName}（我 / 当前消化主体）`,
    ...others.map((member) => `- ${member.displayName || member.name}（同场其他成员）`),
  ];
  const system = [
    `你在为「${selfName}」消化它亲身在场的公开群聊经历，写入该智能体自己的长期记忆。`,
    `在场名单：\n${participantLines.join("\n")}`,
    `对话里「${selfName}（我）：」是该智能体自己的发言；「${input.userLabel}：」是真实用户；其余名字是同场其他成员。`,
    "只抽取未来仍值得记得的共同经历；没有长期价值时 streams 返回空数组。",
    "每条记忆必须返回 perspective，只能是 me|ta|us|everyone：me=我公开说过、做过或被直接卷入后的立场；ta=我亲眼看见用户或其他成员的可核对言行，可写“我当时觉得/注意到”；us=我与用户的直接互动；everyone=没有个人落点时才保留的中性共同事件。优先 me/ta/us，不要为了完整复述全群而滥用 everyone。",
    "优先保留：用户如何把成员放到同一个公开场、成员第一次怎样接上话、某次公开互动如何形成气氛/误会/默契/新话题。不要把整晚压成话题摘要。",
    "严禁捏造未公开的内心、私下经历或动机。其他成员的话不能写成我说过；我的观察必须能从原文找到依据。",
    "按独立事件拆分，最多 4 条；每条 narrative 写 60~180 字，含关键参与者和明确结果/我方位置。相邻条目不能只是换句话重述。",
    "这是“我自己见证过这件公开事件”的记忆，不是全群会议纪要，也不是共享群记忆。",
    "绝对不得写画像、事实、约束、约定或人格种子；只返回 streams。",
    '只返回 JSON：{"streams":[{"narrative":"...","about":"...","perspective":"me|ta|us|everyone"}]}',
  ].join("\n");
  const transcript = input.messages
    .map((message) => speakerLine(message, input.members, input.self.agentId, input.userLabel))
    .join("\n");
  const human = [
    `本轮公开群聊原文（说话人已用真实名字标注；「${selfName}（我）」=当前消化主体）：`,
    transcript,
  ].join("\n\n");
  return { system, human };
}

async function digestGroupForAgent(
  groupId: string,
  agentId: number,
  members: GroupMember[],
  options: DigestOptions,
): Promise<{ written: number; lastMessageId: string | null }> {
  const cursor = readGroupDigestCursor(groupId, agentId);
  const messages = listGroupMessagesAfterCursor(groupId, cursor, GROUP_DIGEST_BATCH_LIMIT);
  if (!messages.length) return { written: 0, lastMessageId: cursor.lastMessageId };
  const self = members.find((member) => member.agentId === agentId);
  if (!self) throw new Error(`群成员 ${agentId} 不在群 ${groupId} 中`);
  const identity = readGroupUserIdentity();
  const { system, human } = buildPresenceDigestPrompt({
    members,
    self,
    userLabel: identity.name,
    messages,
  });
  const complete: DigestComplete =
    options.complete ||
    ((systemPrompt, humanPrompt) =>
      requestDigestJson(systemPrompt, humanPrompt, {
        temperature: 0.1,
        retries: 1,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            streams: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  narrative: { type: "string" },
                  about: { type: "string" },
                  perspective: { type: "string", enum: ["me", "ta", "us", "everyone"] },
                },
                required: ["narrative", "about", "perspective"],
              },
            },
          },
          required: ["streams"],
        },
      }) as Promise<PresenceDigestResult>);
  const embed: DigestEmbed =
    options.embed || (async (text: string) => (await embedText(text, { wait: true })).vector);
  const result = await complete(system, human);
  const items = Array.isArray(result?.streams) ? result.streams : [];
  const participantIds = new Set<number>([
    ...members.filter((member) => member.status === "active").map((member) => member.agentId),
    ...messages
      .filter((message) => message.speakerType === "assistant")
      .map((message) => Number(message.speakerId))
      .filter((id) => Number.isInteger(id) && id > 0),
  ]);
  const participantsJson = JSON.stringify([
    `user:default_user:${identity.name}`,
    ...members
      .filter((member) => participantIds.has(member.agentId))
      .map((member) => `agent:${member.agentId}:${member.displayName || member.name}`),
  ]);
  const db = getDb();
  const first = messages[0];
  const last = messages[messages.length - 1];
  const rawStart = Number.isFinite(new Date(first.createdAt).getTime())
    ? new Date(first.createdAt).getTime()
    : null;
  const rawEnd = Number.isFinite(new Date(last.createdAt).getTime())
    ? new Date(last.createdAt).getTime()
    : null;
  const batchKey = `${first.id}:${last.id}`;
  let written = 0;
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    const narrative = String(item?.narrative || "").trim().slice(0, 8000);
    if (!narrative) continue;
    const id = createId(groupId, agentId, batchKey, itemIndex);
    const perspective = normalizePerspective(item?.perspective);
    const about = String(item?.about || "").trim().slice(0, 200) || null;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO hippocampus_streams
        (id, agent_id, user_id, narrative, about, type, raw_start, raw_end,
         revisit_count, significance, archived, origin_scope, perspective,
         origin_group_session_id, participants_json, created_at, updated_at)
       VALUES (?, ?, 'default_user', ?, ?, 'group_presence', ?, ?,
         0, 0.5, 0, 'group_public', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      agentId,
      narrative,
      about,
      rawStart,
      rawEnd,
      perspective,
      groupId,
      participantsJson,
      now,
      now,
    );
    written += 1;
    try {
      const vector = await embed(narrative);
      storeStreamEmbedding(id, vector);
      await linkStreamToExistingMemory(memoryScope(agentId, "default_user"), {
        id,
        narrative,
        vector,
      });
    } catch (error) {
      // A missing embedding model must not erase the memory itself, but the
      // failure has to be visible in the audit log for later repair.
      logTick(
        memoryScope(agentId, "default_user"),
        "group_presence_digest",
        "failed",
        { groupId, streamId: id, stage: "embedding_or_akin" },
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  advanceGroupDigestCursor({
    groupId,
    agentId,
    lastMessageCreatedAt: last.createdAt,
    lastMessageId: last.id,
  });
  return { written, lastMessageId: last.id };
}

/** Each member digests only into its own stream scope. */
export async function digestGroupPresence(
  groupId: string,
  participantAgentIds: number[],
  options: DigestOptions = {},
): Promise<{ agentId: number; written?: number; error?: string }[]> {
  const ids = [...new Set(participantAgentIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  if (digesting.has(groupId)) return [];
  digesting.add(groupId);
  try {
    const members = listGroupMembers(groupId, true);
    const results: { agentId: number; written?: number; error?: string }[] = [];
    for (const agentId of ids) {
      try {
        const result = await digestGroupForAgent(groupId, agentId, members, options);
        results.push({ agentId, written: result.written });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ agentId, error: message });
        logTick(
          memoryScope(agentId, "default_user"),
          "group_presence_digest",
          "failed",
          { groupId, stage: "digest" },
          message,
        );
      }
    }
    return results;
  } finally {
    digesting.delete(groupId);
  }
}

export function scheduleGroupPresenceDigest(groupId: string, participantAgentIds: number[]) {
  const ids = [...new Set(participantAgentIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return;
  const existing = pendingTimers.get(groupId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(groupId);
    void digestGroupPresence(groupId, ids).catch((error) => {
      console.warn("[GROUP_PRESENCE_DIGEST] failed", groupId, error);
    });
  }, GROUP_DIGEST_IDLE_MS);
  timer.unref?.();
  pendingTimers.set(groupId, timer);
}

export function cancelGroupPresenceDigest(groupId: string) {
  const timer = pendingTimers.get(groupId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(groupId);
  }
}

export function groupPresenceDigestState() {
  return {
    idleMs: GROUP_DIGEST_IDLE_MS,
    pending: pendingTimers.size,
    digesting: digesting.size,
  };
}

/**
 * Startup recovery: groups with public messages in the last 24 hours and any
 * member whose digest cursor is behind get another chance. Failures are logged
 * per member, never silently dropped.
 */
export async function recoverGroupPresenceDigests(): Promise<number> {
  const since = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  const groupIds = listGroupIdsWithRecentMessages(since);
  let recovered = 0;
  for (const groupId of groupIds) {
    const members = listGroupMembers(groupId);
    if (!members.length) continue;
    const behind = members.filter((member) => {
      const cursor = readGroupDigestCursor(groupId, member.agentId);
      const latest = getDb()
        .prepare(
          `SELECT id FROM group_messages
           WHERE group_session_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(groupId) as { id: string } | undefined;
      return Boolean(latest?.id && latest.id !== cursor.lastMessageId);
    });
    if (!behind.length) continue;
    recovered += 1;
    await digestGroupPresence(groupId, behind.map((member) => member.agentId));
  }
  return recovered;
}
