<script setup lang="ts">
import { ref } from 'vue';
import MemoryEchoPanel from './MemoryEchoPanel.vue';
import CallTracePanel from './CallTracePanel.vue';
import ChatHistoryPanel from './ChatHistoryPanel.vue';

type PanelTab = 'memory' | 'traces' | 'history';

const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: 'memory', label: '记忆召回' },
  { id: 'traces', label: '调用记录' },
  { id: 'history', label: '聊天记录' },
];

const activeTab = ref<PanelTab>('memory');
</script>

<template>
  <!--
    Docked panel, not an overlay: it is a flex child of `.chat-body-layout`, so
    the conversation area shrinks instead of being covered by the drawer.
    It stays open until toggled from the header; clicking elsewhere must not close it.
  -->
  <aside class="right-panel">
    <div class="panel-tabs">
      <button
        v-for="tab in PANEL_TABS"
        :key="tab.id"
        type="button"
        class="panel-tab"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="panel-body" :class="{ 'is-fixed': activeTab === 'history' }">
      <MemoryEchoPanel v-if="activeTab === 'memory'" />
      <CallTracePanel v-else-if="activeTab === 'traces'" />
      <ChatHistoryPanel v-else />
    </div>
  </aside>
</template>

<style scoped>
/*
 * Docked side panel: it takes its own space in the `.chat-body-layout` flex
 * row, so the conversation column shrinks instead of being covered.
 */
.right-panel {
  flex: 0 0 380px;
  max-width: 45vw;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--bg-chat-window);
  border-left: 1px solid var(--border-color);
}

.panel-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex-shrink: 0;
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--border-color);
}

.panel-tab {
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.panel-tab:hover {
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
}

.panel-tab.active {
  color: var(--color-primary, #3D8C41);
  border-color: color-mix(in srgb, var(--color-primary, #3D8C41) 40%, transparent);
  background: color-mix(in srgb, var(--color-primary, #3D8C41) 10%, transparent);
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 14px;
}

/* 聊天记录页自己管理滚动，避免工具栏和清空按钮跟着列表滚走 */
.panel-body.is-fixed {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
