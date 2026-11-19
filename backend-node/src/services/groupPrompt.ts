import type {
  GroupMember,
  GroupMessage,
  GroupSession,
  GroupTurnPlan,
  GroupUserIdentity,
} from "./groupChatTypes.js";
import { renderGroupUserIdentity } from "./groupChatRepository.js";

export const GROUP_PUBLIC_HISTORY_LIMIT = 48;
export const GROUP_ANCHOR_TRIGGER_MESSAGES = 100;

export interface GroupPromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GroupRecallStream {
  id?: string;
  narrative: string;
  about?: string;
  type?: string;
  originScope?: string | null;
  originGroupSessionId?: string | null;
  perspective?: string | null;
  createdAt?: string;
}

export interface GroupPrivateRecall {
  streams: GroupRecallStream[];
  facts?: Array<{ description?: string }>;
  portraitText?: string;
  constraints?: string[];
}

function namesById(members: GroupMember[]): Map<number, string> {
  return new Map(
    members.map((member) => [member.agentId, member.displayName || member.name] as const),
  );
}

export function groupSpeakerLabel(
  message: GroupMessage,
  memberNames: Map<number, string>,
  userLabel: string,
  currentAgentId?: number,
): string {
  if (message.speakerType === "system") return "系统";
  if (message.speakerType === "user") return userLabel;
  const agentId = Number(message.speakerId);
  if (currentAgentId !== undefined && agentId === currentAgentId) return "我";
  return memberNames.get(agentId) || `成员${message.speakerId}`;
}

export function formatGroupPublicLine(
  message: GroupMessage,
  memberNames: Map<number, string>,
  userLabel: string,
  currentAgentId?: number,
): string {
  return `${groupSpeakerLabel(message, memberNames, userLabel, currentAgentId)}：${message.content}`;
}

export function formatGroupPublicTranscript(
  messages: GroupMessage[],
  members: GroupMember[],
  userLabel: string,
  currentAgentId?: number,
): string {
  const names = namesById(members);
  return messages
    .filter((message) => message.content.trim())
    .map((message) => formatGroupPublicLine(message, names, userLabel, currentAgentId))
    .join("\n");
}

/**
 * Map public group events onto chat turns. The current member's own lines are
 * assistant; every other line is a user turn with an explicit speaker label.
 * This keeps the public transcript visibly public instead of pretending it is
 * a private chat history.
 */
export function buildGroupDialogueMessages(input: {
  currentAgentId: number;
  recentMessages: GroupMessage[];
  members: GroupMember[];
  userLabel: string;
}): GroupPromptMessage[] {
  const names = namesById(input.members);
  const messages: GroupPromptMessage[] = [];
  for (const message of input.recentMessages.slice(-GROUP_PUBLIC_HISTORY_LIMIT)) {
    const content = message.content.trim();
    if (!content) continue;
    if (message.speakerType === "system") {
      messages.push({ role: "user", content: `系统事件：${content}` });
      continue;
    }
    if (message.speakerType === "user") {
      messages.push({ role: "user", content: `${input.userLabel}：${content}` });
      continue;
    }
    const agentId = Number(message.speakerId);
    if (agentId === input.currentAgentId) {
      messages.push({ role: "assistant", content });
    } else {
      messages.push({
        role: "user",
        content: `${names.get(agentId) || `成员${message.speakerId}`}：${content}`,
      });
    }
  }
  return messages;
}

function formatRecallLine(stream: GroupRecallStream): string {
  const narrative = String(stream.narrative || "").trim().slice(0, 500);
  if (!narrative) return "";
  const when = stream.createdAt ? `[${new Date(stream.createdAt).toISOString().slice(0, 10)}] ` : "";
  return `- ${when}${narrative}`;
}

