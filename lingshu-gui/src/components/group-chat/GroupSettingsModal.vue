<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { useAgentsStore } from '../../stores/agents';
import { useGroupChatStore } from '../../stores/groupChat';
import type { GroupDetail } from '../../services/groupChatApi';

const props = defineProps<{ visible: boolean; detail: GroupDetail | null }>();
const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'deleted'): void;
}>();

const agentsStore = useAgentsStore();
const groupStore = useGroupChatStore();
const title = ref('');
const description = ref('');
const saving = ref(false);
const addAgentId = ref<number | undefined>(undefined);

watch(
  () => [props.visible, props.detail?.group.id, props.detail?.group.title] as const,
  () => {
    if (!props.visible || !props.detail) return;
    title.value = props.detail.group.title;
    description.value = props.detail.group.description;
    addAgentId.value = undefined;
    void agentsStore.fetchAgents();
  },
  { immediate: true },
);

const removable = computed(() => (props.detail?.members.length || 0) > 2);
const addableAgents = computed(() => {
  const existing = new Set((props.detail?.members || []).map((member) => member.agentId));
  return agentsStore.agents
    .filter((agent) => agent.id && !existing.has(Number(agent.id)) && agent.isActive !== false)
    .map((agent) => ({ label: agent.displayName || agent.name, value: Number(agent.id) }));
});

function close() {
  emit('update:visible', false);
}

async function save() {
  if (!title.value.trim()) {
    Message.warning('群聊名称不能为空');
    return;
  }
  saving.value = true;
  try {
    await groupStore.renameGroup(title.value.trim(), description.value.trim());
    Message.success('群设置已保存');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}

async function addMember() {
  if (!addAgentId.value) return;
  try {
    await groupStore.addMember(addAgentId.value);
    addAgentId.value = undefined;
    Message.success('成员已加入');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  }
}

async function removeMember(agentId: number) {
  try {
    await groupStore.removeMember(agentId);
    Message.success('成员已移出');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  }
}

async function removeGroup() {
  try {
    await groupStore.deleteCurrentGroup();
    Message.success('群聊已删除');
    close();
    emit('deleted');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  }
}

function avatarText(displayName: string) {
  return (displayName || '?').slice(0, 1);
}
</script>

<template>
  <a-modal
    :visible="props.visible"
    title="群设置"
    :footer="false"
    width="560px"
    :mask-closable="false"
    @cancel="close"
  >
    <div v-if="props.detail" class="settings-body">
      <section class="settings-section">
        <label class="field-label">群聊名称</label>
        <a-input v-model="title" :max-length="60" show-word-limit />
        <label class="field-label">群简介</label>
        <a-textarea v-model="description" :max-length="240" :auto-size="{ minRows: 2, maxRows: 4 }" />
        <div class="save-row">
          <a-button type="primary" size="small" :loading="saving" @click="save">保存</a-button>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-title">成员（{{ props.detail.members.length }}）</div>
        <div class="member-list">
          <div v-for="member in props.detail.members" :key="member.agentId" class="member-row">
            <a-avatar :size="30" :image-url="member.avatar || undefined">
              {{ avatarText(member.displayName || member.name) }}
            </a-avatar>
            <div class="member-name">
              <span>{{ member.displayName || member.name }}</span>
              <small>{{ member.name }}</small>
            </div>
            <a-popconfirm
              v-if="removable"
              content="移出后该成员不再看到后续群消息，但已形成的个人记忆保留。"
              @ok="removeMember(member.agentId)"
            >
              <a-button size="mini" status="danger" type="text">移出</a-button>
            </a-popconfirm>
          </div>
        </div>
        <div v-if="addableAgents.length" class="add-member-row">
          <a-select
            v-model="addAgentId"
            placeholder="添加已有智能体"
            :options="addableAgents"
            allow-clear
            size="small"
            style="flex: 1"
          />
          <a-button size="small" :disabled="!addAgentId" @click="addMember">添加</a-button>
        </div>
        <p class="field-hint">群聊至少保留两位成员。移出成员只影响之后的公开事件，不会删除该成员自己的记忆。</p>
      </section>

      <section class="settings-section danger-zone">
        <div class="section-title">删除群聊</div>
        <p class="field-hint">删除会移除本群公开消息、成员关系和本群公开经历；其他私聊数据不受影响。</p>
        <a-popconfirm content="确定删除这个群聊？此操作不可恢复。" @ok="removeGroup">
          <a-button status="danger" size="small">删除群聊</a-button>
        </a-popconfirm>
      </section>
    </div>
  </a-modal>
</template>

<style scoped>
.settings-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-color, rgba(0, 0, 0, 0.06));
}
.settings-section:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.field-label {
  font-size: 12px;
  color: var(--text-secondary, #86909c);
}
.field-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-tertiary, #a9aeb8);
}
.save-row {
  display: flex;
  justify-content: flex-end;
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #1d2129);
}
.member-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--bg-secondary, rgba(0, 0, 0, 0.02));
}
.member-name {
  flex: 1;
  display: flex;
  flex-direction: column;
  font-size: 13px;
  color: var(--text-primary, #1d2129);
}
.member-name small {
  color: var(--text-tertiary, #a9aeb8);
}
.add-member-row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.danger-zone {
  background: rgba(245, 63, 63, 0.04);
  border-radius: 10px;
  padding: 12px;
}
</style>
