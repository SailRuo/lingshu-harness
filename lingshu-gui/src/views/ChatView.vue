<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ConversationList from '../components/chat/ConversationList.vue';
import ChatWindow from '../components/chat/ChatWindow.vue';
import GroupSettingsModal from '../components/group-chat/GroupSettingsModal.vue';
import { useGroupChatStore } from '../stores/groupChat';

defineOptions({ name: 'ChatView' });

const route = useRoute();
const router = useRouter();
const groupStore = useGroupChatStore();

/** 群聊深链：/chat?group=<groupId>。空字符串表示当前选中私聊。 */
const selectedGroupId = computed(() => String(route.query.group || ''));
const isSettingsVisible = ref(false);

/** 群设置弹窗内容：仅当已加载详情与当前深链一致时传入。 */
const settingsDetail = computed(() => (
  selectedGroupId.value && groupStore.currentGroup?.group.id === selectedGroupId.value
    ? groupStore.currentGroup
    : null
));

// 群列表与私聊列表各自独立加载，互不阻塞
onMounted(() => {
  if (groupStore.groups.length === 0) {
    void groupStore.loadGroups();
  }
});

// 深链 / 前进后退：路由变化时打开对应群
watch(
  selectedGroupId,
  async (groupId) => {
    if (!groupId) return;
    if (groupStore.currentGroup?.group.id === groupId) return;
    try {
      await groupStore.selectGroup(groupId);
    } catch (error) {
      console.error('[chat-view] failed to open group', error);
      if (route.query.group) {
        await router.replace({ path: '/', query: {} });
      }
    }
  },
  { immediate: true },
);

function handleSelectGroup(groupId: string) {
  void router.push({ path: '/', query: { group: groupId } });
}

function handleSelectPrivate() {
  if (route.query.group) {
    void router.replace({ path: '/', query: {} });
  }
}

async function handleOpenGroupSettings(groupId: string) {
  if (!groupId) return;
  // 右键未选中的群时，先加载详情再打开设置；加载完成后再同步路由，
  // 避免 watch 与这里并发重复请求。
  try {
    if (groupStore.currentGroup?.group.id !== groupId) {
      await groupStore.selectGroup(groupId);
    }
  } catch (error) {
    console.error('[chat-view] failed to open group for settings', error);
    return;
  }
  if (groupId !== selectedGroupId.value) {
    void router.push({ path: '/', query: { group: groupId } });
  }
  isSettingsVisible.value = true;
}

function handleGroupDeleted() {
  isSettingsVisible.value = false;
  handleSelectPrivate();
}
</script>

<template>
  <div class="chat-view">
    <ConversationList
      :selected-group-id="selectedGroupId"
      @select-group="handleSelectGroup"
      @select-private="handleSelectPrivate"
      @open-group-settings="handleOpenGroupSettings"
    />
    <ChatWindow
      :active-group-id="selectedGroupId"
      @open-group-settings="handleOpenGroupSettings(selectedGroupId)"
    />

    <GroupSettingsModal
      v-model:visible="isSettingsVisible"
      :detail="settingsDetail"
      @deleted="handleGroupDeleted"
    />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