export function buildGroupStaticPrompt(input: {
  group: GroupSession;
  members: GroupMember[];
  currentAgent: GroupMember;
  userIdentity: GroupUserIdentity;
  privateRecall: GroupPrivateRecall;
  anchor: { summary: string; coveredAt: string } | null;
}): string {
  const userName = input.userIdentity.name;
  const selfName = input.currentAgent.displayName || input.currentAgent.name;
  const others = input.members.filter((member) => member.agentId !== input.currentAgent.agentId);
  const privateStreams = input.privateRecall.streams.filter(
    (stream) => String(stream.originScope || "").trim() !== "group_public",
  );
  const groupExperiences = input.privateRecall.streams.filter(
    (stream) => String(stream.originScope || "").trim() === "group_public",
  );
  const privateLines = privateStreams.map(formatRecallLine).filter(Boolean);
  const groupLines = groupExperiences.map(formatRecallLine).filter(Boolean);
  const factLines = (input.privateRecall.facts || [])
    .map((fact) => String(fact.description || "").trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => `- ${line}`);
  const constraintLines = (input.privateRecall.constraints || [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => `- ${line}`);

  return [
    `你是「${selfName}」。`,
    "# 我是谁",
    `你的名字是「${selfName}」。`,
    input.currentAgent.roleSetting?.trim()
      ? `你的人设：\n${input.currentAgent.roleSetting.trim()}`
      : "",
    input.currentAgent.speakingStyle?.trim()
      ? `你的说话风格：\n${input.currentAgent.speakingStyle.trim()}`
      : "",
    `# 群聊场景`,
    `你正在灵枢桌面版的多人文字群聊中发言。群里的「${userName}」就是你私聊里一直在对话的同一个人，只是此刻场景换成了多人在场。你仍带着自己与这位用户相处形成的记忆、判断和关系，但群里的公开消息是对所有成员可见的共同现场。`,
    `当前群：${input.group.title}${input.group.description ? `\n群简介：${input.group.description}` : ""}`,
    "# 用户身份底座（用户亲自填写，跨私聊/群聊一致）",
    renderGroupUserIdentity(input.userIdentity),
    "# 群成员",
    `- 「${userName}」是本群用户。`,
    `- 你是「${selfName}」。`,
    ...others.map((member) => `- 「${member.displayName || member.name}」是另一位群成员。`),
    "成员名单是本群唯一在场名单。未列出的名字不能被当作群成员或凭空出现的新角色；对方当然可以谈论群外的人，但不能假定那个人就在群里。成员名单不等于彼此已经有私交，第一次同场时你们对彼此可能是陌生的。",
    "# 群聊规则",
    "1. 只代表你自己发言。不要替其他成员说话、解释他们的内心，也不要冒充用户。",
    "2. 群公开消息是所有成员共同看见的事件，不是你和用户的私聊经历。不要把它说成“你私下跟我说过”；你在私聊里记得的事可以记得，但不要替其他成员知道，也不要在群里复述私密细节。",
    "3. 不要声称知道其他成员与用户的私下经历；不要用“我记得你们俩之前……”这类没有公开依据的话。",
    "4. 默认只说 1–2 句、一个具体反应或接话点，像真实的群聊，不要长篇安慰、背景复述或连续反问。",
    "5. 不要使用“@名字”的写法，直接叫名字或直接说话。不要复述其他成员刚说过的句子。",
    "# 你的私有记忆（只有你自己知道，其他成员看不到）",
    privateLines.length ? privateLines.join("\n") : "（这次没有被召回的相关私人记忆。）",
    factLines.length ? `\n你确认过的相关事实：\n${factLines.join("\n")}` : "",
    constraintLines.length ? `\n你记得的相处约定：\n${constraintLines.join("\n")}` : "",
    input.privateRecall.portraitText?.trim()
      ? `\n你对这位用户自己的认识（只属于你）：\n${input.privateRecall.portraitText.trim().slice(0, 1200)}`
      : "",
    "# 你曾共同在场的群聊公开经历（也是你自己的记忆，但来源是公开群聊）",
    groupLines.length
      ? groupLines.join("\n")
      : "（还没有形成与本群相关的公开经历记忆。）",
    "# 本群公开历史摘要",
    input.anchor?.summary?.trim()
      ? `以下摘要只覆盖已经滚出实时窗口的公开消息，不是私聊经历：\n${input.anchor.summary.trim()}`
      : "（暂无更早的公开历史摘要。）",
    "# 公开事件流说明",
    "下面的对话是本群公开事件流：你自己的历史发言为 assistant；其他成员、用户和系统事件的发言为 user，内容里带说话人标签。请只把公开事件当作此刻共同现场，不要伪装成私聊记忆。",
  ]
    .filter((block) => block !== "")
    .join("\n\n");
}

export function buildGroupMemberPrompt(input: {
  group: GroupSession;
  members: GroupMember[];
  currentAgent: GroupMember;
  userIdentity: GroupUserIdentity;
  privateRecall: GroupPrivateRecall;
  anchor: { summary: string; coveredAt: string } | null;
  recentMessages: GroupMessage[];
  plan: GroupTurnPlan;
  replyToMessage: GroupMessage | null;
}): { system: string; messages: GroupPromptMessage[] } {
  const userName = input.userIdentity.name;
  const selfName = input.currentAgent.displayName || input.currentAgent.name;
  const replyToLine = input.replyToMessage
    ? formatGroupPublicTranscript(
        [input.replyToMessage],
        input.members,
        userName,
        input.currentAgent.agentId,
      )
    : "";
  const speechActLine: Record<GroupTurnPlan["speechAct"], string> = {
    respond_user: `导演指定这句由你直接回应用户「${userName}」刚刚的发言。`,
    respond_member: `导演指定这句接住上一位成员的话：先回应对方具体说的那一点，而不是另起一段重复回答用户。`,
    clarify: "导演指定这句只澄清当前公开对话里一个必要的误会或细节，澄清完就停。",
    add_perspective: "导演指定这句只补充一个不同角度，给群里新增一小点信息、感受或态度，不要重复上一位的结论。",
    invite_user: `导演指定这句自然把话头递回给用户「${userName}」，不要替用户总结。`,
    close: "导演指定这句自然收束，不再展开新话题。",
  };
  const directorBlock = [
    "# 本次发言安排",
    speechActLine[input.plan.speechAct],
    input.plan.directorPrompt ? `导演的具体安排：${input.plan.directorPrompt}` : "",
    replyToLine ? `这句要接住的公开事件：\n${replyToLine}` : "",
    `只以「${selfName}」的身份说 1–2 句。不要写成私聊式长段，不要使用 @，不要替其他成员发言。`,
  ]
    .filter(Boolean)
    .join("\n");

  const system = `${buildGroupStaticPrompt(input)}\n\n${directorBlock}`;
  const messages = buildGroupDialogueMessages({
    currentAgentId: input.currentAgent.agentId,
    recentMessages: input.recentMessages,
    members: input.members,
    userLabel: userName,
  });
  messages.push({
    role: "user",
    content: "请根据上面的群公开事件和本次发言安排，以你自己的身份说一句群聊回复。",
  });
  return { system, messages };
}

export function buildDirectorPrompt(input: {
  group: GroupSession;
  members: GroupMember[];
  userIdentity: GroupUserIdentity;
  recentMessages: GroupMessage[];
  rootEventId: string;
  userText: string;
  afterAgentReply: boolean;
  consecutiveAgentReplies: number;
  mentionedAgentName?: string;
  replyToMessageId?: string;
}): GroupPromptMessage[] {
  const userName = input.userIdentity.name;
  const names = input.members.map((member) => member.displayName || member.name);
  const transcript = input.recentMessages
    .slice(-GROUP_PUBLIC_HISTORY_LIMIT)
    .map((message) => {
      const label =
        message.speakerType === "system"
          ? "系统"
          : message.speakerType === "user"
            ? userName
            : input.members.find((member) => member.agentId === Number(message.speakerId))?.displayName ||
              `成员${message.speakerId}`;
      return `[id=${message.id}] ${label}：${message.content}`;
    })
    .join("\n");
  const roster = input.members
    .map((member) => `- 「${member.displayName || member.name}」`)
    .join("\n");
  const system = [
    "你是桌面版多智能体群聊的导演，不是群成员。你不写任何成员回复正文，只决定下一句话权属于谁。",
    `当前群：${input.group.title}${input.group.description ? `\n群简介：${input.group.description}` : ""}`,
    `在场用户：「${userName}」。`,
    `在场成员（speakerName 必须与下列名字完全一致）：\n${roster || "（无）"}`,
    "你只读公开事件流，没有长期记忆，也不维护成员关系。你要回答的是：此刻哪一条公开事件仍在被回应；下一句话权应属于哪位成员，还是应当自然交还用户。",
    "判断原则：",
    "1. next=member 只在该成员能对刚刚发生的事件作出实质回应时成立：直接回应用户、接住另一位成员、澄清误会、补充不同角度。",
    "2. next=user 是正常的社会性交接，不是失败。成员刚提出真实问题、需要用户补充信息、用户已被充分回应、成员间互动已自然完成或事件已收束时，应优先交还用户。",
    "3. 不要按关键词、固定轮流顺序或“凑人数”决定发言者；不要为了更有趣而无条件续聊。",
    "4. 续发时不能选刚刚说完的同一位成员；speechAct 必须是 respond_member 才能接上一位成员的话。",
    "5. 用户明确 @某位成员时，系统会直接让该成员先回应用户，不经过你；你只在之后判断下一步。",
    `本轮触发用户事件 id：${input.rootEventId}`,
    input.mentionedAgentName ? `本轮用户点名：${input.mentionedAgentName}` : "",
    input.afterAgentReply ? "这是某位成员刚说完后的续发判断。" : "这是用户本轮发言后的首次判断。",
    `本轮已连续成员发言：${input.consecutiveAgentReplies} 条（安全上限 7 条）。`,
    "只输出一个 JSON 对象，字段必须齐全：",
    '{"next":"member|user","speakerName":"成员精确名或空字符串","replyToMessageId":"公开事件 id","speechAct":"respond_user|respond_member|clarify|add_perspective|invite_user|close","directorPrompt":"next=member 时说明接住哪条事件的哪一点、面向谁、以什么角度；不能代写台词","reason":"仅供观测的简短理由"}',
    "硬约束：next=member → speakerName 必须是在场成员且不能是刚说完的那位，speechAct 只能是 respond_user|respond_member|clarify|add_perspective；next=user → speakerName 必须为空字符串，speechAct 只能是 invite_user|close。禁止 next=user 配 respond_user。",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `公开事件窗口（每条前面的 id 可用于 replyToMessageId）：\n${transcript || "（暂无公开消息）"}\n\n用户本轮原文：${input.userText}\n\n请只输出合法 JSON。`,
    },
  ];
}

export function buildGroupAnchorPrompt(input: {
  groupTitle: string;
  previousSummary: string;
  transcript: string;
}): string {
  return [
    `你在压缩群聊「${input.groupTitle}」已经滚出实时窗口的公开历史。`,
    "只保留尚未解决的话题、明确承诺、关键事实、公开事件时间线和必要上下文。",
    "不得写成员的私下记忆、心理揣测、用户画像或回复建议；不得把群公开内容写成私聊经历。",
    input.previousSummary.trim() ? `已有摘要：\n${input.previousSummary.trim()}` : "",
    `新增公开消息：\n${input.transcript}`,
    '只返回 JSON：{"summary":"..."}',
  ]
    .filter(Boolean)
    .join("\n\n");
}
