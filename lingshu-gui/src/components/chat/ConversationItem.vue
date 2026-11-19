<script setup lang="ts">
import { computed } from 'vue';
import type { Conversation } from '../../types/conversation';
import { renderWechatEmoji } from '../emoji/render';
import { previewTextWithImagePlaceholder } from '../../utils/messageText';

const props = defineProps<{
  conv: Conversation;
  selected: boolean;
  index: number;
}>();

function formatTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return date.toLocaleDateString('zh-CN');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function handleAvatarError(event: Event) {
  const img = event.target as HTMLImageElement;
  if (!img.src.endsWith('/lingshu.png')) {
    img.src = '/lingshu.png';
  }
}

const previewHtml = computed(() => {
  const source = previewTextWithImagePlaceholder(props.conv.lastMessage || '');
  const escaped = escapeHtml(source);
  return renderWechatEmoji(escaped, {
    emojiSize: 13,
    className: 'conversation-preview-emoji',
  });
});

const isGroup = computed(() => props.conv.type === 'group');
const memberCountLabel = computed(() => {
  if (!isGroup.value) return '';
  const count = Number(props.conv.metadata?.memberCount || 0);
  return count > 0 ? `${count}人` : '';
});
</script>

<template>
  <div
    class="conversation-item"
    :class="{
      selected,
      'has-divider': index > 0,
    }"
  >
    <img
      v-if="!isGroup"
      class="avatar"
      :src="conv.avatar || '/lingshu.png'"
      :alt="conv.name"
      @error="handleAvatarError"
    />
    <div v-else class="avatar group-avatar" :title="conv.name">
      <span class="material-symbols-outlined">groups</span>
    </div>
    <div class="item-content">
      <div class="item-header">
        <span class="name text-ellipsis">{{ conv.name }}</span>
        <span class="header-right">
          <span v-if="memberCountLabel" class="member-count">{{ memberCountLabel }}</span>
          <span class="time">{{ formatTime(conv.timestamp) }}</span>
        </span>
      </div>
      <div class="item-footer">
        <p class="preview text-ellipsis" v-html="previewHtml" />
        <span v-if="conv.unreadCount > 0" class="unread-badge">
          {{ conv.unreadCount > 99 ? '99+' : conv.unreadCount }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.conversation-item {
  display: flex;
  align-items: center;
  height: 64px;
  gap: 10px;
  padding: 6px 12px;
  border-radius: 2px;
  cursor: pointer;
  position: relative;
  transition: background-color var(--transition-fast);
  width: 100%;
  box-sizing: border-box;
}

.conversation-item:hover {
  background-color: var(--bg-hover);
}

.conversation-item.has-divider {
  border-top: 1px solid color-mix(in srgb, var(--border-color) 55%, transparent);
}

.conversation-item.selected {
  background-color: var(--color-item-active);
}

.conversation-item.selected .name,
.conversation-item.selected .time,
.conversation-item.selected .preview {
  color: var(--color-item-active-text);
}

.conversation-item.selected .time {
  opacity: 0.8;
}

.avatar {
  width: 34px;
  height: 34px;
  border-radius: 4px;
  flex-shrink: 0;
  object-fit: cover;
}

.group-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, #6a8dff, #8a63ff);
  overflow: hidden;
}

.group-avatar .material-symbols-outlined {
  font-size: 20px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: 8px;
}

.member-count {
  font-size: 10px;
  color: var(--text-placeholder);
  background-color: var(--bg-hover);
  border-radius: 8px;
  padding: 1px 6px;
  line-height: 14px;
}

.item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}

.item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.name {
  font-size: var(--font-size-sm);
  font-weight: 400;
  color: var(--text-primary);
  max-width: 160px;
}

.time {
  font-size: 10px;
  color: var(--text-placeholder);
  flex-shrink: 0;
  margin-left: 8px;
}

.item-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.preview {
  font-size: 11px;
  color: var(--text-tertiary);
  max-width: 180px;
}

.preview :deep(img.emoji.twemoji),
.preview :deep(img.wechat-emoji) {
  width: 13px;
  height: 13px;
  vertical-align: -0.2em;
  margin: 0 1px;
}

.unread-badge {
  min-width: 18px;
  height: 18px;
  padding: 2px 6px;
  border-radius: var(--radius-full);
  background-color: var(--color-unread-bg);
  color: white;
  font-size: var(--font-size-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-left: 4px;
}
</style>
