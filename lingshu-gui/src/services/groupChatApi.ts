import { getFullUrl } from '../utils/apiConfig';

export interface GroupSession {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: 'active' | 'archived';
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
  status: 'active' | 'removed';
  joinedAt: string;
  updatedAt: string;
  name: string;
  displayName: string;
  avatar: string | null;
  color: string | null;
}

export interface GroupMessage {
  id: string;
  groupSessionId: string;
  userId: string;
  speakerType: 'user' | 'assistant' | 'system';
  speakerId: string;
  turnId: string;
  content: string;
  metadataJson: string | null;
  metadata: Record<string, unknown>;
  status: 'streaming' | 'completed' | 'error';
  createdAt: string;
  completedAt: string | null;
}

export interface GroupTurnPlan {
  next: 'member' | 'user';
  speakerId: number | null;
  speakerName: string;
  replyToMessageId: string;
  speechAct: string;
  directorPrompt: string;
  source: string;
  reason: string;
}

export interface GroupDetail {
  group: GroupSession;
  members: GroupMember[];
  anchor: {
    summary: string;
    coveredMessageId: string;
    coveredAt: string;
    updatedAt: string;
  } | null;
}

export interface GroupChatEvent {
  type:
    | 'group.user_message'
    | 'group.system_message'
    | 'group.director.status'
    | 'group.director.plan'
    | 'group.member.status'
    | 'group.member.started'
    | 'group.member.delta'
    | 'group.member.completed'
    | 'group.turn.completed'
    | 'group.error';
  eventId: string;
  groupSessionId: string;
  turnId: string;
  timestamp: string;
  content?: string;
  messageId?: string;
  agentId?: number;
  metadata: Record<string, unknown>;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(getFullUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String((body as { detail?: string }).detail || `请求失败（${response.status}）`));
  }
  return (await response.json()) as T;
}

export const groupChatApi = {
  listGroups(): Promise<GroupSession[]> {
    return requestJson('/api/v1/group-chat/groups');
  },
  getGroup(groupId: string): Promise<GroupDetail> {
    return requestJson(`/api/v1/group-chat/groups/${encodeURIComponent(groupId)}`);
  },
  createGroup(input: {
    title: string;
    description?: string;
    memberAgentIds: number[];
  }): Promise<GroupDetail> {
    return requestJson('/api/v1/group-chat/groups', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateGroup(groupId: string, patch: { title?: string; description?: string }): Promise<GroupDetail> {
    return requestJson(`/api/v1/group-chat/groups/${encodeURIComponent(groupId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
  deleteGroup(groupId: string): Promise<{ deleted: boolean }> {
    return requestJson(`/api/v1/group-chat/groups/${encodeURIComponent(groupId)}`, {
      method: 'DELETE',
    });
  },
  addMember(groupId: string, agentId: number): Promise<{ detail: GroupDetail }> {
    return requestJson(`/api/v1/group-chat/groups/${encodeURIComponent(groupId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    });
  },
  removeMember(groupId: string, agentId: number): Promise<{ detail: GroupDetail }> {
    return requestJson(
      `/api/v1/group-chat/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(String(agentId))}`,
      { method: 'DELETE' },
    );
  },
  listMessages(
    groupId: string,
    options: { limit?: number; beforeMessageId?: string } = {},
  ): Promise<{ messages: GroupMessage[]; hasMoreOlder: boolean }> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.beforeMessageId) params.set('beforeMessageId', options.beforeMessageId);
    const query = params.toString();
    return requestJson(
      `/api/v1/group-chat/groups/${encodeURIComponent(groupId)}/messages${query ? `?${query}` : ''}`,
    );
  },
  markRead(groupId: string, lastMessageId?: string): Promise<unknown> {
    return requestJson(`/api/v1/group-chat/groups/${encodeURIComponent(groupId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ lastMessageId }),
    });
  },
  openGroup(groupId: string): Promise<GroupDetail> {
    return requestJson(`/api/v1/group-chat/groups/${encodeURIComponent(groupId)}/open`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
};

function parseSseBlock(block: string): GroupChatEvent | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as GroupChatEvent;
  } catch {
    return null;
  }
}

/**
 * POST + SSE (same wire style as the private chat stream): the server keeps a
 * single `data: {...}` event per line block, and the browser reads the body
 * incrementally instead of buffering the whole response.
 */
export async function streamGroupTurn(
  groupId: string,
  input: { message: string; mentionedAgentIds: number[] },
  onEvent: (event: GroupChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    getFullUrl(`/api/v1/group-chat/groups/${encodeURIComponent(groupId)}/messages`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String((body as { detail?: string }).detail || `群聊请求失败（${response.status}）`));
  }
  if (!response.body) throw new Error('群聊响应没有可读流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseBlock(block);
      if (event) onEvent(event);
      boundary = buffer.indexOf('\n\n');
    }
  }
  const tail = parseSseBlock(buffer);
  if (tail) onEvent(tail);
}
