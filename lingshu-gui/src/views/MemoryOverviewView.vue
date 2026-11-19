<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import MemoryPageShell from '../components/memory/MemoryPageShell.vue';
import { useMemoryApiContext, type MemoryAgentFilter } from '../composables/useMemoryApiContext';
import { useAgentsStore } from '../stores/agents';

interface OverviewData {
  counts: Record<string, number>;
  selfState: {
    closeness: number;
    intimacyTier: string;
  };
  recent: {
    streams: Array<{ id: string; narrative: string; about: string; type: string }>;
    seeds: Array<{ id: string; content: string; subject: string }>;
    facts: Array<{ description: string; relation: string }>;
    digests: Array<{ id: string; triggeredAt: string }>;
  };
}

const MOOD_LABEL: Record<string, string> = {
  surface: '表面',
  testing: '试探',
  heart: '交心',
  unreserved: '无保留',
};

const router = useRouter();
const agentsStore = useAgentsStore();
const agentFilter = ref<MemoryAgentFilter>(0);
const { memoryQueryParams, getFullUrl } = useMemoryApiContext({ agentFilter });

const loading = ref(false);
const errorText = ref('');
const data = ref<OverviewData | null>(null);
const selfPortraitUpdatedAt = ref('');

function formatTime(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const [res, portraitRes] = await Promise.all([
      fetch(getFullUrl(`/api/v1/memory/overview?${memoryQueryParams()}`)),
      fetch(getFullUrl(`/api/v1/memory/self-portrait?${memoryQueryParams()}`)).catch(() => null),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data.value = await res.json();
    selfPortraitUpdatedAt.value = '';
    if (portraitRes?.ok) {
      const portrait = await portraitRes.json();
      selfPortraitUpdatedAt.value = portrait?.selfPortrait?.updatedAt || '';
    }
  } catch (e) {
    errorText.value = (e as Error).message || '加载失败';
  } finally {
    loading.value = false;
  }
}

function go(path: string) {
  router.push(path);
}

watch(agentFilter, () => { void load(); });
onMounted(() => {
  void agentsStore.fetchAgents();
  void load();
});
</script>

<template>
  <MemoryPageShell v-model:agent-filter="agentFilter" title="记忆总览" subtitle="她记住了什么 · 各层一览">
    <div class="overview-content">
      <div v-if="loading" class="state-box">加载中…</div>
      <div v-else-if="errorText" class="state-box error">{{ errorText }}</div>
      <template v-else-if="data">
        <section class="self-state-card">
          <div class="self-metric">
            <span class="label">亲近</span>
            <strong>{{ Math.round((data.selfState.closeness || 0) * 100) }}%</strong>
          </div>
          <div class="self-metric">
            <span class="label">亲密度</span>
            <strong>{{ MOOD_LABEL[data.selfState.intimacyTier] || data.selfState.intimacyTier }}</strong>
          </div>
        </section>

        <section class="count-grid">
          <button class="count-card" type="button" @click="go('/memory-streams')">
            <span class="count-num">{{ data.counts.streams ?? 0 }}</span>
            <span class="count-label">意识流</span>
            <span class="count-sub">外 {{ data.counts.streamsExternal ?? 0 }} · 内 {{ data.counts.streamsInternal ?? 0 }}</span>
          </button>
          <button class="count-card" type="button" @click="go('/memory-seeds')">
            <span class="count-num">{{ data.counts.seeds ?? 0 }}</span>
            <span class="count-label">印象种子</span>
          </button>
          <button class="count-card" type="button" @click="go('/memory-self-portrait')">
            <span class="count-num">{{ selfPortraitUpdatedAt ? '有' : '无' }}</span>
            <span class="count-label">她的自画像</span>
            <span class="count-sub">{{ selfPortraitUpdatedAt ? `更新于 ${formatTime(selfPortraitUpdatedAt)}` : '会话摘要提交后生成' }}</span>
          </button>
          <button class="count-card" type="button" @click="go('/memory-graph')">
            <span class="count-num">{{ data.counts.factsCurrent ?? 0 }}</span>
            <span class="count-label">硬事实</span>
            <span class="count-sub">过期 {{ data.counts.factsExpired ?? 0 }}</span>
          </button>
          <button class="count-card" type="button" @click="go('/memory-boundaries')">
            <span class="count-num">{{ data.counts.constraints ?? 0 }}</span>
            <span class="count-label">边界规则</span>
          </button>
          <button class="count-card" type="button" @click="go('/memory-boundaries')">
            <span class="count-num">{{ data.counts.appointments ?? 0 }}</span>
            <span class="count-label">约定提醒</span>
          </button>
        </section>

        <div class="recent-grid">
          <section class="recent-panel">
            <h3>最近意识流</h3>
            <div v-if="!data.recent.streams.length" class="empty">暂无</div>
            <article v-for="s in data.recent.streams" :key="s.id" class="recent-item">
              <span class="tag" :class="s.type">{{ s.type === 'internal' ? '内心' : '对话' }}</span>
              <span class="about">{{ s.about }}</span>
              <p>{{ s.narrative }}</p>
            </article>
          </section>
          <section class="recent-panel">
            <h3>最近印象</h3>
            <div v-if="!data.recent.seeds.length" class="empty">暂无</div>
            <article v-for="s in data.recent.seeds" :key="s.id" class="recent-item">
              <span class="tag">{{ s.subject }}</span>
              <p>{{ s.content }}</p>
            </article>
          </section>
        </div>
      </template>
    </div>
  </MemoryPageShell>
</template>

<style scoped>
.overview-content { padding: 20px 24px 32px; }
.state-box { padding: 40px; text-align: center; color: var(--text-secondary); }
.state-box.error { color: #e57373; }
.self-state-card {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 20px;
  padding: 16px 20px;
  border-radius: 12px;
  background: var(--bg-secondary, rgba(255,255,255,0.03));
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
}
.self-metric { display: flex; flex-direction: column; gap: 4px; }
.self-metric .label { font-size: 12px; color: var(--text-secondary); }
.self-metric strong { font-size: 18px; }
.count-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.count-card {
  text-align: left;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: var(--bg-secondary, rgba(255,255,255,0.02));
  cursor: pointer;
  transition: border-color 0.15s;
}
.count-card:hover { border-color: color-mix(in srgb, var(--color-primary, #3D8C41) 35%, transparent); }
.count-num { display: block; font-size: 28px; font-weight: 700; line-height: 1.1; }
.count-label { display: block; margin-top: 6px; font-size: 13px; color: var(--text-primary); }
.count-sub { display: block; margin-top: 4px; font-size: 11px; color: var(--text-tertiary, var(--text-secondary)); }
.recent-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.recent-panel {
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: var(--bg-secondary, rgba(255,255,255,0.02));
}
.recent-panel h3 { margin: 0 0 12px; font-size: 14px; }
.recent-item { padding: 10px 0; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06)); }
.recent-item:last-child { border-bottom: 0; }
.recent-item p { margin: 6px 0 0; font-size: 13px; line-height: 1.55; color: var(--text-secondary); }
.tag {
  display: inline-block;
  margin-right: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(255,255,255,0.06);
  color: var(--text-secondary);
}
.tag.internal { color: #f472b6; }
.about { font-size: 11px; color: var(--text-tertiary, var(--text-secondary)); }
.empty { font-size: 13px; color: var(--text-secondary); }
@media (max-width: 900px) {
  .count-grid, .recent-grid, .self-state-card { grid-template-columns: 1fr; }
}
</style>
