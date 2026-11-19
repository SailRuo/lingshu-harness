/**
 * Shared types for the desktop multi-agent group chat.
 *
 * The public event stream is intentionally separate from `chat_messages`:
 * a group message is visible to every member, while a private chat message is
 * visible only to the agent that owns that thread. Keeping the tables apart is
 * the first line of the memory boundary.
 */

export type GroupSpeakerType = "user" | "assistant" | "system";

export type GroupSpeechAct =
  | "respond_user"
  | "respond_member"
  | "clarify"
  | "add_perspective"
  | "invite_user"
  | "close";

export interface GroupSession {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: "active" | "archived";
  unreadCount: number;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount?: number;
}

export interface GroupMember {
  groupSessionId: string;
  agentId: number;
  status: "active" | "removed";
  joinedAt: string;
  updatedAt: string;
  // Hydrated from agent_configs for API / prompt rendering.
  name: string;
  displayName: string;
  avatar: string | null;
  color: string | null;
  roleSetting?: string;
  speakingStyle?: string;
}

export interface GroupMessage {
  id: string;
  groupSessionId: string;
  userId: string;
  speakerType: GroupSpeakerType;
  speakerId: string;
  turnId: string;
  content: string;
  metadataJson: string | null;
  metadata: Record<string, unknown>;
  status: "streaming" | "completed" | "error";
  createdAt: string;
  completedAt: string | null;
}

export interface GroupTurnPlan {
  next: "member" | "user";
  speakerId: number | null;
  speakerName: string;
  replyToMessageId: string;
  speechAct: GroupSpeechAct;
  directorPrompt: string;
  source: "mention" | "llm" | "fallback" | "rule";
  reason: string;
}

export interface GroupUserIdentity {
  userId: string;
  name: string;
  age: number;
  gender: string;
  bio: string;
}

export type GroupChatEventType =
  | "group.user_message"
  | "group.system_message"
  | "group.director.status"
  | "group.director.plan"
  | "group.member.status"
  | "group.member.started"
  | "group.member.delta"
  | "group.member.completed"
  | "group.turn.completed"
  | "group.error";

export interface GroupChatEvent {
  type: GroupChatEventType;
  eventId: string;
  groupSessionId: string;
  turnId: string;
  timestamp: string;
  content?: string;
  messageId?: string;
  agentId?: number;
  metadata: Record<string, unknown>;
}

/** Raw model output before validation. Never trust these fields. */
export interface RawDirectorDecision {
  next?: unknown;
  speakerName?: unknown;
  replyToMessageId?: unknown;
  speechAct?: unknown;
  directorPrompt?: unknown;
  reason?: unknown;
}
