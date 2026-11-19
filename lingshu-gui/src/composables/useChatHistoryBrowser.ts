import { computed, ref, shallowRef } from 'vue';
import type { AnyMessage } from '../types/message';
import { useAgentsStore } from '../stores/agents';
import { useChatStore } from '../stores/chat';
import { buildHistoricalMessages, type ChatTurnHistorySnapshot } from '../stores/chat-history';
import { getFullUrl } from '../utils/apiConfig';
import { fuzzyMatchText } from '../utils/fuzzyTextMatch';
import { stripEmbeddedImageMarkup } from '../utils/messageText';

const PAGE_SIZE = 200;
const MAX_PAGES = 20;

export type HistoryDateRange = (Date | string | number)[] | undefined;

function oldestPositiveTurnId(turns: ChatTurnHistorySnapshot[]): number | null {
  for (const turn of turns) {
    const id = Number(turn.id);
    if (Number.isFinite(id) && id > 0) return id;
  }
  return null;
}

function coerceDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'object' && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  return null;
}

function startOfDay(value: unknown): Date | null {
  const date = coerceDate(value);
  if (!date) return null;
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(value: unknown): Date | null {
  const date = coerceDate(value);
  if (!date) return null;
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function messageSearchText(message: AnyMessage): string {
  if (message.type === 'text') return stripEmbeddedImageMarkup(message.content || '');
  if (message.type === 'image') {
    const fileName = typeof message.metadata?.fileName === 'string' ? message.metadata.fileName : '';
    const summary = typeof message.metadata?.summaryText === 'string' ? message.metadata.summaryText : '';
    return `【图片】 ${fileName} ${summary}`.trim();
  }
  if (message.type === 'file') return `【文件】 ${message.fileName || ''}`.trim();
  if (message.type === 'voice') return '【语音】';
  if (message.type === 'system') return message.content || '';
  if (message.type === 'quote') return `${message.quotedContent || ''} ${message.content || ''}`.trim();
  if (message.type === 'link') return `${message.title || ''} ${message.description || ''} ${message.url || ''}`.trim();
  return '';
}

export function useChatHistoryBrowser() {
  const chatStore = useChatStore();
  const agentsStore = useAgentsStore();

  const messages = ref<AnyMessage[]>([]);
  const loading = shallowRef(false);
  const truncated = shallowRef(false);
  const errorText = shallowRef('');
  const query = shallowRef('');
  const dateRange = ref<HistoryDateRange>();

  const filteredMessages = computed(() => {
    const range = dateRange.value;
    const start = startOfDay(range?.[0])?.getTime() ?? null;
    const end = endOfDay(range?.[1])?.getTime() ?? null;
    const needle = query.value;

    return messages.value.filter((message) => {
      const stamp = message.timestamp instanceof Date
        ? message.timestamp.getTime()
        : new Date(message.timestamp).getTime();
      if (start !== null && stamp < start) return false;
      if (end !== null && stamp > end) return false;
      if (!needle.trim()) return true;
      return fuzzyMatchText(messageSearchText(message), needle);
    });
  });

  async function fetchTurnPage(sessionId: string, beforeTurnId: number | null): Promise<ChatTurnHistorySnapshot[]> {
    const params = new URLSearchParams({
      size: String(PAGE_SIZE),
      userId: chatStore.userId,
      sessionId,
    });
    if (beforeTurnId) params.set('beforeTurnId', String(beforeTurnId));
    const response = await fetch(getFullUrl(`/api/v1/chat/turns?${params}`));
    if (!response.ok) {
      throw new Error(`加载聊天记录失败 (${response.status})`);
    }
    const payload = await response.json();
    return Array.isArray(payload) ? payload as ChatTurnHistorySnapshot[] : [];
  }

  async function load(): Promise<void> {
    const sessionId = String(chatStore.currentConversationId || '').trim();
    if (!sessionId) {
      messages.value = [];
      errorText.value = '请先选择一个对话';
      truncated.value = false;
      return;
    }

    loading.value = true;
    errorText.value = '';
    truncated.value = false;
    try {
      await agentsStore.fetchAgents();
      const pages: ChatTurnHistorySnapshot[] = [];
      let beforeTurnId: number | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const turns = await fetchTurnPage(sessionId, beforeTurnId);
        if (!turns.length) break;
        pages.unshift(...turns);
        const oldest = oldestPositiveTurnId(turns);
        if (!oldest || turns.length < PAGE_SIZE) break;
        if (page === MAX_PAGES - 1) {
          truncated.value = true;
          break;
        }
        beforeTurnId = oldest;
      }

      const conversation = chatStore.currentConversation;
      const agentId = chatStore.currentAgentId ?? Number(conversation?.metadata?.agentId || 0);
      const agent = agentsStore.agents.find((item) => String(item.id) === String(agentId));
      messages.value = buildHistoricalMessages(pages, {
        displayName: agent?.displayName || conversation?.name || '灵枢 AI',
        avatar: agent?.avatar || conversation?.avatar || '/lingshu.png',
      });
    } catch (error) {
      messages.value = [];
      errorText.value = error instanceof Error ? error.message : '加载聊天记录失败';
    } finally {
      loading.value = false;
    }
  }

  function resetFilters(): void {
    query.value = '';
    dateRange.value = undefined;
  }

  return {
    messages,
    filteredMessages,
    loading,
    truncated,
    errorText,
    query,
    dateRange,
    load,
    resetFilters,
  };
}
