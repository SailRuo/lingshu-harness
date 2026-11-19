<script setup lang="ts">
import { ref } from 'vue';
import Message from '@arco-design/web-vue/es/message';
import IconExclamationCircle from '@arco-design/web-vue/es/icon/icon-exclamation-circle';
import { useChatStore } from '../../stores/chat';
import { resumeApprovedTask } from '../../utils/approvalFlow.js';
import { getFullUrl } from '../../utils/apiConfig';

const visible = ref(false);
const loading = ref(false);
const callInfo = ref({
  id: '',
  tool: '',
  args: {} as any,
  taskId: ''
});

// 暴露打开方法
const open = (id: string, tool: string, args: any, taskId: string = '') => {
  callInfo.value = { id, tool, args, taskId };
  visible.value = true;
};

const handleApprove = async () => {
  loading.value = true;
  try {
    const chatStore = useChatStore();
    const response = await fetch(getFullUrl('/api/v1/tools/approve'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: callInfo.value.id,
        approved: true,
        task_id: callInfo.value.taskId
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      Message.error(error.detail || '批准执行失败');
      return;
    }

    visible.value = false;
    loading.value = false;
    Message.success('已批准执行');

    void resumeApprovedTask({
      resume: (taskId: string) => chatStore.resumeTask(taskId),
      taskId: callInfo.value.taskId
    }).then((result) => {
      if (result.resumeAttempted && !result.resumeSucceeded && !result.resumeNotRequired) {
        Message.warning(`已批准执行，但恢复任务失败：${result.resumeErrorMessage || '请手动继续'}`);
      }
    });
  } catch (error) {
    Message.error('批准执行失败');
  } finally {
    loading.value = false;
  }
};

const handleReject = async () => {
  loading.value = true;
  try {
    const chatStore = useChatStore();
    const response = await fetch(getFullUrl('/api/v1/tools/approve'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: callInfo.value.id,
        approved: false,
        task_id: callInfo.value.taskId
      })
    });
    if (response.ok) {
      Message.info('已拒绝执行');
      visible.value = false;
      void resumeApprovedTask({
        resume: (taskId: string) => chatStore.resumeTask(taskId),
        taskId: callInfo.value.taskId
      }).then((result) => {
        if (result.resumeAttempted && !result.resumeSucceeded && !result.resumeNotRequired) {
          Message.warning(`已拒绝执行，但恢复任务失败：${result.resumeErrorMessage || '请手动继续'}`);
        }
      });
      return;
    }
    const error = await response.json().catch(() => ({}));
    Message.error(error.detail || '拒绝执行失败');
  } catch (error) {
    Message.error('拒绝执行失败');
  } finally {
    loading.value = false;
  }
};

defineExpose({ open });
</script>

<template>
  <a-modal 
    v-model:visible="visible" 
    title="工具执行审批" 
    @cancel="visible = false"
    :footer="false"
  >
    <div class="approval-content">
      <div class="warning-info">
        <IconExclamationCircle class="warning-icon" />
        <div class="text">
          <p class="main">Agent 正在申请执行敏感操作</p>
          <p class="sub">请检查参数并决定是否允许。未经授权的执行可能会导致数据丢失。</p>
        </div>
      </div>

      <div class="tool-info">
        <div class="info-row">
          <span class="label">工具名称:</span>
          <span class="value code">{{ callInfo.tool }}</span>
        </div>
        <div class="info-row vertical">
          <span class="label">执行参数:</span>
          <div class="args-view">
            <pre>{{ JSON.stringify(callInfo.args, null, 2) }}</pre>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <a-button @click="handleReject" :loading="loading">拒绝执行</a-button>
        <a-button type="primary" @click="handleApprove" :loading="loading" class="approve-btn">批准执行</a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.approval-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.warning-info {
  display: flex;
  gap: 12px;
  background: var(--color-warning-light-1);
  padding: 16px;
  border-radius: 8px;
  border-left: 4px solid var(--color-warning);
}

.warning-icon {
  font-size: 24px;
  color: var(--color-warning);
  flex-shrink: 0;
}

.text .main {
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.text .sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
}

.tool-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-row {
  display: flex;
  gap: 8px;
  font-size: 14px;
}

.info-row.vertical {
  flex-direction: column;
}

.label {
  color: var(--text-tertiary);
  width: 70px;
  flex-shrink: 0;
}

.value.code {
  font-family: monospace;
  color: var(--color-primary);
  background: var(--color-primary-light-1);
  padding: 2px 6px;
  border-radius: 4px;
}

.args-view {
  background: var(--bg-hover);
  padding: 12px;
  border-radius: 8px;
  max-height: 200px;
  overflow-y: auto;
}

.args-view pre {
  margin: 0;
  font-size: 12px;
  font-family: 'Fira Code', monospace;
  color: var(--text-secondary);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 10px;
}

.approve-btn {
  background-color: var(--color-warning) !important;
  border-color: var(--color-warning) !important;
}

.approve-btn:hover {
  background-color: var(--color-warning-hover) !important;
}
</style>
