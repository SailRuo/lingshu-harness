<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue';
import { RangePicker as ARangePicker } from '@arco-design/web-vue';
import IconSearch from '@arco-design/web-vue/es/icon/icon-search';
import IconDelete from '@arco-design/web-vue/es/icon/icon-delete';
import { useChatHistoryBrowser } from '../../composables/useChatHistoryBrowser';
import { highlightFuzzyMatches } from '../../utils/fuzzyTextMatch';
import { stripEmbeddedImageMarkup } from '../../utils/messageText';
import { useChatStore } from '../../stores/chat';
import type { AnyMessage } from '../../types/message';

const chatStore = useChatStore();
const showConfirmModal = ref(false);

const {
  filteredMessages,
  loading,
  truncated,
  errorText,
  query,
  dateRange,
  load,
  resetFilters,
} = useChatHistoryBrowser();

const shortcuts = [
  {
    label: '今天',
    value: () => {
      const now = new Date();
      return [now, now];
    },
  },
  {
    label: '近 7 天',
    value: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 6);
      return [start, end];
    },
  },
  {
    label: '近 30 天',
    value: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 29);
      return [start, end];
    },
  },
];

const resultCountLabel = computed(() => {
  if (loading.value) return '加载中…';
  return `共 ${filteredMessages.value.length} 条`;
});

const streamRef = useTemplateRef<HTMLElement>('historyStream');

async function reload() {
  resetFilters();
  await load();
}

onMounted(() => {
  void reload();
});

watch(
  () => chatStore.currentConversationId,
  () => {
    void reload();
  },
);

watch(
  [loading, filteredMessages],
  async () => {
    if (loading.value) return;
    await nextTick();
    const el = streamRef.value;
    if (!el) return;
    if (!query.value.trim() && !dateRange.value) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop = 0;
    }
  },
);

async function handleClearHistory() {
  if (chatStore.currentConversationId) {
    await chatStore.clearConversationHistory(chatStore.currentConversationId);
    await load();
  }
  showConfirmModal.value = false;
}

function formatStamp(date: Date | string): string {
  const stamp = asDate(date);
  return stamp.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function shouldShowDayDivider(message: AnyMessage, index: number): boolean {
  if (index === 0) return true;
  const previous = filteredMessages.value[index - 1];
  return asDate(previous.timestamp).toDateString() !== asDate(message.timestamp).toDateString();
}

function formatDayLabel(date: Date | string): string {
  const stamp = asDate(date);
  const today = new Date();
  if (stamp.toDateString() === today.toDateString()) return '今天';
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (stamp.toDateString() === yesterday.toDateString()) return '昨天';
  return stamp.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function highlightedText(message: AnyMessage): string {
  if (message.type !== 'text') return '';
  return highlightFuzzyMatches(stripEmbeddedImageMarkup(message.content || ''), query.value);
}

function imageAlt(message: AnyMessage): string {
  if (message.type !== 'image') return '图片';
  const fileName = typeof message.metadata?.fileName === 'string' ? message.metadata.fileName : '';
  return fileName || '图片';
}
</script>

<template>
  <div class="history-browser">
    <div class="history-toolbar">
      <ARangePicker
        v-model="dateRange"
        class="history-dates"
        format="YYYY-MM-DD"
        allow-clear
        :shortcuts="shortcuts"
        shortcuts-position="left"
      />
      <div class="history-filter-row">
        <div class="history-search">
          <IconSearch :size="14" class="history-search-icon" />
          <input
            v-model="query"
            class="history-search-input"
            type="search"
            placeholder="模糊搜索消息内容"
          >
        </div>
        <span class="history-count">{{ resultCountLabel }}</span>
      </div>
    </div>

    <p v-if="truncated" class="history-hint">仅加载了较早一部分记录，可用日期缩小范围后再搜。</p>
    <p v-else-if="errorText" class="history-hint history-hint-error">{{ errorText }}</p>

    <div ref="historyStream" class="history-stream">
      <div v-if="loading" class="history-empty">正在加载聊天记录…</div>
      <div v-else-if="filteredMessages.length === 0" class="history-empty">没有符合条件的消息</div>
      <template v-else>
        <article
          v-for="(message, index) in filteredMessages"
          :key="message.id"
          class="history-item"
        >
          <div v-if="shouldShowDayDivider(message, index)" class="history-day">
            {{ formatDayLabel(message.timestamp) }}
          </div>
          <div class="history-row" :class="{ self: message.isSelf }">
            <div class="history-meta">
              <span class="history-name">{{ message.isSelf ? '我' : message.senderName }}</span>
              <time class="history-time">{{ formatStamp(message.timestamp) }}</time>
            </div>
            <div v-if="message.type === 'text'" class="history-bubble" v-html="highlightedText(message)" />
            <div v-else-if="message.type === 'image'" class="history-bubble history-bubble-media">
              <img class="history-thumb" :src="message.url" :alt="imageAlt(message)">
            </div>
            <div v-else class="history-bubble history-bubble-muted">
              {{ message.type === 'file' ? `文件：${message.fileName}` : '【非文本消息】' }}
            </div>
          </div>
        </article>
      </template>
    </div>

    <button class="history-clear" type="button" @click="showConfirmModal = true">
      <IconDelete :size="15" />
      <span>清空对话记录</span>
    </button>
  </div>

  <a-modal
    v-model:visible="showConfirmModal"
    title="确认清空"
    simple
    :ok-button-props="{ status: 'danger' }"
    ok-text="确认清空"
    cancel-text="取消"
    @ok="handleClearHistory"
    @cancel="showConfirmModal = false"
  >
    <div class="clear-confirm-text">
      确定要清空与该智能体的所有本地对话记录吗？这不会影响智能体的记忆库。
    </div>
  </a-modal>
</template>

<style scoped>
.history-browser {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.history-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.history-dates {
  width: 100%;
}

.history-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.history-search {
  flex: 1;
  min-width: 0;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
}

.history-search-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.history-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
}

.history-search-input::placeholder {
  color: var(--text-placeholder);
}

.history-count {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.history-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.history-hint-error {
  color: var(--color-error, #f53f3f);
}

.history-stream {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.history-empty {
  padding: 40px 12px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.history-item + .history-item {
  margin-top: 10px;
}

.history-day {
  margin: 8px 0 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
}

.history-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.history-row.self {
  align-items: flex-end;
}

.history-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}

.history-name {
  color: var(--text-secondary);
}

.history-time {
  color: var(--text-tertiary);
}

.history-bubble {
  max-width: 86%;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--bg-message-other);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.history-row.self .history-bubble {
  background: var(--bg-message-self);
  color: var(--text-message-self);
}

.history-bubble-media {
  padding: 6px;
}

.history-bubble-muted {
  color: var(--text-secondary);
}

.history-thumb {
  display: block;
  max-width: 100%;
  max-height: 180px;
  border-radius: 6px;
  object-fit: cover;
}

.history-bubble :deep(mark) {
  padding: 0 1px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--color-primary) 38%, transparent);
  color: inherit;
}

.history-clear {
  flex-shrink: 0;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  border-radius: 8px;
  background-color: rgba(245, 63, 63, 0.1);
  color: var(--color-error, #f53f3f);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.2s, transform 0.1s;
}

.history-clear:hover {
  background-color: rgba(245, 63, 63, 0.2);
}

.history-clear:active {
  transform: scale(0.98);
}

.clear-confirm-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-primary);
}
</style>
