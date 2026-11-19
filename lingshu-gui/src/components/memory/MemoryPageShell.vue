<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Select as ASelect } from '@arco-design/web-vue';
import type { MemoryAgentFilter } from '../../composables/useMemoryApiContext';
import { useAgentsStore } from '../../stores/agents';
import { useChatStore } from '../../stores/chat';

const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  agentFilterMode?: 'all' | 'self-evolution';
  showMemoryNav?: boolean;
}>(), {
  agentFilterMode: 'all',
  showMemoryNav: true,
});

const NAV_ITEMS = [
  { path: '/memory-overview', label: '总览' },
  { path: '/memory-streams', label: '意识流' },
  { path: '/memory-self-portrait', label: '她的自画像' },
  { path: '/memory-graph', label: '图谱' },
  { path: '/memory-boundaries', label: '规则' },
  { path: '/memory-audit', label: '审计' },
];

const chatStore = useChatStore();
const agentsStore = useAgentsStore();
const route = useRoute();
const router = useRouter();
const agentFilter = defineModel<MemoryAgentFilter>('agentFilter', { required: true });

const selectableAgents = computed(() => {
  if (props.agentFilterMode === 'self-evolution') {
    return agentsStore.agents.filter((agent) => agent.selfEvolutionEnabled !== false);
  }
  return agentsStore.agents;
});

const agentOptions = computed(() =>
  selectableAgents.value.map((agent) => ({
    value: agent.id,
    label: agent.displayName,
  })),
);

function syncAgentFilterFromSession() {
  const agents = selectableAgents.value;
  if (!agents.length) {
    agentFilter.value = 0;
    return;
  }
  
  if (
    typeof agentsStore.selectedAgentId === 'number'
    && Number.isFinite(agentsStore.selectedAgentId)
    && agents.some((a) => a.id === agentsStore.selectedAgentId)
  ) {
    agentFilter.value = agentsStore.selectedAgentId;
    return;
  }

  const sessionAgentId = chatStore.currentAgentId;
  if (
    typeof sessionAgentId === 'number'
    && Number.isFinite(sessionAgentId)
    && agents.some((a) => a.id === sessionAgentId)
  ) {
    agentFilter.value = sessionAgentId;
    return;
  }
  const fallback = agents.find((a) => a.isDefault) || agents[0];
  if (typeof fallback?.id === 'number') agentFilter.value = fallback.id;
}

watch(agentFilter, (newVal) => {
  if (typeof newVal === 'number' && Number.isFinite(newVal) && newVal !== 0) {
    agentsStore.selectedAgentId = newVal;
  }
});

function goNav(path: string) {
  if (route.path !== path) router.push(path);
}

onMounted(() => {
  void agentsStore.fetchAgents();
});

watch(selectableAgents, () => { syncAgentFilterFromSession(); }, { immediate: true });
</script>

<template>
  <div id="memory-page-root" class="memory-page">
    <header class="page-header">
      <div class="header-main">
        <h1>{{ title }}</h1>
        <p v-if="subtitle">{{ subtitle }}</p>
      </div>
      <div class="header-right">
        <div v-if="$slots.actions" class="header-actions">
          <slot name="actions" />
        </div>
        <ASelect
          v-model="agentFilter"
          :options="agentOptions"
          placeholder="选择智能体"
          class="agent-select"
        />
      </div>
    </header>

    <nav v-if="showMemoryNav" class="memory-nav">
      <button
        v-for="item in NAV_ITEMS"
        :key="item.path"
        type="button"
        class="nav-chip"
        :class="{ active: route.path === item.path }"
        @click="goNav(item.path)"
      >
        {{ item.label }}
      </button>
    </nav>

    <div class="memory-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.memory-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px 12px;
  border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.08));
}

.header-main {
  flex: 1;
  min-width: 0;
}

.header-main h1 {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
}

.header-main p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.agent-select {
  width: 260px;
  flex: none;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
  justify-content: flex-end;
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  flex-shrink: 0;
}

.header-actions :deep(button) {
  white-space: nowrap;
  flex-shrink: 0;
  min-width: max-content;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.header-actions :deep(button:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}

.header-actions :deep(button.danger) {
  border-color: rgba(245, 63, 63, 0.35);
  color: #f53f3f;
}

.memory-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06));
}

.nav-chip {
  height: 32px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.nav-chip:hover {
  color: var(--text-primary);
  background: var(--bg-hover, rgba(255,255,255,0.04));
}

.nav-chip.active {
  color: var(--color-primary, #3D8C41);
  border-color: color-mix(in srgb, var(--color-primary, #3D8C41) 40%, transparent);
  background: color-mix(in srgb, var(--color-primary, #3D8C41) 10%, transparent);
}

.memory-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
