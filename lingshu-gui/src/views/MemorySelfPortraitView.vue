<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import MemoryPageShell from '../components/memory/MemoryPageShell.vue';
import { useMemoryApiContext, type MemoryAgentFilter } from '../composables/useMemoryApiContext';
import { useAgentsStore } from '../stores/agents';

interface RetiredDimension {
  key: string;
  reason: string;
  at: string;
}

interface SelfPortraitData {
  selfPortrait: {
    narrative: string;
    dimensions: Record<string, string>;
    retired: RetiredDimension[];
    updatedAt: string;
  } | null;
  anchor: {
    summary: string;
    coveredAt: string;
    updatedAt: string;
  } | null;
  hasAnchor: boolean;
}

const agentsStore = useAgentsStore();
const agentFilter = ref<MemoryAgentFilter>(0);
const { memoryQueryParams, getFullUrl } = useMemoryApiContext({ agentFilter });

const loading = ref(false);
const errorText = ref('');
const data = ref<SelfPortraitData | null>(null);

const dimensions = computed(() =>
  Object.entries(data.value?.selfPortrait?.dimensions || {}).filter(([, value]) => value),
);
const retired = computed(() => data.value?.selfPortrait?.retired || []);
const hasPortrait = computed(() => Boolean(data.value?.selfPortrait));

function formatTime(value: string): string {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const res = await fetch(getFullUrl(`/api/v1/memory/self-portrait?${memoryQueryParams()}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data.value = await res.json();
  } catch (e) {
    errorText.value = (e as Error).message || '加载失败';
  } finally {
    loading.value = false;
  }
}

watch(agentFilter, () => { void load(); });
onMounted(() => {
  void agentsStore.fetchAgents();
  void load();
});
</script>

<template>
  <MemoryPageShell
    v-model:agent-filter="agentFilter"
    title="她的自画像"
    subtitle="从相处里慢慢长出来的自我理解 · 只读"
  >
    <div class="portrait-content">
      <div v-if="loading" class="state-box">加载中…</div>
      <div v-else-if="errorText" class="state-box error">{{ errorText }}</div>
      <div v-else-if="!hasPortrait" class="state-box empty-state">
        <div class="empty-title">她还没有长出稳定的自画像</div>
        <p>会话变长、历史被压缩成会话摘要之后，这里会出现她对自己的理解。</p>
      </div>
      <template v-else-if="data?.selfPortrait">
        <section class="portrait-hero">
          <h2>她正在成为的样子</h2>
          <p class="portrait-meta">最近更新：{{ formatTime(data.selfPortrait.updatedAt) }}</p>
          <p v-if="data.selfPortrait.narrative" class="portrait-narrative">
            {{ data.selfPortrait.narrative }}
          </p>
          <p v-else class="portrait-narrative muted">她还没有用一段话概括自己。</p>
        </section>

        <section v-if="dimensions.length" class="panel">
          <h3>感知透镜</h3>
          <ul class="dimension-list">
            <li v-for="[key, value] in dimensions" :key="key">
              <span class="dimension-key">{{ key }}</span>
              <span class="dimension-value">{{ value }}</span>
            </li>
          </ul>
        </section>

        <details v-if="retired.length" class="panel folded">
          <summary>已经褪去的维度（{{ retired.length }}）</summary>
          <ul class="retired-list">
            <li v-for="item in retired" :key="`${item.key}-${item.at}`">
              <div class="retired-head">
                <strong>{{ item.key }}</strong>
                <span v-if="item.at">{{ formatTime(item.at) }}</span>
              </div>
              <p v-if="item.reason">{{ item.reason }}</p>
            </li>
          </ul>
        </details>

        <details v-if="data.anchor?.summary" class="panel folded">
          <summary>历史会话摘要（生成于 {{ formatTime(data.anchor.updatedAt) }}）</summary>
          <p class="anchor-range">
            覆盖范围：截至 {{ formatTime(data.anchor.coveredAt) }} 之前的对话
          </p>
          <p class="anchor-summary">{{ data.anchor.summary }}</p>
        </details>
      </template>
    </div>
  </MemoryPageShell>
</template>

<style scoped>
.portrait-content { padding: 20px 24px 32px; max-width: 860px; }
.state-box { padding: 40px; text-align: center; color: var(--text-secondary); }
.state-box.error { color: #e57373; }
.empty-state { padding: 64px 20px; }
.empty-title { font-size: 16px; color: var(--text-primary); margin-bottom: 8px; }
.empty-state p { margin: 0; font-size: 13px; }
.portrait-hero {
  padding: 20px 22px;
  border-radius: 12px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: var(--bg-secondary, rgba(255,255,255,0.03));
  margin-bottom: 16px;
}
.portrait-hero h2 { margin: 0 0 6px; font-size: 18px; }
.portrait-meta { margin: 0 0 14px; font-size: 12px; color: var(--text-secondary); }
.portrait-narrative { margin: 0; font-size: 14px; line-height: 1.75; white-space: pre-wrap; }
.portrait-narrative.muted { color: var(--text-secondary); }
.panel {
  padding: 16px 18px;
  border-radius: 12px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: var(--bg-secondary, rgba(255,255,255,0.02));
  margin-bottom: 14px;
}
.panel h3 { margin: 0 0 12px; font-size: 14px; }
.folded summary { cursor: pointer; font-size: 14px; color: var(--text-primary); }
.dimension-list, .retired-list { margin: 0; padding: 0; list-style: none; }
.dimension-list li {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06));
}
.dimension-list li:last-child { border-bottom: 0; }
.dimension-key { flex: 0 0 110px; font-size: 13px; color: var(--text-secondary); }
.dimension-value { flex: 1; font-size: 13px; line-height: 1.6; }
.retired-list { margin-top: 12px; }
.retired-list li { padding: 10px 0; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06)); }
.retired-list li:last-child { border-bottom: 0; }
.retired-head { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.retired-head span { font-size: 11px; color: var(--text-secondary); }
.retired-list p { margin: 6px 0 0; font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
.anchor-range { margin: 12px 0 6px; font-size: 12px; color: var(--text-secondary); }
.anchor-summary { margin: 0; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
</style>
