<script setup lang="ts">
import { computed, ref } from 'vue';
import MessageList from '../components/chat/MessageList.vue';
import type { AnyMessage } from '../types/message';
import { taskPreviewScenarios } from '../dev/taskPreviewSamples.js';
import type { TaskPreviewScenario } from '../dev/taskPreviewSamples.js';

defineOptions({ name: 'DebugTaskPreviewView' });

const selectedScenarioId = ref(taskPreviewScenarios[0]?.id || '');

const selectedScenario = computed<TaskPreviewScenario | undefined>(() =>
  taskPreviewScenarios.find((scenario) => scenario.id === selectedScenarioId.value) || taskPreviewScenarios[0],
);

const previewMessages = computed<AnyMessage[]>(() => {
  const scenario = selectedScenario.value;
  if (!scenario) return [];

  return [
    {
      id: `${scenario.id}-user`,
      type: 'text',
      senderId: 'user',
      senderName: '我',
      timestamp: new Date('2026-05-04T19:43:30+08:00'),
      status: 'sent',
      isSelf: true,
      content: scenario.prompt,
      metadata: {},
    },
    {
      id: `${scenario.id}-assistant`,
      type: 'text',
      senderId: 'bot',
      senderName: '灵枢 AI',
      senderAvatar: '/lingshu.png',
      timestamp: new Date('2026-05-04T19:43:36+08:00'),
      status: 'sent',
      isSelf: false,
      content: scenario.finalText,
      metadata: {
        taskId: scenario.events[0]?.taskId || scenario.id,
        timelineEvents: scenario.events,
      },
    },
  ];
});
</script>

<template>
  <div class="debug-task-preview-view">
    <header class="preview-toolbar">
      <div class="preview-heading">
        <h1>任务执行预览</h1>
        <p>{{ selectedScenario?.description }}</p>
      </div>
      <a-radio-group v-model="selectedScenarioId" type="button" size="small">
        <a-radio
          v-for="scenario in taskPreviewScenarios"
          :key="scenario.id"
          :value="scenario.id"
        >
          {{ scenario.title }}
        </a-radio>
      </a-radio-group>
    </header>

    <section class="preview-meta">
      <div class="meta-chip">
        <span class="meta-label">样本来源</span>
        <span class="meta-value">真实日志抽样</span>
      </div>
      <div class="meta-chip">
        <span class="meta-label">事件数</span>
        <span class="meta-value">{{ selectedScenario?.events.length || 0 }}</span>
      </div>
      <div class="meta-chip">
        <span class="meta-label">查看地址</span>
        <span class="meta-value">#/debug/task-preview</span>
      </div>
    </section>

    <section class="preview-shell">
      <MessageList :messages="previewMessages" />
    </section>
  </div>
</template>

<style scoped>
.debug-task-preview-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 18px 20px 20px;
  gap: 14px;
  background: var(--bg-chat-window);
}

.preview-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.preview-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preview-heading h1 {
  margin: 0;
  font-size: 20px;
  line-height: 1.3;
  font-weight: 600;
  color: var(--text-primary);
}

.preview-heading p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
  max-width: 720px;
}

.preview-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--bg-message-other);
  border: 1px solid var(--border-color);
}

.meta-label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.meta-value {
  font-size: 12px;
  color: var(--text-primary);
}

.preview-shell {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-message-other);
  overflow: hidden;
}

@media (max-width: 720px) {
  .debug-task-preview-view {
    padding: 14px;
  }

  .preview-toolbar {
    flex-direction: column;
  }
}
</style>
