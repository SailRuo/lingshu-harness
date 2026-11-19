<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Select as ASelect, Switch as ASwitch, Modal, Message } from '@arco-design/web-vue';
import * as echarts from 'echarts';
import MemoryPageShell from '../components/memory/MemoryPageShell.vue';
import { useMemoryApiContext, type MemoryAgentFilter } from '../composables/useMemoryApiContext';
import { useAgentsStore } from '../stores/agents';
import { useUIStore } from '../stores/ui';

interface StreamItem {
  id: string;
  narrative: string;
  about: string;
  type: string;
  rawStart: number | null;
  rawEnd: number | null;
  revisitCount: number;
  createdAt: string | null;
  similarity?: number;
  similarityKind?: 'query' | 'expanded';
  similarityLabel?: string;
  similarityTitle?: string;
  showSimilarityValue?: boolean;
}

interface ProbeCandidate {
  id: string;
  narrative: string;
  about: string;
  type: string;
  similarity: number;
  stage: 'direct' | 'expanded' | 'ann';
  rawStart: number | null;
  rawEnd: number | null;
  revisitCount: number;
  createdAt: string | null;
}

interface StreamProbeState {
  active: boolean;
  query: string;
  rank1Floor: number;
  tailFloor: number;
  annCount: number;
  afterFloor: number;
  coRecall: number;
  corpusTotal: number;
  candidates: ProbeCandidate[];
}

const TYPE_FILTER = [
  { value: '', label: '全部' },
  { value: 'external', label: '对话片段' },
  { value: 'internal', label: '内心独白' },
];

const agentsStore = useAgentsStore();
const uiStore = useUIStore();
const route = useRoute();
const agentFilter = ref<MemoryAgentFilter>(0);
const { memoryQueryParams, getFullUrl } = useMemoryApiContext({ agentFilter });

const loading = ref(false);
const clearing = ref(false);
const rebuilding = ref(false);
const rebuildOpen = ref(false);
const rebuildTotal = ref(0);
const rebuildCompleted = ref(0);
const rebuildOk = ref(0);
const rebuildFailed = ref(0);
const rebuildMessage = ref('');
const rebuildStatus = ref<'idle' | 'running' | 'completed' | 'failed'>('idle');
let rebuildAbort: AbortController | null = null;
const errorText = ref('');
const items = ref<StreamItem[]>([]);
const typeFilter = ref('');
const query = ref('');
const vectorMode = ref(false);
const searchMode = ref<'text' | 'vector'>('text');
const streamProbe = ref<StreamProbeState | null>(null);
// 原话数据按"轮范围"缓存（同段多条共用，省重复请求）；展开状态按"意识流 id"独立记（互不牵连）。
const turnCache = ref<Record<string, Array<{ user: string; assistant: string; missing?: boolean }>>>({});
const expandedIds = ref<Record<string, boolean>>({});

const highlightId = computed(() => String(route.query.streamId || route.query.id || ''));
const rebuildPercent = computed(() => {
  if (rebuildTotal.value <= 0) return rebuildStatus.value === 'running' ? 0 : 100;
  return Math.min(100, Math.round((rebuildCompleted.value / rebuildTotal.value) * 100));
});
const displayItems = computed(() => {
  if (streamProbe.value?.active && streamProbe.value.candidates.length) {
    return streamProbe.value.candidates;
  }
  return items.value;
});

// 叙事簇弹窗：点某条意识流 → 拉它的 AKIN(记忆簇相似)邻居，按时间顺序串成一条叙事。
const narrativeOpen = ref(false);
const narrativeLoading = ref(false);
const narrativeError = ref('');
const narrativeFocalId = ref('');
const narrativeItems = ref<StreamItem[]>([]);

