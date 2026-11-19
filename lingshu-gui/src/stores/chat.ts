import { defineStore } from 'pinia';
import { ref, computed, onMounted } from 'vue';
import type { Conversation } from '../types/conversation';
import type { AnyMessage, ImageMessage, MessageStatus, TextMessage, SystemMessage } from '../types/message';
import { useAgentsStore } from './agents';
import Message from '@arco-design/web-vue/es/message';
import type { UnifiedChatEvent, UnifiedChatEventType } from '../types/chat-events';
import { getChatEventRenderTarget, isUnifiedChatEventType } from '../types/chat-events';
import { buildHistoricalMessages } from './chat-history';
import { hydrateHistoricalTaskState } from '../utils/historicalTaskState.js';
import { resolveContinuationTaskId } from '../utils/continuationTask.js';
import { isTerminalTaskStatus, syncTerminalTaskStatusAcrossMessages } from '../utils/taskMessageStatus.js';
import { getFullUrl } from '../utils/apiConfig';
import { parseServerDateTime } from '../utils/dateTime';
import { previewTextWithImagePlaceholder, stripEmbeddedImageMarkup } from '../utils/messageText';
import { stripTtsEmotionTags } from '../utils/ttsEmotionTags';
import { sessionChatWs } from '../services/sessionChatWs';
import type { DeleteMessagesImpact } from '../utils/messageDelete';

function normalizeAssetUrl(path: string): string {
  if (!path) return path;
  return getFullUrl(path.startsWith('/') ? path : `/${path}`);
}

function assistantPreviewText(content: string): string {
  return previewTextWithImagePlaceholder(stripEmbeddedImageMarkup(content));
}

// 获取或生成用户 ID
function getClientUserId(): string {
  const storageKey = 'lingshu_user_id';
  const fixedUserId = 'default_user';
  localStorage.setItem(storageKey, fixedUserId);
  return fixedUserId;
}

function logChatRequestDebug(kind: string, payload: Record<string, unknown>) {
  console.info(`[chat-debug] ${kind}`, payload);
}

function createClientMessageId(prefix = 'msg'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isVoiceUserMessage(message: AnyMessage | undefined): message is TextMessage {
  if (!message || !message.isSelf || message.type !== 'text') return false;
  const input = (message as TextMessage).metadata?.input as Record<string, unknown> | undefined;
  if (input?.kind === 'voice') return true;
  return String(message.id || '').startsWith('voice-user-');
}

function isAssistantTextMessage(message: AnyMessage | undefined): message is TextMessage {
  return Boolean(message && message.type === 'text' && !message.isSelf);
}

/**
 * 助手消息可携带一份独立的朗读文本（`[]` 情绪标签只对 TTS 可见），
 * 与展示正文（已剥掉标签）分开保存。
 */
type TtsTextMessage = TextMessage & { ttsText?: string };

/**
 * `[]` 情绪标签只对 TTS 可见：后端 text_delta 的 metadata.ttsText 是本段增量，
 * 这里累积成整条消息的朗读文本（气泡正文仍然是剥掉标签的展示文本）。
 */
function accumulateTtsText(message: TextMessage | undefined, deltaTtsText: string): string {
  if (!message || !deltaTtsText) return '';
  const previous = typeof message.metadata?.ttsText === 'string' ? message.metadata.ttsText : '';
  const next = previous + deltaTtsText;
  message.metadata = { ...message.metadata, ttsText: next };
  return next;
}

/** 展开事件 metadata 时排除逐段 ttsText，避免覆盖累积后的整段朗读文本。 */
function metadataWithoutDeltaTtsText(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  if (metadata.ttsText === undefined) return metadata;
  const { ttsText: _deltaTtsText, ...rest } = metadata;
  return rest;
}

/**
 * 兜底：老库里可能存着带 `[]` 情绪标签的助手消息，渲染前统一剥掉。
 */
function stripHistoricalEmotionTags(message: AnyMessage): AnyMessage {
  if (message.type !== 'text' || message.isSelf) return message;
  const text = message as TextMessage;
  const content = String(text.content || '');
  if (!content) return message;
  const stripped = stripTtsEmotionTags(content);
  if (stripped === content) return message;
  return { ...text, content: stripped };
}

function findLastAssistantMessageIndexByTaskId(messages: AnyMessage[], taskId: string): number {
  return messages.findLastIndex((message) => isAssistantTextMessage(message) && message.metadata?.taskId === taskId);
}

/**
 * 仅匹配「sending 且不是续聊」的助手气泡。
 * 用于新轮次主响应事件（无 follow_up 标记）按 taskId 路由：
 * 必须落在 sendMessage 新创建的占位 aiMsg 上，绝不落在被重排到末尾的旧续聊气泡上，
 * 否则两段不同消息会被拼接进同一个气泡。
 */
function findLastSendingPrimaryAssistantIndexByTaskId(messages: AnyMessage[], taskId: string): number {
  return messages.findLastIndex(
    (message) =>
      isAssistantTextMessage(message)
      && message.metadata?.taskId === taskId
      && message.status === 'sending'
      && !message.metadata?.followUp,
  );
}

function findAssistantMessageIndexByMessageId(messages: AnyMessage[], messageId: string): number {
  return messages.findIndex(
    (message) =>
      isAssistantTextMessage(message)
      && (message.metadata?.messageId === messageId || message.id === messageId),
  );
}

function parseBubbleIndex(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function normalizeTurnId(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  return text || undefined;
}

function readMetadataAgentId(metadata?: Record<string, unknown>): number | null {
  const value = Number(metadata?.agentId);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function getAssistantBubbleIndex(message: TextMessage): number | undefined {
  return parseBubbleIndex(message.metadata?.bubbleIndex) ?? undefined;
}

function getStreamOwnerIndex(messages: AnyMessage[], streamOwnerId?: string): number {
  if (!streamOwnerId) return -1;
  return messages.findIndex(
    (message) => message.id === streamOwnerId && isAssistantTextMessage(message),
  );
}

function findLastSendingPrimaryAssistantIndex(messages: AnyMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantTextMessage(message)) continue;
    if (message.status !== 'sending') continue;
    if (message.metadata?.followUp) continue;
    return index;
  }
  return -1;
}

function resolveStreamOwnerIndex(
  messages: AnyMessage[],
  options: {
    explicitId?: string;
    backendMessageId?: string;
  },
): number {
  const { explicitId, backendMessageId } = options;
  if (explicitId) {
    const explicitIdx = getStreamOwnerIndex(messages, explicitId);
    if (explicitIdx !== -1) return explicitIdx;
  }
  if (backendMessageId) {
    const backendIdx = findAssistantMessageIndexByMessageId(messages, backendMessageId);
    if (backendIdx !== -1) return backendIdx;
  }
  const sendingIdx = findLastSendingPrimaryAssistantIndex(messages);
  if (sendingIdx !== -1) return sendingIdx;
  return messages.findLastIndex((message) => isAssistantTextMessage(message));
}

function resolveStreamOwnerId(
  messages: AnyMessage[],
  eventData: IncomingChatEventPayload,
  explicitId?: string,
): string | undefined {
  const resolvedIdx = resolveStreamOwnerIndex(messages, {
    explicitId,
    backendMessageId: typeof eventData.messageId === 'string' ? eventData.messageId : undefined,
  });
  if (resolvedIdx !== -1) {
    return messages[resolvedIdx].id;
  }
  return explicitId
    || (typeof eventData.messageId === 'string' ? eventData.messageId : undefined);
}

function readSegmentTexts(owner: TextMessage): string[] {
  const raw = owner.metadata?.segmentTexts;
  if (!Array.isArray(raw)) return [];
  return raw.map((part) => (typeof part === 'string' ? part : ''));
}

function writeSegmentTexts(owner: TextMessage, segmentTexts: string[]): void {
  owner.metadata = {
    ...owner.metadata,
    segmentTexts,
  };
}

function ensureStreamOwnerTagged(
  messages: AnyMessage[],
  ownerIdx: number,
  turnId: string,
  streamOwnerId: string,
): TextMessage {
  const owner = messages[ownerIdx] as TextMessage;
  messages[ownerIdx] = {
    ...owner,
    metadata: {
      ...owner.metadata,
      turnId,
      bubbleIndex: 0,
      segmentGroupId: streamOwnerId,
    },
  };
  return messages[ownerIdx] as TextMessage;
}

function createAssistantSegmentMessage(
  template: TextMessage,
  bubbleIndex: number,
  turnId: string,
  streamOwnerId: string,
): TextMessage {
  const baseTime = template.timestamp instanceof Date
    ? template.timestamp.getTime()
    : new Date(template.timestamp).getTime();
  return {
    id: createClientMessageId('assistant-seg'),
    type: 'text',
    senderId: template.senderId,
    senderName: template.senderName,
    senderAvatar: template.senderAvatar,
    timestamp: new Date(baseTime + bubbleIndex),
    status: 'sending',
    isSelf: false,
    content: '',
    metadata: {
      turnId,
      bubbleIndex,
      segmentGroupId: streamOwnerId,
      taskId: template.metadata?.taskId,
      timelineEvents: [],
      taskEvents: [],
      seenEventIds: [],
    },
  };
}

function syncSegmentMessagesFromTexts(
  messages: AnyMessage[],
  options: {
    streamOwnerId: string;
    turnId: string;
    segmentTexts: string[];
    template: TextMessage;
  },
): void {
  const { streamOwnerId, turnId, segmentTexts, template } = options;
  const ownerIdx = getStreamOwnerIndex(messages, streamOwnerId);
  if (ownerIdx === -1) return;

  ensureStreamOwnerTagged(messages, ownerIdx, turnId, streamOwnerId);
  messages[ownerIdx] = {
    ...(messages[ownerIdx] as TextMessage),
    content: segmentTexts[0] || '',
    status: resolveSegmentStreamStatus(segmentTexts, 0),
  };

  for (let bubbleIndex = 1; bubbleIndex < segmentTexts.length; bubbleIndex += 1) {
    let segmentIdx = findAssistantSegmentIndexByTurnBubble(messages, turnId, bubbleIndex);
    if (segmentIdx === -1) {
      const insertAfter = findLastAssistantSegmentIndexForTurn(messages, turnId);
      const insertAt = insertAfter >= 0 ? insertAfter + 1 : ownerIdx + 1;
      messages.splice(
        insertAt,
        0,
        createAssistantSegmentMessage(template, bubbleIndex, turnId, streamOwnerId),
      );
      segmentIdx = insertAt;
    }
    messages[segmentIdx] = {
      ...(messages[segmentIdx] as TextMessage),
      content: segmentTexts[bubbleIndex] || '',
      status: resolveSegmentStreamStatus(segmentTexts, bubbleIndex),
      metadata: {
        ...(messages[segmentIdx] as TextMessage).metadata,
        turnId,
        bubbleIndex,
        segmentGroupId: streamOwnerId,
      },
    };
  }
}

function findAssistantSegmentIndexByTurnBubble(
  messages: AnyMessage[],
  turnId: string,
  bubbleIndex: number,
): number {
  return messages.findIndex(
    (message) =>
      isAssistantTextMessage(message)
      && normalizeTurnId(message.metadata?.turnId) === turnId
      && getAssistantBubbleIndex(message) === bubbleIndex,
  );
}

function findLastAssistantSegmentIndexForTurn(messages: AnyMessage[], turnId: string): number {
  let lastIdx = -1;
  let lastBubble = -1;
  messages.forEach((message, index) => {
    if (!isAssistantTextMessage(message)) return;
    if (normalizeTurnId(message.metadata?.turnId) !== turnId) return;
    const idx = getAssistantBubbleIndex(message);
    if (typeof idx === 'number' && idx >= lastBubble) {
      lastBubble = idx;
      lastIdx = index;
    }
  });
  return lastIdx;
}

function resolveSegmentStreamStatus(segmentTexts: string[], bubbleIndex: number): MessageStatus {
  const hasLaterContent = segmentTexts
    .slice(bubbleIndex + 1)
    .some((part) => part.trim().length > 0);
  return hasLaterContent ? 'sent' : 'sending';
}

function finalizeAssistantStreamMessages(
  messages: TextMessage[],
  anchorMessageId?: string,
): void {
  if (!anchorMessageId) return;
  const anchorIdx = messages.findIndex((message) => message.id === anchorMessageId);
  if (anchorIdx === -1) return;

  const anchor = messages[anchorIdx] as TextMessage;
  const turnId = normalizeTurnId(anchor.metadata?.turnId) || '';
  const segmentGroupId = typeof anchor.metadata?.segmentGroupId === 'string'
    ? anchor.metadata.segmentGroupId
    : anchorMessageId;

  const relatedIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (!isAssistantTextMessage(message)) return;
    if (turnId && normalizeTurnId(message.metadata?.turnId) === turnId) {
      relatedIndexes.push(index);
      return;
    }
    if (message.id === anchorMessageId || message.metadata?.segmentGroupId === segmentGroupId) {
      relatedIndexes.push(index);
    }
  });

  if (relatedIndexes.length === 0) {
    relatedIndexes.push(anchorIdx);
  }

  relatedIndexes.sort((a, b) => b - a);
  for (const index of relatedIndexes) {
    const message = messages[index] as TextMessage;
    const segmentTexts = readSegmentTexts(message);
    const bubbleIndex = getAssistantBubbleIndex(message);
    if (segmentTexts.length > 0 && bubbleIndex !== undefined && Number.isFinite(bubbleIndex) && bubbleIndex < segmentTexts.length) {
      const segText = segmentTexts[bubbleIndex];
      if (typeof segText === 'string' && segText.trim()) {
        message.content = segText;
      }
    }
    const noContent = !String(message.content || '').trim();
    const timeline = (message.metadata?.timelineEvents as unknown[] | undefined) || [];
    const hasActivity = timeline.length > 0;
    const isEmptyPlaceholder =
      message.id === anchorMessageId
      && noContent
      && !hasActivity
      && getAssistantBubbleIndex(message) === 0;

    if (isEmptyPlaceholder) {
      messages.splice(index, 1);
      continue;
    }
    if (message.status === 'sending') {
      message.status = 'sent';
    }
  }
}

