<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { useAgentsStore } from '../../stores/agents';
import { useGroupChatStore } from '../../stores/groupChat';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'created', groupId: string): void;
}>();

const agentsStore = useAgentsStore();
const groupStore = useGroupChatStore();
const title = ref('');
const description = ref('');
const memberIds = ref<number[]>([]);
const submitting = ref(false);

const agentOptions = computed(() =>
  agentsStore.agents
    .filter((agent) => agent.isActive !== false && agent.id)
    .map((agent) => ({
      label: agent.displayName || agent.name,
      value: Number(agent.id),
    })),
);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    title.value = '';
    description.value = '';
    memberIds.value = [];
    void agentsStore.fetchAgents();
  },
);

function close() {
  emit('update:visible', false);
}

async function submit() {
  if (!title.value.trim()) {
    Message.warning('请填写群聊名称');
    return;
  }
  if (memberIds.value.length < 2) {
    Message.warning('群聊至少需要选择两位成员');
    return;
  }
  submitting.value = true;
  try {
    const detail = await groupStore.createGroup({
      title: title.value.trim(),
      description: description.value.trim(),
      memberAgentIds: memberIds.value,
    });
    Message.success('群聊已创建');
    emit('created', detail.group.id);
    close();
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <a-modal
    :visible="props.visible"
    title="创建群聊"
    :mask-closable="false"
    :footer="false"
    width="520px"
    @cancel="close"
  >
    <div class="group-create-form">
      <label class="field-label">群聊名称</label>
      <a-input v-model="title" placeholder="例如：伙伴们的小组" :max-length="60" show-word-limit />

      <label class="field-label">群简介（选填）</label>
      <a-textarea
        v-model="description"
        placeholder="这个群是为什么建起来的？"
        :max-length="240"
        :auto-size="{ minRows: 2, maxRows: 4 }"
      />

      <label class="field-label">选择成员（至少 2 位）</label>
      <a-select
        v-model="memberIds"
        multiple
        placeholder="选择已有的智能体"
        :options="agentOptions"
        :max-tag-count="4"
      />
      <p class="field-hint">成员只共享本群的公开事件；各自的私聊记忆、画像和事实互不可见。</p>

      <div class="form-actions">
        <a-button @click="close">取消</a-button>
        <a-button type="primary" :loading="submitting" @click="submit">创建</a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.group-create-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.field-label {
  font-size: 13px;
  color: var(--text-secondary, #86909c);
  margin-top: 4px;
}
.field-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-tertiary, #a9aeb8);
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
</style>
