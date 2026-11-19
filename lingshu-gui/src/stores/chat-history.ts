import type { AnyMessage, ImageMessage, TextMessage } from '../types/message';
import type { UnifiedChatEvent } from '../types/chat-events';
import { getFullUrl } from '../utils/apiConfig';
import { parseServerDateTime } from '../utils/dateTime';
import { stripEmbeddedImageMarkup } from '../utils/messageText';

export interface ChatTurnHistorySnapshot {
  id: number | string;
  userMessage?: string | null;
  userImages?: Array<{
    uploadId: string;
    url: string;
    mimeType?: string | null;
    fileName?: string | null;
    sizeBytes?: number | null;
    width?: number | null;
    height?: number | null;
    summaryText?: string | null;
  }> | null;
  assistantImages?: Array<{
    uploadId: string;
    url: string;
    mimeType?: string | null;
    fileName?: string | null;
    sizeBytes?: number | null;
    width?: number | null;
    height?: number | null;
    summaryText?: string | null;
  }> | null;
  assistantMessage?: string | null;
  status: string;
  errorMessage?: string | null;
  timestamp: string | Date;
  taskId?: string | null;
  role?: string | null;
  messageKind?: string | null;
}

interface AssistantIdentity {
  displayName: string;
  avatar: string;
}

function deriveRunStatus(events: UnifiedChatEvent[]): string | undefined {
  const lastStateEvent = [...events].reverse().find((event) => event.metadata?.run_status);
  if (lastStateEvent?.metadata?.run_status) {
    return String(lastStateEvent.metadata.run_status);
  }
  if (events.some((event) => event.type === 'done')) {
    return 'done';
  }
  return undefined;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : parseServerDateTime(value);
}

function deriveAssistantContent(turn: ChatTurnHistorySnapshot): string {
  if (turn.status === 'failed') {
    return `⚠️ ${turn.errorMessage || '请求失败'}`;
  }
  return stripEmbeddedImageMarkup(turn.assistantMessage || '');
}

function isAssistantFollowupTurn(
  currentTurn: ChatTurnHistorySnapshot,
  nextTurn: ChatTurnHistorySnapshot | undefined,
): boolean {
  if (!nextTurn) return false;
  if (!currentTurn.taskId || currentTurn.taskId !== nextTurn.taskId) return false;
  if (currentTurn.assistantMessage || currentTurn.errorMessage || currentTurn.status === 'failed') return false;

  const nextHasUserMessage = Boolean(nextTurn.userMessage && nextTurn.userMessage.trim());
  const nextHasAssistantContent = Boolean(deriveAssistantContent(nextTurn).trim());
  return !nextHasUserMessage && nextHasAssistantContent;
}

export function buildHistoricalMessages(
  turns: ChatTurnHistorySnapshot[],
  assistant: AssistantIdentity,
): AnyMessage[] {
  const messages: AnyMessage[] = [];

  turns.forEach((turn, index) => {
    const timestamp = toDate(turn.timestamp);
    const userMessage = turn.userMessage?.trim() || '';
    const userImages = Array.isArray(turn.userImages) ? turn.userImages : [];
    const assistantContent = deriveAssistantContent(turn);
    const hasAssistantFollowup = isAssistantFollowupTurn(turn, turns[index + 1]);

    // Handle system messages (e.g., voice call events)
    if (turn.role === 'system' && turn.assistantMessage) {
      messages.push({
        id: `s-${turn.id}`,
        type: 'system',
        senderId: 'user',
        senderName: '我',
        senderAvatar: '',
        timestamp,
        status: 'sent',
        isSelf: true,
        content: turn.assistantMessage,
        metadata: {
          messageKind: turn.messageKind || 'system_event',
        },
      });
      return;
    }

    userImages.forEach((image, imageIndex) => {
      const imageMessage: ImageMessage = {
        id: `u-${turn.id}-img-${image.uploadId || imageIndex}`,
        type: 'image',
        senderId: 'user',
        senderName: '我',
        senderAvatar: '',
        timestamp,
        status: 'sent',
        isSelf: true,
        url: getFullUrl(image.url),
        thumbnailUrl: getFullUrl(image.url),
        width: image.width || 960,
        height: image.height || 960,
        metadata: {
          uploadId: image.uploadId,
          mimeType: image.mimeType || undefined,
          fileName: image.fileName || undefined,
          sizeBytes: image.sizeBytes || undefined,
          summaryText: image.summaryText || undefined,
        },
      };
      messages.push(imageMessage);
    });

    if (userMessage) {
      messages.push({
        id: `u-${turn.id}`,
        type: 'text',
        senderId: 'user',
        senderName: '我',
        senderAvatar: '',
        timestamp,
        status: 'sent',
        isSelf: true,
        content: turn.userMessage || '',
      });
    }

    const shouldCreateAssistantMessage =
      !hasAssistantFollowup &&
      (Boolean(assistantContent.trim()) || Boolean(turn.taskId) || Boolean((turn.assistantImages || []).length));

    if (!shouldCreateAssistantMessage) {
      return;
    }

    const assistantImages = Array.isArray(turn.assistantImages) ? turn.assistantImages : [];
    assistantImages.forEach((image, imageIndex) => {
      const imageMessage: ImageMessage = {
        id: `a-${turn.id}-img-${image.uploadId || imageIndex}`,
        type: 'image',
        senderId: 'bot',
        senderName: assistant.displayName,
        senderAvatar: assistant.avatar,
        timestamp,
        status: 'sent',
        isSelf: false,
        url: getFullUrl(image.url),
        thumbnailUrl: getFullUrl(image.url),
        width: image.width || 960,
        height: image.height || 960,
        metadata: {
          uploadId: image.uploadId,
          mimeType: image.mimeType || undefined,
          fileName: image.fileName || undefined,
          sizeBytes: image.sizeBytes || undefined,
          summaryText: image.summaryText || undefined,
        },
      };
      messages.push(imageMessage);
    });

    if (assistantContent.trim() || turn.taskId) {
      messages.push({
        id: `a-${turn.id}`,
        type: 'text',
        senderId: 'bot',
        senderName: assistant.displayName,
        senderAvatar: assistant.avatar,
        timestamp,
        status: 'sent',
        isSelf: false,
        content: assistantContent,
        metadata: {
          taskId: turn.taskId || undefined,
          timelineEvents: [],
          taskEvents: [],
          followUp: !userMessage,
        },
      });
    }
  });

  return messages;
}

export function hydrateHistoricalAssistantMessage(
  messages: AnyMessage[],
  taskId: string,
  events: UnifiedChatEvent[],
): AnyMessage[] {
  const targetIndex = messages.findIndex(
    (message) => message.type === 'text' && !message.isSelf && message.metadata?.taskId === taskId,
  );
  if (targetIndex === -1) {
    return messages;
  }

  const targetMessage = messages[targetIndex] as TextMessage;
  const nextRunStatus = deriveRunStatus(events);
  const nextMessage: TextMessage = {
    ...targetMessage,
    metadata: {
      ...targetMessage.metadata,
      timelineEvents: events,
      taskEvents: events.filter((event) => event.type !== 'text_delta' && event.type !== 'error'),
      ...(nextRunStatus ? { run_status: nextRunStatus } : {}),
    },
  };

  return messages.map((message, index) => (index === targetIndex ? nextMessage : message));
}