function hasFollowUpFlag(message: TextMessage): boolean {
  const meta = message.metadata;
  return Boolean(meta?.followUp || meta?.follow_up);
}

function isFollowUpAssistantMessage(message: AnyMessage): message is TextMessage {
  // 仅对仍处于 'sending' 状态的实时流式续聊消息进行分区重排，已完成/历史的续聊不重排，保持历史相对位置
  return isAssistantTextMessage(message) && hasFollowUpFlag(message) && message.status === 'sending';
}

function registerCancelledFollowUpMessage(cancelled: Set<string>, message: TextMessage) {
  cancelled.add(message.id);
  const backendId = message.metadata?.messageId;
  if (typeof backendId === 'string' && backendId.trim()) {
    cancelled.add(backendId.trim());
  }
}

function isCancelledFollowUpMessageId(cancelled: Set<string>, messageId: string): boolean {
  const id = messageId.trim();
  return Boolean(id && cancelled.has(id));
}

import { hasAssistantStreamProgress } from '../utils/chatStreamProgress.js';

/** 续聊气泡分区：默认仅抽出仍在 sending 的续聊（用户新发言时收尾/丢弃，不再排到用户消息之后）。 */
function partitionFollowUpMessages(
  messages: AnyMessage[],
  options?: { includeSentFollowUps?: boolean },
) {
  const followUps: TextMessage[] = [];
  const core: AnyMessage[] = [];
  for (const message of messages) {
    const isActiveFollowUp = isFollowUpAssistantMessage(message);
    const isSentFollowUp =
      Boolean(options?.includeSentFollowUps)
      && isAssistantTextMessage(message)
      && hasFollowUpFlag(message);
    if (isActiveFollowUp || isSentFollowUp) {
      followUps.push(message);
    } else {
      core.push(message);
    }
  }
  return { core, followUps };
}

interface ChatImageRef {
  uploadId: string;
  url: string;
  mimeType: string;
  fileName?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  summaryText?: string | null;
}

interface IncomingChatEventPayload extends Record<string, unknown> {
  type?: string;
  eventId?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  taskId?: string;
  turnId?: string | number | null;
  messageId?: string | number | null;
  messageKind?: string;
  threadId?: number;
  agentId?: number;
  unreadCount?: number;
  createdAt?: string;
}

interface ChatInboxRow {
  threadId: number;
  agentId: number;
  userId: string;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  lastMessageKind?: string | null;
  unreadCount?: number;
}

async function uploadAttachmentImages(attachments: any[]): Promise<ChatImageRef[]> {
  const imageFiles = attachments.filter((attachment) => attachment.type === 'image');
  const images: ChatImageRef[] = [];
  for (const attachment of imageFiles) {
    images.push(await uploadChatImage(attachment.file));
  }
  return images;
}

async function uploadChatImage(file: File): Promise<ChatImageRef> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(getFullUrl('/api/v1/chat/uploads'), {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail ? `upload image failed (${res.status}): ${detail}` : `upload image failed (${res.status})`);
  }

  const data = await res.json();
  return {
    ...data,
    url: normalizeAssetUrl(String(data.url || '')),
  };
}

export interface TtsSignal {
  messageId: string;
  segments: Array<{
    segmentId?: string;
    audioUrl?: string;
    text?: string;
    seq?: number;
    mimeType?: string;
    audioBase64?: string;
  }>;
  stopToken: string | null;
  timestamp: number;
}

export interface FollowUpSpeakSignal {
  messageId: string;
  content: string;
  timestamp: number;
}

export interface GreetingSpeakSignal {
  conversationId: string;
  messageId: string;
  content: string;
  agentId: number | null;
  timestamp: number;
}

