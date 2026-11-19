import { randomUUID } from "node:crypto";
import { getAgent } from "./agentService.js";
import { listConstraints, recallForChat } from "./memoryService.js";
import { getUserPortrait } from "./witnessService.js";
import { memoryScope } from "./memoryScope.js";
import { streamGroupReply, isAbortError } from "./chatStreamService.js";
import {
  appendGroupMessage,
  deleteGroupMessage,
  getGroupSession,
  GroupChatError,
  listGroupMembers,
  listRecentGroupMessages,
  markGroupRead,
  readGroupAnchor,
  readGroupUserIdentity,
  recordDirectorTurn,
  updateGroupMessage,
} from "./groupChatRepository.js";
import {
  parseMentionedAgentIds,
  planForMention,
  selectGroupSpeaker,
} from "./groupDirector.js";
import { buildGroupMemberPrompt } from "./groupPrompt.js";
import { refreshGroupConversationAnchor } from "./groupConversationAnchor.js";
import {
  cancelGroupPresenceDigest,
  scheduleGroupPresenceDigest,
} from "./groupPresenceDigest.js";
import type {
  GroupChatEvent,
  GroupMessage,
  GroupTurnPlan,
} from "./groupChatTypes.js";

const MAX_CONSECUTIVE_MEMBER_REPLIES = 7;

export interface RunGroupTurnInput {
  groupId: string;
  userText: string;
  mentionedAgentIds?: number[];
  signal?: AbortSignal;
}

function event(
  type: GroupChatEvent["type"],
  input: {
    groupId: string;
    turnId: string;
    content?: string;
    messageId?: string;
    agentId?: number;
    metadata?: Record<string, unknown>;
  },
): GroupChatEvent {
  return {
    type,
    eventId: randomUUID(),
    groupSessionId: input.groupId,
    turnId: input.turnId,
    timestamp: new Date().toISOString(),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    metadata: input.metadata || {},
  };
}

function privateRecallForMember(agentId: number, query: string, recentMessages: GroupMessage[]) {
  return recallForChat({
    agentId,
    userId: "default_user",
    query: query.slice(0, 2000),
    recentMessages: recentMessages.slice(-5).map((message) => ({
      role: message.speakerType === "assistant" ? "assistant" : "user",
      content: message.content,
    })),
    limit: 7,
  }).catch(() => ({
    streams: [] as any[],
    facts: [] as any[],
    candidates: [],
    candidateCount: 0,
    selectedIds: [],
    queries: [],
    query,
  }));
}

/**
 * One user-triggered group turn:
 *   user public event -> director plan -> member stream -> director again ...
 * with a hard 7-member-reply safety ceiling. No autonomous opening.
 */
