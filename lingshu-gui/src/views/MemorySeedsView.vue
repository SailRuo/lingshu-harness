<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import * as echarts from 'echarts';
import { Message, Select as ASelect } from '@arco-design/web-vue';
import MemoryPageShell from '../components/memory/MemoryPageShell.vue';
import AppModal from '../components/ui/AppModal.vue';
import AppDrawer from '../components/ui/AppDrawer.vue';
import { useAppConfirm } from '../composables/useAppConfirm';
import { useMemoryApiContext, type MemoryAgentFilter } from '../composables/useMemoryApiContext';
import { useAgentsStore } from '../stores/agents';

interface SeedItem {
  id: string;
  subject: string;
  content: string;
  innerOrientation?: string;
  outerExpression?: string;
  wakeText?: string;
  boostText?: string;
  suppressText?: string;
  tags?: string[];
  count: number;
  lastSeen: string | null;
  source: string;
  status?: 'active' | 'retired' | string;
  revision?: number;
  applicability?: { scope?: string[] } | null;
  autoMutable?: boolean;
  salience: number;
  freshness: number;
  wakeScore?: number;
  finalScore?: number;
  active?: boolean;
  reason?: string;
}

interface SeedFormState {
  innerOrientation: string;
  outerExpression: string;
  wakeText: string;
  boostText: string;
  suppressText: string;
  tagsText: string;
  source: string;
  applicabilityScope: string[];
}

interface SeedChangeItem {
  id: string;
  seedId: string;
  action: string;
  reason: string;
  baseRevision: number;
  newRevision: number;
  before: Record<string, any> | null;
  after: Record<string, any> | null;
  changeSummary: { from?: string; to?: string; boundary?: string } | null;
  timeScope: { description?: string; refs?: string[] } | null;
  evidence: Array<{ id: string; created_at?: string | null }>;
  source: string;
  batchKey: string | null;
  createdAt: string;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  new: '新建',
  merge: '合并',
  reinforce: '印证',
  revise: '修正',
  retire: '停用',
  reactivate: '恢复',
  manual_create: '手动新建',
  manual_edit: '手动编辑',
  manual_update: '手动编辑',
  manual_delete: '手动删除',
  delete: '删除',
  restore_default: '恢复默认',
};

const STATUS_OPTIONS = [
  { value: 'active', label: '现行' },
  { value: 'retired', label: '已停用' },
  { value: 'all', label: '全部' },
];

const SCOPE_OPTIONS = [
  { value: 'private', label: '私聊' },
  { value: 'group', label: '群聊' },
  { value: 'theater', label: '剧场' },
];

const TRIGGER_SOURCE_LABELS: Record<string, string> = {
  self_evolution: '自我演化',
  manual: '手动',
  system: '系统',
};

const ACTIVATION_REASON_LABELS: Record<string, string> = {
  active: '可现行',
  wake_below_floor: '唤醒分不足',
  suppressed_below_floor: '被压低',
  final_below_threshold: '未过现行阈',
  missing_portrait: '画像不全',
  budget_truncated: '预算截断',
};

const SOURCE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'default', label: '默认' },
  { value: 'learned', label: '习得' },
];

const EMPTY_FORM = (): SeedFormState => ({
  innerOrientation: '',
  outerExpression: '',
  wakeText: '',
  boostText: '',
  suppressText: '',
  tagsText: '',
  source: 'learned',
  applicabilityScope: [],
});

const agentsStore = useAgentsStore();
const route = useRoute();
const agentFilter = ref<MemoryAgentFilter>(0);
const { memoryQueryParams, getFullUrl } = useMemoryApiContext({ agentFilter });
const {
  visible: confirmVisible,
  title: confirmTitle,
  content: confirmContent,
  okText: confirmOkText,
  cancelText: confirmCancelText,
  okStatus: confirmOkStatus,
  confirming: confirmLoading,
  open: openConfirm,
  submit: submitConfirm,
  cancel: cancelConfirm,
} = useAppConfirm();

const loading = ref(false);
const saving = ref(false);
const generating = ref(false);
const errorText = ref('');
const viewMode = ref<'list' | 'graph'>('list');
const items = ref<SeedItem[]>([]);
const sourceFilter = ref('');
const statusFilter = ref<'active' | 'retired' | 'all'>('active');
const query = ref('');
const wakeProbe = ref<{
  active: boolean;
  wakeQuery: string;
  activeCount: number;
  activeThreshold: number;
  candidateFloor: number;
} | null>(null);

const editorOpen = ref(false);
const editorMode = ref<'create' | 'edit'>('create');
const editingSeedId = ref<string | null>(null);
const form = ref<SeedFormState>(EMPTY_FORM());
const draftInput = ref('');
const showStructuredFields = ref(false);

const historyOpen = ref(false);
const historyLoading = ref(false);
const historySeed = ref<SeedItem | null>(null);
const historyItems = ref<SeedChangeItem[]>([]);

