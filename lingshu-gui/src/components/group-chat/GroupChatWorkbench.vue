<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { GroupDetail, GroupMessage } from '../../services/groupChatApi';
import { useGroupChatStore } from '../../stores/groupChat';

const props = defineProps<{
  detail: GroupDetail;
  messages: GroupMessage[];
  sending: boolean;
  loadingMessages: boolean;
  hasMoreOlder: boolean;
  directorPhase: 'idle' | 'thinking' | 'decided';
  memberStatus: Record<number, 'thinking' | 'streaming' | 'done'>;
  lastError: string;
}>();
const emit = defineEmits<{
  (event: 'open-settings'): void;
}>();

const groupStore = useGroupChatStore();
const draft = ref('');
const showMentions = ref(false);
const messageListRef = ref<HTMLElement | null>(null);

const memberMap = computed(() => {
  const map = new Map<number, { name: string; avatar: string | null }>();
  for (const member of props.detail.members) {
    map.set(member.agentId, {
      name: member.displayName || member.name,
      avatar: member.avatar,
    });
  }
  return map;
});

const typingMembers = computed(() =>
  props.detail.members.filter((member) => {
    const phase = props.memberStatus[member.agentId];
    return phase === 'thinking' || phase === 'streaming';
  }),
);

const canSend = computed(() => Boolean(draft.value.trim()) && !props.sending);

function speakerName(message: GroupMessage) {
  if (message.speakerType === 'user') return '我';
  if (message.speakerType === 'system') return '系统';
  return memberMap.value.get(Number(message.speakerId))?.name || `成员${message.speakerId}`;
}

function speakerAvatar(message: GroupMessage) {
  return memberMap.value.get(Number(message.speakerId))?.avatar || null;
}

