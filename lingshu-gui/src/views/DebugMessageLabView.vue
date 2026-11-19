<script setup lang="ts">
import { ref } from 'vue';
import MessageList from '../components/chat/MessageList.vue';
import InputArea from '../components/chat/InputArea.vue';
import type { AnyMessage, ImageMessage, TextMessage } from '../types/message';

defineOptions({ name: 'DebugMessageLabView' });

const sessionId = 'debug-message-lab';
const now = new Date();
const messages = ref<AnyMessage[]>([
  {
    id: 'seed-image',
    type: 'image',
    senderId: 'user',
    senderName: '我',
    timestamp: new Date(now.getTime() - 4 * 60 * 1000),
    status: 'sent',
    isSelf: true,
    url: '/lingshu.png',
    thumbnailUrl: '/lingshu.png',
    width: 960,
    height: 960,
    metadata: {
      fileName: 'lingshu.png',
      mimeType: 'image/png',
    },
  },
  {
    id: 'seed-user',
    type: 'text',
    senderId: 'user',
    senderName: '我',
    timestamp: new Date(now.getTime() - 4 * 60 * 1000 + 800),
    status: 'sent',
    isSelf: true,
    content: '这是一条带图片的历史消息，点图片可以预览。',
  },
  {
    id: 'seed-assistant-1',
    type: 'text',
    senderId: 'bot',
    senderName: '灵枢 AI',
    senderAvatar: '/lingshu.png',
    timestamp: new Date(now.getTime() - 3 * 60 * 1000),
    status: 'sent',
    isSelf: false,
    content: '第一条 assistant 回复。',
    metadata: { timelineEvents: [], taskEvents: [] },
  },
  {
    id: 'seed-assistant-2',
    type: 'text',
    senderId: 'bot',
    senderName: '灵枢 AI',
    senderAvatar: '/lingshu.png',
    timestamp: new Date(now.getTime() - 3 * 60 * 1000 + 1200),
    status: 'sent',
    isSelf: false,
    content: '这是同一轮里的连续 assistant 回复，用来回归连续消息展示。',
    metadata: { timelineEvents: [], taskEvents: [] },
  },
]);

function appendMessage(message: AnyMessage) {
  messages.value = [...messages.value, message];
}

function buildUserTextMessage(content: string): TextMessage {
  return {
    id: `user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'text',
    senderId: 'user',
    senderName: '我',
    timestamp: new Date(),
    status: 'sent',
    isSelf: true,
    content,
  };
}

function buildUserImageMessage(attachment: { id: string; url: string; name: string; file?: File }): ImageMessage {
  return {
    id: `user-image-${attachment.id}`,
    type: 'image',
    senderId: 'user',
    senderName: '我',
    timestamp: new Date(),
    status: 'sent',
    isSelf: true,
    url: attachment.url,
    thumbnailUrl: attachment.url,
    width: 960,
    height: 960,
    metadata: {
      fileName: attachment.name,
      mimeType: attachment.file?.type || 'image/*',
      sizeBytes: attachment.file?.size,
    },
  };
}

function buildAssistantTextMessage(content: string, suffix: string): TextMessage {
  return {
    id: `assistant-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'text',
    senderId: 'bot',
    senderName: '灵枢 AI',
    senderAvatar: '/lingshu.png',
    timestamp: new Date(),
    status: 'sent',
    isSelf: false,
    content,
    metadata: { timelineEvents: [], taskEvents: [] },
  };
}

async function handleSend(content: string, attachments: Array<{ id: string; type: 'image' | 'file'; url: string; name: string; file?: File }>) {
  attachments
    .filter((attachment) => attachment.type === 'image')
    .forEach((attachment) => {
      appendMessage(buildUserImageMessage(attachment));
    });

  if (content.trim()) {
    appendMessage(buildUserTextMessage(content));
  }

  window.setTimeout(() => {
    appendMessage(buildAssistantTextMessage('这是第一段 assistant 回答。', 'part-1'));
  }, 220);

  window.setTimeout(() => {
    appendMessage(buildAssistantTextMessage('这是紧跟着的第二段回答，用来验证连续消息气泡。', 'part-2'));
  }, 620);
}
</script>

<template>
  <div class="debug-message-lab">
    <div class="lab-shell">
      <MessageList :messages="messages" />
      <InputArea :session-id="sessionId" mode="chat" @send="handleSend" />
    </div>
  </div>
</template>

<style scoped>
.debug-message-lab {
  width: 100%;
  height: 100%;
  background: var(--bg-chat-window);
  padding: 16px;
  box-sizing: border-box;
}

.lab-shell {
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-message-other);
}
</style>
