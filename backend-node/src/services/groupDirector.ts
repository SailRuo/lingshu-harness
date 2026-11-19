import { requestDigestJson } from "./memoryService.js";
import { buildDirectorPrompt, type GroupPromptMessage } from "./groupPrompt.js";
import type {
  GroupMember,
  GroupMessage,
  GroupSession,
  GroupSpeechAct,
  GroupTurnPlan,
  GroupUserIdentity,
  RawDirectorDecision,
} from "./groupChatTypes.js";

const MEMBER_SPEECH_ACTS = new Set<GroupSpeechAct>([
  "respond_user",
  "respond_member",
  "clarify",
  "add_perspective",
]);
const USER_SPEECH_ACTS = new Set<GroupSpeechAct>(["invite_user", "close"]);

const DIRECTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    next: { type: "string", enum: ["member", "user"] },
    speakerName: { type: "string" },
    replyToMessageId: { type: "string" },
    speechAct: {
      type: "string",
      enum: [
        "respond_user",
        "respond_member",
        "clarify",
        "add_perspective",
        "invite_user",
        "close",
      ],
    },
    directorPrompt: { type: "string" },
    reason: { type: "string" },
  },
  required: ["next", "speakerName", "replyToMessageId", "speechAct", "directorPrompt", "reason"],
};

export interface DirectorValidationContext {
  members: GroupMember[];
  recentMessages: GroupMessage[];
  rootEventId: string;
  afterAgentReply: boolean;
  lastSpeakerAgentId?: number | null;
}

function memberName(member: GroupMember) {
  return String(member.displayName || member.name || "").trim();
}

/**
 * An explicit @mention is a hard social semantic: the mentioned member speaks
 * first, directly to the user. The director is not called for this step, so it
 * cannot steal the floor.
 */
export function planForMention(input: {
  members: GroupMember[];
  mentionedAgentIds: number[];
  replyToMessageId: string;
}): GroupTurnPlan | null {
  const enabled = input.members.filter((member) => member.status === "active");
  for (const agentId of input.mentionedAgentIds) {
    const member = enabled.find((item) => item.agentId === Number(agentId));
    if (!member) continue;
    return {
      next: "member",
      speakerId: member.agentId,
      speakerName: memberName(member),
      replyToMessageId: input.replyToMessageId,
      speechAct: "respond_user",
      directorPrompt: `用户刚刚明确点名了你「${memberName(member)}」，请先直接回应用户这句话，再自然收住。`,
      source: "mention",
      reason: "用户直接点名该成员，硬语义优先于导演",
    };
  }
  return null;
}