const lifecycleOpen = ref(false);
const lifecycleMode = ref<'retire' | 'reactivate'>('retire');
const lifecycleTarget = ref<SeedItem | null>(null);
const lifecycleReason = ref('');
const lifecycleSaving = ref(false);

const DRAFT_PLACEHOLDER =
  '用自然语言描述你心里怎么想。例如：我厌恶轻飘飘的陪伴宣告。那些随口说出的「我陪着你」「我一直在」，在我听来太轻…我更相信藏在细节里的关心。';

const chartRef = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;
const graphEmpty = ref(false);
const hasSelfEvolutionAgents = computed(() =>
  agentsStore.agents.some((agent) => agent.selfEvolutionEnabled !== false),
);

function seedLabel(seed: SeedItem): string {
  return (seed.innerOrientation || seed.content || '').trim();
}

function sourceLabel(source: string | undefined): string {
  if (source === 'default') return '默认';
  if (source === 'learned') return '习得';
  return source || '—';
}

function statusLabel(status: string | undefined): string {
  return status === 'retired' ? '已停用' : '现行';
}

function scopeLabel(seed: SeedItem): string {
  const scope = seed.applicability?.scope;
  if (!Array.isArray(scope) || !scope.length) return '全部场景';
  return scope
    .map((item) => SCOPE_OPTIONS.find((option) => option.value === item)?.label || item)
    .join('、');
}

function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] || eventType;
}

function changeSourceLabel(source: string | undefined): string {
  return TRIGGER_SOURCE_LABELS[source || ''] || source || '—';
}

function changeEvidenceCount(entry: SeedChangeItem): number {
  return Array.isArray(entry.evidence) ? entry.evidence.length : 0;
}

function changeSummaryText(entry: SeedChangeItem): string {
  if (!entry.changeSummary) return '';
  const parts: string[] = [];
  if (entry.changeSummary.from) parts.push(`旧：${entry.changeSummary.from}`);
  if (entry.changeSummary.to) parts.push(`新：${entry.changeSummary.to}`);
  if (entry.changeSummary.boundary) parts.push(`边界：${entry.changeSummary.boundary}`);
  return parts.join('；');
}

function timeScopeText(entry: SeedChangeItem): string {
  return entry.timeScope?.description || '';
}

function activationReasonLabel(reason: string | undefined): string {
  if (!reason) return '';
  return ACTIVATION_REASON_LABELS[reason] || reason;
}

function formatScore(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(3);
}

function formatHistoryTime(iso: string): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

function truncatePreview(text: string, max = 80): string {
  const value = text.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

const editorTitle = computed(() => (editorMode.value === 'create' ? '新建习得种子' : '编辑人格种子'));

function normalizeTagsInput(input: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input.split(/[，,]/)) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag.slice(0, 24));
    if (tags.length >= 12) break;
  }
  return tags;
}

function openCreate() {
  editorMode.value = 'create';
  editingSeedId.value = null;
  form.value = EMPTY_FORM();
  draftInput.value = '';
  showStructuredFields.value = false;
  editorOpen.value = true;
}

function openEdit(seed: SeedItem) {
  editorMode.value = 'edit';
  editingSeedId.value = seed.id;
  form.value = {
    innerOrientation: seed.innerOrientation || '',
    outerExpression: seed.outerExpression || '',
    wakeText: seed.wakeText || '',
    boostText: seed.boostText || '',
    suppressText: seed.suppressText || '',
    tagsText: (seed.tags || []).join('，'),
    source: seed.source || 'learned',
    applicabilityScope: Array.isArray(seed.applicability?.scope) ? [...seed.applicability!.scope!] : [],
  };
  draftInput.value = '';
  showStructuredFields.value = true;
  editorOpen.value = true;
}

function closeEditor() {
  editorOpen.value = false;
}

async function openHistory(seed: SeedItem) {
  if (!agentFilter.value) return;
  historySeed.value = seed;
  historyOpen.value = true;
  historyItems.value = [];
  await loadHistory();
}