async function openNarrative(item: { id: string }) {
  narrativeOpen.value = true;
  narrativeLoading.value = true;
  narrativeError.value = '';
  narrativeFocalId.value = item.id;
  narrativeItems.value = [];
  try {
    const res = await fetch(getFullUrl(`/api/v1/memory/streams/${item.id}/cluster`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    narrativeItems.value = Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    narrativeError.value = (e as Error).message || '加载失败';
  } finally {
    narrativeLoading.value = false;
  }
}

function closeNarrative() {
  narrativeOpen.value = false;
}

// 关联图（记忆簇）：节点=切片，边=AKIN（相似）。
const viewMode = ref<'list' | 'graph'>('list');
const chartRef = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;
const graphEmpty = ref(false);

const STAGE_LABELS: Record<ProbeCandidate['stage'], string> = {
  direct: '直召过闸',
  expanded: '簇扩展带出',
  ann: '未过闸',
};

function formatScore(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(3);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function buildStreamProbe(data: Record<string, unknown>, fullItems: StreamItem[]): StreamProbeState {
  const floors = asRecord(data.floors) || {};
  const corpus = asRecord(data.corpus) || {};
  const correct = asRecord(data.correctQueryPrefix) || {};
  const topAnn = asArray(correct.topAnn);
  const afterFloorItems = asArray(correct.afterFloorItems);
  const coRecallItems = asArray(correct.coRecallItems);
  const floorIds = new Set(
    afterFloorItems
      .map((row) => asRecord(row)?.id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id)),
  );
  const finalIds = new Set(
    coRecallItems
      .map((row) => asRecord(row)?.id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id)),
  );
  const fullById = new Map(fullItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const candidates: ProbeCandidate[] = [];

  const pushRow = (row: unknown, fallbackStage: ProbeCandidate['stage']) => {
    const rec = asRecord(row);
    if (!rec) return;
    const id = String(rec.id || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    const full = fullById.get(id);
    // 直召过闸 = 过了问句相似度地板；最终里多出来的是 AKIN/关联扩展，不再过 0.40 问句闸。
    const stage: ProbeCandidate['stage'] = floorIds.has(id)
      ? 'direct'
      : finalIds.has(id)
        ? 'expanded'
        : fallbackStage;
    candidates.push({
      id,
      narrative: String(rec.narrative || full?.narrative || ''),
      about: String(rec.about || full?.about || ''),
      type: full?.type || 'external',
      similarity: Number(rec.similarity ?? full?.similarity ?? 0),
      stage,
      rawStart: full?.rawStart ?? null,
      rawEnd: full?.rawEnd ?? null,
      revisitCount: full?.revisitCount ?? 0,
      createdAt: full?.createdAt ?? null,
    });
  };

  for (const row of topAnn) pushRow(row, 'ann');
  for (const row of afterFloorItems) pushRow(row, 'direct');
  for (const row of coRecallItems) pushRow(row, 'expanded');
  candidates.sort((a, b) => {
    const stageRank = { direct: 0, expanded: 1, ann: 2 } as const;
    const d = stageRank[a.stage] - stageRank[b.stage];
    if (d !== 0) return d;
    return b.similarity - a.similarity;
  });

  return {
    active: true,
    query: String(data.query || ''),
    rank1Floor: Number(floors.rank1 ?? 0.4),
    tailFloor: Number(floors.tail ?? 0.45),
    annCount: Number(correct.annCount ?? topAnn.length),
    afterFloor: Number(correct.afterFloor ?? afterFloorItems.length),
    coRecall: Number(correct.coRecall ?? coRecallItems.length),
    corpusTotal: Number(corpus.total ?? 0),
    candidates,
  };
}

async function loadRecallDebug(q: string, fullItems: StreamItem[]) {
  if (!vectorMode.value || !q) {
    streamProbe.value = null;
    return;
  }
  try {
    const params = memoryQueryParams({ q });
    const res = await fetch(getFullUrl(`/api/v1/memory/streams/recall-debug?${params}`));
    if (!res.ok) {
      streamProbe.value = null;
      return;
    }
    const data = await res.json();
    streamProbe.value = buildStreamProbe(data || {}, fullItems);
  } catch {
    streamProbe.value = null;
  }
}

async function load() {
  const q = query.value.trim();
  if (vectorMode.value && !q) {
    Message.warning('向量搜索需要输入关键词');
    return;
  }
  loading.value = true;
  errorText.value = '';
  streamProbe.value = null;
  try {
    const params = memoryQueryParams({
      limit: 200,
      type: typeFilter.value || undefined,
      q: q || undefined,
      ...(vectorMode.value && q ? { vector: '1' } : {}),
    });
    const res = await fetch(getFullUrl(`/api/v1/memory/streams?${params}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    items.value = Array.isArray(data.items) ? data.items : [];
    await ensureHighlightedStreamVisible();
    searchMode.value = data.mode === 'vector' ? 'vector' : 'text';
    if (vectorMode.value && q) {
      await loadRecallDebug(q, items.value);
    }
  } catch (e) {
    errorText.value = (e as Error).message || '加载失败';
  } finally {
    loading.value = false;
  }
}

async function ensureHighlightedStreamVisible() {
  const id = highlightId.value;
  if (!id || items.value.some((item) => item.id === id)) return;
  try {
    const res = await fetch(getFullUrl(`/api/v1/memory/streams/${encodeURIComponent(id)}`));
    if (!res.ok) return;
    const detail = await res.json();
    if (detail?.id) {
      items.value = [detail, ...items.value];
    }
  } catch {
    // Deep-link highlighting is best-effort; the regular list still renders.
  }
}

function turnCacheKey(rawStart: number, rawEnd: number | null): string {
  return rawEnd && rawEnd !== rawStart ? `${rawStart}-${rawEnd}` : String(rawStart);
}

async function loadTurn(rawStart: number, rawEnd: number | null) {
  const key = turnCacheKey(rawStart, rawEnd);
  if (turnCache.value[key]) return;
  try {
    const params = memoryQueryParams({
      start: rawStart,
      end: rawEnd ?? undefined,
    });
    const res = await fetch(getFullUrl(`/api/v1/memory/turns?${params}`));
    if (!res.ok) return;
    const data = await res.json();
    const turnItems = Array.isArray(data.items) ? data.items : [];
    if (!turnItems.length) {
      if (data?.missing) {
        turnCache.value[key] = [{ user: '', assistant: '原话已被清空或重新导入，无法展开旧记录。', missing: true }];
      }
      return;
    }
    turnCache.value[key] = turnItems.map((item: { user_message?: string; assistant_message?: string }) => ({
      user: item.user_message || '',
      assistant: item.assistant_message || '',
    }));
  } catch { /* ignore */ }
}

async function toggleTurn(item: { id: string; rawStart: number | null; rawEnd: number | null }) {
  if (expandedIds.value[item.id]) {
    const next = { ...expandedIds.value };
    delete next[item.id];
    expandedIds.value = next;
    return;
  }
  if (item.rawStart) await loadTurn(item.rawStart, item.rawEnd);
  expandedIds.value = { ...expandedIds.value, [item.id]: true };
}

// 兜底：万一漏进旧的英文 key（如主动惦记早期的 self.inner），也翻成第一人称中文，绝不裸露英文。
const LEGACY_ABOUT_LABEL: Record<string, string> = {
  'self.inner': '我·内心', 'self.feeling': '我·感受', 'self.value': '我·在乎',
  'self.reaction': '我·反应', 'self.boundary': '我·边界',
  'us.trust': '我们·信任', 'us.routine': '我们·相处', 'us.conflict': '我们·摩擦', 'us.general': '我们·其它',
  'user.work': '他·工作', 'user.health': '他·健康', 'user.family': '他·家人', 'user.hobby': '他·爱好',
  'user.emotion': '他·情绪', 'user.daily': '他·日常', 'user.general': '他·其它', 'general': '其它',
};

// 这是灵儿自己的记忆，第一人称显示：她·→我·、咱俩·→我们·（他·指用户，不变）。
function aboutLabel(about: string): string {
  const text = String(about || '');
  if (LEGACY_ABOUT_LABEL[text]) return LEGACY_ABOUT_LABEL[text];
  if (text.startsWith('她·')) return '我·' + text.slice(2);
  if (text.startsWith('咱俩·')) return '我们·' + text.slice(3);
  if (text.startsWith('咱俩')) return '我们' + text.slice(2);
  return text;
}

function aboutColor(about: string): string {
  if (about.startsWith('她·') || about.startsWith('self.')) return '#f472b6';
  if (about.startsWith('咱俩') || about.startsWith('us.')) return '#34d399';
  return '#60a5fa';
}

interface GraphStream { id: string; narrative: string; about: string; createdAt: string | null }
interface GraphEdge { type: string; source_id: string; target_id: string; weight: number }

function initChart() {
  if (!chartRef.value) return;
  if (chart) { chart.dispose(); chart = null; }
  chart = echarts.init(chartRef.value);
  window.addEventListener('resize', () => chart?.resize());
}

function renderGraph(data: { streams: GraphStream[]; edges: GraphEdge[] }) {
  if (!chart) return;
  const nodes = (data.streams || []).map((s) => ({
    id: s.id,
    name: (s.narrative || '').slice(0, 18) + ((s.narrative || '').length > 18 ? '…' : ''),
    value: s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '',
    symbolSize: 16,
    itemStyle: { color: aboutColor(s.about || '') },
  }));
  const links = (data.edges || []).map((e, i) => ({
    source: e.source_id,
    target: e.target_id,
    lineStyle: { color: 'rgba(96,165,250,0.5)', width: Math.max(1, (e.weight || 0.7) * 2) },
    id: String(i),
  }));
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      confine: true,
      formatter: (p: { data?: { name?: string; value?: string } }) =>
        p.data?.value ? `${p.data?.name || ''}<br/>${p.data.value}` : (p.data?.name || ''),
    },
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      data: nodes,
      links,
      force: { repulsion: 220, edgeLength: [80, 160], gravity: 0.08 },
      label: { show: true, fontSize: 10, color: '#cbd5e1' },
      emphasis: { focus: 'adjacency', label: { show: true } },
    }],
  }, true);
}

async function loadGraph() {
  loading.value = true;
  errorText.value = '';
  graphEmpty.value = false;
  let payload: { streams: GraphStream[]; edges: GraphEdge[] } | null = null;
  try {
    const res = await fetch(getFullUrl(`/api/v1/memory/streams/graph?${memoryQueryParams()}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (e) {
    errorText.value = (e as Error).message || '加载失败';
    return;
  } finally {
    loading.value = false;
  }
  if (!payload) return;
  graphEmpty.value = (payload.streams?.length || 0) === 0;
  if (graphEmpty.value) return;
  await nextTick();
  initChart();
  if (!chart) return;
  renderGraph(payload);
  chart.resize();
}

function reload() {
  if (viewMode.value === 'graph') void loadGraph();
  else void load();
}

function applyRebuildPayload(payload: {
  phase?: string;
  status?: string;
  total?: number;
  completed?: number;
  ok?: number;
  failed?: number;
  message?: string;
  error?: string;
}) {
  rebuildTotal.value = Number(payload.total || 0);
  rebuildCompleted.value = Number(payload.completed || 0);
  rebuildOk.value = Number(payload.ok || 0);
  rebuildFailed.value = Number(payload.failed || 0);
  rebuildMessage.value = String(payload.error || payload.message || '');
  if (payload.status === 'failed') {
    rebuildStatus.value = 'failed';
    rebuilding.value = false;
    return;
  }
  if (payload.phase === 'done') {
    rebuildStatus.value = payload.status === 'completed' ? 'completed' : 'failed';
    rebuilding.value = false;
    return;
  }
  rebuildStatus.value = 'running';
}

function consumeRebuildSse(buffer: string): string {
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        applyRebuildPayload(JSON.parse(raw));
      } catch {
        // ignore malformed SSE frames
      }
    }
  }
  return rest;
}

function closeRebuildDialog() {
  if (rebuilding.value) return;
  rebuildOpen.value = false;
}

function confirmRebuildEmbeddings() {
  Modal.confirm({
    title: '重建全部意识流向量？',
    content: '将用当前向量模型重算本智能体下所有意识流向量（并发 20）。期间召回可能短暂不准；叙事原文不会改动。',
    okText: '开始重建',
    cancelText: '取消',
    onOk: () => { void runRebuildEmbeddings(); },
  });
}

async function runRebuildEmbeddings() {
  if (rebuilding.value) return;
  rebuildAbort?.abort();
  rebuildAbort = new AbortController();
  rebuilding.value = true;
  rebuildOpen.value = true;
  rebuildStatus.value = 'running';
  rebuildTotal.value = 0;
  rebuildCompleted.value = 0;
  rebuildOk.value = 0;
  rebuildFailed.value = 0;
  rebuildMessage.value = '正在连接…';
  try {
    const res = await fetch(
      getFullUrl(`/api/v1/memory/streams/rebuild-embeddings?${memoryQueryParams()}`),
      { method: 'POST', signal: rebuildAbort.signal },
    );
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = consumeRebuildSse(buffer + decoder.decode(value, { stream: true }));
    }
    consumeRebuildSse(buffer + '\n\n');
    if (rebuildStatus.value === 'running') {
      rebuildStatus.value = 'completed';
      rebuilding.value = false;
    }
    if (rebuildStatus.value === 'completed') {
      Message.success(rebuildMessage.value || '向量已重建');
    } else if (rebuildStatus.value === 'failed') {
      Message.error(rebuildMessage.value || '重建失败');
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    rebuilding.value = false;
    rebuildStatus.value = 'failed';
    rebuildMessage.value = (e as Error).message || '重建失败';
    Message.error(rebuildMessage.value);
  }
}

function confirmDeleteStream(item: { id: string }) {
  Modal.confirm({
    title: '删除这条意识流？',
    content: '将删除该条记录及其关联簇边；人格种子与其它记忆不受影响。不可撤销。',
    okText: '删除',
    okButtonProps: { status: 'danger' },
    cancelText: '取消',
    onOk: async () => {
      const params = memoryQueryParams();
      const res = await fetch(getFullUrl(`/api/v1/memory/streams/${item.id}?${params}`), {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      Message.success('已删除');
      const nextExpanded = { ...expandedIds.value };
      delete nextExpanded[item.id];
      expandedIds.value = nextExpanded;
      await reload();
    },
  });
}

function confirmClearStreams() {
  Modal.confirm({
    title: '清空全部意识流？',
    content: '将删除当前智能体下的所有意识流记录与关联簇；人格种子、规则、硬事实等其它记忆不受影响。不可撤销。',
    okText: '清空',
    okButtonProps: { status: 'danger' },
    cancelText: '取消',
    onOk: async () => {
      clearing.value = true;
      try {
        const params = memoryQueryParams();
        const res = await fetch(getFullUrl(`/api/v1/memory/streams/clear?${params}`), { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        Message.success(data.deleted ? `已清空 ${data.deleted} 条意识流` : '意识流已为空');
        turnCache.value = {};
        expandedIds.value = {};
        await reload();
      } catch (e) {
        Message.error((e as Error).message || '清空失败');
      } finally {
        clearing.value = false;
      }
    },
  });
}

watch([agentFilter, typeFilter], () => { reload(); });
watch(viewMode, () => { reload(); });
watch(highlightId, () => { if (viewMode.value === 'list') void load(); });
onMounted(() => {
  void agentsStore.fetchAgents();
  void load();
});
onBeforeUnmount(() => {
  rebuildAbort?.abort();
  rebuildAbort = null;
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <MemoryPageShell v-model:agent-filter="agentFilter" title="意识流" subtitle="她记住的生活片段">
    <div class="streams-content">
      <div class="mode-tabs">
        <button type="button" :class="{ active: viewMode === 'list' }" @click="viewMode = 'list'">列表</button>
        <button type="button" :class="{ active: viewMode === 'graph' }" @click="viewMode = 'graph'">关联图</button>
        <button
          type="button"
          class="clear-btn"
          :disabled="clearing"
          @click="confirmClearStreams"
        >
          {{ clearing ? '清空中…' : '清空' }}
        </button>
        <button
          v-if="uiStore.consoleNavUnlocked"
          type="button"
          class="rebuild-btn"
          :disabled="rebuilding"
          @click="confirmRebuildEmbeddings"
        >
          {{ rebuilding ? '重建中…' : '重建向量' }}
        </button>
      </div>

      <div v-if="viewMode === 'list'" class="toolbar">
        <ASelect
          v-model="typeFilter"
          :options="TYPE_FILTER"
          placeholder="全部"
          class="filter-select"
        />
        <input
          v-model="query"
          class="search-input"
          :placeholder="vectorMode ? '输入一句用户话，试探会召回哪些意识流…' : '搜索摘要或分类…'"
          @keyup.enter="load"
        />
        <label class="vector-toggle" title="与主聊天相同的意识流召回：ANN → AKIN 簇扩展 → 关联扩展">
          <span>向量</span>
          <ASwitch v-model="vectorMode" size="small" />
        </label>
        <button type="button" class="search-btn" @click="load">
          {{ vectorMode && query.trim() ? '召回试探' : '搜索' }}
        </button>
      </div>

      <div v-if="streamProbe?.active" class="wake-probe-banner">
        <div class="wake-probe-main">
          向量召回（同对话路径）：<code>{{ streamProbe.query }}</code>
        </div>
        <div class="wake-probe-meta">
          问句相似度闸：首条 ≥ {{ streamProbe.rank1Floor.toFixed(2) }}，其余 ≥ {{ streamProbe.tailFloor.toFixed(2) }}
          · ANN {{ streamProbe.annCount }} · 直召过闸 {{ streamProbe.afterFloor }} 条
          · 最终 {{ streamProbe.coRecall }} 条（含簇/关联扩展）· 库内 {{ streamProbe.corpusTotal }}
        </div>
      </div>

      <div v-if="loading" class="state-box">加载中…</div>
      <div v-else-if="errorText" class="state-box error">{{ errorText }}</div>

      <template v-else-if="viewMode === 'graph'">
        <div v-if="graphEmpty" class="state-box">还没有记忆簇——同主题的意识流要在新对话里攒够、相似才会连成簇</div>
        <div v-else ref="chartRef" class="graph-chart" />
      </template>

      <div v-else-if="!displayItems.length" class="state-box">
        {{ streamProbe?.active
          ? '没有撞上候选意识流（ANN 未命中）'
          : (searchMode === 'vector' ? '没有语义相关的意识流' : '暂无意识流记录') }}
      </div>

      <div v-else class="stream-list">
        <article
          v-for="item in displayItems"
          :key="item.id"
          class="stream-card"
          :class="{
            highlight: highlightId === item.id,
            'is-final': streamProbe?.active && 'stage' in item && item.stage === 'direct',
            'is-expanded': streamProbe?.active && 'stage' in item && item.stage === 'expanded',
          }"
        >
          <header class="stream-head">
            <span class="type-pill" :class="item.type">{{ item.type === 'internal' ? '内心' : '对话' }}</span>
            <span class="about-pill" :style="{ color: aboutColor(item.about) }">{{ aboutLabel(item.about) }}</span>
            <template v-if="streamProbe?.active && 'stage' in item">
              <span class="score-pill" :class="item.stage">{{ STAGE_LABELS[item.stage] }}</span>
              <span class="score-text">
                <template v-if="item.stage === 'expanded'">
                  对问句 sim {{ formatScore(item.similarity) }}（扩展不按此闸）
                </template>
                <template v-else>
                  sim {{ formatScore(item.similarity) }}
                </template>
              </span>
            </template>
            <time v-if="item.createdAt" class="time">{{ new Date(item.createdAt).toLocaleString() }}</time>
          </header>
          <p class="narrative">{{ item.narrative }}</p>
          <footer class="stream-foot">
            <div class="stream-foot-left">
              <span v-if="!streamProbe?.active && item.similarity != null" class="sim-pill">
                <span :title="('similarityTitle' in item && item.similarityTitle) || '召回分数'">
                  {{ ('similarityLabel' in item && item.similarityLabel) || '匹配' }}
                  <template v-if="!('showSimilarityValue' in item) || item.showSimilarityValue !== false">
                    {{ Math.round(Number(item.similarity) * 100) }}%
                  </template>
                </span>
              </span>
              <span v-if="item.revisitCount">回访 {{ item.revisitCount }} 次</span>
              <button
                v-if="item.rawStart"
                type="button"
                class="link-btn"
                @click="toggleTurn(item)"
              >
                {{ expandedIds[item.id] ? '收起' : '看原话' }}
              </button>
              <button
                type="button"
                class="link-btn"
                @click="openNarrative(item)"
              >
                叙事
              </button>
            </div>
            <button
              type="button"
              class="link-btn danger"
              @click="confirmDeleteStream(item)"
            >
              删除
            </button>
          </footer>
          <div v-if="item.rawStart && expandedIds[item.id] && turnCache[turnCacheKey(item.rawStart, item.rawEnd)]" class="turn-preview">
            <template v-for="(turn, index) in turnCache[turnCacheKey(item.rawStart, item.rawEnd)]" :key="`${item.id}-turn-${index}`">
              <div v-if="turn.user" class="bubble user">
                {{ turn.user }}
              </div>
              <div v-if="turn.assistant && !turn.missing" class="bubble assistant">
                {{ turn.assistant }}
              </div>
              <div v-if="turn.missing" class="bubble missing">
                {{ turn.assistant }}
              </div>
            </template>
          </div>
        </article>
      </div>

      <div v-if="narrativeOpen" class="narrative-mask" @click.self="closeNarrative">
        <div class="narrative-modal">
          <header class="narrative-modal-head">
            <h3>叙事 · 这条心事的来龙去脉</h3>
            <button type="button" class="narrative-close" @click="closeNarrative">✕</button>
          </header>
          <div v-if="narrativeLoading" class="state-box">加载中…</div>
          <div v-else-if="narrativeError" class="state-box error">{{ narrativeError }}</div>
          <div v-else-if="narrativeItems.length <= 1" class="state-box">
            这条意识流还没连上别的——同一桩事攒够、相似才会串成一条叙事
          </div>
          <ol v-else class="narrative-timeline">
            <li
              v-for="node in narrativeItems"
              :key="node.id"
              class="narrative-node"
              :class="{ focal: node.id === narrativeFocalId }"
            >
              <span class="narrative-dot" :style="{ background: aboutColor(node.about) }" />
              <div class="narrative-body">
                <div class="narrative-meta">
                  <span class="about-pill" :style="{ color: aboutColor(node.about) }">{{ aboutLabel(node.about) }}</span>
                  <time v-if="node.createdAt">{{ new Date(node.createdAt).toLocaleString() }}</time>
                  <span v-if="node.id === narrativeFocalId" class="focal-tag">当前</span>
                </div>
                <p class="narrative-text">{{ node.narrative }}</p>
              </div>
            </li>
          </ol>
        </div>
      </div>

      <div v-if="rebuildOpen" class="narrative-mask">
        <div class="rebuild-modal">
          <header class="narrative-modal-head">
            <h3>重建意识流向量</h3>
            <button
              v-if="!rebuilding"
              type="button"
              class="narrative-close"
              @click="closeRebuildDialog"
            >✕</button>
          </header>
          <div class="rebuild-body">
            <p class="rebuild-copy">{{ rebuildMessage || '准备中…' }}</p>
            <div class="rebuild-track">
              <div class="rebuild-fill" :style="{ width: `${rebuildPercent}%` }" />
            </div>
            <div class="rebuild-meta">
              <span>{{ rebuildPercent }}%</span>
              <span>{{ rebuildCompleted }} / {{ rebuildTotal }}</span>
            </div>
            <p v-if="rebuildOk || rebuildFailed" class="rebuild-counts">
              成功 {{ rebuildOk }} · 失败 {{ rebuildFailed }}
            </p>
            <button
              v-if="!rebuilding"
              type="button"
              class="search-btn rebuild-done"
              @click="closeRebuildDialog"
            >完成</button>
          </div>
        </div>
      </div>
    </div>
  </MemoryPageShell>
</template>

<style scoped>
.streams-content { padding: 16px 24px 32px; }
.mode-tabs { display: inline-flex; align-items: center; border: 1px solid var(--border-color, rgba(255,255,255,0.12)); border-radius: 8px; overflow: hidden; margin-bottom: 16px; }
.mode-tabs button {
  height: 34px; padding: 0 14px; border: none; background: transparent;
  color: var(--text-secondary); cursor: pointer;
}
.mode-tabs button.active { background: rgba(255,255,255,0.06); color: var(--text-primary); }
.clear-btn {
  margin-left: 4px;
  border-left: 1px solid var(--border-color, rgba(255,255,255,0.12)) !important;
  color: #f87171 !important;
}
.clear-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.rebuild-btn {
  margin-left: 0;
  border-left: 1px solid var(--border-color, rgba(255,255,255,0.12)) !important;
  color: var(--text-primary) !important;
}
.rebuild-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.rebuild-modal {
  width: min(420px, 92vw);
  border-radius: 14px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: var(--bg-primary, #1b1b1d);
  box-shadow: 0 20px 60px rgba(0,0,0,0.45);
}
.rebuild-body { padding: 8px 20px 20px; }
.rebuild-copy {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.rebuild-track {
  height: 8px;
  border-radius: 999px;
  background: rgba(255,255,255,0.08);
  overflow: hidden;
}
.rebuild-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-primary, #3D8C41);
  transition: width 0.2s ease;
}
.rebuild-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.rebuild-counts {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-tertiary, var(--text-secondary));
}
.rebuild-done { margin-top: 16px; width: 100%; }
.graph-chart { height: min(70vh, 640px); border-radius: 12px; border: 1px solid var(--border-color, rgba(255,255,255,0.08)); }
.toolbar { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.filter-select { width: 140px; flex: none; }
.search-input {
  height: 36px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: var(--bg-secondary, transparent);
  color: var(--text-primary);
}
.search-input { flex: 1; min-width: 200px; }
.vector-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
  flex: none;
}
.search-btn {
  height: 36px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}
.wake-probe-banner {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(96, 165, 250, 0.25);
  background: rgba(96, 165, 250, 0.08);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.wake-probe-main code {
  display: inline;
  margin-left: 4px;
  color: var(--text-primary);
  word-break: break-word;
}
.wake-probe-meta { margin-top: 4px; opacity: 0.9; }
.state-box { padding: 48px; text-align: center; color: var(--text-secondary); }
.state-box.error { color: #e57373; }
.stream-list { display: flex; flex-direction: column; gap: 12px; }
.stream-card {
  padding: 16px 18px;
  border-radius: 12px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: var(--bg-secondary, rgba(255,255,255,0.02));
}
.stream-card.highlight { border-color: var(--color-primary, #3D8C41); }
.stream-card.is-final {
  border-color: rgba(34, 197, 94, 0.45);
  background: rgba(34, 197, 94, 0.06);
}
.stream-card.is-expanded {
  border-color: rgba(96, 165, 250, 0.35);
  background: rgba(96, 165, 250, 0.06);
}
.stream-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.type-pill, .about-pill { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.type-pill { background: rgba(255,255,255,0.06); color: var(--text-secondary); }
.type-pill.internal { color: #f472b6; }
.score-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255,255,255,0.06);
  color: var(--text-secondary);
}
.score-pill.direct {
  background: rgba(34, 197, 94, 0.18);
  color: #86efac;
}
.score-pill.expanded {
  background: rgba(96, 165, 250, 0.18);
  color: #93c5fd;
}
.score-pill.ann {
  background: rgba(251, 191, 36, 0.16);
  color: #fbbf24;
}
.score-text {
  font-size: 11px;
  color: var(--text-tertiary, var(--text-secondary));
  font-variant-numeric: tabular-nums;
}
.time { margin-left: auto; font-size: 11px; color: var(--text-tertiary, var(--text-secondary)); }
.narrative { margin: 0; font-size: 14px; line-height: 1.65; white-space: pre-wrap; }
.stream-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}
.stream-foot-left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sim-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(96, 165, 250, 0.14);
  color: #93c5fd;
}
.link-btn { border: none; background: none; color: var(--color-primary, #3D8C41); cursor: pointer; padding: 0; }
.link-btn.danger { color: #f87171; }
.link-btn.danger:hover { text-decoration: underline; }
.turn-preview { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.bubble { padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.5; }
.bubble.user { background: rgba(96,165,250,0.12); }
.bubble.assistant { background: rgba(52,211,153,0.12); }
.bubble.missing { background: rgba(251,191,36,0.12); color: #fbbf24; }

.narrative-mask {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.narrative-modal {
  width: min(680px, 92vw); max-height: 82vh;
  display: flex; flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: var(--bg-primary, #1b1b1d);
  box-shadow: 0 20px 60px rgba(0,0,0,0.45);
}
.narrative-modal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.08));
}
.narrative-modal-head h3 { margin: 0; font-size: 15px; color: var(--text-primary); }
.narrative-close {
  border: none; background: none; color: var(--text-secondary);
  font-size: 15px; cursor: pointer; padding: 4px 6px;
}
.narrative-timeline { list-style: none; margin: 0; padding: 12px 20px 20px; overflow-y: auto; }
.narrative-node { position: relative; display: flex; gap: 12px; padding: 12px 0; }
.narrative-node:not(:last-child)::before {
  content: ''; position: absolute; left: 5px; top: 22px; bottom: -12px;
  width: 2px; background: var(--border-color, rgba(255,255,255,0.12));
}
.narrative-dot { flex: none; width: 12px; height: 12px; border-radius: 999px; margin-top: 5px; }
.narrative-body { flex: 1; }
.narrative-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; color: var(--text-tertiary, var(--text-secondary)); margin-bottom: 4px; }
.narrative-text { margin: 0; font-size: 14px; line-height: 1.6; white-space: pre-wrap; color: var(--text-primary); }
.narrative-node.focal .narrative-text { color: var(--color-primary, #3D8C41); }
.focal-tag { padding: 1px 7px; border-radius: 999px; background: rgba(61,140,65,0.18); color: var(--color-primary, #3D8C41); font-weight: 600; }
</style>