export function parseMentionedAgentIds(
  text: string,
  members: GroupMember[],
): number[] {
  const active = members
    .filter((member) => member.status === "active")
    .slice()
    .sort((left, right) => {
      const leftName = String(left.displayName || left.name || "");
      const rightName = String(right.displayName || right.name || "");
      return rightName.length - leftName.length;
    });
  const found: number[] = [];
  for (const member of active) {
    const names = [member.displayName, member.name].filter(Boolean);
    if (names.some((name) => new RegExp(`@\\s*${escapeRegExp(name)}`).test(text))) {
      found.push(member.agentId);
    }
  }
  return [...new Set(found)];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Structural + social validation. No keyword-based turn selection happens here. */
export function validateDirectorDecision(
  raw: RawDirectorDecision,
  context: DirectorValidationContext,
): GroupTurnPlan | null {
  const active = context.members.filter((member) => member.status === "active");
  if (!active.length) return null;
  const next = raw.next === "member" || raw.next === "user" ? raw.next : null;
  const speechAct = String(raw.speechAct || "") as GroupSpeechAct;
  const replyToMessageId = String(raw.replyToMessageId || "").trim();
  const allowedReplyIds = new Set([
    ...context.recentMessages.map((message) => message.id),
    context.rootEventId,
  ]);
  if (!next) return null;
  if (!replyToMessageId || !allowedReplyIds.has(replyToMessageId)) return null;
  const reason = String(raw.reason || "").trim() || "导演选择下一句话权";
  const directorPrompt = String(raw.directorPrompt || "").trim();

  if (next === "user") {
    if (!USER_SPEECH_ACTS.has(speechAct)) return null;
    if (String(raw.speakerName || "").trim()) return null;
    return {
      next: "user",
      speakerId: null,
      speakerName: "",
      replyToMessageId,
      speechAct,
      directorPrompt: "",
      source: "llm",
      reason,
    };
  }

  if (!MEMBER_SPEECH_ACTS.has(speechAct)) return null;
  const requestedName = String(raw.speakerName || "").trim().toLocaleLowerCase();
  if (!requestedName) return null;
  const matches = active.filter(
    (member) => memberName(member).toLocaleLowerCase() === requestedName,
  );
  if (matches.length !== 1) return null;
  const speaker = matches[0];
  if (context.afterAgentReply) {
    if (speechAct !== "respond_member") return null;
    if (
      context.lastSpeakerAgentId != null &&
      speaker.agentId === Number(context.lastSpeakerAgentId)
    ) {
      return null;
    }
  }
  return {
    next: "member",
    speakerId: speaker.agentId,
    speakerName: memberName(speaker),
    replyToMessageId,
    speechAct,
    directorPrompt,
    source: "llm",
    reason,
  };
}

export interface SelectGroupSpeakerInput {
  group: GroupSession;
  members: GroupMember[];
  userIdentity: GroupUserIdentity;
  recentMessages: GroupMessage[];
  rootEventId: string;
  userText: string;
  mentionedAgentIds?: number[];
  afterAgentReply?: boolean;
  consecutiveAgentReplies?: number;
  lastSpeakerAgentId?: number | null;
}

const SAFETY_PATTERN =
  /自杀|自残|想死|不想活|活不下去|结束生命|割腕|跳楼|吞药|自杀计划|轻生|伤害自己|准备.*(?:刀|药|绳|地点|时间)/i;

export async function selectGroupSpeaker(
  input: SelectGroupSpeakerInput,
): Promise<GroupTurnPlan> {
  const active = input.members.filter((member) => member.status === "active");
  const replyToMessageId = input.recentMessages[input.recentMessages.length - 1]?.id || input.rootEventId;
  if (!active.length) {
    return {
      next: "user",
      speakerId: null,
      speakerName: "",
      replyToMessageId,
      speechAct: "close",
      directorPrompt: "",
      source: "fallback",
      reason: "群内没有可用成员",
    };
  }

  if (!input.afterAgentReply) {
    const mentionPlan = planForMention({
      members: active,
      mentionedAgentIds: input.mentionedAgentIds || [],
      replyToMessageId: input.rootEventId,
    });
    if (mentionPlan) return mentionPlan;
  }

  const messages: GroupPromptMessage[] = buildDirectorPrompt({
    group: input.group,
    members: active,
    userIdentity: input.userIdentity,
    recentMessages: input.recentMessages,
    rootEventId: input.rootEventId,
    userText: input.userText,
    afterAgentReply: Boolean(input.afterAgentReply),
    consecutiveAgentReplies: Math.max(0, Number(input.consecutiveAgentReplies || 0)),
    mentionedAgentName: active.find((member) =>
      (input.mentionedAgentIds || []).includes(member.agentId),
    )?.displayName,
  });
  const system = messages.find((message) => message.role === "system")?.content || "";
  const human = messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n\n");

  let lastInvalid = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = (await requestDigestJson(system, human, {
        temperature: 0.1,
        retries: 0,
        schema: DIRECTOR_SCHEMA,
      })) as RawDirectorDecision;
      const plan = validateDirectorDecision(raw, {
        members: active,
        recentMessages: input.recentMessages,
        rootEventId: input.rootEventId,
        afterAgentReply: Boolean(input.afterAgentReply),
        lastSpeakerAgentId: input.lastSpeakerAgentId,
      });
      if (plan) return plan;
      lastInvalid = `next=${String(raw?.next)} speechAct=${String(raw?.speechAct)} speaker=${String(raw?.speakerName)} replyTo=${String(raw?.replyToMessageId)}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastInvalid = message;
      // A transport / provider failure is not "invalid director output".
      // Retrying the exact same request rarely helps, and silently closing the
      // turn would look like the group ignored the user. Surface it instead.
      if (/fetch failed|econn|etimedout|timeout|socket|network|429|5\d\d|401|403/i.test(message)) {
        throw new Error(`群聊导演调用失败，本轮已停止：${message}`);
      }
    }
  }

  if (SAFETY_PATTERN.test(input.userText)) {
    const first = active[0];
    return {
      next: "member",
      speakerId: first.agentId,
      speakerName: memberName(first),
      replyToMessageId,
      speechAct: "respond_user",
      directorPrompt: "用户的风险表达需要被认真接住。请优先回应现实安全，明确请用户联系可信任的人并远离危险。",
      source: "fallback",
      reason: `导演输出无效（${lastInvalid}），安全兜底由成员直接回应`,
    };
  }

  return {
    next: "user",
    speakerId: null,
    speakerName: "",
    replyToMessageId,
    speechAct: "close",
    directorPrompt: "",
    source: "fallback",
    reason: `导演连续两次输出无效（${lastInvalid}），安全收束本轮`,
  };
}