export async function* runGroupTurn(
  input: RunGroupTurnInput,
): AsyncGenerator<GroupChatEvent, void, unknown> {
  const group = getGroupSession(input.groupId);
  if (!group) throw new GroupChatError(404, "群聊不存在");
  const members = listGroupMembers(input.groupId);
  if (members.length < 2) throw new GroupChatError(400, "群聊至少需要两位成员");
  const text = String(input.userText || "").trim();
  if (!text) throw new GroupChatError(400, "消息不能为空");
  if (text.length > 4000) throw new GroupChatError(400, "群消息不能超过 4000 字");

  const identity = readGroupUserIdentity();
  const turnId = `group-turn-${randomUUID()}`;
  const mentionedIds = [
    ...new Set([
      ...(input.mentionedAgentIds || []).map(Number),
      ...parseMentionedAgentIds(text, members),
    ]),
  ];
  const validMentionIds = mentionedIds.filter((agentId) =>
    members.some((member) => member.agentId === agentId),
  );

  cancelGroupPresenceDigest(input.groupId);
  const userMessage = appendGroupMessage({
    groupSessionId: input.groupId,
    userId: "default_user",
    speakerType: "user",
    speakerId: "default_user",
    turnId,
    content: text,
    metadataJson: JSON.stringify({ mentioned_agent_ids: validMentionIds }),
    status: "completed",
  });
  yield event("group.user_message", {
    groupId: input.groupId,
    turnId,
    messageId: userMessage.id,
    metadata: { message: userMessage, mentionedAgentIds: validMentionIds },
  });

  let replyCount = 0;
  let plan: GroupTurnPlan | null = null;
  let lastSpeakerAgentId: number | null = null;
  let turnFailed = false;
  try {
    yield event("group.director.status", {
      groupId: input.groupId,
      turnId,
      metadata: { phase: "thinking" },
    });

    plan =
      planForMention({
        members,
        mentionedAgentIds: validMentionIds,
        replyToMessageId: userMessage.id,
      }) ||
      (await selectGroupSpeaker({
        group,
        members,
        userIdentity: identity,
        recentMessages: listRecentGroupMessages(input.groupId, 48),
        rootEventId: userMessage.id,
        userText: text,
        mentionedAgentIds: validMentionIds,
      }));

    recordDirectorTurn({
      groupId: input.groupId,
      turnId,
      triggerMessageId: userMessage.id,
      plan,
      source: plan.source,
    });
    yield event("group.director.plan", {
      groupId: input.groupId,
      turnId,
      metadata: { plan },
    });

    while (plan.next === "member" && plan.speakerId) {
      if (replyCount >= MAX_CONSECUTIVE_MEMBER_REPLIES) break;
      input.signal?.throwIfAborted();
      const member = members.find((item) => item.agentId === plan!.speakerId);
      if (!member) break;
      const agent = getAgent(member.agentId);
      const agentName = member.displayName || member.name || agent?.displayName || `成员${member.agentId}`;
      const recent = listRecentGroupMessages(input.groupId, 48);
      const replyToMessage =
        recent.find((message) => message.id === plan!.replyToMessageId) ||
        recent[recent.length - 1] ||
        null;
      const placeholder = appendGroupMessage({
        groupSessionId: input.groupId,
        userId: "default_user",
        speakerType: "assistant",
        speakerId: String(member.agentId),
        turnId,
        content: "",
        metadataJson: JSON.stringify({
          speaker_name: agentName,
          speech_act: plan.speechAct,
          reply_to_message_id: plan.replyToMessageId,
          plan_source: plan.source,
          plan_reason: plan.reason,
        }),
        status: "streaming",
      });
      yield event("group.member.status", {
        groupId: input.groupId,
        turnId,
        agentId: member.agentId,
        messageId: placeholder.id,
        metadata: { phase: "thinking", speakerName: agentName },
      });
      yield event("group.member.started", {
        groupId: input.groupId,
        turnId,
        agentId: member.agentId,
        messageId: placeholder.id,
        metadata: {
          speakerName: agentName,
          message: placeholder,
          speechAct: plan.speechAct,
          replyToMessageId: plan.replyToMessageId,
        },
      });

      try {
        const recall = await privateRecallForMember(member.agentId, text, recent);
        const portrait = getUserPortrait(memoryScope(member.agentId, "default_user"));
        const constraints = listConstraints(memoryScope(member.agentId, "default_user"))
          .items.slice(0, 8)
          .map((item) => String(item.description || "").trim())
          .filter(Boolean);
        const prompt = buildGroupMemberPrompt({
          group,
          members,
          currentAgent: member,
          userIdentity: identity,
          privateRecall: {
            streams: recall.streams as any[],
            facts: (recall as any).facts || [],
            portraitText: portrait?.narrative || "",
            constraints,
          },
          anchor: readGroupAnchor(input.groupId),
          recentMessages: recent,
          plan,
          replyToMessage,
        });
        const llmMessages = [
          { role: "system" as const, content: prompt.system },
          ...prompt.messages,
        ];
        yield event("group.member.status", {
          groupId: input.groupId,
          turnId,
          agentId: member.agentId,
          messageId: placeholder.id,
          metadata: { phase: "streaming", speakerName: agentName },
        });
        let fullText = "";
        const iterator = streamGroupReply(llmMessages, { signal: input.signal });
        let next = await iterator.next();
        while (!next.done) {
          const delta = next.value.content;
          fullText += delta;
          yield event("group.member.delta", {
            groupId: input.groupId,
            turnId,
            agentId: member.agentId,
            messageId: placeholder.id,
            content: delta,
            metadata: { speakerName: agentName },
          });
          next = await iterator.next();
        }
        const finalText = String(next.value?.text || fullText).trim();
        if (!finalText) throw new Error(`群成员 ${agentName} 返回空回复`);
        const completed = updateGroupMessage(placeholder.id, {
          content: finalText,
          status: "completed",
        });
        replyCount += 1;
        lastSpeakerAgentId = member.agentId;
        yield event("group.member.completed", {
          groupId: input.groupId,
          turnId,
          agentId: member.agentId,
          messageId: placeholder.id,
          metadata: {
            message: completed,
            speakerName: agentName,
            speechAct: plan.speechAct,
          },
        });
        yield event("group.member.status", {
          groupId: input.groupId,
          turnId,
          agentId: member.agentId,
          messageId: placeholder.id,
          metadata: { phase: "done", speakerName: agentName },
        });
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) throw error;
        console.error("[GROUP_TURN] member reply failed", error);
        const current = updateGroupMessage(placeholder.id, { status: "error" });
        if (!current?.content.trim()) deleteGroupMessage(placeholder.id);
        yield event("group.error", {
          groupId: input.groupId,
          turnId,
          agentId: member.agentId,
          messageId: placeholder.id,
          content: error instanceof Error ? error.message : String(error),
          metadata: { phase: "member_reply", speakerName: agentName },
        });
        turnFailed = true;
        break;
      }

      if (replyCount >= MAX_CONSECUTIVE_MEMBER_REPLIES) break;
      input.signal?.throwIfAborted();
      yield event("group.director.status", {
        groupId: input.groupId,
        turnId,
        metadata: { phase: "thinking", afterAgentReply: true },
      });
      plan = await selectGroupSpeaker({
        group,
        members,
        userIdentity: identity,
        recentMessages: listRecentGroupMessages(input.groupId, 48),
        rootEventId: userMessage.id,
        userText: text,
        afterAgentReply: true,
        consecutiveAgentReplies: replyCount,
        lastSpeakerAgentId,
      });
      recordDirectorTurn({
        groupId: input.groupId,
        turnId,
        triggerMessageId: userMessage.id,
        plan,
        source: plan.source,
      });
      yield event("group.director.plan", {
        groupId: input.groupId,
        turnId,
        metadata: { plan },
      });
      if (plan.next === "user") break;
    }
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted) throw error;
    yield event("group.error", {
      groupId: input.groupId,
      turnId,
      content: error instanceof Error ? error.message : String(error),
      metadata: { phase: "turn" },
    });
    turnFailed = true;
  } finally {
    markGroupRead(input.groupId, "default_user");
    scheduleGroupPresenceDigest(
      input.groupId,
      members.map((member) => member.agentId),
    );
    const latestMembers = listGroupMembers(input.groupId);
    void refreshGroupConversationAnchor({
      groupId: input.groupId,
      groupTitle: group.title,
      userLabel: identity.name,
      members: latestMembers,
    }).catch(() => undefined);
  }
  if (!turnFailed && !input.signal?.aborted) {
    yield event("group.turn.completed", {
      groupId: input.groupId,
      turnId,
      metadata: { replyCount, lastPlan: plan },
    });
  }
}