async function loadHistory() {
  if (!historySeed.value) return;
  historyLoading.value = true;
  try {
    const params = memoryQueryParams({ limit: 100 });
    const res = await fetch(
      getFullUrl(`/api/v1/memory/seeds/${historySeed.value.id}/changes?${params}`),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    historyItems.value = Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    Message.error((e as Error).message || '加载历史失败');
  } finally {
    historyLoading.value = false;
  }
}

function closeHistory() {
  historyOpen.value = false;
  historySeed.value = null;
  historyItems.value = [];
}

function openLifecycle(seed: SeedItem, mode: 'retire' | 'reactivate') {
  lifecycleTarget.value = seed;
  lifecycleMode.value = mode;
  lifecycleReason.value = '';
  lifecycleOpen.value = true;
}

async function submitLifecycle() {
  if (!lifecycleTarget.value) return;
  const reason = lifecycleReason.value.trim();
  if (!reason) {
    Message.warning(lifecycleMode.value === 'retire' ? '请填写停用原因' : '请填写恢复原因');
    return;
  }
  lifecycleSaving.value = true;
  try {
    const params = memoryQueryParams();
    const action = lifecycleMode.value === 'retire' ? 'retire' : 'reactivate';
    const res = await fetch(
      getFullUrl(`/api/v1/memory/seeds/${lifecycleTarget.value.id}/${action}?${params}`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(detail || `HTTP ${res.status}`);
    }
    Message.success(lifecycleMode.value === 'retire' ? '已停用' : '已恢复');
    lifecycleOpen.value = false;
    await reload();
  } catch (e) {
    Message.error((e as Error).message || '操作失败');
  } finally {
    lifecycleSaving.value = false;
  }
}

async function generateSeedDraft() {
  if (!agentFilter.value) {
    Message.warning('先开启一个智能体的自我演化');
    return;
  }
  const draft = draftInput.value.trim();
  if (draft.length < 4) {
    Message.warning('请先写几句自然语言描述');
    return;
  }
  generating.value = true;
  try {
    const params = memoryQueryParams();
    const res = await fetch(getFullUrl(`/api/v1/memory/seeds/generate-draft?${params}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const item = data.item as Partial<SeedFormState> | undefined;
    if (!item) throw new Error('生成结果为空');
    form.value = {
      ...form.value,
      innerOrientation: String(item.innerOrientation || '').trim(),
      outerExpression: String(item.outerExpression || '').trim(),
      wakeText: String(item.wakeText || '').trim(),
      boostText: String(item.boostText || '').trim(),
      suppressText: String(item.suppressText || '').trim(),
      tagsText: Array.isArray((item as any).tags) ? (item as any).tags.join('，') : form.value.tagsText,
    };
    showStructuredFields.value = true;
    Message.success('已生成，可微调后保存');
  } catch (e) {
    Message.error((e as Error).message || 'AI 生成失败');
  } finally {
    generating.value = false;
  }
}

function validateForm(): boolean {
  const fields: Array<[keyof Pick<
    SeedFormState,
    'innerOrientation' | 'outerExpression' | 'wakeText' | 'boostText' | 'suppressText'
  >, string]> = [
    ['innerOrientation', '内在取向'],
    ['outerExpression', '外在显现'],
    ['wakeText', '唤醒画像'],
    ['boostText', '推高倾向'],
    ['suppressText', '压低倾向'],
  ];
  for (const [key, label] of fields) {
    if (!form.value[key].trim()) {
      Message.warning(`请填写${label}`);
      return false;
    }
  }
  return true;
}

async function saveSeed() {
  if (!agentFilter.value) {
    Message.warning('先开启一个智能体的自我演化');
    return;
  }
  if (!validateForm()) return;
  saving.value = true;
  try {
    const params = memoryQueryParams();
    const payload = {
      innerOrientation: form.value.innerOrientation.trim(),
      outerExpression: form.value.outerExpression.trim(),
      wakeText: form.value.wakeText.trim(),
      boostText: form.value.boostText.trim(),
      suppressText: form.value.suppressText.trim(),
      tags: normalizeTagsInput(form.value.tagsText),
      source: editorMode.value === 'edit' ? form.value.source : 'learned',
      applicability: form.value.applicabilityScope.length
        ? { scope: form.value.applicabilityScope }
        : null,
    };
    const url =
      editorMode.value === 'create'
        ? getFullUrl(`/api/v1/memory/seeds?${params}`)
        : getFullUrl(`/api/v1/memory/seeds/${editingSeedId.value}?${params}`);
    const res = await fetch(url, {
      method: editorMode.value === 'create' ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(detail || `HTTP ${res.status}`);
    }
    Message.success(editorMode.value === 'create' ? '已创建' : '已保存');
    closeEditor();
    await reload();
  } catch (e) {
    Message.error((e as Error).message || '保存失败');
  } finally {
    saving.value = false;
  }
}

function confirmDelete(seed: SeedItem) {
  openConfirm({
    title: '删除这颗人格种子？',
    content: '删除后不可撤销；默认种子可通过「恢复默认」重新安装。',
    okText: '删除',
    okStatus: 'danger',
    onOk: async () => {
      const params = memoryQueryParams();
      const res = await fetch(getFullUrl(`/api/v1/memory/seeds/${seed.id}?${params}`), {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      Message.success('已删除');
      await reload();
    },
  });
}

function confirmRestoreDefaults() {
  if (!agentFilter.value) {
    Message.warning('先开启一个智能体的自我演化');
    return;
  }
  openConfirm({
    title: '恢复默认人格种子？',
    content: '将删除当前全部人格种子（含习得），并重新写入系统预装默认模板。此操作不可撤销。',
    okText: '恢复',
    okStatus: 'warning',
    onOk: async () => {
      const params = memoryQueryParams();
      const res = await fetch(getFullUrl(`/api/v1/memory/seeds/restore-defaults?${params}`), {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      const learned = Number(data?.removedLearned ?? 0);
      Message.success(
        learned > 0
          ? `已恢复默认模板，并清除 ${learned} 颗习得种子`
          : '人格种子已恢复默认',
      );
      await reload();
    },
  });
}

async function loadList() {
  if (!agentFilter.value) {
    items.value = [];
    wakeProbe.value = null;
    errorText.value = '';
    loading.value = false;
    return;
  }
  loading.value = true;
  errorText.value = '';
  try {
    const q = query.value.trim();
    if (q) {
      const params = memoryQueryParams({
        q,
        limit: 50,
        source: sourceFilter.value || undefined,
      });
      const res = await fetch(getFullUrl(`/api/v1/memory/seeds/wake-probe?${params}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = Array.isArray(data.items) ? data.items : [];
      items.value =
        statusFilter.value === 'all'
          ? all
          : all.filter((item: SeedItem) =>
              statusFilter.value === 'retired'
                ? item.status === 'retired'
                : (item.status || 'active') === 'active',
            );
      const paramsBlock = data.params || {};
      wakeProbe.value = {
        active: true,
        wakeQuery: String(data.wakeQuery || ''),
        activeCount: Array.isArray(data.activeSeedIds) ? data.activeSeedIds.length : 0,
        activeThreshold: Number(paramsBlock.activeThreshold ?? 0.45),
        candidateFloor: Number(paramsBlock.candidateFloor ?? 0.4),
      };
    } else {
      const params = memoryQueryParams({
        limit: 200,
        subject: 'about_self',
        source: sourceFilter.value || undefined,
        status: statusFilter.value,
      });
      const res = await fetch(getFullUrl(`/api/v1/memory/seeds?${params}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      items.value = Array.isArray(data.items) ? data.items : [];
      wakeProbe.value = null;
    }
  } catch (e) {
    errorText.value = (e as Error).message || '加载失败';
    wakeProbe.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadGraph() {
  if (!agentFilter.value) {
    graphEmpty.value = true;
    errorText.value = '';
    loading.value = false;
    return;
  }
  loading.value = true;
  errorText.value = '';
  graphEmpty.value = false;
  let payload: {
    seeds: SeedItem[];
    streams: Array<{ id: string; narrative: string }>;
    edges: Array<{ type: string; source_id: string; target_id: string; target_type: string; source_type?: string }>;
  } | null = null;
  try {
    const res = await fetch(getFullUrl(`/api/v1/memory/seeds/graph?${memoryQueryParams()}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (e) {
    errorText.value = (e as Error).message || '加载失败';
    return;
  } finally {
    loading.value = false;
  }
  await nextTick();
  initChart();
  if (!chart || !payload) return;
  const personalitySeeds = (payload.seeds || []).filter((s) => s.subject === 'about_self');
  const nodeCount = personalitySeeds.length + (payload.streams?.length || 0);
  graphEmpty.value = nodeCount === 0;
  if (graphEmpty.value) return;
  renderGraph({ ...payload, seeds: personalitySeeds });
  chart.resize();
}

function renderGraph(data: { seeds: SeedItem[]; streams: Array<{ id: string; narrative: string }>; edges: Array<{ type: string; source_id: string; target_id: string; target_type: string; source_type?: string }> }) {
  if (!chart) return;
  const seedNodes = (data.seeds || []).map((s) => {
    const label = seedLabel(s);
    return {
      id: s.id,
      name: label.slice(0, 24) + (label.length > 24 ? '…' : ''),
      symbolSize: Math.max(14, Math.min(40, 10 + (s.salience || 0) * 8)),
      itemStyle: { color: s.source === 'default' ? '#60a5fa' : '#f472b6' },
      category: 'personality',
    };
  });
  const streamNodes = (data.streams || []).map((s) => ({
    id: s.id,
    name: (s.narrative || '').slice(0, 20) + '…',
    symbolSize: 12,
    itemStyle: { color: '#94a3b8' },
    category: 'stream',
  }));
  const links = (data.edges || []).map((e, i) => ({
    source: e.source_id,
    target: e.target_id,
    label: { show: false },
    lineStyle: {
      color:
        e.type === 'EVOKES'
          ? 'rgba(52,211,153,0.4)'
          : e.type === 'AKIN'
            ? 'rgba(96,165,250,0.5)'
            : 'rgba(255,255,255,0.2)',
    },
    id: String(i),
  }));
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      confine: true,
      formatter: (params: { data?: { name?: string } }) => params.data?.name || '',
    },
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      data: [...seedNodes, ...streamNodes],
      links,
      force: { repulsion: 220, edgeLength: [80, 160], gravity: 0.08 },
      label: { show: true, fontSize: 10, color: '#cbd5e1' },
      emphasis: { focus: 'adjacency', label: { show: true } },
    }],
  }, true);
}

function initChart() {
  if (!chartRef.value) return;
  if (chart) {
    chart.dispose();
    chart = null;
  }
  chart = echarts.init(chartRef.value);
  window.addEventListener('resize', () => chart?.resize());
}

async function reload() {
  if (viewMode.value === 'graph') {
    await loadGraph();
  } else {
    await loadList();
  }
}

watch([agentFilter, sourceFilter, statusFilter], () => { void reload(); });
watch(viewMode, () => { void reload(); });
onMounted(async () => {
  void agentsStore.fetchAgents();
  await reload();
  if (route.query.id && viewMode.value === 'list') {
    // scroll highlight could be added
  }
});
onBeforeUnmount(() => {
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <MemoryPageShell
    v-model:agent-filter="agentFilter"
    title="自我演化"
    subtitle="内在取向 · 外在显现 · 场画像"
    agent-filter-mode="self-evolution"
    :show-memory-nav="false"
  >
    <div class="seeds-content">
      <div class="toolbar">
        <div class="mode-tabs">
          <button type="button" :class="{ active: viewMode === 'list' }" @click="viewMode = 'list'">列表</button>
          <button type="button" :class="{ active: viewMode === 'graph' }" @click="viewMode = 'graph'">关联图</button>
        </div>
        <template v-if="viewMode === 'list'">
          <ASelect
            v-model="statusFilter"
            :options="STATUS_OPTIONS"
            class="filter-select"
          />
          <ASelect
            v-model="sourceFilter"
            :options="SOURCE_OPTIONS"
            placeholder="全部来源"
            class="filter-select"
          />
          <input
            v-model="query"
            class="search-input"
            placeholder="输入一句用户话，试探会唤醒哪些种子…"
            @keyup.enter="reload"
          />
          <button type="button" class="search-btn" @click="reload">
            {{ query.trim() ? '唤醒试探' : '刷新' }}
          </button>
          <button type="button" class="action-btn" :disabled="!agentFilter" @click="openCreate">新建习得</button>
          <button type="button" class="action-btn subtle" :disabled="!agentFilter" @click="confirmRestoreDefaults">恢复默认</button>
        </template>
      </div>

      <div v-if="wakeProbe?.active" class="wake-probe-banner">
        <div class="wake-probe-main">
          文本唤醒（同私聊近窗召回路径）：<code>{{ wakeProbe.wakeQuery }}</code>
        </div>
        <div class="wake-probe-meta">
          现行阈值 {{ wakeProbe.activeThreshold.toFixed(2) }} · 候选底 {{ wakeProbe.candidateFloor.toFixed(2) }}
          · 可现行 {{ wakeProbe.activeCount }} / {{ items.length }}
        </div>
      </div>

      <div v-if="loading" class="state-box">加载中…</div>
      <div v-else-if="!hasSelfEvolutionAgents" class="state-box">没有开启自我演化的智能体。</div>
      <div v-else-if="errorText" class="state-box error">{{ errorText }}</div>
      <div v-else-if="viewMode === 'graph' && graphEmpty" class="state-box">暂无人格种子，关联图为空</div>
      <div v-else-if="viewMode === 'graph'" ref="chartRef" class="graph-chart" />

      <div v-else-if="!items.length" class="state-box">
        {{ wakeProbe?.active ? '没有撞上候选种子（ANN 未命中或画像不全）' : '暂无人格种子' }}
      </div>
      <div v-else class="seed-list">
        <article
          v-for="seed in items"
          :key="seed.id"
          class="seed-card"
          :class="{ 'is-active': wakeProbe?.active && seed.active }"
        >
          <header class="seed-card-head">
            <div class="head-left">
              <span class="source-tag" :class="seed.source">{{ sourceLabel(seed.source) }}</span>
              <span class="status-pill" :class="seed.status === 'retired' ? 'retired' : 'active'">
                {{ statusLabel(seed.status) }}
              </span>
              <span class="revision-pill">v{{ seed.revision ?? 0 }}</span>
              <span v-if="seed.autoMutable === false" class="protected-pill">受保护</span>
              <template v-if="wakeProbe?.active">
                <span class="score-pill" :class="{ active: seed.active }">
                  {{ seed.active ? '可现行' : activationReasonLabel(seed.reason) }}
                </span>
                <span class="score-text">wake {{ formatScore(seed.wakeScore) }} · final {{ formatScore(seed.finalScore) }}</span>
              </template>
            </div>
            <div class="card-actions">
              <button type="button" class="link-btn" @click="openHistory(seed)">历史</button>
              <button type="button" class="link-btn" @click="openEdit(seed)">编辑</button>
              <button
                v-if="seed.status === 'retired'"
                type="button"
                class="link-btn"
                @click="openLifecycle(seed, 'reactivate')"
              >
                恢复
              </button>
              <button
                v-else
                type="button"
                class="link-btn"
                @click="openLifecycle(seed, 'retire')"
              >
                停用
              </button>
              <button type="button" class="link-btn danger" @click="confirmDelete(seed)">删除</button>
            </div>
          </header>
          <p class="scope-line">适用范围：{{ scopeLabel(seed) }}</p>
          <p class="inner">{{ seed.innerOrientation || seed.content }}</p>
          <div v-if="seed.tags?.length" class="seed-tags">
            <span v-for="tag in seed.tags" :key="tag">{{ tag }}</span>
          </div>
          <p v-if="seed.outerExpression" class="outer">外在：{{ seed.outerExpression }}</p>
          <dl class="portraits">
            <div v-if="seed.wakeText"><dt>唤醒</dt><dd>{{ seed.wakeText }}</dd></div>
            <div v-if="seed.boostText"><dt>推高</dt><dd>{{ seed.boostText }}</dd></div>
            <div v-if="seed.suppressText"><dt>压低</dt><dd>{{ seed.suppressText }}</dd></div>
          </dl>
          <footer>
            <span v-if="seed.lastSeen">更新 {{ seed.lastSeen.slice(0, 10) }}</span>
          </footer>
        </article>
      </div>
    </div>

    <AppModal
      v-model:visible="editorOpen"
      :title="editorTitle"
      :ok-loading="saving"
      ok-text="保存"
      cancel-text="取消"
      :width="640"
      @ok="saveSeed"
      @cancel="closeEditor"
    >
      <div class="editor-form">
        <template v-if="editorMode === 'create'">
          <label class="field draft-field">
            <span>自然语言描述</span>
            <textarea
              v-model="draftInput"
              rows="5"
              :placeholder="DRAFT_PLACEHOLDER"
            />
          </label>
          <div class="draft-actions">
            <button
              type="button"
              class="generate-btn"
              :disabled="generating"
              @click="generateSeedDraft"
            >
              {{ generating ? '生成中…' : 'AI 生成种子' }}
            </button>
            <span class="draft-hint">只需写你心里怎么想，其余字段由 AI 补全</span>
          </div>
        </template>

        <template v-if="editorMode === 'edit' || showStructuredFields">
          <label v-if="editorMode === 'edit'" class="field">
            <span>来源</span>
            <ASelect
              v-model="form.source"
              :options="[{ value: 'default', label: '默认' }, { value: 'learned', label: '习得' }]"
              :disabled="form.source === 'default' && editingSeedId?.startsWith('default-personality-')"
            />
          </label>
          <label class="field">
            <span>适用范围（不选=全部场景）</span>
            <div class="scope-options">
              <label v-for="option in SCOPE_OPTIONS" :key="option.value" class="scope-option">
                <input
                  v-model="form.applicabilityScope"
                  type="checkbox"
                  :value="option.value"
                />
                <span>{{ option.label }}</span>
              </label>
            </div>
          </label>
          <label class="field">
            <span>标签</span>
            <input v-model="form.tagsText" class="tag-input" placeholder="冷启动，情绪承接，边界" />
          </label>
          <label class="field">
            <span>内在取向</span>
            <textarea v-model="form.innerOrientation" rows="3" placeholder="第一人称，我心里怎么判断、站位、边界" />
          </label>
          <label class="field">
            <span>外在显现</span>
            <textarea v-model="form.outerExpression" rows="3" placeholder="第一人称，说出口时怎么显现" />
          </label>
          <label class="field">
            <span>唤醒画像</span>
            <textarea v-model="form.wakeText" rows="2" placeholder="什么场会叫醒这颗种子" />
          </label>
          <label class="field">
            <span>推高倾向</span>
            <textarea v-model="form.boostText" rows="2" placeholder="这种场加强什么方向" />
          </label>
          <label class="field">
            <span>压低倾向</span>
            <textarea v-model="form.suppressText" rows="2" placeholder="这种场压住什么滑坡" />
          </label>
        </template>
      </div>
    </AppModal>

    <AppModal
      v-model:visible="lifecycleOpen"
      :title="lifecycleMode === 'retire' ? '停用这颗种子' : '恢复这颗种子'"
      :ok-loading="lifecycleSaving"
      :ok-text="lifecycleMode === 'retire' ? '停用' : '恢复'"
      cancel-text="取消"
      :ok-status="lifecycleMode === 'retire' ? 'danger' : 'primary'"
      :width="440"
      @ok="submitLifecycle"
      @cancel="lifecycleOpen = false"
    >
      <div class="lifecycle-form">
        <p class="app-modal-message">
          {{
            lifecycleMode === 'retire'
              ? '停用后它不再参与本轮唤醒与回应策略，但历史会保留。'
              : '恢复后它会重新参与唤醒与回应策略。'
          }}
        </p>
        <label class="field">
          <span>{{ lifecycleMode === 'retire' ? '停用原因' : '恢复原因' }}</span>
          <textarea v-model="lifecycleReason" rows="3" placeholder="简述真实互动依据" />
        </label>
      </div>
    </AppModal>

    <AppModal
      v-model:visible="confirmVisible"
      :title="confirmTitle"
      :ok-text="confirmOkText"
      :cancel-text="confirmCancelText"
      :ok-status="confirmOkStatus"
      :ok-loading="confirmLoading"
      :width="440"
      @ok="submitConfirm"
      @cancel="cancelConfirm"
    >
      <p class="app-modal-message">{{ confirmContent }}</p>
    </AppModal>

    <AppDrawer
      v-model:visible="historyOpen"
      title="演化历史"
      :width="400"
      popup-container="#memory-page-root"
      @cancel="closeHistory"
    >
      <div v-if="historySeed" class="history-context">
        <span class="source-tag" :class="historySeed.source">{{ sourceLabel(historySeed.source) }}</span>
        <p class="history-preview">{{ truncatePreview(seedLabel(historySeed)) }}</p>
      </div>

      <div v-if="historyLoading" class="history-state">加载中…</div>
      <template v-else-if="!historyItems.length">
        <div class="history-state">
          <p class="history-empty-title">还没有变更记录</p>
          <p class="history-empty-hint">编辑、段末自我演化或恢复默认之后，会在这里按时间列出前后差异。</p>
        </div>
        <div v-if="historySeed" class="history-entry current-only">
          <div class="history-meta">
            <span class="history-badge muted">当前</span>
          </div>
          <div class="app-prose">
            <p v-if="historySeed.innerOrientation"><strong>内在取向</strong>{{ historySeed.innerOrientation }}</p>
            <p v-if="historySeed.outerExpression"><strong>外在显现</strong>{{ historySeed.outerExpression }}</p>
            <p v-if="historySeed.wakeText"><strong>唤醒</strong>{{ historySeed.wakeText }}</p>
            <p v-if="historySeed.tags?.length"><strong>标签</strong>{{ historySeed.tags.join('、') }}</p>
          </div>
        </div>
      </template>
      <ol v-else class="history-timeline">
        <li v-for="entry in historyItems" :key="entry.id" class="history-entry">
          <div class="history-meta">
            <span class="history-time">{{ formatHistoryTime(entry.createdAt) }}</span>
            <span class="history-badge">{{ eventTypeLabel(entry.action) }}</span>
            <span class="history-source">{{ changeSourceLabel(entry.source) }}</span>
          </div>
          <p v-if="entry.reason" class="history-reason">{{ entry.reason }}</p>
          <p v-if="changeSummaryText(entry)" class="history-note">{{ changeSummaryText(entry) }}</p>
          <p v-if="timeScopeText(entry)" class="history-note muted">{{ timeScopeText(entry) }}</p>
          <p v-if="changeEvidenceCount(entry)" class="history-note">
            证据 {{ changeEvidenceCount(entry) }} 条
          </p>
          <div class="app-prose">
            <p v-if="entry.after?.innerOrientation"><strong>内在取向</strong>{{ entry.after.innerOrientation }}</p>
            <p v-if="entry.after?.outerExpression"><strong>外在显现</strong>{{ entry.after.outerExpression }}</p>
            <p v-if="entry.after?.tags"><strong>标签</strong>{{ Array.isArray(entry.after.tags) ? entry.after.tags.join('、') : entry.after.tags }}</p>
          </div>
          <div v-if="!entry.after && entry.before" class="app-prose muted">
            <p v-if="entry.before.innerOrientation"><strong>已停用</strong>{{ entry.before.innerOrientation }}</p>
          </div>
        </li>
      </ol>
    </AppDrawer>
  </MemoryPageShell>
</template>

<style scoped>
.seeds-content { padding: 16px 24px 32px; min-height: 400px; }
.toolbar { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.mode-tabs { display: inline-flex; border: 1px solid var(--border-color, rgba(255,255,255,0.12)); border-radius: 8px; overflow: hidden; }
.mode-tabs button {
  height: 34px; padding: 0 14px; border: none; background: transparent;
  color: var(--text-secondary); cursor: pointer;
}
.mode-tabs button.active { background: rgba(255,255,255,0.06); color: var(--text-primary); }
.filter-select { width: 140px; flex: none; }
.search-input {
  flex: 1;
  min-width: 180px;
  height: 36px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: transparent;
  color: var(--text-primary);
}
.search-btn, .action-btn {
  height: 36px; padding: 0 14px; border-radius: 8px;
  border: 1px solid var(--border-color); background: transparent; cursor: pointer; color: var(--text-primary);
}
.action-btn.subtle { color: var(--text-secondary); }
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
.graph-chart { height: min(70vh, 640px); border-radius: 12px; border: 1px solid var(--border-color, rgba(255,255,255,0.08)); }
.seed-list { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.seed-card {
  padding: 14px; border-radius: 10px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: var(--bg-secondary, rgba(255,255,255,0.02));
}
.seed-card.is-active {
  border-color: rgba(34, 197, 94, 0.45);
  background: rgba(34, 197, 94, 0.06);
}
.seed-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
.head-left { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.source-tag {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: rgba(255,255,255,0.06); color: var(--text-secondary);
}
.source-tag.default {
  background: rgba(37, 99, 235, 0.1);
  color: #1d4ed8;
}
[data-theme="dark"] .source-tag.default {
  background: rgba(96, 165, 250, 0.15);
  color: #93c5fd;
}
.score-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255,255,255,0.06);
  color: var(--text-secondary);
}
.score-pill.active {
  background: var(--color-primary-light);
  color: var(--color-primary-active);
  font-weight: 500;
}
[data-theme="dark"] .score-pill.active {
  background: rgba(34, 197, 94, 0.18);
  color: #86efac;
}
.score-text {
  font-size: 11px;
  color: var(--text-tertiary, var(--text-secondary));
  font-variant-numeric: tabular-nums;
}
.card-actions { display: flex; gap: 8px; }
.link-btn {
  border: none; background: transparent; padding: 0; font-size: 12px;
  color: var(--text-secondary); cursor: pointer;
}
.link-btn.danger { color: #f87171; }
.seed-card .inner { margin: 0 0 8px; font-size: 14px; line-height: 1.55; font-weight: 500; }
.seed-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
}
.seed-tags span {
  font-size: 11px;
  line-height: 1;
  padding: 4px 7px;
  border-radius: 999px;
  font-weight: 500;
  background: var(--color-primary-light);
  color: #047857;
}
[data-theme="dark"] .seed-tags span {
  background: rgba(34, 197, 94, 0.12);
  color: #86efac;
}
.seed-card .outer { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
.portraits { margin: 0 0 10px; font-size: 12px; }
.portraits div { margin-bottom: 6px; }
.portraits dt { display: inline; color: var(--text-tertiary, var(--text-secondary)); margin-right: 6px; }
.portraits dt::after { content: '：'; }
.portraits dd { display: inline; margin: 0; color: var(--text-secondary); line-height: 1.45; }
.seed-card footer { display: flex; gap: 10px; font-size: 11px; color: var(--text-tertiary, var(--text-secondary)); }
.editor-form { display: flex; flex-direction: column; gap: 12px; }
.editor-form .field { display: flex; flex-direction: column; gap: 6px; }
.editor-form .field span { font-size: 12px; color: var(--text-secondary); }
.editor-form textarea {
  width: 100%; padding: 8px 10px; border-radius: 8px; resize: vertical;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: transparent; color: var(--text-primary); font: inherit; line-height: 1.5;
}
.tag-input {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: transparent;
  color: var(--text-primary);
  font: inherit;
}
.draft-field textarea { min-height: 120px; }
.draft-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.generate-btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  border: none;
  background: #22c55e;
  color: #052e16;
  font-weight: 600;
  cursor: pointer;
}
.generate-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.draft-hint {
  font-size: 12px;
  color: var(--text-secondary);
}
.state-box.compact { padding: 24px; }
.history-context {
  margin: -4px 0 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.08));
}
.history-preview {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.history-state { padding: 8px 0 12px; color: var(--text-secondary); font-size: 13px; }
.history-empty-title { margin: 0 0 6px; color: var(--text-primary); font-weight: 500; }
.history-empty-hint { margin: 0; line-height: 1.55; font-size: 12px; }
.history-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.history-entry {
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: rgba(255,255,255,0.02);
}
.history-entry.current-only { margin-top: 4px; }
.history-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; margin-bottom: 4px; }
.history-time { color: var(--text-primary); font-weight: 500; }
.history-badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(37, 99, 235, 0.1);
  color: #1d4ed8;
}
[data-theme="dark"] .history-badge {
  background: rgba(96, 165, 250, 0.15);
  color: #93c5fd;
}
.history-badge.muted { background: rgba(255,255,255,0.06); color: var(--text-secondary); }
.history-source { color: var(--text-secondary); }
.history-reason { margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
.history-note {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #047857;
}
[data-theme="dark"] .history-note { color: #86efac; }
.history-diffs { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.diff-block { font-size: 12px; line-height: 1.5; }
.diff-label { font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
.diff-old { margin: 0; color: #b91c1c; white-space: pre-wrap; }
[data-theme="dark"] .diff-old { color: #f87171; }
.diff-new { margin: 4px 0 0; color: #047857; white-space: pre-wrap; }
[data-theme="dark"] .diff-new { color: #86efac; }
.app-prose.muted { opacity: 0.85; }
.history-extra { margin-top: 8px; font-size: 12px; color: var(--text-secondary); }
.history-extra pre { margin: 4px 0 0; white-space: pre-wrap; font-family: inherit; font-size: 12px; }
.extra-label { font-weight: 500; color: var(--text-primary); }
</style>
