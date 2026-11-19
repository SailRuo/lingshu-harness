/**
 * QQ 群 ↔ 本地会话的桥（对齐移动端 src/qqbot/groupRoutes.ts + groupBridge.ts）。
 *
 * 与移动端的差异（桌面是常驻 Node 单进程，不需要 iOS 的原生桥）：
 * - openid → 会话键的映射落盘 runtime/qqbot_group_routes.json（移动端落 localStorage / SharedPreferences）；
 * - 群回合不跑导演，改为「点名优先，否则由抢到去重的绑定应答」——桌面没有多角色群聊引擎；
 * - 其余平台规则逐条对齐：群名归并、bot 回声过滤、mentions[].is_you、
 *   被动回复 5 条/msg_id 配额、presence 表 + 有界等待兄弟绑定、绝不代发。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureExternalThread } from "./chatThreadService.js";
import { streamChat } from "./chatStreamService.js";
import { saveProactiveRoute } from "./proactiveRouteService.js";
import { splitForChannelDelivery, stripThinkBlocks } from "./channelDelivery.js";
import { synthesizeText } from "./ttsService.js";
import { prepareOutboundVoice } from "./qqbotAudio.js";
import { getSettings } from "./settingsService.js";
import { createQqBotClient, FILE_TYPE_IMAGE, FILE_TYPE_VOICE, type QQBotClient } from "./qqbotGateway.js";
import { getQqBindingRow, listQqBindingRows } from "./qqbotService.js";
import { decryptSecret } from "./secretStore.js";
import { getRuntimeDir } from "../runtimePaths.js";
import { sessionHub } from "./sessionHub.js";
import { config } from "../config.js";

/** QQ 被动回复：同一个 msg_id 最多 5 条。 */
export const MAX_PASSIVE_REPLIES_PER_MESSAGE = 5;
/** 被动回复窗口：平台限制 5 分钟，presence 也按同样的时间失效。 */
const PRESENCE_TTL_MS = 5 * 60 * 1000;
/** 有界等待兄弟绑定登记 presence（移动端 iOS 800ms / Android 1200ms，取 800ms）。 */
const SIBLING_PRESENCE_WAIT_MS = 800;
const SIBLING_PRESENCE_POLL_MS = 50;
const INBOUND_DEDUPE_TTL_MS = 5 * 60 * 1000;
const GROUP_ROUTE_FILE = path.join(getRuntimeDir(), "qqbot_group_routes.json");
/** 去重/配额键的分隔符（NUL，与移动端 groupBridge 一致）。 */
const SEP = String.fromCharCode(0);

/**
 * 昵称里的噪声：控制字符、零宽字符、BOM、以及 QQ 昵称为空时下发的全角空格 U+3000。
 * 不剥掉的话群里会冒出一堆「　」当作发言人名字。
 * （字符类用 fromCharCode 拼出来，避免在源码里写裸控制字符。）
 */
const NICKNAME_NOISE_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
    `${String.fromCharCode(127)}` +
    `${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}` +
    `${String.fromCharCode(0x2028)}-${String.fromCharCode(0x202e)}` +
    `${String.fromCharCode(0x2060)}${String.fromCharCode(0xfeff)}${String.fromCharCode(0x3000)}]`,
  "g",
);

/* ------------------------------ 群会话映射（按群名归并） ------------------------------ */

/**
 * 群名 → 稳定会话键。`group_openid` 按机器人分配（同一个群两个机器人两个 openid），
 * 只有 `GET /v2/groups/{openid}/info` 的 `group_name` 跨机器人一致，
 * 所以按群名 sha1 归并：`qqgroup-g-<sha1(群名) 前 16 位 hex>`。
 */
function qqGroupSessionKeyByName(name: string): string {
  const digest = crypto.createHash("sha1").update(String(name || ""), "utf8").digest("hex");
  return `qqgroup-g-${digest.slice(0, 16)}`;
}

/** 拿不到群名时的回退：按 openid，一个机器人一个会话（等价旧行为）。 */
function qqGroupFallbackSessionKey(groupOpenid: string): string {
  return `qqgroup-${String(groupOpenid || "").trim().toLowerCase()}`;
}

