import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  groupChatApi,
  streamGroupTurn,
  type GroupChatEvent,
  type GroupDetail,
  type GroupMember,
  type GroupMessage,
  type GroupSession,
  type GroupTurnPlan,
} from '../services/groupChatApi';

function localId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useGroupChatStore = defineStore('groupChat', () => {
  const groups = ref<GroupSession[]>([]);
  const currentGroup = ref<GroupDetail | null>(null);
  const messages = ref<GroupMessage[]>([]);
  const hasMoreOlder = ref(false);
  const loadingGroups = ref(false);
  const loadingMessages = ref(false);
  const sending = ref(false);
  const lastError = ref('');
  const directorPhase = ref<'idle' | 'thinking' | 'decided'>('idle');
  const lastPlan = ref<GroupTurnPlan | null>(null);
  const memberStatus = ref<Record<number, 'thinking' | 'streaming' | 'done'>>({});
  const optimisticUserId = ref<string | null>(null);

  const currentGroupId = computed(() => currentGroup.value?.group.id || '');
  const members = computed<GroupMember[]>(() => currentGroup.value?.members || []);
  const activeMembers = computed(() => members.value.filter((member) => member.status === 'active'));

  function mergeMessage(message: GroupMessage) {
    const index = messages.value.findIndex((item) => item.id === message.id);
    if (index >= 0) {
      messages.value[index] = { ...messages.value[index], ...message };
    } else {
      messages.value.push(message);
    }
    messages.value.sort((left, right) => {
      const byTime = left.createdAt.localeCompare(right.createdAt);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });
  }

  function patchMessage(messageId: string, patch: Partial<GroupMessage>) {
    const index = messages.value.findIndex((item) => item.id === messageId);
    if (index < 0) return;
    messages.value[index] = { ...messages.value[index], ...patch };
  }

  /** 群消息落库/完成时，同步刷新会话列表里群条目的预览与时间。 */
  function updateGroupPreview(groupId: string, text: string, at?: string) {
    const entry = groups.value.find((group) => group.id === groupId);
    if (!entry) return;
    if (text.trim()) entry.lastMessageText = text;
    entry.lastMessageAt = at || new Date().toISOString();
  }

  function handleEvent(event: GroupChatEvent) {
    if (event.type === 'group.user_message') {
      const message = event.metadata.message as GroupMessage | undefined;
      if (message) {
        if (optimisticUserId.value) {
          const index = messages.value.findIndex((item) => item.id === optimisticUserId.value);
          if (index >= 0) messages.value.splice(index, 1);
          optimisticUserId.value = null;
        }
        mergeMessage(message);
        updateGroupPreview(message.groupSessionId, message.content, message.createdAt);
      }
      return;
    }
    if (event.type === 'group.director.status') {
      directorPhase.value = 'thinking';
      return;
    }
    if (event.type === 'group.director.plan') {
      directorPhase.value = 'decided';
      lastPlan.value = (event.metadata.plan as GroupTurnPlan) || null;
      return;
    }
    if (event.type === 'group.member.status') {
      const agentId = Number(event.agentId || 0);
      const phase = String(event.metadata.phase || '');
      if (agentId && (phase === 'thinking' || phase === 'streaming' || phase === 'done')) {
        memberStatus.value = { ...memberStatus.value, [agentId]: phase };
      }
      return;
    }
    if (event.type === 'group.member.started') {
      const message = event.metadata.message as GroupMessage | undefined;
      if (message) mergeMessage(message);
      if (event.agentId) {
        memberStatus.value = { ...memberStatus.value, [event.agentId]: 'streaming' };
      }
      directorPhase.value = 'decided';
      return;
    }
    if (event.type === 'group.member.delta') {
      const messageId = String(event.messageId || '');
      if (!messageId) return;
      const index = messages.value.findIndex((item) => item.id === messageId);
      if (index >= 0) {
        messages.value[index] = {
          ...messages.value[index],
          content: `${messages.value[index].content}${event.content || ''}`,
          status: 'streaming',
        };
      }
      if (event.agentId) {
        memberStatus.value = { ...memberStatus.value, [event.agentId]: 'streaming' };
      }
      return;
    }
    if (event.type === 'group.member.completed') {
      const message = event.metadata.message as GroupMessage | undefined;
      if (message) {
        mergeMessage(message);
        updateGroupPreview(message.groupSessionId, message.content, message.createdAt);
      }
      if (event.agentId) {
        memberStatus.value = { ...memberStatus.value, [event.agentId]: 'done' };
      }
      return;
    }
    if (event.type === 'group.turn.completed') {
      directorPhase.value = 'idle';
      lastPlan.value = null;
      return;
    }
    if (event.type === 'group.error') {
      lastError.value = String(event.content || '群聊发生错误');
      if (event.messageId) patchMessage(String(event.messageId), { status: 'error' });
    }
  }

  async function loadGroups() {
    loadingGroups.value = true;
    try {
      groups.value = await groupChatApi.listGroups();
    } finally {
      loadingGroups.value = false;
    }
  }

  async function createGroup(input: { title: string; description?: string; memberAgentIds: number[] }) {
    const detail = await groupChatApi.createGroup(input);
    await loadGroups();
    currentGroup.value = detail;
    messages.value = [];
    hasMoreOlder.value = false;
    return detail;
  }

  async function selectGroup(groupId: string) {
    lastError.value = '';
    directorPhase.value = 'idle';
    lastPlan.value = null;
    memberStatus.value = {};
    loadingMessages.value = true;
    try {
      const detail = await groupChatApi.openGroup(groupId);
      currentGroup.value = detail;
      const page = await groupChatApi.listMessages(groupId, { limit: 40 });
      messages.value = page.messages;
      hasMoreOlder.value = page.hasMoreOlder;
      const inList = groups.value.find((group) => group.id === groupId);
      if (inList) inList.unreadCount = 0;
    } finally {
      loadingMessages.value = false;
    }
  }

  async function loadOlderMessages() {
    if (!currentGroupId.value || !hasMoreOlder.value || loadingMessages.value) return;
    const oldest = messages.value[0];
    if (!oldest) return;
    loadingMessages.value = true;
    try {
      const page = await groupChatApi.listMessages(currentGroupId.value, {
        limit: 40,
        beforeMessageId: oldest.id,
      });
      messages.value = [...page.messages, ...messages.value];
      hasMoreOlder.value = page.hasMoreOlder;
    } finally {
      loadingMessages.value = false;
    }
  }

  async function sendMessage(text: string, mentionedAgentIds: number[] = []) {
    const content = text.trim();
    if (!content || !currentGroupId.value || sending.value) return;
    sending.value = true;
    lastError.value = '';
    directorPhase.value = 'thinking';
    lastPlan.value = null;
    memberStatus.value = {};
    const optimisticId = localId('local-user');
    optimisticUserId.value = optimisticId;
    messages.value.push({
      id: optimisticId,
      groupSessionId: currentGroupId.value,
      userId: 'default_user',
      speakerType: 'user',
      speakerId: 'default_user',
      turnId: '',
      content,
      metadataJson: null,
      metadata: {},
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    try {
      await streamGroupTurn(
        currentGroupId.value,
        { message: content, mentionedAgentIds },
        handleEvent,
      );
      if (!lastError.value) {
        const conversation = groups.value.find((group) => group.id === currentGroupId.value);
        if (conversation) {
          conversation.lastMessageText = content;
          conversation.lastMessageAt = new Date().toISOString();
        }
      }
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error);
    } finally {
      sending.value = false;
      directorPhase.value = 'idle';
      optimisticUserId.value = null;
      void loadGroups();
    }
  }

  async function renameGroup(title: string, description?: string) {
    if (!currentGroupId.value) return;
    currentGroup.value = await groupChatApi.updateGroup(currentGroupId.value, { title, description });
    await loadGroups();
  }

  async function addMember(agentId: number) {
    if (!currentGroupId.value) return;
    const result = await groupChatApi.addMember(currentGroupId.value, agentId);
    currentGroup.value = result.detail;
    await loadGroups();
  }

  async function removeMember(agentId: number) {
    if (!currentGroupId.value) return;
    const result = await groupChatApi.removeMember(currentGroupId.value, agentId);
    currentGroup.value = result.detail;
    await loadGroups();
  }

  async function deleteCurrentGroup() {
    if (!currentGroupId.value) return;
    await groupChatApi.deleteGroup(currentGroupId.value);
    currentGroup.value = null;
    messages.value = [];
    await loadGroups();
  }

  return {
    groups,
    currentGroup,
    messages,
    hasMoreOlder,
    loadingGroups,
    loadingMessages,
    sending,
    lastError,
    directorPhase,
    lastPlan,
    memberStatus,
    currentGroupId,
    members,
    activeMembers,
    loadGroups,
    createGroup,
    selectGroup,
    loadOlderMessages,
    sendMessage,
    renameGroup,
    addMember,
    removeMember,
    deleteCurrentGroup,
  };
});