function avatarText(message: GroupMessage) {
  return speakerName(message).slice(0, 1);
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function insertMention(member: { name: string }) {
  const spacer = draft.value && !draft.value.endsWith(' ') ? ' ' : '';
  draft.value = `${draft.value}${spacer}@${member.name} `;
  showMentions.value = false;
  nextTick(() => focusInput());
}

const inputRef = ref<HTMLTextAreaElement | null>(null);
function focusInput() {
  inputRef.value?.focus();
}

function mentionedAgentIds() {
  const text = draft.value;
  return props.detail.members
    .filter((member) => {
      const name = member.displayName || member.name;
      return text.includes(`@${name}`);
    })
    .map((member) => member.agentId);
}

async function send() {
  if (!canSend.value) return;
  const content = draft.value;
  const mentions = mentionedAgentIds();
  draft.value = '';
  showMentions.value = false;
  await groupStore.sendMessage(content, mentions);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}

function scrollToBottom() {
  nextTick(() => {
    const element = messageListRef.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
}

watch(
  () => {
    const last = props.messages[props.messages.length - 1];
    return `${props.messages.length}:${last?.id || ''}:${last?.content.length || 0}`;
  },
  () => scrollToBottom(),
);

watch(
  () => props.detail.group.id,
  () => {
    draft.value = '';
    scrollToBottom();
  },
);

void nextTick(() => scrollToBottom());
</script>

<template>
  <section class="group-workbench">
    <header class="workbench-header">
      <div class="header-main">
        <div class="group-avatar">
          <span class="material-symbols-outlined">groups</span>
        </div>
        <div class="header-text">
          <h1>{{ props.detail.group.title }}</h1>
          <p v-if="props.detail.group.description">{{ props.detail.group.description }}</p>
          <p v-else class="muted">{{ props.detail.members.length }} 位成员 · 公开群聊</p>
        </div>
      </div>
      <div class="header-actions">
        <div class="avatar-stack">
          <a-avatar
            v-for="member in props.detail.members.slice(0, 5)"
            :key="member.agentId"
            :size="26"
            :image-url="member.avatar || undefined"
            :title="member.displayName || member.name"
          >
            {{ (member.displayName || member.name).slice(0, 1) }}
          </a-avatar>
        </div>
        <a-button size="small" type="text" @click="emit('open-settings')">
          <span class="material-symbols-outlined settings-icon">settings</span>
        </a-button>
      </div>
    </header>

    <div ref="messageListRef" class="message-scroll">
      <div v-if="props.hasMoreOlder" class="load-older">
        <a-button size="mini" type="text" :loading="props.loadingMessages" @click="groupStore.loadOlderMessages()">
          加载更早的消息
        </a-button>
      </div>
      <div v-if="props.messages.length === 0 && !props.loadingMessages" class="empty-chat">
        <span class="material-symbols-outlined empty-icon">forum</span>
        <p>群已经建好了，说点什么吧。</p>
        <p class="muted">成员会看到同一段公开消息，但各自记得的部分只属于自己。</p>
      </div>

      <template v-for="message in props.messages" :key="message.id">
        <div v-if="message.speakerType === 'system'" class="system-event">
          <span>{{ message.content }}</span>
        </div>
        <div v-else-if="message.speakerType === 'user'" class="message-row user-row">
          <div class="bubble user-bubble">
            <div class="bubble-text">{{ message.content }}</div>
            <div class="bubble-time">{{ timeLabel(message.createdAt) }}</div>
          </div>
          <div class="avatar user-avatar">我</div>
        </div>
        <div v-else class="message-row assistant-row">
          <a-avatar :size="34" :image-url="speakerAvatar(message) || undefined" class="assistant-avatar">
            {{ avatarText(message) }}
          </a-avatar>
          <div class="assistant-content">
            <div class="speaker-line">
              <span class="speaker-name">{{ speakerName(message) }}</span>
              <span class="bubble-time">{{ timeLabel(message.createdAt) }}</span>
            </div>
            <div class="bubble assistant-bubble" :class="{ 'is-error': message.status === 'error' }">
              <span class="bubble-text">{{ message.content }}</span>
              <span v-if="message.status === 'streaming'" class="streaming-caret">▍</span>
              <span v-if="message.status === 'error'" class="error-note">回复中断</span>
            </div>
          </div>
        </div>
      </template>

      <div v-if="props.directorPhase === 'thinking' && typingMembers.length === 0" class="typing-line">
        <span class="typing-dots"><i></i><i></i><i></i></span>
        导演正在判断下一句话权…
      </div>
      <div v-else-if="typingMembers.length" class="typing-line">
        <span class="typing-dots"><i></i><i></i><i></i></span>
        {{ typingMembers.map((member) => member.displayName || member.name).join('、') }} 正在打字…
      </div>
    </div>

    <footer class="composer">
      <div v-if="props.lastError" class="composer-error">{{ props.lastError }}</div>
      <div class="composer-box">
        <textarea
          ref="inputRef"
          v-model="draft"
          class="composer-input"
          placeholder="在群里说点什么…（Enter 发送，Shift+Enter 换行）"
          rows="2"
          :disabled="props.sending"
          @keydown="handleKeydown"
          @input="showMentions = draft.endsWith('@') || showMentions"
        />
        <div class="composer-tools">
          <button type="button" class="tool-button" title="@ 群成员" @click="showMentions = !showMentions">
            @
          </button>
          <span class="composer-hint">群公开消息，所有成员可见</span>
          <a-button type="primary" size="small" :disabled="!canSend" :loading="props.sending" @click="send">
            发送
          </a-button>
        </div>
        <div v-if="showMentions" class="mention-popover">
          <button
            v-for="member in props.detail.members"
            :key="member.agentId"
            type="button"
            class="mention-item"
            @mousedown.prevent="insertMention({ name: member.displayName || member.name })"
          >
            <a-avatar :size="22" :image-url="member.avatar || undefined">
              {{ (member.displayName || member.name).slice(0, 1) }}
            </a-avatar>
            {{ member.displayName || member.name }}
          </button>
        </div>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.group-workbench {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-chat-window, #fff);
}
.workbench-header {
  height: 68px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 22px;
  border-bottom: 1px solid var(--border-color, rgba(0, 0, 0, 0.06));
}
.header-main {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.group-avatar {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, #6a8dff, #8a63ff);
  flex-shrink: 0;
}
.group-avatar .material-symbols-outlined {
  font-size: 24px;
}
.header-text h1 {
  margin: 0;
  font-size: 16px;
  color: var(--text-primary, #1d2129);
}
.header-text p {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--text-secondary, #86909c);
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.muted {
  color: var(--text-tertiary, #a9aeb8);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.avatar-stack {
  display: flex;
  align-items: center;
}
.avatar-stack :deep(.arco-avatar) {
  margin-left: -6px;
  border: 2px solid var(--bg-chat-window, #fff);
}
.settings-icon {
  font-size: 20px;
  color: var(--text-secondary, #86909c);
}
.message-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.load-older {
  text-align: center;
}
.empty-chat {
  margin: auto;
  text-align: center;
  color: var(--text-secondary, #86909c);
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}
.empty-chat p {
  margin: 0;
  font-size: 13px;
}
.empty-icon {
  font-size: 44px;
  color: var(--text-tertiary, #c9cdd4);
}
.system-event {
  display: flex;
  justify-content: center;
}
.system-event span {
  max-width: 80%;
  padding: 5px 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.04);
  color: var(--text-tertiary, #86909c);
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}
.message-row {
  display: flex;
  gap: 10px;
  max-width: min(760px, 86%);
}
.user-row {
  align-self: flex-end;
  justify-content: flex-end;
}
.assistant-row {
  align-self: flex-start;
}
.user-avatar {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: #165dff;
  color: #fff;
  font-size: 13px;
  align-items: center;
  justify-content: center;
  display: flex;
  flex-shrink: 0;
}
.assistant-avatar {
  flex-shrink: 0;
  margin-top: 18px;
}
.assistant-content {
  min-width: 0;
}
.speaker-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.speaker-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #4e5969);
}
.bubble {
  border-radius: 12px;
  padding: 9px 13px;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.user-bubble {
  background: #165dff;
  color: #fff;
  border-bottom-right-radius: 4px;
}
.assistant-bubble {
  background: var(--bg-secondary, #f2f3f5);
  color: var(--text-primary, #1d2129);
  border-bottom-left-radius: 4px;
}
.assistant-bubble.is-error {
  background: rgba(245, 63, 63, 0.06);
}
.bubble-time {
  font-size: 10px;
  color: var(--text-tertiary, #a9aeb8);
  margin-top: 2px;
}
.user-bubble .bubble-time {
  color: rgba(255, 255, 255, 0.65);
  text-align: right;
}
.streaming-caret {
  animation: blink 1s step-end infinite;
  margin-left: 1px;
}
@keyframes blink {
  50% { opacity: 0; }
}
.error-note {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: #f53f3f;
}
.typing-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-tertiary, #86909c);
  padding-left: 44px;
}
.typing-dots {
  display: inline-flex;
  gap: 3px;
}
.typing-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: bounce 1.2s infinite ease-in-out;
}
.typing-dots i:nth-child(2) { animation-delay: 0.15s; }
.typing-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-3px); opacity: 1; }
}
.composer {
  flex-shrink: 0;
  padding: 10px 20px 16px;
}
.composer-error {
  margin-bottom: 8px;
  color: #f53f3f;
  font-size: 12px;
}
.composer-box {
  position: relative;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  padding: 10px 12px 8px;
  background: var(--bg-chat-window, #fff);
  transition: border-color 0.15s ease;
}
.composer-box:focus-within {
  border-color: #165dff;
}
.composer-input {
  width: 100%;
  border: none;
  resize: none;
  outline: none;
  background: transparent;
  color: var(--text-primary, #1d2129);
  font-size: 14px;
  line-height: 1.6;
  font-family: inherit;
}
.composer-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.tool-button {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #86909c);
  font-size: 16px;
  cursor: pointer;
}
.tool-button:hover {
  background: rgba(0, 0, 0, 0.05);
}
.composer-hint {
  flex: 1;
  font-size: 11px;
  color: var(--text-tertiary, #a9aeb8);
}
.mention-popover {
  position: absolute;
  left: 10px;
  bottom: 48px;
  width: 220px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bg-popup, #fff);
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 6px;
  z-index: 20;
}
.mention-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary, #1d2129);
}
.mention-item:hover {
  background: rgba(22, 93, 255, 0.08);
}
</style>
