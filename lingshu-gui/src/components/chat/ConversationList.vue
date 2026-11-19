<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useUIStore } from '../../stores/ui';
import { useAgentsStore } from '../../stores/agents';
import { useGroupChatStore } from '../../stores/groupChat';
import { parseServerDateTime } from '../../utils/dateTime';
import type { Conversation } from '../../types/conversation';
import IconSearch from '@arco-design/web-vue/es/icon/icon-search';
import IconPlus from '@arco-design/web-vue/es/icon/icon-plus';
import IconDelete from '@arco-design/web-vue/es/icon/icon-delete';
import IconUserGroup from '@arco-design/web-vue/es/icon/icon-user-group';
import ConversationItem from './ConversationItem.vue';
import GroupCreateModal from '../group-chat/GroupCreateModal.vue';

const props = defineProps<{
  selectedGroupId?: string;
}>();

const emit = defineEmits<{
  (event: 'select-group', groupId: string): void;
  (event: 'select-private'): void;
  (event: 'open-group-settings', groupId: string): void;
}>();

const chatStore = useChatStore();
const uiStore = useUIStore();
const agentsStore = useAgentsStore();
const groupStore = useGroupChatStore();

const isResizing = ref(false);
const isNewChatMenuVisible = ref(false);
const isGroupCreateVisible = ref(false);

onMounted(() => {
  if (chatStore.conversations.length === 0) {
    void chatStore.loadConversations();
  }
});

const groupConversations = computed<Conversation[]>(() =>
  groupStore.groups.map((group) => ({
    id: `group:${group.id}`,
    name: group.title || '群聊',
    lastMessage: group.lastMessageText || '还没有消息',
    timestamp: parseServerDateTime(
      group.lastMessageAt || group.updatedAt || group.createdAt,
    ),
    avatar: '',
    unreadCount: Number(group.unreadCount || 0),
    isPinned: false,
    isMuted: false,
    type: 'group' as const,
    metadata: {
      groupId: group.id,
      memberCount: Number(group.memberCount || 0),
    },
  })),
);

/**
 * 私聊 + 群聊合并后的统一会话列表：按最后消息时间倒序，
 * 搜索同时匹配名称与最后一条消息。
 */
const mergedConversations = computed<Conversation[]>(() => {
  const merged = [...chatStore.conversations, ...groupConversations.value];
  merged.sort((left, right) => {
    const leftTime = left.timestamp instanceof Date ? left.timestamp.getTime() : 0;
    const rightTime = right.timestamp instanceof Date ? right.timestamp.getTime() : 0;
    return rightTime - leftTime;
  });
  return merged;
});

const visibleConversations = computed<Conversation[]>(() => {
  const query = chatStore.searchQuery.trim().toLowerCase();
  if (!query) return mergedConversations.value;
  return mergedConversations.value.filter(
    (item) =>
      item.name.toLowerCase().includes(query)
      || item.lastMessage.toLowerCase().includes(query),
  );
});

function isSelected(conv: Conversation): boolean {
  if (conv.type === 'group') {
    return Boolean(props.selectedGroupId) && conv.metadata?.groupId === props.selectedGroupId;
  }
  return !props.selectedGroupId && conv.id === chatStore.currentConversationId;
}

function handleSelect(conv: Conversation) {
  if (conv.type === 'group') {
    const groupId = String(conv.metadata?.groupId || '');
    if (groupId) emit('select-group', groupId);
    return;
  }
  emit('select-private');
  void chatStore.selectConversation(conv.id);
}

const handleNewChatMenuVisibleChange = (visible: boolean) => {
  isNewChatMenuVisible.value = visible;
  if (visible) agentsStore.fetchAgents();
};

const handleSelectAgent = async (agentId: number) => {
  // 若当前正停留在群聊，先退出群聊深链，让新私聊会话正常显示
  emit('select-private');
  await chatStore.createNewConversation(agentId);
  isNewChatMenuVisible.value = false;
};

function handleCreateGroup() {
  isNewChatMenuVisible.value = false;
  isGroupCreateVisible.value = true;
}

function handleGroupCreated(groupId: string) {
  emit('select-group', groupId);
}

function handleSearch(e: Event) {
  const target = e.target as HTMLInputElement;
  chatStore.setSearchQuery(target.value);
}

function handleAvatarError(event: Event) {
  const img = event.target as HTMLImageElement;
  if (!img.src.endsWith('/lingshu.png')) {
    img.src = '/lingshu.png';
  }
}