export const useChatStore = defineStore('chat', () => {
  const agentsStore = useAgentsStore();
  const conversations = ref<Conversation[]>([]);
  const currentConversationId = ref<string | null>(null);
  const messagesMap = ref<Record<string, AnyMessage[]>>({});
  const latestTtsSignal = ref<TtsSignal | null>(null);
  const latestFollowUpSpeakSignal = ref<FollowUpSpeakSignal | null>(null);
  const latestGreetingSpeakSignal = ref<GreetingSpeakSignal | null>(null);
  const cancelledFollowUpMessageIds = ref<Set<string>>(new Set());
  const isLoadingMessages = ref(false);
  const isLoadingOlderMessages = ref(false);
  const searchQuery = ref('');
  const activeNav = ref('message');
  const userId = ref(getClientUserId());
  const currentAgentId = ref<number | null>(null); // 当前会话绑定的智能体 ID
  const pendingApproval = ref<{ callId: string; toolName: string; args: Record<string, unknown>; taskId: string } | null>(null)
  const lastMergedMessageId = ref<string | null>(null);
  const activeSkillsMap = ref<Record<string, string[]>>({});
  const currentMemoryEchoes = ref<any[]>([]);
  const oldestTurnIdMap = ref<Record<string, number | null>>({});
  const hasMoreHistoryMap = ref<Record<string, boolean>>({});
  const HISTORY_PAGE_SIZE = 20;
  /** In-flight / recent turnIds we already scheduled for echo refresh. */
  const memoryEchoRefreshInFlight = new Set<string>();

  async function refreshMemoryEchoForTurn(options: {
    conversationId: string;
    turnId: string;
    userMessage?: string;
    assistantMessage?: string;
    /** Prefer inlined snapshot from done metadata (avoids UUID/id mismatch). */
    snapshot?: Record<string, unknown> | null;
  }) {
    const conversationId = String(options.conversationId || '').trim();
    if (!conversationId) return;
    if (String(currentConversationId.value) !== conversationId) return;

    let turnId = String(options.turnId || '').trim();
    let snapshot: Record<string, unknown> | null =
      options.snapshot && typeof options.snapshot === 'object'
        ? { ...options.snapshot }
        : null;

    // Recall traces are keyed by integer ChatMessage id, not stream UUID.
    const numericTurnId = Number(turnId);
    const hasNumericTurnId = Number.isInteger(numericTurnId) && numericTurnId > 0;
    if (!snapshot && !hasNumericTurnId) {
      return;
    }
    if (hasNumericTurnId) {
      turnId = String(numericTurnId);
    }

    const inflightKey = `${conversationId}:${turnId || 'inline'}`;
    if (memoryEchoRefreshInFlight.has(inflightKey)) return;
    memoryEchoRefreshInFlight.add(inflightKey);

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      if (!snapshot && hasNumericTurnId) {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            const recallRes = await fetch(getFullUrl(`/api/v1/memory/recall/${turnId}`));
            if (recallRes.ok) {
              snapshot = await recallRes.json();
              break;
            }
          } catch {
            // retry
          }
          await sleep(150 + attempt * 100);
        }
      }

      // Do not invent an empty stub — that hides real activation behind a blank panel.
      if (!snapshot) return;

      const turnUserId = String(
        (snapshot as { userId?: string }).userId
          || userId.value,
      );
      if (turnUserId && turnUserId !== String(userId.value)) return;

      const messages = messagesMap.value[conversationId] as AnyMessage[] | undefined;
      let userMessage = String(options.userMessage || '').trim();
      let assistantMessage = String(options.assistantMessage || '').trim();
      if (messages?.length) {
        if (!assistantMessage) {
          const assistant = [...messages].reverse().find((m) => {
            if (!isAssistantTextMessage(m)) return false;
            const meta = m.metadata || {};
            return (
              normalizeTurnId(meta.turnId) === turnId
              || String(meta.persistedTurnId || '') === turnId
              || String(meta.messageId || '') === turnId
            );
          }) as TextMessage | undefined;
          assistantMessage = String(assistant?.content || '').trim();
        }
        if (!userMessage) {
          const user = [...messages].reverse().find((m) => m.type === 'text' && m.isSelf) as TextMessage | undefined;
          userMessage = String(user?.content || '').trim();
        }
      }

      const entry = {
        turnId: turnId || `inline-${Date.now()}`,
        sessionId: conversationId,
        userMessage,
        assistantMessage,
        timestamp: new Date().toISOString(),
        snapshot,
      };
      const rest = currentMemoryEchoes.value.filter(
        (item) => String(item.turnId) !== String(entry.turnId),
      );
      currentMemoryEchoes.value = [entry, ...rest].slice(0, 40);
    } finally {
      memoryEchoRefreshInFlight.delete(inflightKey);
    }
  }

  const currentConversation = computed(() =>
    conversations.value.find((c) => c.id === currentConversationId.value) || null
  );

  const currentSessionActiveSkills = computed(() => 
    currentConversationId.value ? activeSkillsMap.value[currentConversationId.value] || [] : []
  );

  const currentMessages = computed<AnyMessage[]>(
    () => (currentConversationId.value ? messagesMap.value[currentConversationId.value] || [] : [])
  );



  const filteredConversations = computed<Conversation[]>(() => {
    if (!searchQuery.value) return conversations.value;
    const q = searchQuery.value.toLowerCase();
    return conversations.value.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.lastMessage.toLowerCase().includes(q)
    );
  });

  const totalUnreadCount = computed<number>(
    () => conversations.value.reduce((sum, c) => sum + c.unreadCount, 0)
  );

  function upsertConversationFromInbox(
    row: ChatInboxRow,
    agent?: { displayName?: string; avatar?: string },
  ): Conversation {
    const id = String(row.threadId);
    const existing = conversations.value.find((item) => item.id === id);
    const next: Conversation = {
      id,
      name: agent?.displayName || existing?.name || '智能体',
      lastMessage: assistantPreviewText(row.lastMessage || existing?.lastMessage || '暂无消息') || '暂无消息',
      timestamp: parseServerDateTime(row.lastMessageAt, existing?.timestamp ?? new Date()),
      avatar: agent?.avatar || existing?.avatar || '/lingshu.png',
      unreadCount: Number(row.unreadCount || 0),
      isPinned: existing?.isPinned || false,
      isMuted: existing?.isMuted || false,
      type: 'chat',
      metadata: {
        ...(existing?.metadata || {}),
        agentId: row.agentId,
        threadId: row.threadId,
        lastMessageKind: row.lastMessageKind || null,
      },
    };
    const index = conversations.value.findIndex((item) => item.id === id);
    if (index >= 0) {
      conversations.value[index] = next;
    } else {
      conversations.value.push(next);
    }
    return next;
  }

  async function markAgentRead(agentId: number, readThroughMessageId: number) {
    if (!agentId || !readThroughMessageId) return;
    try {
      const res = await fetch(getFullUrl(`/api/v1/chat/agents/${agentId}/mark-read`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: userId.value,
          readThroughMessageId,
        }),
      });
      if (!res.ok) return;
      const row = (await res.json()) as ChatInboxRow;
      const agent = agentsStore.agents.find((item) => item.id === agentId);
      upsertConversationFromInbox(row, agent);
    } catch (err) {
      console.warn('mark-read failed', err);
    }
  }

  function handleProactivePush(
    conversationId: string,
    payload: IncomingChatEventPayload,
  ) {
    const content = String(payload.content || '').trim();
    if (!content) return;

    const messageId = payload.messageId != null ? String(payload.messageId) : createClientMessageId('proactive');
    const messageKind = String(payload.messageKind || 'proactive_outreach');
    const conv = conversations.value.find((item) => item.id === conversationId);
    const agentId = Number(conv?.metadata?.agentId || payload.agentId || 0);
    const agent = agentsStore.agents.find((item) => item.id === agentId);

    if (!messagesMap.value[conversationId]) {
      messagesMap.value[conversationId] = [];
    }
    const messages = messagesMap.value[conversationId] as TextMessage[];
    if (findAssistantMessageIndexByMessageId(messages, messageId) !== -1) {
      return;
    }

    const proactiveMsg: TextMessage = {
      id: `proactive-${messageId}`,
      type: 'text',
      senderId: 'bot',
      senderName: agent?.displayName || '灵枢 AI',
      senderAvatar: agent?.avatar || '/lingshu.png',
      timestamp: payload.createdAt ? parseServerDateTime(payload.createdAt) : new Date(),
      status: 'sent',
      isSelf: false,
      content,
      metadata: {
        messageId,
        messageKind,
        proactive: true,
        timelineEvents: [],
        taskEvents: [],
      },
    };
    messages.push(proactiveMsg);

    if (conv) {
      conv.lastMessage = content;
      conv.timestamp = proactiveMsg.timestamp;
      if (typeof payload.unreadCount === 'number') {
        conv.unreadCount = payload.unreadCount;
      }
    }

    if (conversationId === currentConversationId.value && agentId > 0) {
      void markAgentRead(agentId, Number(messageId));
    }
  }

  // 通话问候气泡：服务端发起、无对应用户气泡，通用 dispatch 会丢弃，这里专门建/更新一条。
  function appendCallGreetingBubble(conversationId: string, messageId: string, content: string) {
    const text = String(content || '').trim();
    if (!text) return;
    if (!messagesMap.value[conversationId]) {
      messagesMap.value[conversationId] = [];
    }
    const messages = messagesMap.value[conversationId] as TextMessage[];
    const bubbleId = `greeting-${messageId}`;
    const existingIdx = messages.findIndex((m) => m.id === bubbleId);
    const conv = conversations.value.find((c) => c.id === conversationId);
    const agentId = Number(conv?.metadata?.agentId || 0);
    const agent = agentsStore.agents.find((a) => a.id === agentId);
    if (existingIdx >= 0) {
      (messages[existingIdx] as TextMessage).content = text;
    } else {
      messages.push({
        id: bubbleId,
        type: 'text',
        senderId: 'bot',
        senderName: agent?.displayName || '灵儿',
        senderAvatar: agent?.avatar || '/lingshu.png',
        timestamp: new Date(),
        status: 'sent',
        isSelf: false,
        content: text,
        metadata: { messageId, messageKind: 'greeting', timelineEvents: [], taskEvents: [] },
      });
    }
    if (conv) {
      conv.lastMessage = text;
      conv.timestamp = new Date();
    }
  }

  async function loadConversations() {
    try {
      await agentsStore.fetchAgents();
      const res = await fetch(getFullUrl(`/api/v1/chat/inbox?userId=${encodeURIComponent(userId.value)}`));
      if (!res.ok) throw new Error('Failed to fetch inbox');
      const rows = (await res.json()) as ChatInboxRow[];

      conversations.value = rows.map((row) => {
        const agent = agentsStore.agents.find((a) => a.id === row.agentId);
        return {
          id: String(row.threadId),
          name: agent?.displayName || '智能体',
          lastMessage: assistantPreviewText(row.lastMessage || '暂无消息') || '暂无消息',
          timestamp: parseServerDateTime(row.lastMessageAt),
          avatar: agent?.avatar || '/lingshu.png',
          unreadCount: Number(row.unreadCount || 0),
          isPinned: false,
          isMuted: false,
          type: 'chat' as const,
          metadata: {
            agentId: row.agentId,
            threadId: row.threadId,
            lastMessageKind: row.lastMessageKind || null,
          },
        };
      });

      if (!currentConversationId.value && conversations.value.length > 0) {
        selectConversation(conversations.value[0].id);
      }
    } catch (err) {
      console.error('Load conversations error:', err);
    }
  }

  async function createNewConversation(agentId: number) {
    try {
      const agent = agentsStore.agents.find((a) => a.id === agentId);
      const res = await fetch(
        getFullUrl(`/api/v1/chat/agents/${agentId}/open?userId=${encodeURIComponent(userId.value)}`),
        { method: 'POST' },
      );

      if (!res.ok) throw new Error('Failed to open agent thread');
      const row = (await res.json()) as ChatInboxRow;
      const conversation = upsertConversationFromInbox(row, agent);
      selectConversation(conversation.id);
      // 新建会话后让灵儿主动发首条招呼（异步，不阻塞进入会话）
      void requestSessionGreeting(agentId, Number(row.threadId), conversation.id);
      return row;
    } catch (err) {
      Message.error('创建对话失败');
      console.error(err);
    }
  }

  /**
   * 触发空线程的主动开场白。后端 ensure_session_greeting 幂等：
   * 线程已有消息时返回 status='exists'，不会重复打招呼。
   */
  async function requestSessionGreeting(agentId: number, threadId: number, conversationId: string) {
    if (!agentId || !threadId) return;
    try {
      const res = await fetch(
        getFullUrl(
          `/api/v1/chat/agents/${agentId}/threads/${threadId}/greeting?userId=${encodeURIComponent(userId.value)}`,
        ),
        { method: 'POST' },
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        status?: string;
        turn?: { id?: number; assistantMessage?: string; timestamp?: string } | null;
      };
      if (data?.status !== 'created' || !data?.turn) return;
      // 用户尚未开口、且仍停留在该会话时，刷新拉入开场白（避免覆盖用户已发内容）
      const list = messagesMap.value[conversationId] || [];
      const userSpoke = list.some((m) => m.isSelf);
      if (userSpoke || currentConversationId.value !== conversationId) return;
      await loadMessages(conversationId);
      const conv = conversations.value.find((c) => c.id === conversationId);
      const greetingText = String(data.turn.assistantMessage || '').trim();
      if (conv && greetingText) {
        conv.lastMessage = greetingText;
        conv.timestamp = parseServerDateTime(data.turn.timestamp);
      }
      // 通知 ChatWindow 按其自动播放策略朗读开场白（复用 /api/tts/stream）
      if (greetingText) {
        latestGreetingSpeakSignal.value = {
          conversationId,
          messageId: data.turn.id != null ? String(data.turn.id) : `greeting-${threadId}`,
          content: greetingText,
          agentId: agentId || null,
          timestamp: Date.now(),
        };
      }
    } catch (err) {
      console.warn('session greeting failed', err);
    }
  }

  async function deleteConversation(sessionId: string) {
    try {
      const conv = conversations.value.find((c) => c.id === sessionId);
      const agentId = Number(conv?.metadata?.agentId || 0);
      if (!agentId) throw new Error('Missing agent for thread');
      const res = await fetch(getFullUrl(`/api/v1/chat/agents/${agentId}/threads/${sessionId}`), {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Delete thread failed');
      
      Message.success('会话已删除');
      
      // 更新本地列表
      conversations.value = conversations.value.filter(c => c.id !== sessionId);
      delete messagesMap.value[sessionId];

      // 如果删除的是当前选中的会话，切换到第一个
      if (currentConversationId.value === sessionId) {
        currentConversationId.value = null;
        if (conversations.value.length > 0) {
          selectConversation(conversations.value[0].id);
        }
      }
    } catch (err) {
      Message.error('删除会话失败');
      console.error(err);
    }
  }

  async function clearConversationHistory(sessionId: string) {
    try {
      const conv = conversations.value.find((c) => c.id === sessionId);
      const agentId = Number(conv?.metadata?.agentId || 0);
      if (!agentId) throw new Error('Missing agent for thread');
      const res = await fetch(
        getFullUrl(
          `/api/v1/chat/agents/${agentId}/threads/${sessionId}/clear-history?userId=${encodeURIComponent(userId.value)}`,
        ),
        { method: 'POST' }
      );
      if (!res.ok) throw new Error('Clear thread history failed');
      
      Message.success('对话记录已清空');
      
      // 清空本地该会话的消息
      messagesMap.value[sessionId] = [];
      if (String(currentConversationId.value) === String(sessionId)) {
        currentMemoryEchoes.value = [];
      }

      // 更新会话列表中的最后消息
      if (conv) {
        conv.lastMessage = '暂无消息';
        conv.unreadCount = 0;
      }

      // 清空后线程已空，让灵儿重新主动开口（异步）
      const threadId = Number(conv?.metadata?.threadId ?? sessionId);
      void requestSessionGreeting(agentId, threadId, sessionId);
    } catch (err) {
      Message.error('清空对话记录失败');
      console.error(err);
    }
  }

  async function previewDeleteMessages(sessionId: string, messageIds: number[]): Promise<DeleteMessagesImpact> {
    const conv = conversations.value.find((c) => c.id === sessionId);
    const agentId = Number(conv?.metadata?.agentId || 0);
    if (!agentId) throw new Error('Missing agent for thread');
    const res = await fetch(
      getFullUrl(`/api/v1/chat/agents/${agentId}/threads/${sessionId}/messages/delete-impact?userId=${encodeURIComponent(userId.value)}`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds, includeMemory: true }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || '删除影响评估失败');
    }
    return res.json() as Promise<DeleteMessagesImpact>;
  }

  async function appendVoiceCallSystemMessage(
    sessionId: string,
    kind: 'voice_call_summary' | 'voice_call_rejected' | 'voice_call_missed',
    durationSec?: number,
    endedBy?: 'user' | 'agent',
  ) {
    const conv = conversations.value.find((c) => c.id === sessionId);
    const threadId = Number(conv?.metadata?.threadId || 0);
    if (!threadId) return;

    let content = '';
    if (kind === 'voice_call_summary') {
      const minutes = Math.floor((durationSec || 0) / 60);
      const seconds = (durationSec || 0) % 60;
      if (minutes <= 0) {
        content = `通话 ${seconds} 秒`;
      } else {
        content = `通话 ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
      }
    } else if (kind === 'voice_call_rejected') {
      content = '通话被拒绝';
    } else if (kind === 'voice_call_missed') {
      content = '未接来电';
    }

    const metadata = {
      kind,
      ...(durationSec != null ? { durationSec } : {}),
      ...(endedBy ? { endedBy } : {}),
    };

    const newMsg: SystemMessage = {
      id: `s-${Date.now()}`,
      type: 'system',
      senderId: 'user',
      senderName: '我',
      senderAvatar: '',
      timestamp: new Date(),
      status: 'sent',
      isSelf: true,
      content,
      metadata: {
        messageKind: kind,
        ...metadata,
      },
    };
    const list = messagesMap.value[sessionId];
    if (list) {
      list.push(newMsg);
    }
    if (conv) {
      conv.lastMessage = content;
      conv.timestamp = new Date();
    }

    try {
      const res = await fetch(
        getFullUrl(`/api/v1/chat/system-message?userId=${encodeURIComponent(userId.value)}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            threadId,
            content,
            messageKind: kind,
            metadata,
          }),
        },
      );
      if (!res.ok) {
        console.warn('[voice-call] Failed to persist system message:', await res.text());
      } else {
        const data = await res.json();
        if (data?.id) {
          newMsg.id = `s-${data.id}`;
        }
      }
    } catch (err) {
      console.warn('[voice-call] Error persisting system message:', err);
    }
  }

  async function deleteSelectedMessages(
    sessionId: string,
    messageIds: number[],
    includeMemory = true,
  ) {
    const conv = conversations.value.find((c) => c.id === sessionId);
    const agentId = Number(conv?.metadata?.agentId || 0);
    if (!agentId) throw new Error('Missing agent for thread');
    const res = await fetch(
      getFullUrl(`/api/v1/chat/agents/${agentId}/threads/${sessionId}/messages/delete?userId=${encodeURIComponent(userId.value)}`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds, includeMemory }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || '删除消息失败');
    }
    const deletedTurnKeys = new Set(messageIds.map((id) => String(id)));
    currentMemoryEchoes.value = currentMemoryEchoes.value.filter(
      (item) => !deletedTurnKeys.has(String(item.turnId)),
    );
    await loadMessages(sessionId);
    Message.success('已删除所选消息');
  }

  function removeLocalMessages(uiIds: string[], conversationId?: string) {
    const convId = conversationId || currentConversationId.value;
    if (!convId || !messagesMap.value[convId]) return;
    const targetSet = new Set(uiIds);
    messagesMap.value[convId] = messagesMap.value[convId].filter((m) => !targetSet.has(m.id));
  }

  // 初始化数据
  onMounted(() => {
    loadConversations();
  });

  async function selectConversation(id: string) {
    const isSameConversation = id === currentConversationId.value;
    cancelledFollowUpMessageIds.value = new Set();
    currentConversationId.value = id;
    // 切换会话时，重置当前选中的智能体为会话绑定的智能体（如果有）
    const conv = conversations.value.find(c => c.id === id);
    if (conv && conv.metadata && conv.metadata.agentId) {
      currentAgentId.value = Number(conv.metadata.agentId) || null;
    } else {
      currentAgentId.value = null;
    }
    bindSessionChatWs(id);
    const threadId = Number(conv?.metadata?.threadId ?? id);
    const wsAgentId = readMetadataAgentId(conv?.metadata);
    if (isSameConversation && sessionChatWs.isBoundTo(threadId, wsAgentId)) {
      return;
    }
    await loadMessages(id);
  }

  function bindSessionChatWs(conversationId: string) {
    const conv = conversations.value.find((item) => item.id === conversationId);
    const agentId = readMetadataAgentId(conv?.metadata);
    const threadId = Number(conv?.metadata?.threadId ?? conversationId);
    sessionChatWs.bindSession(threadId, agentId);
    sessionChatWs.setPushHandler((eventData) => {
      if (eventData.type === 'chat.proactive') {
        handleProactivePush(conversationId, eventData);
        return;
      }
      if (eventData.type === 'chat.channel_sync') {
        void loadMessages(conversationId);
        void loadConversations();
        return;
      }
      dispatchIncomingChatEvent(conversationId, eventData);
    });
    sessionChatWs.setCancelHandler(() => {
      discardActiveFollowUpMessages(conversationId);
    });
  }

  function discardActiveFollowUpMessages(conversationId: string) {
    const messages = messagesMap.value[conversationId] as TextMessage[] | undefined;
    if (!messages?.length) return;
    const next: AnyMessage[] = [];
    for (const message of messages) {
      if (!isAssistantTextMessage(message) || !hasFollowUpFlag(message) || message.status !== 'sending') {
        next.push(message);
        continue;
      }
      registerCancelledFollowUpMessage(cancelledFollowUpMessageIds.value, message);
      if (String(message.content || '').trim()) {
        next.push({ ...message, status: 'sent' });
      }
    }
    messagesMap.value[conversationId] = next;
  }

  function finalizeInterruptedFollowUps(deferredFollowUpMessages: TextMessage[], userTimestamp: Date) {
    const partialBeforeUser: TextMessage[] = [];
    for (const followUpMessage of deferredFollowUpMessages) {
      followUpMessage.status = 'sent';
      registerCancelledFollowUpMessage(cancelledFollowUpMessageIds.value, followUpMessage);
      const hasContent = Boolean(String(followUpMessage.content || '').trim());
      if (hasContent) {
        followUpMessage.timestamp = new Date(userTimestamp.getTime() - 1);
        partialBeforeUser.push(followUpMessage);
      }
    }
    return partialBeforeUser;
  }

  async function loadMessages(conversationId: string) {
    isLoadingMessages.value = true;
    try {
      if (!messagesMap.value[conversationId]) {
        messagesMap.value[conversationId] = [];
      }
      
      // 通过 HTTP API 请求该会话的历史记录
      const params = new URLSearchParams({
        size: String(HISTORY_PAGE_SIZE),
        userId: userId.value,
        sessionId: conversationId,
      });
      
      await agentsStore.fetchAgents();

      const [turnsResponse] = await Promise.all([
        fetch(getFullUrl(`/api/v1/chat/turns?${params}`))
      ]);
      if (!turnsResponse.ok) throw new Error('History fetch failed');

      const turns: any[] = await turnsResponse.json();
      oldestTurnIdMap.value[conversationId] = oldestPositiveTurnId(turns);
      hasMoreHistoryMap.value[conversationId] = turns.length >= HISTORY_PAGE_SIZE;

      // Parse memory echo historical items (recall trace + legacy retrievedFacts)
      const recallEntries = await Promise.all(
        turns
          .filter((turn: any) => turn.assistantMessage || turn.assistant_message)
          .slice(0, 40)
          .map(async (turn: any) => {
            const turnId = String(turn.id);
            let snapshot: any = turn.retrievedFacts || null;
            const numericTurnId = Number(turnId);
            const canFetchRecall = Number.isInteger(numericTurnId) && numericTurnId > 0;
            if (canFetchRecall) {
              try {
                const recallRes = await fetch(getFullUrl(`/api/v1/memory/recall/${turnId}`));
                if (recallRes.ok) {
                  snapshot = await recallRes.json();
                }
              } catch {
                // keep legacy snapshot if recall fetch fails
              }
            }
            if (!snapshot || (snapshot.empty && !snapshot.snippets?.length && !snapshot.streams?.length)) {
              if (!turn.retrievedFacts) return null;
              snapshot = turn.retrievedFacts;
            }
            const turnUserId = snapshot.userId || turn.retrievedFacts?.userId || userId.value;
            if (String(turnUserId) !== String(userId.value)) return null;
            return {
              turnId,
              sessionId: String(conversationId),
              userMessage: turn.userMessage || turn.user_message,
              assistantMessage: turn.assistantMessage || turn.assistant_message,
              timestamp: turn.timestamp || turn.created_at,
              snapshot,
            };
          }),
      );
      currentMemoryEchoes.value = recallEntries.filter(Boolean).reverse() as any[];
      const convo = conversations.value.find(c => String(c.id) === String(conversationId));
      const agentId = convo?.metadata?.agentId;
      const agent = agentsStore.agents.find(a => String(a.id) === String(agentId));

      const chronologicalTurns = [...turns];
      const formattedMessages = buildHistoricalMessages(chronologicalTurns, {
        displayName: agent?.displayName || '灵枢 AI',
        avatar: agent?.avatar || '/lingshu.png',
      });

      const taskIds = formattedMessages
        .filter((msg): msg is TextMessage => msg.type === 'text' && !msg.isSelf && Boolean(msg.metadata?.taskId))
        .map((msg) => String(msg.metadata?.taskId));

      const taskEventEntries = await Promise.all(
        taskIds.map(async (taskId) => {
          try {
            return [taskId, await fetchTaskEvents(taskId)] as const;
          } catch (err) {
            console.error(`Failed to load events for task ${taskId}:`, err);
            return [taskId, []] as const;
          }
        }),
      );

      const historicalTaskState = hydrateHistoricalTaskState(
        formattedMessages,
        Object.fromEntries(taskEventEntries),
      );

      // 兜底：老库里可能存着带 [] 情绪标签的助手消息，展示前统一剥掉。
      messagesMap.value[conversationId] = historicalTaskState.messages.map(stripHistoricalEmotionTags);

      const lastMessageId = turns.reduce((max, turn) => {
        const id = Number(turn.id);
        return Number.isFinite(id) && id > 0 && id > max ? id : max;
      }, 0);
      if (agentId && lastMessageId > 0) {
        await markAgentRead(Number(agentId), lastMessageId);
      }
    } catch (err) {
      console.error('Load messages error:', err);
    } finally {
      isLoadingMessages.value = false;
    }
  }

  function oldestPositiveTurnId(turns: any[]): number | null {
    for (const turn of turns) {
      const id = Number(turn.id);
      if (Number.isFinite(id) && id > 0) return id;
    }
    return null;
  }

  async function buildMessagesFromTurns(conversationId: string, turns: any[]): Promise<AnyMessage[]> {
    const convo = conversations.value.find(c => String(c.id) === String(conversationId));
    const agentId = convo?.metadata?.agentId;
    const agent = agentsStore.agents.find(a => String(a.id) === String(agentId));
    const formattedMessages = buildHistoricalMessages([...turns], {
      displayName: agent?.displayName || '灵枢 AI',
      avatar: agent?.avatar || '/lingshu.png',
    });

    const taskIds = formattedMessages
      .filter((msg): msg is TextMessage => msg.type === 'text' && !msg.isSelf && Boolean(msg.metadata?.taskId))
      .map((msg) => String(msg.metadata?.taskId));

    const taskEventEntries = await Promise.all(
      taskIds.map(async (taskId) => {
        try {
          return [taskId, await fetchTaskEvents(taskId)] as const;
        } catch (err) {
          console.error(`Failed to load events for task ${taskId}:`, err);
          return [taskId, []] as const;
        }
      }),
    );

    return hydrateHistoricalTaskState(
      formattedMessages,
      Object.fromEntries(taskEventEntries),
    ).messages.map(stripHistoricalEmotionTags);
  }

  async function loadOlderMessages(conversationId: string): Promise<boolean> {
    if (isLoadingOlderMessages.value) return false;
    if (hasMoreHistoryMap.value[conversationId] === false) return false;
    const beforeTurnId = oldestTurnIdMap.value[conversationId];
    if (!beforeTurnId) return false;

    isLoadingOlderMessages.value = true;
    try {
      const params = new URLSearchParams({
        size: String(HISTORY_PAGE_SIZE),
        userId: userId.value,
        sessionId: conversationId,
        beforeTurnId: String(beforeTurnId),
      });
      await agentsStore.fetchAgents();
      const res = await fetch(getFullUrl(`/api/v1/chat/turns?${params}`));
      if (!res.ok) throw new Error('Older history fetch failed');
      const turns: any[] = await res.json();
      if (!turns.length) {
        hasMoreHistoryMap.value[conversationId] = false;
        return false;
      }

      const olderMessages = await buildMessagesFromTurns(conversationId, turns);
      const existing = messagesMap.value[conversationId] || [];
      const existingIds = new Set(existing.map((msg) => String(msg.id)));
      const nextOlder = olderMessages.filter((msg) => !existingIds.has(String(msg.id)));
      messagesMap.value[conversationId] = [...nextOlder, ...existing];
      oldestTurnIdMap.value[conversationId] = oldestPositiveTurnId(turns) ?? beforeTurnId;
      hasMoreHistoryMap.value[conversationId] = turns.length >= HISTORY_PAGE_SIZE;
      return nextOlder.length > 0;
    } catch (err) {
      console.error('Load older messages error:', err);
      return false;
    } finally {
      isLoadingOlderMessages.value = false;
    }
  }

  async function sendMessage(content: string, attachments: any[] = [], mode: 'auto' | 'task' | 'chat' = 'auto', taskId?: string) {
    if (!currentConversationId.value || (!content.trim() && attachments.length === 0 && !taskId)) return;

    let effectiveTaskId = mode === 'chat' ? undefined : taskId;
    let effectiveMode = mode;

    const imageFiles = attachments.filter((a) => a.type === 'image');

    const conversationId = currentConversationId.value;
    if (!messagesMap.value[conversationId]) {
      messagesMap.value[conversationId] = [];
    }
    const conversationMessages = messagesMap.value[conversationId] as TextMessage[];

    if (effectiveMode !== 'chat' && !effectiveTaskId && (content.trim() || attachments.length > 0)) {
      effectiveTaskId = resolveContinuationTaskId(conversationMessages);
    }

    const hasNewUserPayload = Boolean(content.trim() || attachments.length > 0);
    let deferredFollowUpMessages: TextMessage[] = [];
    if (hasNewUserPayload) {
      // 必须在"将旧 sending 置为 sent"之前 partition，否则 isFollowUpAssistantMessage 永远拿不到 sending，
      // 续聊气泡无法重排到用户新消息之后，且 SSE 路由也会找错气泡。
      const partitioned = partitionFollowUpMessages(conversationMessages);
      deferredFollowUpMessages = partitioned.followUps;
      // 在用户新消息进入之前，先扫描 core 把"上一次 sendMessage 流还没结束、占位 aiMsg 一个事件都没收到"
      // 的空白占位 splice 掉（上次流的 finally 还没跑，所以不能等它清理）。
      const cleanedCore: AnyMessage[] = [];
      for (const msg of partitioned.core) {
        const m = msg as TextMessage;
        if (
          !m.isSelf
          && m.type === 'text'
          && m.status === 'sending'
          && !((m.content || '').trim())
          && !((m.metadata?.timelineEvents as unknown[] | undefined)?.length)
        ) {
          // 空白占位 aiMsg：丢弃，不要留在视图里
          continue;
        }
        cleanedCore.push(msg);
      }
      messagesMap.value[conversationId] = cleanedCore;
      // 仅清理留在原位的非续聊 bot 旧消息：避免它们再次触发 TTS 监听；续聊气泡保持 sending 等待重排+继续接 SSE。
      // 已有流式内容的进行中主回复保持 sending，后续 SSE 通过 streamOwnerId 继续写入同一气泡，避免拆成两个框。
      for (const msg of cleanedCore) {
        if (!msg.isSelf && (msg as TextMessage).status === 'sending') {
          const assistantMsg = msg as TextMessage;
          if (hasAssistantStreamProgress(assistantMsg)) {
            continue;
          }
          assistantMsg.status = 'sent';
        }
      }
    } else {
      // 任务恢复 / 无新用户载荷：旧的 sending 一律收尾
      for (const msg of conversationMessages) {
        if (!msg.isSelf && msg.status === 'sending') {
          msg.status = 'sent';
        }
      }
    }

    const interruptedFollowUps = hasNewUserPayload
      ? finalizeInterruptedFollowUps(deferredFollowUpMessages, new Date())
      : [];

    const optimisticImageMessageIds: string[] = [];
    if (content.trim() || attachments.length > 0) {
      const timestamp = new Date();
      interruptedFollowUps.forEach((message) => {
        messagesMap.value[conversationId].push(message);
      });
      const userImageMessages: ImageMessage[] = imageFiles.map((attachment, index) => {
        const messageId = createClientMessageId(`img-${index}`);
        optimisticImageMessageIds.push(messageId);
        return {
          id: messageId,
          type: 'image',
          senderId: 'user',
          senderName: '我',
          timestamp,
          status: 'sending',
          isSelf: true,
          url: attachment.url,
          thumbnailUrl: attachment.url,
          width: 960,
          height: 960,
          metadata: {
            attachmentId: attachment.id,
            fileName: attachment.name || undefined,
            sizeBytes: attachment.size || undefined,
            mimeType: attachment.file?.type || undefined,
          },
        };
      });
      userImageMessages.forEach((message) => {
        messagesMap.value[conversationId].push(message);
      });

      if (content.trim()) {
        const userMsg: TextMessage = {
          id: createClientMessageId('user'),
          type: 'text',
          senderId: 'user',
          senderName: '我',
          timestamp,
          status: 'sent',
          isSelf: true,
          content: content,
          metadata: {
            attachments: attachments.map(a => ({
              name: a.name,
              type: a.type,
              size: a.size
            }))
          }
        };
        messagesMap.value[conversationId].push(userMsg);
      }

      // 更新会话列表最后一条消息
      const conv = conversations.value.find(c => c.id === conversationId);
      if (conv) {
        conv.lastMessage = content.trim() || (imageFiles.length > 0 ? `[图片 ${imageFiles.length}]` : '');
        conv.timestamp = timestamp;
      }
    }

    // 发送消息到后端流式接口
    const convo = conversations.value.find(c => c.id === currentConversationId.value);
    const agentId = convo?.metadata?.agentId;
    const sessionId = convo?.metadata?.threadId ?? convo?.id;

    // 获取当前智能体信息
    const agent = agentsStore.agents.find(a => a.id === agentId);



    // 尝试寻找现有的 AI 消息（仅用于无用户载荷的任务恢复 SSE，例如 resumeTask 传空消息）
    // ask_user / 澄清后用户再次输入会携带同一 taskId，但必须在新的助手气泡中展示，不能追加到已结束的那一条
    let aiMsg: TextMessage | undefined;
    if (effectiveTaskId && conversationId && !hasNewUserPayload) {
      const messages = messagesMap.value[conversationId] as TextMessage[];
      const aiMsgIndex = findLastAssistantMessageIndexByTaskId(messages, effectiveTaskId);
      aiMsg = aiMsgIndex >= 0 ? messages[aiMsgIndex] : undefined;
    }

    if (aiMsg) {
      aiMsg.status = 'sending';
    } else {
      aiMsg = {
        id: createClientMessageId('assistant'),
        type: 'text',
        senderId: 'bot',
        senderName: agent?.displayName || '灵枢 AI',
        senderAvatar: agent?.avatar || '/lingshu.png',
        timestamp: new Date(),
        status: 'sending',
        isSelf: false,
        content: '',
        metadata: { taskId: effectiveTaskId } // 记录任务 ID 以便后续合并
      };
      
      if (conversationId) {
        messagesMap.value[conversationId].push(aiMsg);
      }
    }

    // 进行中的续聊已在 finalizeInterruptedFollowUps 中丢弃或排到用户消息之前，不再追加到用户消息之后。

    const patchOptimisticImageMessage = (
      messageId: string,
      uploaded: ChatImageRef,
      previewUrl: string,
    ) => {
      const messages = messagesMap.value[conversationId] as AnyMessage[];
      const imageMsg = messages.find((item) => item.id === messageId) as ImageMessage | undefined;
      if (!imageMsg || imageMsg.type !== 'image') return;
      imageMsg.url = uploaded.url;
      imageMsg.thumbnailUrl = uploaded.url;
      imageMsg.width = uploaded.width || imageMsg.width;
      imageMsg.height = uploaded.height || imageMsg.height;
      imageMsg.status = 'sent';
      imageMsg.metadata = {
        ...imageMsg.metadata,
        uploadId: uploaded.uploadId,
        mimeType: uploaded.mimeType,
        fileName: uploaded.fileName || imageMsg.metadata?.fileName,
        sizeBytes: uploaded.sizeBytes || imageMsg.metadata?.sizeBytes,
        summaryText: uploaded.summaryText || undefined,
      };
      if (previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };

    const markOptimisticImageFailed = (messageId: string, error: unknown) => {
      const messages = messagesMap.value[conversationId] as AnyMessage[];
      const imageMsg = messages.find((item) => item.id === messageId) as ImageMessage | undefined;
      if (!imageMsg || imageMsg.type !== 'image') return;
      imageMsg.status = 'failed';
      imageMsg.metadata = {
        ...imageMsg.metadata,
        uploadError: error instanceof Error ? error.message : String(error),
      };
    };

    const images: ChatImageRef[] = [];
    for (let index = 0; index < imageFiles.length; index += 1) {
      const attachment = imageFiles[index];
      const messageId = optimisticImageMessageIds[index];
      const previewUrl = String(attachment.url || '');
      try {
        const uploaded = await uploadChatImage(attachment.file);
        images.push(uploaded);
        patchOptimisticImageMessage(messageId, uploaded, previewUrl);
      } catch (err) {
        console.error('Failed to upload image', err);
        markOptimisticImageFailed(messageId, err);
        if (aiMsg) {
          aiMsg.content = '⚠️ 图片上传失败：' + ((err as Error).message || '未知错误');
          aiMsg.status = 'failed';
        }
        throw err;
      }
    }

    // 使用流式 API
    const payload = {
      message: content,
      images: images,
      userId: userId.value,
      sessionId: sessionId,
      agentId: agentId,
      mode: effectiveMode,
      taskId: effectiveTaskId
    };

    logChatRequestDebug('chat.ws.request', {
      source: content.trim() || attachments.length > 0 ? (effectiveTaskId ? 'user_continuation' : 'user_message') : 'task_resume_ws',
      sessionId,
      agentId,
      taskId: effectiveTaskId || null,
      mode: effectiveMode,
      messageLength: content.length,
      message: content,
      attachmentCount: attachments.length,
      imageCount: images.length,
    });

    try {
      bindSessionChatWs(conversationId);
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await sessionChatWs.sendChat(payload, {
        requestId,
        onEvent: (eventData) => {
          if (eventData.type === 'chat.started') return;
          dispatchChatEvent(conversationId, eventData, { streamOwnerId: aiMsg?.id });
        },
      });

      const aiMessageId = aiMsg?.id;

      // 发送中的任务仅依赖 SSE 增量事件更新，避免流结束后被 /events 回放覆盖。
      // /events 只在切换会话加载历史时使用（loadMessages）。

      // 流式传输完成，更新状态
      const messages = messagesMap.value[conversationId] as TextMessage[];
      if (messages && messages.length > 0) {
        finalizeAssistantStreamMessages(messages, aiMessageId);
        const conv = conversations.value.find(c => c.id === conversationId);
        if (conv) {
          const lastAssistant = [...messages].reverse().find((message) => isAssistantTextMessage(message));
          if (lastAssistant) {
            conv.lastMessage = assistantPreviewText(lastAssistant.content);
          }
        }
        const echoAnchor = aiMessageId
          ? messages.find((m) => m.id === aiMessageId)
          : [...messages].reverse().find((m) => isAssistantTextMessage(m));
        const echoMeta = (echoAnchor as TextMessage | undefined)?.metadata || {};
        const echoTurnId = normalizeTurnId(
          echoMeta.persistedTurnId ?? echoMeta.messageId ?? echoMeta.turnId,
        );
        const inlineSnapshot =
          echoMeta.recallSnapshot && typeof echoMeta.recallSnapshot === 'object'
            ? (echoMeta.recallSnapshot as Record<string, unknown>)
            : null;
        if (echoTurnId || inlineSnapshot) {
          void refreshMemoryEchoForTurn({
            conversationId,
            turnId: echoTurnId || '',
            assistantMessage: String((echoAnchor as TextMessage | undefined)?.content || ''),
            snapshot: inlineSnapshot,
          });
        }
      }
    } catch (err) {
      console.error('Stream error:', err);
      // 更新错误状态
      const messages = messagesMap.value[conversationId] as TextMessage[];
      if (messages && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.type === 'text' && !lastMsg.isSelf) {
          lastMsg.content = '⚠️ 消息发送失败：' + (err as Error).message;
          lastMsg.status = 'failed';
        }
      }
    }
  }

  function createOptimisticVoiceTurn(
    content: string,
    options: {
      mode?: 'push' | 'call';
      source?: string;
      transport?: string;
      utteranceId?: string;
      durationMs?: number;
      sampleRate?: number;
      decodeS?: number;
      rtf?: number;
      serviceS?: number;
      startS?: number;
      platform?: string;
      asrModel?: string;
      audioUrl?: string;
      audioSegmentId?: string;
      audioMimeType?: string;
      attachments?: any[];
    } = {},
  ) {
    const trimmed = content.trim();
    const imageFiles = (options.attachments || []).filter((attachment) => attachment.type === 'image');
    const conversationId = currentConversationId.value;
    if (!conversationId || (!trimmed && imageFiles.length === 0)) return null;

    if (!messagesMap.value[conversationId]) {
      messagesMap.value[conversationId] = [];
    }

    const conversationMessages = messagesMap.value[conversationId] as TextMessage[];
    // 语音新回合：仅未结束的续聊须整体排在用户新消息之前（已完成的续聊在历史中保持原位）
    const partitioned = partitionFollowUpMessages(conversationMessages);
    const deferredFollowUpMessages = partitioned.followUps;
    messagesMap.value[conversationId] = partitioned.core;
    for (const msg of partitioned.core) {
      if (!msg.isSelf && (msg as TextMessage).status === 'sending') {
        const assistantMsg = msg as TextMessage;
        if (options.mode === 'call') {
          assistantMsg.status = 'sent';
          assistantMsg.metadata = {
            ...assistantMsg.metadata,
            interrupted: true,
          };
          continue;
        }
        if (hasAssistantStreamProgress(assistantMsg)) {
          continue;
        }
        assistantMsg.status = 'sent';
      }
    }

    const convo = conversations.value.find((item) => item.id === conversationId);
    const agentId = convo?.metadata?.agentId;
    const agent = agentsStore.agents.find((item) => item.id === agentId);
    const timestamp = new Date();
    const userMessageId = createClientMessageId('voice-user');
    const assistantMessageId = createClientMessageId('voice-assistant');

    const userMsg: TextMessage = {
      id: userMessageId,
      type: 'text',
      senderId: 'user',
      senderName: '我',
      timestamp,
      status: 'sent',
      isSelf: true,
      content: trimmed,
      metadata: {
        assistantMessageId,
        input: {
          kind: 'voice',
          mode: options.mode || 'call',
          source: options.source,
          transport: options.transport,
          utteranceId: options.utteranceId,
          durationMs: options.durationMs,
          sampleRate: options.sampleRate,
          decodeS: options.decodeS,
          rtf: options.rtf,
          serviceS: options.serviceS,
          startS: options.startS,
          platform: options.platform,
          asrModel: options.asrModel,
          audioUrl: options.audioUrl,
          audioSegmentId: options.audioSegmentId,
          audioMimeType: options.audioMimeType,
        },
      },
    };

    const assistantMsg: TextMessage = {
      id: assistantMessageId,
      type: 'text',
      senderId: 'bot',
      senderName: agent?.displayName || '灵枢 AI',
      senderAvatar: agent?.avatar || '/lingshu.png',
      timestamp: new Date(),
      status: 'sending',
      isSelf: false,
      content: '',
      metadata: {
        messageId: assistantMessageId,
        timelineEvents: [],
        taskEvents: [],
      },
    };

    // 语音新回合：续聊属于上一轮，须排在用户新消息之前（sendMessage 则仍把续聊放在用户之后，避免任务流穿插）。
    if (deferredFollowUpMessages.length > 0) {
      const requeueAt = new Date(timestamp.getTime() - 1);
      for (const followUpMessage of deferredFollowUpMessages) {
        followUpMessage.timestamp = requeueAt;
        followUpMessage.status = 'sent';
        messagesMap.value[conversationId].push(followUpMessage);
      }
    }

    const optimisticImageMessageIds: string[] = [];
    const userImageMessages: ImageMessage[] = imageFiles.map((attachment, index) => {
      const messageId = createClientMessageId(`voice-img-${index}`);
      optimisticImageMessageIds.push(messageId);
      return {
        id: messageId,
        type: 'image',
        senderId: 'user',
        senderName: '我',
        timestamp,
        status: 'sending',
        isSelf: true,
        url: attachment.url,
        thumbnailUrl: attachment.url,
        width: 960,
        height: 960,
        metadata: {
          attachmentId: attachment.id,
          fileName: attachment.name || undefined,
          sizeBytes: attachment.size || undefined,
          mimeType: attachment.file?.type || undefined,
        },
      };
    });
    userImageMessages.forEach((message) => {
      messagesMap.value[conversationId].push(message);
    });

    if (trimmed) {
      messagesMap.value[conversationId].push(userMsg);
    }
    messagesMap.value[conversationId].push(assistantMsg);

    if (convo) {
      convo.lastMessage = trimmed || (imageFiles.length > 0 ? `[图片 ${imageFiles.length}]` : '');
      convo.timestamp = timestamp;
    }

    return {
      conversationId,
      userMessageId,
      assistantMessageId,
      optimisticImageMessageIds,
    };
  }

  async function uploadVoiceAttachmentImages(
    conversationId: string,
    attachments: any[],
    optimisticImageMessageIds: string[],
    assistantMessageId: string,
  ): Promise<ChatImageRef[]> {
    const imageFiles = attachments.filter((attachment) => attachment.type === 'image');
    const images: ChatImageRef[] = [];
    for (let index = 0; index < imageFiles.length; index += 1) {
      const attachment = imageFiles[index];
      const messageId = optimisticImageMessageIds[index];
      const previewUrl = String(attachment.url || '');
      try {
        const uploaded = await uploadChatImage(attachment.file);
        images.push(uploaded);
        const messages = messagesMap.value[conversationId] as AnyMessage[];
        const imageMsg = messages.find((item) => item.id === messageId) as ImageMessage | undefined;
        if (imageMsg && imageMsg.type === 'image') {
          imageMsg.url = uploaded.url;
          imageMsg.thumbnailUrl = uploaded.url;
          imageMsg.width = uploaded.width || imageMsg.width;
          imageMsg.height = uploaded.height || imageMsg.height;
          imageMsg.status = 'sent';
          imageMsg.metadata = {
            ...imageMsg.metadata,
            uploadId: uploaded.uploadId,
            mimeType: uploaded.mimeType,
            fileName: uploaded.fileName || imageMsg.metadata?.fileName,
            sizeBytes: uploaded.sizeBytes || imageMsg.metadata?.sizeBytes,
            summaryText: uploaded.summaryText || undefined,
          };
          if (previewUrl.startsWith('blob:')) {
            URL.revokeObjectURL(previewUrl);
          }
        }
      } catch (err) {
        const messages = messagesMap.value[conversationId] as AnyMessage[];
        const imageMsg = messages.find((item) => item.id === messageId) as ImageMessage | undefined;
        if (imageMsg && imageMsg.type === 'image') {
          imageMsg.status = 'failed';
          imageMsg.metadata = {
            ...imageMsg.metadata,
            uploadError: err instanceof Error ? err.message : String(err),
          };
        }
        markAssistantMessageFailed(
          conversationId,
          assistantMessageId,
          `图片上传失败：${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }
    return images;
  }

  function updateVoiceUserMessage(assistantMessageId: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    for (const messages of Object.values(messagesMap.value)) {
      const list = messages as AnyMessage[];
      let userMsg = list.find(
        (m) => isVoiceUserMessage(m) && (m as TextMessage).metadata?.assistantMessageId === assistantMessageId,
      );
      if (!userMsg) {
        const aIdx = list.findIndex(
          (m) => isAssistantTextMessage(m) && (m as TextMessage).metadata?.messageId === assistantMessageId,
        );
        if (aIdx >= 0) {
          userMsg = list[aIdx - 1];
        }
      }
      if (userMsg && isVoiceUserMessage(userMsg)) {
        (userMsg as TextMessage).content = trimmed;
        break;
      }
    }
  }

  async function resumeTask(taskId: string) {
    logChatRequestDebug('task.resume.request', {
      taskId,
      requestedBy: userId.value,
    });
    const res = await fetch(getFullUrl(`/api/v1/tasks/${taskId}/resume`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: userId.value })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      const detail = typeof error?.detail === 'string' ? error.detail : '';
      throw new Error(detail || `Task resume failed (${res.status})`);
    }
    const data = await res.json();
    
    // 重新发起 SSE 请求以接续任务
    logChatRequestDebug('task.resume.followup_sse', {
      taskId,
      mode: 'task',
      message: '',
    });
    await sendMessage('', [], 'task', taskId);
    return data;
  }

  async function cancelTask(taskId: string) {
    const res = await fetch(getFullUrl(`/api/v1/tasks/${taskId}/cancel`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: userId.value })
    });
    if (!res.ok) throw new Error('Task cancel failed');
    return await res.json();
  }

  function dispatchChatEvent(
    conversationId: string,
    eventData: IncomingChatEventPayload,
    options?: { streamOwnerId?: string },
  ) {
    const eventType = normalizeEventType(eventData.type);
    if (!eventType) return;

    // 处理技能激活状态更新
    if (eventData.metadata?.active_skills) {
      activeSkillsMap.value[conversationId] = eventData.metadata.active_skills as string[];
    }
    const target = getChatEventRenderTarget(eventType);

    const messages = messagesMap.value[conversationId] as AnyMessage[];
    if (!messages || messages.length === 0) return;

    if (eventType === 'image' || target === 'message_image') {
      const meta = eventData.metadata || {};
      const uploadId = String(meta.uploadId || meta.upload_id || '').trim();
      const rawUrl = String(meta.url || eventData.content || '').trim();
      if (!rawUrl) return;
      const imageId = `a-img-${uploadId || eventData.eventId || Date.now()}`;
      if (messages.some((item) => item.id === imageId)) return;
      const convo = conversations.value.find((item) => item.id === conversationId);
      const agentId = convo?.metadata?.agentId;
      const agent = agentsStore.agents.find((item) => item.id === agentId);
      const imageMessage: ImageMessage = {
        id: imageId,
        type: 'image',
        senderId: 'bot',
        senderName: agent?.displayName || '灵枢 AI',
        senderAvatar: agent?.avatar || '/lingshu.png',
        timestamp: new Date(),
        status: 'sent',
        isSelf: false,
        url: getFullUrl(rawUrl),
        thumbnailUrl: getFullUrl(rawUrl),
        width: Number(meta.width) || 960,
        height: Number(meta.height) || 960,
        metadata: {
          uploadId: uploadId || undefined,
          mimeType: (meta.mimeType || meta.mime_type || undefined) as string | undefined,
          fileName: (meta.fileName || meta.file_name || undefined) as string | undefined,
          sizeBytes: (meta.sizeBytes || meta.size_bytes || undefined) as number | undefined,
          summaryText: (meta.summaryText || meta.summary_text || undefined) as string | undefined,
        },
      };
      // Insert before the trailing sending assistant text bubble when present.
      const sendingIdx = messages.findLastIndex(
        (m) => m.type === 'text' && !m.isSelf && m.status === 'sending',
      );
      if (sendingIdx !== -1) {
        messages.splice(sendingIdx, 0, imageMessage);
      } else {
        messages.push(imageMessage);
      }
      return;
    }

    const followUpMessageId = typeof eventData.messageId === 'string' ? eventData.messageId : '';
    const isFollowUpAssistantEvent = Boolean(
      (eventData.metadata?.follow_up || eventData.metadata?.followUp) && followUpMessageId,
    );

    if (
      followUpMessageId
      && isCancelledFollowUpMessageId(cancelledFollowUpMessageIds.value, followUpMessageId)
    ) {
      return;
    }

    if (isFollowUpAssistantEvent && findAssistantMessageIndexByMessageId(messages, followUpMessageId) === -1) {
      // 优先认领 sendMessage 刚创建、内容仍空的占位 aiMsg —— 后端常以 follow_up=true + 新 messageId
      // 形式推送新轮次主响应，如果都 push 独立气泡，占位 aiMsg 永远是个空"..."。
      // 认领后该气泡被打上 followUp=true，下方非 follow_up 事件用 primary-only 路由（排除 followUp），
      // 不会再被同轮次的其它非续聊事件二次写入造成 merge。
      const placeholderIdx = messages.findLastIndex((m) => {
        if (!isAssistantTextMessage(m)) return false;
        const tm = m as TextMessage;
        if (tm.status !== 'sending') return false;
        if (tm.metadata?.messageId) return false;
        if ((tm.content || '').trim()) return false;
        const timeline = (tm.metadata?.timelineEvents as unknown[] | undefined) || [];
        if (timeline.length > 0) return false;
        return true;
      });
      if (placeholderIdx !== -1) {
        const placeholder = messages[placeholderIdx] as TextMessage;
        placeholder.metadata = {
          ...placeholder.metadata,
          messageId: followUpMessageId,
          taskId: eventData.taskId || placeholder.metadata?.taskId,
          turnId: eventData.turnId ? String(eventData.turnId) : (placeholder.metadata?.turnId as string | undefined),
          followUp: true,
          timelineEvents: (placeholder.metadata?.timelineEvents as UnifiedChatEvent[] | undefined) || [],
          taskEvents: (placeholder.metadata?.taskEvents as UnifiedChatEvent[] | undefined) || [],
        };
      } else {
        const convo = conversations.value.find((item) => item.id === conversationId);
        const agentId = convo?.metadata?.agentId;
        const agent = agentsStore.agents.find((item) => item.id === agentId);
        messages.push({
          id: `assistant-${followUpMessageId}`,
          type: 'text',
          senderId: 'bot',
          senderName: agent?.displayName || '灵枢 AI',
          senderAvatar: agent?.avatar || '/lingshu.png',
          timestamp: new Date(),
          status: 'sending',
          isSelf: false,
          content: '',
          metadata: {
            messageId: followUpMessageId,
            taskId: eventData.taskId || undefined,
            turnId: eventData.turnId ? String(eventData.turnId) : undefined,
            followUp: true,
            timelineEvents: [],
            taskEvents: [],
          },
        });
      }
    }

    // 寻址逻辑：优先匹配 taskId，否则使用最后一条消息
    let targetIdx = messages.findLastIndex((message) => isAssistantTextMessage(message));
    if (targetIdx === -1) {
      targetIdx = messages.length - 1;
    }
    if (followUpMessageId) {
      const messageIdx = findAssistantMessageIndexByMessageId(messages, followUpMessageId);
      if (messageIdx !== -1) {
        targetIdx = messageIdx;
      }
    }
    const streamOwnerId = options?.streamOwnerId;
    let routedByStreamOwner = false;
    if (!isFollowUpAssistantEvent) {
      const ownerIdx = resolveStreamOwnerIndex(messages, {
        explicitId: streamOwnerId,
        backendMessageId: followUpMessageId || undefined,
      });
      if (ownerIdx !== -1) {
        targetIdx = ownerIdx;
        routedByStreamOwner = Boolean(streamOwnerId || followUpMessageId);
      }
    }
    if (eventData.taskId && !routedByStreamOwner) {
      if (isFollowUpAssistantEvent) {
        // 续聊事件已在上面通过 messageId 路由（或刚 push/认领出气泡），此处不再用 taskId 抢路由。
      } else {
        // 新轮次主响应：只匹配 sending 且非续聊的气泡（即 sendMessage 的未被认领的占位 aiMsg）。
        // 故意不 fallback 到 findLastAssistantMessageIndexByTaskId —— 否则会落到已被认领为
        // followUp 的占位 / 已 sent 的旧续聊气泡上，把不同消息内容拼接到一起（merge 乱序 bug）。
        const primarySendingIdx = findLastSendingPrimaryAssistantIndexByTaskId(messages, eventData.taskId);
        if (primarySendingIdx !== -1) {
          targetIdx = primarySendingIdx;
          if (targetIdx !== messages.length - 1 && eventData.type !== 'text_delta') {
            lastMergedMessageId.value = messages[targetIdx].id;
          }
        }
      }
    }

    const lastMsg = messages[targetIdx] as TextMessage;
    const ownerIdxForDedup = streamOwnerId ? getStreamOwnerIndex(messages, streamOwnerId) : -1;
    const dedupMessage = ownerIdxForDedup >= 0 ? (messages[ownerIdxForDedup] as TextMessage) : lastMsg;
    const seenEventIds = (dedupMessage.metadata?.seenEventIds as string[] | undefined) || [];
    if (eventData.eventId && seenEventIds.includes(eventData.eventId)) return;

    if (target === 'message_text' && eventData.content) {
      const bubbleIndex = parseBubbleIndex(eventData.metadata?.bubbleIndex) ?? 0;
      const turnId = normalizeTurnId(eventData.turnId);
      const ownerIdx = resolveStreamOwnerIndex(messages, {
        explicitId: streamOwnerId,
        backendMessageId: followUpMessageId || undefined,
      });
      const resolvedOwnerIdx = ownerIdx !== -1 ? ownerIdx : targetIdx;
      const effectiveStreamOwnerId = messages[resolvedOwnerIdx]?.id || lastMsg.id;

      if (turnId && resolvedOwnerIdx !== -1) {
        const owner = messages[resolvedOwnerIdx] as TextMessage;
        const segmentTexts = readSegmentTexts(owner);
        while (segmentTexts.length <= bubbleIndex) segmentTexts.push('');
        segmentTexts[bubbleIndex] = (segmentTexts[bubbleIndex] || '') + eventData.content;
        writeSegmentTexts(owner, segmentTexts);
        syncSegmentMessagesFromTexts(messages, {
          streamOwnerId: effectiveStreamOwnerId,
          turnId,
          segmentTexts,
          template: owner,
        });

        const targetSegmentIdx = findAssistantSegmentIndexByTurnBubble(messages, turnId, bubbleIndex);
        const resolvedIdx = targetSegmentIdx >= 0 ? targetSegmentIdx : resolvedOwnerIdx;
        const segmentMsg = messages[resolvedIdx] as TextMessage;
        const nextSeenEventIds = eventData.eventId ? [...seenEventIds, eventData.eventId] : seenEventIds;
        const ownerTimelineEvents = appendTimelineEvent(owner, eventData, eventType);

        messages[resolvedOwnerIdx] = {
          ...(messages[resolvedOwnerIdx] as TextMessage),
          metadata: {
            ...(messages[resolvedOwnerIdx] as TextMessage).metadata,
            seenEventIds: nextSeenEventIds,
            segmentTexts,
            timelineEvents: ownerTimelineEvents,
          },
        };
        messages[resolvedIdx] = {
          ...segmentMsg,
          metadata: {
            ...segmentMsg.metadata,
            ...metadataWithoutDeltaTtsText(eventData.metadata),
            turnId,
            bubbleIndex,
            segmentGroupId: effectiveStreamOwnerId,
            ...(followUpMessageId ? { messageId: followUpMessageId } : {}),
            ...(isFollowUpAssistantEvent ? { followUp: true } : {}),
            seenEventIds: bubbleIndex === 0 ? nextSeenEventIds : (segmentMsg.metadata?.seenEventIds as string[] | undefined) || [],
          },
        };
        accumulateTtsText(
          messages[resolvedOwnerIdx] as TextMessage,
          typeof eventData.metadata?.ttsText === 'string' ? (eventData.metadata.ttsText as string) : '',
        );

        const conv = conversations.value.find(c => c.id === conversationId);
        if (conv) {
          const lastSegment = segmentTexts.filter((part) => part.trim()).at(-1) || segmentTexts.at(-1) || '';
          conv.lastMessage = assistantPreviewText(lastSegment);
        }
        return;
      }

      const nextSeenEventIds = eventData.eventId ? [...seenEventIds, eventData.eventId] : seenEventIds;
      const timelineEvents = appendTimelineEvent(lastMsg, eventData, eventType);
      messages[targetIdx] = {
        ...lastMsg,
        content: lastMsg.content + eventData.content,
        metadata: {
          ...lastMsg.metadata,
          ...metadataWithoutDeltaTtsText(eventData.metadata),
          ...(followUpMessageId ? { messageId: followUpMessageId } : {}),
          ...(isFollowUpAssistantEvent ? { followUp: true } : {}),
          ...(turnId ? { turnId } : {}),
          seenEventIds: nextSeenEventIds,
          timelineEvents,
        },
      };
      accumulateTtsText(
        messages[targetIdx] as TextMessage,
        typeof eventData.metadata?.ttsText === 'string' ? (eventData.metadata.ttsText as string) : '',
      );
      const conv = conversations.value.find(c => c.id === conversationId);
      if (conv) conv.lastMessage = assistantPreviewText(String((messages[targetIdx] as TextMessage).content || ''));
      return;
    }

    if (eventType === 'tts_stop') {
      const stopToken = eventData.eventId || `${Date.now()}`;
      messages[targetIdx] = {
        ...lastMsg,
        metadata: {
          ...lastMsg.metadata,
          ttsStopToken: stopToken,
        }
      };
      const existingSegments = Array.isArray(messages[targetIdx].metadata?.ttsSegments)
        ? (messages[targetIdx].metadata?.ttsSegments as Array<{ segmentId?: string; audioUrl?: string; text?: string; seq?: number; mimeType?: string; audioBase64?: string }>)
        : [];
      latestTtsSignal.value = {
        messageId: lastMsg.id,
        segments: existingSegments,
        stopToken: stopToken,
        timestamp: lastMsg.timestamp ? new Date(lastMsg.timestamp).getTime() : Date.now(),
      };
      return;
    }

    if (eventType === 'tts_segment') {
      const isFollowUpTts = Boolean(
        eventData.metadata?.follow_up
        || eventData.metadata?.followUp
        || eventData.metadata?.server_initiated
        || eventData.metadata?.serverInitiated,
      );
      if (isFollowUpTts) {
        console.info('[followup-tts] tts_segment received', {
          messageId: lastMsg.id,
          backendMessageId: followUpMessageId || eventData.messageId,
          segmentId: eventData.metadata?.segmentId,
        });
      }
      const existingSegments = Array.isArray(lastMsg.metadata?.ttsSegments)
        ? (lastMsg.metadata?.ttsSegments as Record<string, unknown>[])
        : [];
      const segmentId = typeof eventData.metadata?.segmentId === 'string' ? eventData.metadata.segmentId : '';
      const hasSegment = segmentId
        ? existingSegments.some((segment) => segment.segmentId === segmentId)
        : false;
      if (!hasSegment) {
        const newSegment = {
          segmentId,
          audioUrl: eventData.metadata?.audioUrl,
          text: eventData.metadata?.text,
          seq: eventData.metadata?.seq,
          mimeType: eventData.metadata?.mimeType,
          format: eventData.metadata?.format,
          sampleRate: typeof eventData.metadata?.sampleRate === 'number' ? eventData.metadata.sampleRate : undefined,
          audioBase64: eventData.metadata?.audioBase64,
        };
        const updatedSegments = [...existingSegments, newSegment];
        messages[targetIdx] = {
          ...lastMsg,
          metadata: {
            ...lastMsg.metadata,
            ttsSegments: updatedSegments
          }
        };
        latestTtsSignal.value = {
          messageId: lastMsg.id,
          segments: updatedSegments as any,
          stopToken: (messages[targetIdx].metadata?.ttsStopToken as string | undefined) || null,
          timestamp: lastMsg.timestamp ? new Date(lastMsg.timestamp).getTime() : Date.now(),
        };
      }
      return;
    }

    // 如果该消息还没有绑定 taskId，现在绑定它
    if (eventData.taskId && isAssistantTextMessage(lastMsg) && !lastMsg.metadata?.taskId) {
      lastMsg.metadata = { ...lastMsg.metadata, taskId: eventData.taskId };
    }
    if (followUpMessageId && isAssistantTextMessage(lastMsg) && lastMsg.metadata?.messageId !== followUpMessageId) {
      lastMsg.metadata = { ...lastMsg.metadata, messageId: followUpMessageId };
    }
    const nextSeenEventIds = eventData.eventId ? [...seenEventIds, eventData.eventId] : seenEventIds;
    const timelineEvents = appendTimelineEvent(lastMsg, eventData, eventType);

    if (target === 'message_error') {
      messages[targetIdx] = {
        ...lastMsg,
        content: eventData.content ? `⚠️ ${eventData.content}` : '⚠️ 处理失败',
        status: 'failed',
        metadata: {
          ...lastMsg.metadata,
          ...eventData.metadata,
          ...(followUpMessageId ? { messageId: followUpMessageId } : {}),
          ...(eventData.turnId ? { turnId: String(eventData.turnId) } : {}),
          run_status: 'failed',
          seenEventIds: nextSeenEventIds,
          timelineEvents
        }
      };
      return;
    }

    if (target === 'task_workbench' || target === 'tool_approval' || target === 'stream_lifecycle' || target === 'terminal_panel') {
      // 如果是工具审批，更新全局状态
      if (target === 'tool_approval') {
        const approval = eventData.metadata?.approval as Record<string, unknown> | undefined
        if (approval && typeof approval.call_id === 'string') {
          pendingApproval.value = {
            callId: approval.call_id,
            toolName: typeof approval.tool_name === 'string' ? approval.tool_name : '',
            args: (approval.arguments as Record<string, unknown>) || {},
            taskId: eventData.taskId || ''
          }
        }
      }

      // done 事件常不带 run_status；不能回落到此前工具阶段写入的 running，否则会卡在 sending。
      const rawStatus = (eventData.metadata?.run_status as string)
        || (eventType === 'done' ? 'done' : undefined)
        || (lastMsg.metadata?.run_status as string);
      const normalizedStatus = normalizeRunStatus(rawStatus, eventType === 'done');
      const interrupted = Boolean(eventData.metadata?.interrupted || eventData.metadata?.cancelledByUser);
      if (interrupted && eventType === 'done' && !String(lastMsg.content || '').trim()) {
        messages.splice(targetIdx, 1);
        return;
      }

      // done 事件带 ttsText 时，说明这条消息的朗读文本与展示文本不同（含 [] 情绪标签）。
      const doneTtsText = typeof eventData.metadata?.ttsText === 'string'
        ? (eventData.metadata.ttsText as string)
        : '';
      const updatedMsg: TtsTextMessage = {
        ...lastMsg,
        ...(doneTtsText ? { ttsText: doneTtsText } : {}),
        status: (normalizedStatus === 'done' || normalizedStatus === 'failed') ? 'sent' : lastMsg.status,
        metadata: {
          ...lastMsg.metadata,
          ...eventData.metadata,
          ...(followUpMessageId ? { messageId: followUpMessageId } : {}),
          ...(isFollowUpAssistantEvent ? { followUp: true } : {}),
          ...(eventData.turnId ? { turnId: String(eventData.turnId) } : {}),
          ...(doneTtsText ? { ttsText: doneTtsText } : {}),
          run_status: normalizedStatus,
          seenEventIds: nextSeenEventIds,
          taskEvents: timelineEvents.filter((event) => event.type !== 'text_delta' && event.type !== 'error'),
          timelineEvents
        }
      };
      messages[targetIdx] = updatedMsg;

      if (doneTtsText && followUpMessageId) {
        // 续聊 / 独立气泡：把朗读文本挂到真正对应后端 messageId 的那条助手消息上。
        const ttsTargetIdx = findAssistantMessageIndexByMessageId(messages, followUpMessageId);
        if (ttsTargetIdx !== -1 && ttsTargetIdx !== targetIdx) {
          const ttsTarget = messages[ttsTargetIdx] as TextMessage;
          messages[ttsTargetIdx] = {
            ...ttsTarget,
            ttsText: doneTtsText,
            metadata: { ...ttsTarget.metadata, ttsText: doneTtsText },
          } as TtsTextMessage;
        }
      }

      if (eventData.taskId && isTerminalTaskStatus(normalizedStatus)) {
        syncTerminalTaskStatusAcrossMessages(messages, {
          taskId: eventData.taskId,
          normalizedStatus,
          eventType,
          eventData,
        });
      }

      if (eventType === 'done' && (normalizedStatus === 'done' || normalizedStatus === 'failed')) {
        const meta = (eventData.metadata || {}) as Record<string, unknown>;
        const echoTurnId = normalizeTurnId(
          meta.persistedTurnId
          ?? meta.messageId
          ?? eventData.turnId
          ?? updatedMsg.metadata?.persistedTurnId
          ?? updatedMsg.metadata?.turnId,
        );
        const inlineSnapshot =
          meta.recallSnapshot && typeof meta.recallSnapshot === 'object'
            ? (meta.recallSnapshot as Record<string, unknown>)
            : null;
        if (echoTurnId || inlineSnapshot) {
          void refreshMemoryEchoForTurn({
            conversationId,
            turnId: echoTurnId || '',
            assistantMessage: String(updatedMsg.content || ''),
            snapshot: inlineSnapshot,
          });
        }
      }
      return;
    }
  }

  function dispatchIncomingChatEvent(
    conversationId: string,
    eventData: IncomingChatEventPayload,
    options?: { streamOwnerId?: string },
  ) {
    const messages = messagesMap.value[conversationId] as TextMessage[] | undefined;
    const streamOwnerId = messages?.length
      ? resolveStreamOwnerId(messages, eventData, options?.streamOwnerId)
      : options?.streamOwnerId;
    dispatchChatEvent(
      conversationId,
      eventData,
      streamOwnerId ? { streamOwnerId } : undefined,
    );
  }

  function markAssistantMessageFailed(conversationId: string, assistantMessageId: string, errorMessage: string) {
    dispatchChatEvent(conversationId, {
      type: 'error',
      content: errorMessage,
      messageId: assistantMessageId,
      metadata: {},
    });
  }

  function normalizeRunStatus(status: string | undefined, isEventDone: boolean): string {
    if (isEventDone && (!status || status === 'running')) return 'done';
    if (!status) return isEventDone ? 'done' : 'running';
    const map: Record<string, string> = {
      'task_completed': 'done',
      'human_interrupt': 'interrupted',
      'failure_threshold': 'failed',
      'budget_exhausted': 'budget_exhausted',
      'canceled': 'canceled',
      'running': 'running',
      'done': 'done'
    };
    return map[status] || status;
  }

  function appendTimelineEvent(
    message: TextMessage,
    eventData: { type?: string; eventId?: string; content?: string; metadata?: Record<string, unknown>; taskId?: string },
    eventType: UnifiedChatEventType,
  ): UnifiedChatEvent[] {
    const existing = (message.metadata?.timelineEvents as UnifiedChatEvent[]) || [];
    const eventSequence = Number((eventData as Record<string, unknown>).eventSequence || 0);

    // 幂等性检查：如果该序列号已存在，跳过追加
    if (eventSequence > 0 && existing.some(e => e.eventSequence === eventSequence)) {
      return existing;
    }

    const normalizedEvent: UnifiedChatEvent = {
      type: eventType,
      eventId: eventData.eventId || `${eventType}-${existing.length + 1}`,
      sessionId: null,
      turnId: null,
      taskId: eventData.taskId || null,
      eventSequence: eventSequence || existing.length + 1,
      timestamp: String((eventData as Record<string, unknown>).timestamp || new Date().toISOString()),
      content: eventData.content ?? null,
      metadata: eventData.metadata || {},
      parentEventId: ((eventData as Record<string, unknown>).parentEventId as string | null | undefined) || null,
      depth: Number((eventData as Record<string, unknown>).depth || 0),
      attemptNo: Number((eventData as Record<string, unknown>).attemptNo || 1),
      attemptGroupId: ((eventData as Record<string, unknown>).attemptGroupId as string | null | undefined) || null,
      branchId: ((eventData as Record<string, unknown>).branchId as string | null | undefined) || null,
    };
    return [...existing, normalizedEvent].sort((left, right) => left.eventSequence - right.eventSequence);
  }

  async function fetchTaskEvents(taskId: string): Promise<UnifiedChatEvent[]> {
    try {
      const res = await fetch(getFullUrl(`/api/v1/tasks/${taskId}/events`));
      if (!res.ok) return [];
      const data: any[] = await res.json();
      
      return data.map(item => ({
        type: (item.stepType || 'state') as UnifiedChatEventType,
        eventId: item.eventId,
        taskId: item.taskId,
        parentEventId: item.parentEventId,
        eventSequence: item.eventSequence,
        timestamp: item.timestamp,
        content: item.payload?.content || item.payload?.preview || null,
        depth: item.depth || 0,
        attemptNo: item.attemptNo || 1,
        attemptGroupId: item.attemptGroupId,
        branchId: item.branchId,
        metadata: {
          ...item.payload,
          node_name: item.nodeName,
          run_status: item.payload?.run_status || (item.stepType === 'done' ? 'done' : undefined)
        }
      })).sort((a, b) => a.eventSequence - b.eventSequence);
    } catch (err) {
      console.error('Fetch task events error:', err);
      return [];
    }
  }

  function normalizeEventType(type: string | undefined): UnifiedChatEventType | null {
    if (!type) return null;
    if (type === 'text') return 'text_delta';
    if (type === 'call') return 'tool_call';
    if (type === 'result') return 'tool_result';
    return isUnifiedChatEventType(type) ? type : null;
  }



  function retrySendMessage(_messageId: string) {
    // TODO: 重发失败消息
  }

  function setSearchQuery(query: string) {
    searchQuery.value = query;
  }

  function setActiveNav(nav: string) {
    activeNav.value = nav;
  }

  function setAgentId(agentId: number | null) {
    currentAgentId.value = agentId;
    // 同时更新当前会话的元数据
    const conv = conversations.value.find(c => c.id === currentConversationId.value);
    if (conv) {
      if (!conv.metadata) conv.metadata = {};
      conv.metadata.agentId = agentId;
    }
  }

  function clearPendingApproval() {
    pendingApproval.value = null
  }



  return {
    conversations,
    filteredConversations,
    currentMemoryEchoes,
    currentConversationId,
    messagesMap,
    isLoadingMessages,
    isLoadingOlderMessages,
    hasMoreHistoryMap,
    searchQuery,
    activeNav,
    userId,
    currentConversation,
    currentMessages,
    currentSessionActiveSkills,
    pendingApproval,
    lastMergedMessageId,
    totalUnreadCount,
    loadConversations,
    selectConversation,
    loadMessages,
    loadOlderMessages,
    sendMessage,
    createOptimisticVoiceTurn,
    uploadVoiceAttachmentImages,
    uploadAttachmentImages,
    updateVoiceUserMessage,
    dispatchIncomingChatEvent,
    markAssistantMessageFailed,
    deleteConversation,
    clearConversationHistory,
    previewDeleteMessages,
    deleteSelectedMessages,
    removeLocalMessages,
    resumeTask,
    cancelTask,
    retrySendMessage,
    setSearchQuery,
    setActiveNav,
    currentAgentId,
    setAgentId,
    createNewConversation,
    clearPendingApproval,
    latestTtsSignal,
    latestFollowUpSpeakSignal,
    latestGreetingSpeakSignal,
    appendCallGreetingBubble,
    appendVoiceCallSystemMessage,
  };
});