function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

function readRouteMap(): Record<string, string> {
  try {
    const raw = fs.readFileSync(GROUP_ROUTE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const routes: Record<string, string> = {};
    for (const [openid, sessionId] of Object.entries(parsed || {})) {
      if (typeof sessionId === "string" && sessionId.trim()) routes[openid] = sessionId;
    }
    return routes;
  } catch {
    return {};
  }
}

function writeRoute(groupOpenid: string, sessionKey: string): void {
  try {
    const routes = readRouteMap();
    routes[groupOpenid] = sessionKey;
    fs.writeFileSync(GROUP_ROUTE_FILE, JSON.stringify(routes, null, 2));
  } catch (error) {
    // 映射只用于加速（群改名不拆会话），写失败也能重算。
    console.warn("[QQBot] persist group route failed:", error);
  }
}

/* ------------------------------ 群信息（TTL 缓存 + 失败负缓存） ------------------------------ */

interface QQGroupMeta {
  groupName: string;
  description: string;
  at: number;
}

const META_TTL_MS = 10 * 60 * 1000;
const META_FAILURE_TTL_MS = 5 * 60 * 1000;
const metaCache = new Map<string, QQGroupMeta>();
const metaInflight = new Map<string, Promise<QQGroupMeta>>();
/** 失败只记内存 5 分钟：一次瞬时失败不能把这个群永久钉成「不合并」。 */
const metaFailureAt = new Map<string, number>();

function recentMetaFailure(groupOpenid: string): boolean {
  const at = metaFailureAt.get(groupOpenid);
  if (!at) return false;
  if (Date.now() - at > META_FAILURE_TTL_MS) {
    metaFailureAt.delete(groupOpenid);
    return false;
  }
  return true;
}

async function loadGroupMeta(client: QQBotClient, groupOpenid: string): Promise<QQGroupMeta> {
  const cached = metaCache.get(groupOpenid);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached;
  if (recentMetaFailure(groupOpenid)) {
    return cached ?? { groupName: "", description: "", at: 0 };
  }
  const inflight = metaInflight.get(groupOpenid);
  if (inflight) return inflight;
  const task = (async (): Promise<QQGroupMeta> => {
    try {
      const info = await client.fetchGroupInfo(groupOpenid);
      const groupName = info && info.groupName ? javaTrim(info.groupName) : "";
      if (!groupName) {
        // 群名缺失与请求失败同处理：很可能只是这次没拿到，不能因此永久不合并。
        metaFailureAt.set(groupOpenid, Date.now());
        console.warn("[QQBot] group info unavailable, fallback for 5min:", groupOpenid);
        return { groupName: "", description: "", at: 0 };
      }
      const meta: QQGroupMeta = {
        groupName,
        description: String(info?.description || "").replace(/\s+/g, " ").trim().slice(0, 240),
        at: Date.now(),
      };
      metaCache.set(groupOpenid, meta);
      metaFailureAt.delete(groupOpenid);
      return meta;
    } catch (error) {
      metaFailureAt.set(groupOpenid, Date.now());
      console.warn("[QQBot] resolve group meta failed, fallback for 5min:", error);
      return { groupName: "", description: "", at: 0 };
    }
  })().finally(() => {
    metaInflight.delete(groupOpenid);
  });
  metaInflight.set(groupOpenid, task);
  return task;
}

interface QQGroupRoute {
  sessionKey: string;
  groupName: string;
  description: string;
}

/**
 * openid → 会话键：
 * 1. 先查持久映射（命中即用，群改名不拆会话）
 * 2. 未命中 → 取群信息，拿到群名就按群名算键并写回映射
 * 3. 拿不到群名 → 本次用回退键，只做内存负缓存、绝不写持久映射
 */
async function resolveQQGroupRoute(client: QQBotClient, groupOpenid: string): Promise<QQGroupRoute> {
  const openid = javaTrim(String(groupOpenid || ""));
  const fallbackKey = qqGroupFallbackSessionKey(openid);
  try {
    const cachedKey = readRouteMap()[openid] || "";
    const meta = await loadGroupMeta(client, openid);
    if (cachedKey) {
      return { sessionKey: cachedKey, groupName: meta.groupName, description: meta.description };
    }
    if (meta.groupName) {
      const sessionKey = qqGroupSessionKeyByName(meta.groupName);
      writeRoute(openid, sessionKey);
      console.info("[QQBot] group route new:", openid, `name=[${meta.groupName}]`, "→", sessionKey);
      return { sessionKey, groupName: meta.groupName, description: meta.description };
    }
    console.info("[QQBot] group route fallback (no group name):", openid, "→", fallbackKey);
    return { sessionKey: fallbackKey, groupName: "", description: "" };
  } catch (error) {
    console.warn("[QQBot] resolve group route failed, fallback to openid session:", error);
    return { sessionKey: fallbackKey, groupName: "", description: "" };
  }
}

/* ------------------------------ 成员在场表（哪个机器人代表哪个成员） ------------------------------ */

interface QQGroupPresence {
  bindingId: number;
  groupOpenid: string;
  msgId: string;
  mentioned: boolean;
  at: number;
}

/** sessionKey → (agentId → 该成员机器人在群里的身份)。 */
const presenceBySession = new Map<string, Map<number, QQGroupPresence>>();

function prunePresence(byAgent: Map<number, QQGroupPresence>, now: number): void {
  for (const [agentId, presence] of byAgent) {
    if (now - presence.at > PRESENCE_TTL_MS) byAgent.delete(agentId);
  }
}

function registerQQGroupPresence(input: {
  sessionKey: string;
  agentId: number;
  bindingId: number;
  groupOpenid: string;
  msgId: string | null;
  mentioned: boolean;
}): void {
  const sessionKey = String(input.sessionKey || "").trim();
  if (!sessionKey || !(input.agentId > 0)) return;
  const byAgent = presenceBySession.get(sessionKey) ?? new Map<number, QQGroupPresence>();
  const now = Date.now();
  prunePresence(byAgent, now);
  byAgent.set(input.agentId, {
    bindingId: input.bindingId,
    groupOpenid: String(input.groupOpenid || "").trim(),
    msgId: String(input.msgId || "").trim(),
    mentioned: Boolean(input.mentioned),
    at: now,
  });
  presenceBySession.set(sessionKey, byAgent);
}

function presenceOf(sessionKey: string, agentId: number): QQGroupPresence | null {
  const byAgent = presenceBySession.get(sessionKey);
  if (!byAgent) return null;
  const presence = byAgent.get(agentId);
  if (!presence) return null;
  if (Date.now() - presence.at > PRESENCE_TTL_MS) {
    byAgent.delete(agentId);
    return null;
  }
  return presence;
}

function siblingGroupAgentIds(bindingId: number, agentId: number): number[] {
  try {
    return listQqBindingRows()
      .filter((row) => row.enabled_group && row.agent_id > 0)
      .filter((row) => row.id !== bindingId && row.agent_id !== agentId)
      .map((row) => row.agent_id);
  } catch (error) {
    console.warn("[QQBot] collect sibling bindings failed:", error);
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 有界等待兄弟绑定登记 presence：两个机器人都在群里时平台会各推一条同一条消息，
 * 到达相差 100~300ms。抢到的绑定立刻开跑，会把回复发到「还没登记的成员」身份上。
 */
async function awaitSiblingPresence(
  sessionKey: string,
  bindingId: number,
  agentId: number,
): Promise<void> {
  const siblings = siblingGroupAgentIds(bindingId, agentId);
  if (siblings.length === 0) return;
  const missing = () => siblings.filter((agent) => !presenceOf(sessionKey, agent));
  if (missing().length === 0) return;
  const deadline = Date.now() + SIBLING_PRESENCE_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(SIBLING_PRESENCE_POLL_MS);
    if (missing().length === 0) {
      console.info("[QQBot] sibling presence ready:", sessionKey, "agents=", siblings);
      return;
    }
  }
  console.info("[QQBot] sibling presence timeout, continue:", sessionKey, "missing=", missing());
}

/* ------------------------------ 被动回复配额（按 binding + msg_id） ------------------------------ */

const passiveReplyCounts = new Map<string, { sent: number; at: number }>();

function passiveKey(bindingId: number, msgId: string): string {
  return `${bindingId}${SEP}${msgId}`;
}

function prunePassiveReplyCounts(now: number): void {
  for (const [key, counter] of passiveReplyCounts) {
    if (now - counter.at > PRESENCE_TTL_MS) passiveReplyCounts.delete(key);
  }
}

/** 占一条被动回复额度；false 表示这条 (binding, msg_id) 已达平台上限 5 条。 */
function takePassiveReplySlot(bindingId: number, msgId: string): boolean {
  const now = Date.now();
  prunePassiveReplyCounts(now);
  const key = passiveKey(bindingId, msgId);
  const counter = passiveReplyCounts.get(key) ?? { sent: 0, at: now };
  if (counter.sent >= MAX_PASSIVE_REPLIES_PER_MESSAGE) return false;
  counter.sent += 1;
  counter.at = now;
  passiveReplyCounts.set(key, counter);
  return true;
}

function releasePassiveReplySlot(bindingId: number, msgId: string): void {
  const counter = passiveReplyCounts.get(passiveKey(bindingId, msgId));
  if (counter && counter.sent > 0) counter.sent -= 1;
}

/* ------------------------------ 入站去重 ------------------------------ */

/**
 * 同一条群消息会被同群多个机器人各推一遍（平台按 bot 分配 openid/msg_id），
 * 按 timestamp + 发言人 + 正文（图片再加大小指纹）去重，只允许一个绑定开回合。
 */
const seenInbound = new Map<string, number>();

function claimGroupInbound(
  sessionKey: string,
  input: {
    eventTimestamp: string;
    images: Record<string, any>[];
  },
  sender: string,
  msgId: string,
  text: string,
): boolean {
  const timestamp = String(input.eventTimestamp || "").trim();
  // uploadId 是每次下载随机生成的，不能当指纹；图片字节数跨机器人一致，够用。
  const imageKey = input.images.length ? input.images.map((item) => item.sizeBytes ?? 0).join("|") : "";
  let key = "";
  if (timestamp) {
    key = `${sessionKey}${SEP}ts:${timestamp}${SEP}${sender}${SEP}${text}${SEP}${imageKey}`;
  } else if (msgId) {
    key = `${sessionKey}${SEP}id:${msgId}`;
  } else {
    return true;
  }
  const now = Date.now();
  for (const [item, at] of seenInbound) {
    if (now - at > INBOUND_DEDUPE_TTL_MS) seenInbound.delete(item);
  }
  if (seenInbound.has(key)) return false;
  seenInbound.set(key, now);
  return true;
}

/* ------------------------------ 同群串行回合队列 ------------------------------ */

const turnQueues = new Map<string, Promise<void>>();

function enqueueTurn(sessionKey: string, task: () => Promise<void>): void {
  const previous = turnQueues.get(sessionKey) ?? Promise.resolve();
  const next = previous.then(task, task).catch((error) => {
    console.warn("[QQBot] group turn failed:", error);
  });
  turnQueues.set(sessionKey, next);
  void next.finally(() => {
    if (turnQueues.get(sessionKey) === next) turnQueues.delete(sessionKey);
  });
}

/* ------------------------------ 正文清洗 ------------------------------ */

/** 全量模式正文自带 `<@openid>` / `<@!openid>`。 */
const QQ_MENTION_INLINE_RE = /<@!?([A-Za-z0-9_-]+)>/g;

function sanitizeQQNickname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(NICKNAME_NOISE_RE, " ").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/**
 * 全量模式的正文带着 `<@openid>`：能对上昵称就换成「@昵称」，对不上就整段删掉，
 * 免得模型读到一串 32 位 openid。
 */
function replaceQQMentions(content: string, mentions: Array<Record<string, unknown>>): string {
  if (!content.includes("<@")) return content;
  const namesById = new Map<string, string>();
  for (const mention of mentions) {
    const id = typeof mention.id === "string" ? mention.id : "";
    const name = sanitizeQQNickname(mention.username);
    if (id && name) namesById.set(id, name);
  }
  return content.replace(QQ_MENTION_INLINE_RE, (_tag, id: string) => {
    const name = namesById.get(id);
    return name ? `@${name} ` : "";
  });
}

function cleanGroupContent(content: string): string {
  return String(content || "")
    .replace(/\r/g, "\n")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** 发言人标签：对齐移动端 `formatGroupSenderLabel`（`昵称 (openid)`，昵称空则裸 openid）。 */
function formatGroupSenderLabel(senderName: string | null, senderId: string): string {
  const name = (senderName || "").trim();
  return name ? `${name} (${senderId})` : senderId;
}

function createClientForBinding(bindingId: number): QQBotClient | null {
  const row = getQqBindingRow(bindingId);
  if (!row) return null;
  const secret = decryptSecret(row.client_secret_enc);
  if (!secret) return null;
  return createQqBotClient(bindingId);
}

export interface QQGroupInboundInput {
  /** 收到这条事件的绑定。 */
  bindingId: number;
  agentId: number;
  replyWithVoice: boolean;
  /** 本绑定自己的 client（群信息请求必须用它：openid 授权按机器人发）。 */
  client: QQBotClient;
  eventType: string;
  data: Record<string, any>;
  /** 已下载好的入站图片（vision 载荷）。 */
  images: Record<string, any>[];
  /** 语音附件的转写文本（空串表示没有转写结果）。 */
  voiceTranscript: string;
  /** 有语音附件（转写可能失败）。 */
  hadVoice: boolean;
  /** 有不支持/未识别的附件。 */
  hadUnsupported: boolean;
  /** QQ 平台消息时间戳；多个 bot 收到同一条消息时用它做去重。 */
  eventTimestamp: string;
}

/* ------------------------------ 出站（用「成员自己的机器人」发言） ------------------------------ */

/**
 * 用该成员自己的绑定把一条回复发出去（语音 + 文本双推，文本是保底载体）。
 * 绝不代发：owner 绑定缺位时由调用方跳过本条回复。
 */
async function sendGroupReply(input: {
  ownerBindingId: number;
  ownerAgentId: number;
  ownerGroupOpenid: string;
  ownerMsgId: string;
  replyWithVoice: boolean;
  content: string;
}): Promise<void> {
  const msgId = input.ownerMsgId;
  // 语音 + 文本双推（对齐移动端）：只发语音时 QQ 会收下（2xx）但客户端未必能播。
  if (input.replyWithVoice) {
    const reserved = takePassiveReplySlot(input.ownerBindingId, msgId);
    if (reserved) {
      try {
        const settings = getSettings() as Record<string, any>;
        if (settings.ttsEnabled) {
          const audio = await synthesizeText(input.content, { agentId: input.ownerAgentId });
          const prepared = await prepareOutboundVoice(
            audio.data,
            `reply.${audio.format}`,
            audio.format,
            audio.sampleRate,
          );
          if (!prepared) throw new Error("unsupported voice format");
          const ownerClient = createClientForBinding(input.ownerBindingId);
          if (ownerClient) {
            await ownerClient.sendFileBytes(
              "group",
              input.ownerGroupOpenid,
              FILE_TYPE_VOICE,
              prepared.data,
              prepared.filename,
              "",
              msgId,
            );
          } else {
            throw new Error("owner client unavailable");
          }
        } else {
          releasePassiveReplySlot(input.ownerBindingId, msgId);
        }
      } catch (error) {
        releasePassiveReplySlot(input.ownerBindingId, msgId);
        console.warn("[QQBot] group voice failed, text still follows:", error);
      }
    }
  }
  // 文本按被动回复配额逐条发；超限丢弃（对齐平台规则与移动端）。
  const bubbles = splitForChannelDelivery(input.content);
  for (const bubble of bubbles.length > 0 ? bubbles : [input.content]) {
    if (!takePassiveReplySlot(input.ownerBindingId, msgId)) {
      console.info("[QQBot] group passive reply limit reached, dropped:", input.ownerAgentId);
      return;
    }
    try {
      const ownerClient = createClientForBinding(input.ownerBindingId);
      if (!ownerClient) throw new Error("owner client unavailable");
      await ownerClient.sendText("group", input.ownerGroupOpenid, bubble, msgId);
    } catch (error) {
      releasePassiveReplySlot(input.ownerBindingId, msgId);
      console.warn("[QQBot] group reply send failed:", error);
    }
  }
}

/**
 * QQ 群消息入口（由 QQBotGatewayRunner 在解析出图片/语音后调用）。
 *
 * 流程（对齐移动端 groupBridge.runQQGroupInbound）：
 * 1. bot 回声过滤 → mentions 解析 → 正文清洗（@ 标签换昵称）
 * 2. 解析群会话键（群名归并）→ 登记 presence → 有界等待兄弟绑定
 * 3. 去重抢占（同一条消息只允许一个绑定开回合）
 * 4. 选应答成员：被点名的绑定优先（is_you / 仅@ 事件），否则抢到去重的绑定
 * 5. 群会话独立线程（user_id = 会话键，记忆按群隔离）→ streamChat → 用「成员自己的机器人」发
 */
export function handleQQGroupInbound(input: QQGroupInboundInput): void {
  const data = input.data;
  const groupOpenid = String(data.group_openid || "").trim();
  if (!groupOpenid) return;
  // 别的机器人（含我们自己可能的回声）不接话，否则会互相刷屏。
  if (data.author?.bot === true) return;

  const author = (data.author && typeof data.author === "object" ? data.author : {}) as Record<string, any>;
  const senderId = String(author.member_openid || "");
  if (!senderId) return;
  const senderName = sanitizeQQNickname(author.username) || sanitizeQQNickname(author.nick);
  const mentions = Array.isArray(data.mentions)
    ? (data.mentions.filter(
        (item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
      ) as Array<Record<string, unknown>>)
    : [];
  // 「仅 @」模式只推 GROUP_AT_MESSAGE_CREATE（@ 已被剥离）；
  // 「全量」模式必须靠 mentions[].is_you 判断有没有点名机器人。
  const mentionedMe =
    input.eventType === "GROUP_AT_MESSAGE_CREATE" ||
    mentions.some((mention) => mention.is_you === true);

  let text = cleanGroupContent(replaceQQMentions(String(data.content || ""), mentions));
  if (input.voiceTranscript) text = [text, input.voiceTranscript].filter(Boolean).join(" ").trim();

  const speaker = (senderName || senderId.slice(0, 6) || "群成员").trim();
  const body = text.trim();
  const msgId = String(data.id || "");
  if (!body && !input.images.length) {
    // 空消息兜底（对齐移动端：语音 fallback / 文件提示发回群里）。
    const fallback = input.hadVoice
      ? "（这条语音我没太听清，能再说一遍或者打字告诉我吗～）"
      : input.hadUnsupported
        ? "（这个类型的消息我暂时看不了～）"
        : "";
    if (fallback && takePassiveReplySlot(input.bindingId, msgId)) {
      void input.client
        .sendText("group", groupOpenid, fallback, msgId)
        .catch((error) => {
          releasePassiveReplySlot(input.bindingId, msgId);
          console.warn("[QQBot] group fallback send failed:", error);
        });
    }
    return;
  }
  const messageText = `[${formatGroupSenderLabel(senderName, senderId)}] ${body || "（发来一张图片）"}`;

  void (async () => {
    const route = await resolveQQGroupRoute(input.client, groupOpenid);
    const sessionKey = route.sessionKey || qqGroupFallbackSessionKey(groupOpenid);
    if (!sessionKey) return;

    // 进队列之前登记：抢到去重的绑定要能替其他成员、以该成员自己的机器人身份发言。
    registerQQGroupPresence({
      sessionKey,
      agentId: input.agentId,
      bindingId: input.bindingId,
      groupOpenid,
      msgId,
      mentioned: mentionedMe,
    });
    await awaitSiblingPresence(sessionKey, input.bindingId, input.agentId);

    if (!claimGroupInbound(sessionKey, input, (senderName || senderId).trim(), msgId, messageText)) {
      console.info(
        "[QQBot] duplicate group inbound skipped:",
        sessionKey,
        input.eventTimestamp || msgId || "",
      );
      return;
    }

    enqueueTurn(sessionKey, async () => {
      // 应答成员：被点名的绑定优先（只有它的机器人收到了 @ 事件）；否则由当前绑定应答。
      const byAgent = presenceBySession.get(sessionKey);
      let responderAgentId = input.agentId;
      if (byAgent) {
        for (const [agentId, presence] of byAgent) {
          if (presence.mentioned && agentId !== input.agentId) {
            responderAgentId = agentId;
            break;
          }
        }
      }
      const responderPresence =
        presenceOf(sessionKey, responderAgentId) ??
        ({
          bindingId: input.bindingId,
          groupOpenid,
          msgId,
          mentioned: mentionedMe,
          at: Date.now(),
        } as QQGroupPresence);
      const ownerBinding = getQqBindingRow(responderPresence.bindingId);
      if (!ownerBinding || !decryptSecret(ownerBinding.client_secret_enc)) {
        console.info("[QQBot] skip group reply: owner binding missing:", responderPresence.bindingId);
        return;
      }

      saveProactiveRoute({
        agentId: responderAgentId,
        channel: "qqbot",
        targetType: "group",
        targetId: responderPresence.groupOpenid || groupOpenid,
      });

      // 一个 QQ 群 = 一个独立线程：群聊记忆按 (agentId, 群会话键) 隔离，不污染私聊。
      const thread = ensureExternalThread(sessionKey, responderAgentId);
      const controller = new AbortController();
      let fullText = "";
      const outboundImages: string[] = [];
      try {
        for await (const event of streamChat({
          request: {
            message: messageText,
            sessionId: thread.id,
            agentId: responderAgentId,
            userId: sessionKey,
            mode: "chat",
            images: input.images as any,
            clientHints: {
              surface: "qqbot",
              interactionMode: input.hadVoice ? "voice_message" : "text_chat",
              inputKind: input.images.length && !body ? "image" : input.hadVoice ? "voice" : "text",
              outputMode: "text_bubble",
              transport: "qqbot_gateway",
              botMode: true,
            },
          },
          signal: controller.signal,
          controller,
        })) {
          if (event.type === "text_delta" && event.content) fullText += event.content;
          if (event.type === "image") {
            const url = (event.metadata as any)?.url || event.content;
            if (url) outboundImages.push(String(url));
          }
          if (event.type === "tool_result") {
            const result = (event.metadata as any)?.tool_result;
            for (const image of Array.isArray(result?.images) ? result.images : []) {
              if (image?.url) outboundImages.push(String(image.url));
            }
          }
        }
      } catch {
        fullText = "";
      }

      const reply = stripThinkBlocks(fullText);
      if (reply) {
        await sendGroupReply({
          ownerBindingId: responderPresence.bindingId,
          ownerAgentId: responderAgentId,
          ownerGroupOpenid: responderPresence.groupOpenid || groupOpenid,
          ownerMsgId: responderPresence.msgId,
          replyWithVoice: Boolean(ownerBinding.reply_with_voice),
          content: reply,
        });
      }

      for (const url of outboundImages.slice(0, 3)) {
        try {
          const target = url.startsWith("/") ? `http://127.0.0.1:${config.PORT}${url}` : url;
          const response = await fetch(target, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) continue;
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.length) continue;
          if (!takePassiveReplySlot(responderPresence.bindingId, responderPresence.msgId)) break;
          try {
            const ownerClient = createClientForBinding(responderPresence.bindingId);
            if (!ownerClient) throw new Error("owner client unavailable");
            await ownerClient.sendFileBytes(
              "group",
              responderPresence.groupOpenid || groupOpenid,
              FILE_TYPE_IMAGE,
              bytes,
              "image.png",
              "",
              responderPresence.msgId,
            );
          } catch (error) {
            releasePassiveReplySlot(responderPresence.bindingId, responderPresence.msgId);
            console.warn("[QQBot] group image send failed:", error);
          }
        } catch {
          // best-effort media delivery
        }
      }

      try {
        sessionHub.broadcastJson(thread.id, {
          type: "chat.channel_sync",
          threadId: thread.id,
          agentId: responderAgentId,
        });
      } catch (error) {
        console.warn("[QQBot] channel_sync broadcast failed:", error);
      }
    });
  })().catch((error) => {
    console.warn("[QQBot] group inbound failed:", error);
  });
}