function startResize(e: MouseEvent) {
  isResizing.value = true;
  document.addEventListener('mousemove', handleResize);
  document.addEventListener('mouseup', stopResize);
  e.preventDefault();
}

function handleResize(e: MouseEvent) {
  if (!isResizing.value) return;
  const newWidth = e.clientX - 60;
  uiStore.setConversationListWidth(newWidth);
}

function stopResize() {
  isResizing.value = false;
  document.removeEventListener('mousemove', handleResize);
  document.removeEventListener('mouseup', stopResize);
}
</script>

<template>
  <section
    class="conversation-list"
    :style="{ width: uiStore.conversationListWidth + 'px' }"
  >
    <div class="list-header">
      <div class="search-wrapper">
        <IconSearch :size="14" class="search-icon" style="width: 14px; height: 14px;" />
        <input
          type="text"
          class="search-input"
          placeholder="搜索"
          :value="chatStore.searchQuery"
          @input="handleSearch"
        />
      </div>
      <a-trigger
        trigger="hover"
        position="rt"
        show-arrow
        :popup-offset="8"
        content-class="new-chat-popup"
        :popup-visible="isNewChatMenuVisible"
        @popup-visible-change="(v) => handleNewChatMenuVisibleChange(v as boolean)"
      >
        <button class="add-btn" type="button" title="新建会话">
          <IconPlus :size="16" style="width: 16px; height: 16px;" />
        </button>
        <template #content>
          <div class="new-chat-menu" @click.stop>
            <div class="create-group-entry" @click="handleCreateGroup">
              <span class="create-group-icon">
                <IconUserGroup :size="15" style="width: 15px; height: 15px;" />
              </span>
              <div class="create-group-text">
                <div class="create-group-title">新建群聊</div>
                <div class="create-group-desc">把多个智能体拉进同一个群</div>
              </div>
            </div>
            <div class="menu-divider"></div>
            <div class="agent-select-list">
              <div
                v-for="agent in agentsStore.agents"
                :key="agent.id"
                class="agent-select-item"
                @click="handleSelectAgent(agent.id!)"
              >
                <img
                  class="new-chat-avatar"
                  :src="agent.avatar || '/lingshu.png'"
                  :alt="agent.displayName"
                  @error="handleAvatarError"
                />
                <div class="agent-select-name text-ellipsis">{{ agent.displayName }}</div>
              </div>
              <div v-if="agentsStore.agents.length === 0" class="empty-agents">
                暂无可用智能体，请前往设置创建
              </div>
            </div>
          </div>
        </template>
      </a-trigger>
    </div>

    <div class="list-body">
      <a-scrollbar
        class="conversation-scrollbar"
        :outer-style="{ height: '100%', width: '100%' }"
        style="height: 100%; width: 100%;"
      >
        <div class="scrollbar-inner-wrapper">
          <div v-if="!visibleConversations || visibleConversations.length === 0" class="empty-state">
            <p>暂无会话</p>
          </div>
          <div class="list-content">
            <a-dropdown
              v-for="(conv, index) in visibleConversations || []"
              :key="conv.id"
              trigger="contextMenu"
              alignPoint
              :style="{ display: 'block' }"
            >
              <ConversationItem
                :conv="conv"
                :selected="isSelected(conv)"
                :index="index"
                @click="handleSelect(conv)"
              />
              <template #content>
                <template v-if="conv.type === 'group'">
                  <a-doption @click="emit('open-group-settings', String(conv.metadata?.groupId || ''))">
                    <template #icon><IconUserGroup /></template>
                    群设置
                  </a-doption>
                </template>
                <template v-else>
                  <a-doption @click="chatStore.deleteConversation(conv.id)" class="delete-option">
                    <template #icon><IconDelete /></template>
                    删除会话
                  </a-doption>
                </template>
              </template>
            </a-dropdown>
          </div>
        </div>
      </a-scrollbar>
    </div>

    <div class="resize-handle" @mousedown="startResize"></div>

    <GroupCreateModal
      v-model:visible="isGroupCreateVisible"
      @created="handleGroupCreated"
    />
  </section>
</template>



<style scoped>
.conversation-list {
  position: relative;
  height: 100%;
  background-color: var(--bg-conversation-list);
  border-right: none; /* 取消右侧边框线 */
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: var(--conversation-list-min-width);
  max-width: var(--conversation-list-max-width);
}

.list-header {
  padding: 12px 10px;
  background-color: var(--bg-conversation-list);
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
}

.search-icon {
  position: absolute;
  left: 8px;
  color: var(--text-tertiary);
}

.search-input {
  flex: 1;
  height: 26px;
  padding: 0 12px 0 28px;
  border-radius: 6px;
  background-color: var(--bg-hover);
  font-size: var(--font-size-xs);
  color: var(--text-primary);
  border: 1px solid transparent;
  transition: all var(--transition-fast);
}

.search-input:focus {
  background-color: var(--bg-input);
  border-color: var(--color-primary);
}

.add-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg-hover);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  border: none;
}

.add-btn:hover {
  background-color: var(--bg-selected);
}

:global(.new-chat-popup) {
  padding: 0;
  border-radius: var(--border-radius-medium, 8px);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
  border: 1px solid var(--color-border-2, var(--border-color));
  background: var(--color-bg-popup, var(--bg-conversation-list));
}

/* a-trigger 的 popup 会被 teleport 到 body，下面的菜单样式必须全局作用域， */
/* 否则 scoped style 不会命中，导致“新建群聊”和普通智能体条目字号不一致。 */
:global(.new-chat-popup .new-chat-menu) {
  width: 220px;
  padding: 0;
  background: var(--color-bg-popup, var(--bg-conversation-list));
  font-size: 12px;
}

:global(.new-chat-popup .create-group-entry) {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin: 6px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s;
}

:global(.new-chat-popup .create-group-entry:hover) {
  background-color: var(--bg-hover);
}

:global(.new-chat-popup .create-group-icon) {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, #6a8dff, #8a63ff);
}

:global(.new-chat-popup .create-group-icon svg),
:global(.new-chat-popup .create-group-icon .arco-icon) {
  width: 15px;
  height: 15px;
  font-size: 15px;
}

:global(.new-chat-popup .create-group-text) {
  min-width: 0;
}

:global(.new-chat-popup .create-group-title) {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--text-primary);
}

:global(.new-chat-popup .create-group-desc) {
  font-size: 10px;
  line-height: 1.3;
  color: var(--text-tertiary);
  margin-top: 1px;
}

:global(.new-chat-popup .menu-divider) {
  height: 1px;
  margin: 4px 10px;
  background-color: var(--border-color);
}

:global(.new-chat-popup .agent-select-list) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
  padding-bottom: 6px;
}

:global(.new-chat-popup .new-chat-avatar) {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  flex-shrink: 0;
  object-fit: cover;
  background: var(--bg-hover);
}

:global(.new-chat-popup .agent-select-item) {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s;
}

:global(.new-chat-popup .agent-select-item:hover) {
  background-color: var(--bg-hover);
}

:global(.new-chat-popup .agent-select-name) {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}

:global(.new-chat-popup .empty-agents) {
  padding: 20px;
  text-align: center;
  color: var(--text-tertiary);
}

.list-body {
  flex: 1;
  overflow: hidden;
  min-height: 0;
  position: relative;
}

.conversation-scrollbar {
  min-height: 0;
}

/* 确保 Arco 滚动条滑块可见且样式正确 */
.list-body :deep(.arco-scrollbar) {
  height: 100%;
}

.list-body :deep(.arco-scrollbar-container) {
  height: 100%;
  overflow: auto;
  min-height: 0;
}

.list-body :deep(.arco-scrollbar-thumb-bar) {
  background-color: var(--scrollbar-thumb, rgba(128, 128, 128, 0.3)) !important;
  border-radius: 3px;
  width: 8px !important;
  transition: background-color 0.2s, opacity 0.2s;
  z-index: 100;
}

.list-body :deep(.arco-scrollbar-thumb-bar:hover) {
  background-color: var(--scrollbar-thumb-hover, rgba(128, 128, 128, 0.5)) !important;
}

.list-body :deep(.arco-scrollbar-track) {
  background-color: transparent !important;
  width: 8px !important;
  z-index: 99;
}

.scrollbar-inner-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.list-content {
  width: 100%;
  display: flex;
  flex-direction: column;
}

/*
   注意：由于使用了 a-scrollbar，原生滚动条样式已失效。
   如需自定义 Arco 滚动条样式，请修改 Arco 的 CSS 变量。
*/

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text-tertiary);
  font-size: var(--font-size-md);
}



.resize-handle {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  z-index: 10;
  transition: background-color var(--transition-fast);
}

.resize-handle:hover {
  background-color: var(--color-primary);
}

.delete-option {
  color: var(--color-danger, #f53f3f) !important;
}
</style>
