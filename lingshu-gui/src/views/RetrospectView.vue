<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { Select as ASelect } from '@arco-design/web-vue';
import { useRouter } from 'vue-router';
import { useMemoryApiContext, type MemoryAgentFilter } from '../composables/useMemoryApiContext';
import { useAgentsStore } from '../stores/agents';
import { useChatStore } from '../stores/chat';

type Granularity = 'week' | 'month' | 'quarter' | 'year';
type VadChannel = 'text' | 'voice';

interface BucketItem {
  granularity: Granularity;
  bucketKey: string;
  periodStart: string;
  periodEnd: string;
  summary?: string;
  available: boolean;
}

interface RetrospectArc {
  available: boolean;
  granularity: Granularity;
  bucketKey: string;
  periodStart: string;
  periodEnd: string;
  summary: string;
  themes: Array<{ theme: string; count: number; evidence_ids?: string[] }>;
  moodTrajectory: { trend?: string; description?: string; points?: AffectPoint[] };
  changes: Array<{ dimension: string; then: string; now: string; magnitude?: number; evidence_ids?: string[] }>;
}

interface AffectPoint {
  kind?: string;
  channel?: string;
  period?: string;
  sampleCount?: number;
  createdAt?: string | null;
  affect?: Record<string, number>;
}

interface StreamItem {
  id: string;
  narrative: string;
  about: string;
  type: string;
  createdAt?: string;
}

interface RetrospectData {
  portrait: null | { narrative: string; dimensions: Record<string, string[]>; evidenceIds: string[]; version: number };
  periodPortrait: {
    available: boolean;
    granularity: Granularity;
    bucketKey: string;
    periodStart: string;
    periodEnd: string;
    narrative: string;
    dimensions: Record<string, string[]>;
    evidenceIds: string[];
  };
  arc: RetrospectArc;
  mirror: { available: boolean; dimension?: string; then?: string; now?: string; magnitude?: number; evidence?: string[] };
  affectTimeline: AffectPoint[];
  streams: StreamItem[];
}

const GRANULARITIES: Array<{ value: Granularity; label: string }> = [
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'quarter', label: '季' },
  { value: 'year', label: '年' },
];

const VAD_LINES = [
  { key: 'valence', label: '效价', color: '#60a5fa' },
  { key: 'arousal', label: '唤醒', color: '#f97316' },
  { key: 'dominance', label: '支配', color: '#a78bfa' },
] as const;

const AFFECT_CHANNELS: Array<{ value: VadChannel; label: string }> = [
  { value: 'text', label: '文字' },
  { value: 'voice', label: '语音' },
];

const router = useRouter();
const chatStore = useChatStore();
const agentsStore = useAgentsStore();
const agentFilter = ref<MemoryAgentFilter>(0);
const granularity = shallowRef<Granularity>('month');
const selectedBucketKey = shallowRef('');
const loading = shallowRef(false);
const recomputing = shallowRef(false);
const errorText = shallowRef('');
const affectLoading = shallowRef(false);
const affectErrorText = shallowRef('');
const affectChannel = shallowRef<VadChannel>('text');
const buckets = ref<BucketItem[]>([]);
const data = ref<RetrospectData | null>(null);
const textAffectPoints = ref<AffectPoint[]>([]);
const voiceAffectPoints = ref<AffectPoint[]>([]);
const { memoryQueryParams, getFullUrl } = useMemoryApiContext({ agentFilter });

const timeMirrorAgents = computed(() =>
  agentsStore.agents.filter((agent) => agent.timeMirrorEnabled !== false),
);

const agentOptions = computed(() =>
  timeMirrorAgents.value.map((agent) => ({
    value: agent.id,
    label: agent.displayName,
  })),
);

const bucketOptions = computed(() =>
  buckets.value.map((bucket) => ({
    value: bucket.bucketKey,
    label: bucket.bucketKey,
  })),
);

const arc = computed(() => data.value?.arc ?? null);
const displayPortrait = computed(() => {
  const period = data.value?.periodPortrait;
  if (period?.available && period.narrative) {
    return {
      scope: period.bucketKey,
      narrative: period.narrative,
      dimensions: period.dimensions || {},
    };
  }
  const portrait = data.value?.portrait;
  if (portrait?.narrative) {
    return {
      scope: '长期',
      narrative: portrait.narrative,
      dimensions: portrait.dimensions || {},
    };
  }
  return null;
});
const hasArc = computed(() => Boolean(arc.value?.available));
const activeAffectPoints = computed(() =>
  affectChannel.value === 'voice' ? voiceAffectPoints.value : textAffectPoints.value,
);
const activeBucket = computed(() =>
  buckets.value.find((bucket) => bucket.bucketKey === selectedBucketKey.value) ?? null,
);
const moodPoints = computed(() => {
  const bucket = activeBucket.value;
  if (!bucket) return activeAffectPoints.value;
  return activeAffectPoints.value.filter((point) => isPointInBucket(point, bucket));
});
const chartPoints = computed(() =>
  moodPoints.value
    .filter((point) => point.affect && Object.values(point.affect).some((v) => v != null))
    .sort((a, b) => {
      const left = a.createdAt || a.period || '';
      const right = b.createdAt || b.period || '';
      return left.localeCompare(right);
    }),
);
const hasChart = computed(() => chartPoints.value.length > 0);
const streamEvidenceMap = computed(() => {
  const map = new Map<string, StreamItem>();
  for (const stream of data.value?.streams ?? []) {
    map.set(`stream:${stream.id}`, stream);
  }
  return map;
});

function syncAgentFilterFromSession() {
  const agents = timeMirrorAgents.value;
  if (!agents.length) {
    agentFilter.value = 0;
    return;
  }
  if (
    typeof agentsStore.selectedAgentId === 'number'
    && Number.isFinite(agentsStore.selectedAgentId)
    && agents.some((agent) => agent.id === agentsStore.selectedAgentId)
  ) {
    agentFilter.value = agentsStore.selectedAgentId;
    return;
  }
  const sessionAgentId = chatStore.currentAgentId;
  if (
    typeof sessionAgentId === 'number'
    && Number.isFinite(sessionAgentId)
    && agents.some((agent) => agent.id === sessionAgentId)
  ) {
    agentFilter.value = sessionAgentId;
    return;
  }
  const fallback = agents.find((agent) => agent.isDefault) || agents[0];
  if (typeof fallback?.id === 'number') agentFilter.value = fallback.id;
}

function formatDate(value?: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

function evidenceLabel(id: string): string {
  const stream = streamEvidenceMap.value.get(id);
  if (stream) return stream.narrative.slice(0, 18) || id;
  return id;
}

function openEvidence(id: string) {
  if (id.startsWith('stream:')) {
    const streamId = id.slice('stream:'.length);
    void router.push({ path: '/memory-streams', query: { streamId } });
  }
}

function chartPolyline(metric: string): string {
  const points = chartPoints.value;
  if (!points.length) return '';
  const width = 640;
  const height = 150;
  if (points.length === 1) {
    const raw = Number(points[0].affect?.[metric] ?? 0);
    const y = ((1 - Math.max(-1, Math.min(1, raw))) / 2) * height;
    return `0,${y.toFixed(1)} 640,${y.toFixed(1)}`;
  }
  return points
    .map((point, index) => {
      const raw = Number(point.affect?.[metric] ?? 0);
      const x = (index / Math.max(1, points.length - 1)) * width;
      const y = ((1 - Math.max(-1, Math.min(1, raw))) / 2) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function affectPointLabel(point: AffectPoint): string {
  if (point.period) return point.period;
  if (!point.createdAt) return '';
  return new Date(point.createdAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function dateKey(value?: string | null): string {
  if (!value) return '';
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  if (match) return match[0];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function isPointInBucket(point: AffectPoint, bucket: BucketItem): boolean {
  if (point.period && point.period === bucket.bucketKey) return true;
  const pointDay = dateKey(point.period || point.createdAt);
  if (!pointDay) return false;
  const startDay = dateKey(bucket.periodStart);
  const endDay = dateKey(bucket.periodEnd);
  return (!startDay || pointDay >= startDay) && (!endDay || pointDay <= endDay);
}

async function loadBuckets() {
  if (!agentFilter.value) {
    buckets.value = [];
    selectedBucketKey.value = '';
    return;
  }
  const res = await fetch(getFullUrl(
    `/api/v1/memory/retrospect/buckets?${memoryQueryParams({ granularity: granularity.value })}`,
  ));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  buckets.value = Array.isArray(payload.items) ? payload.items : [];
  if (!selectedBucketKey.value || !buckets.value.some((bucket) => bucket.bucketKey === selectedBucketKey.value)) {
    selectedBucketKey.value = (buckets.value.find((bucket) => bucket.available) ?? buckets.value[0])?.bucketKey ?? '';
  }
}

async function loadData(options?: { recompute?: boolean }) {
  if (!agentFilter.value) {
    data.value = null;
    errorText.value = '';
    loading.value = false;
    recomputing.value = false;
    return;
  }
  loading.value = !options?.recompute;
  recomputing.value = Boolean(options?.recompute);
  errorText.value = '';
  try {
    if (!selectedBucketKey.value) await loadBuckets();
    const res = await fetch(getFullUrl(
      `/api/v1/memory/retrospect?${memoryQueryParams({
        granularity: granularity.value,
        bucketKey: selectedBucketKey.value,
        recompute: options?.recompute ? 1 : 0,
      })}`,
    ));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data.value = await res.json();
    if (options?.recompute) await loadBuckets();
  } catch (error) {
    errorText.value = (error as Error).message || '加载失败';
  } finally {
    loading.value = false;
    recomputing.value = false;
  }
}

async function loadAffectTimeline() {
  if (!agentFilter.value) {
    textAffectPoints.value = [];
    voiceAffectPoints.value = [];
    return;
  }
  affectLoading.value = true;
  affectErrorText.value = '';
  try {
    const res = await fetch(getFullUrl(
      `/api/v1/memory/affect-timeline?${memoryQueryParams({
        limit: 500,
        granularity: 'day',
      })}`,
    ));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    textAffectPoints.value = Array.isArray(payload.textTurnPoints)
      ? payload.textTurnPoints
      : (Array.isArray(payload.turnPoints) ? payload.turnPoints : []);
    voiceAffectPoints.value = Array.isArray(payload.voiceTurnPoints) ? payload.voiceTurnPoints : [];
  } catch (error) {
    affectErrorText.value = (error as Error).message || '加载情绪轨迹失败';
  } finally {
    affectLoading.value = false;
  }
}

async function reloadForScope() {
  selectedBucketKey.value = '';
  await loadBuckets();
  await loadData();
}

watch(agentFilter, () => { void reloadForScope(); });
watch(granularity, () => { void reloadForScope(); });
watch(agentFilter, () => { void loadAffectTimeline(); });
watch(granularity, () => { void loadAffectTimeline(); });
watch(selectedBucketKey, (next, prev) => {
  if (next && next !== prev) void loadData();
});
watch(agentFilter, (newVal) => {
  if (typeof newVal === 'number' && Number.isFinite(newVal) && newVal !== 0) {
    agentsStore.selectedAgentId = newVal;
  }
});
watch(timeMirrorAgents, () => { syncAgentFilterFromSession(); }, { immediate: true });

onMounted(async () => {
  await agentsStore.fetchAgents();
  syncAgentFilterFromSession();
  void reloadForScope();
  void loadAffectTimeline();
});
</script>

<template>
  <div class="retrospect-page">
    <header class="page-header">
      <div class="header-main">
        <span class="eyebrow">Retrospect</span>
        <h1>时光回溯</h1>
        <p>把这段时间的主题、情绪和变化熬成一面时间里的镜子。</p>
      </div>
      <div class="header-controls" role="toolbar" aria-label="回望范围">
        <div class="granularity-tabs" role="group" aria-label="时间粒度">
          <button
            v-for="item in GRANULARITIES"
            :key="item.value"
            type="button"
            :class="{ active: granularity === item.value }"
            :aria-pressed="granularity === item.value"
            @click="granularity = item.value"
          >
            {{ item.label }}
          </button>
        </div>
        <span class="control-divider" aria-hidden="true"></span>
        <ASelect
          v-model="selectedBucketKey"
          :options="bucketOptions"
          class="bucket-select"
          :style="{ width: '168px' }"
          placeholder="选择时间桶"
          aria-label="回望时间桶"
        />
        <ASelect
          v-model="agentFilter"
          :options="agentOptions"
          class="agent-select"
          :style="{ width: '168px' }"
          placeholder="选择智能体"
          aria-label="选择智能体"
        />
        <button
          class="recompute-btn"
          type="button"
          :disabled="recomputing || agentOptions.length === 0"
          @click="loadData({ recompute: true })"
        >
          <span
            class="material-symbols-outlined"
            :class="{ spinning: recomputing }"
            aria-hidden="true"
          >refresh</span>
          {{ recomputing ? '计算中' : '重新计算' }}
        </button>
      </div>
    </header>

    <main class="retrospect-body">
      <div v-if="loading" class="state-box">加载中…</div>
      <div v-else-if="agentOptions.length === 0" class="state-box">没有开启时间镜像的智能体。</div>
      <div v-else-if="errorText" class="state-box error">{{ errorText }}</div>
      <template v-else>
        <section v-if="!hasArc" class="empty-hero">
          <span class="material-symbols-outlined">schedule</span>
          <h2>还在攒切片，回望需要时间积累</h2>
          <p>等意识流、情绪轨迹和画像慢慢长出来，这里会出现一段可翻看的时间弧。</p>
        </section>

        <section v-if="arc?.summary" class="summary-card">
          <span>{{ arc.bucketKey }}</span>
          <h2>{{ arc.summary }}</h2>
          <p>{{ formatDate(arc.periodStart) }} - {{ formatDate(arc.periodEnd) }}</p>
        </section>

        <section class="grid two">
          <article class="panel portrait-panel">
            <div class="panel-heading compact">
              <h3>我眼中的他</h3>
              <span v-if="displayPortrait" class="scope-pill">{{ displayPortrait.scope }}</span>
            </div>
            <p v-if="displayPortrait?.narrative" class="portrait-text">{{ displayPortrait.narrative }}</p>
            <p v-else class="muted">画像还没形成。</p>
            <div v-if="displayPortrait?.dimensions" class="dimension-list">
              <div v-for="(items, key) in displayPortrait.dimensions" :key="key" class="dimension-row">
                <strong>{{ key }}</strong>
                <span>{{ items.join('；') }}</span>
              </div>
            </div>
          </article>

          <article class="panel">
            <div class="panel-heading">
              <div>
                <h3>情绪镜</h3>
                <p>来自 VAD 日聚合，范围跟随上方回望时间桶。</p>
              </div>
              <div class="mini-tabs">
                <button
                  v-for="item in AFFECT_CHANNELS"
                  :key="item.value"
                  type="button"
                  :class="{ active: affectChannel === item.value }"
                  @click="affectChannel = item.value"
                >
                  {{ item.label }}
                </button>
              </div>
            </div>
            <svg v-if="hasChart" class="mood-chart" viewBox="0 0 640 150" preserveAspectRatio="none">
              <line x1="0" y1="75" x2="640" y2="75" class="zero-line" />
              <polyline
                v-for="line in VAD_LINES"
                :key="line.key"
                :points="chartPolyline(line.key)"
                :stroke="line.color"
                class="vad-line"
              />
            </svg>
            <p v-else-if="affectLoading" class="muted">情绪轨迹加载中…</p>
            <p v-else-if="affectErrorText" class="muted">{{ affectErrorText }}</p>
            <p v-else class="muted">{{ affectChannel === 'voice' ? '暂无语音情绪采样。' : '暂无文字情绪采样。' }}</p>
            <div class="legend">
              <span v-for="line in VAD_LINES" :key="line.key" :style="{ color: line.color }">{{ line.label }}</span>
            </div>
            <div v-if="chartPoints.length" class="affect-range">
              {{ affectPointLabel(chartPoints[0]) }} - {{ affectPointLabel(chartPoints[chartPoints.length - 1]) }}
              · {{ chartPoints.length }} 个点
            </div>
          </article>
        </section>

        <section class="grid two">
          <article class="panel">
            <h3>主题弧</h3>
            <div v-if="arc?.themes?.length" class="theme-list">
              <div v-for="theme in arc.themes" :key="theme.theme" class="theme-row">
                <div>
                  <strong>{{ theme.theme }}</strong>
                  <span>{{ theme.count }} 条切片</span>
                </div>
                <div class="evidence-row">
                  <button
                    v-for="id in theme.evidence_ids || []"
                    :key="id"
                    type="button"
                    @click="openEvidence(id)"
                  >
                    {{ evidenceLabel(id) }}
                  </button>
                </div>
              </div>
            </div>
            <p v-else class="muted">暂时没有足够稳定的主题。</p>
          </article>

          <article class="panel mirror-panel">
            <h3>变化对照</h3>
            <div v-if="data?.mirror?.available" class="mirror-card">
              <span class="mirror-dim">{{ data.mirror.dimension || '变化' }}</span>
              <p><strong>那时：</strong>{{ data.mirror.then }}</p>
              <p><strong>现在：</strong>{{ data.mirror.now }}</p>
            </div>
            <p v-else class="muted">还没有足够清晰的 then / now 落差。</p>
          </article>
        </section>

        <section class="panel timeline-panel">
          <h3>切片时间线</h3>
          <div v-if="data?.streams?.length" class="stream-timeline">
            <article v-for="stream in data.streams" :key="stream.id" class="stream-item">
              <time>{{ formatDate(stream.createdAt) }}</time>
              <div>
                <span class="stream-tag">{{ stream.type === 'internal' ? '内心' : '对话' }} · {{ stream.about }}</span>
                <p>{{ stream.narrative }}</p>
              </div>
            </article>
          </div>
          <p v-else class="muted">这个时间桶里还没有意识流切片。</p>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.retrospect-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* 头部只占一行：左侧标题块、右侧控制条，避免控件换行把首屏顶下去 */
.page-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 24px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.08));
}

.header-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.eyebrow {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-tertiary, var(--text-secondary));
}
.header-main h1 {
  margin: 0;
  font-size: 20px;
  line-height: 1.3;
  font-weight: 650;
  letter-spacing: 0.01em;
}
.header-main p {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: nowrap;
}

.control-divider {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: var(--border-color, rgba(255,255,255,0.1));
}

.granularity-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 32px;
  padding: 2px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  border-radius: 9px;
  background: rgba(255,255,255,0.03);
}

.granularity-tabs button {
  height: 26px;
  padding: 0 11px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.granularity-tabs button:hover {
  color: var(--text-primary);
  background: rgba(255,255,255,0.05);
}
.granularity-tabs button.active {
  background: rgba(255,255,255,0.1);
  color: var(--text-primary);
  font-weight: 600;
}
.granularity-tabs button:focus-visible,
.recompute-btn:focus-visible {
  outline: 2px solid var(--color-primary, #3D8C41);
  outline-offset: 2px;
}

.recompute-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  border-radius: 8px;
  color: var(--text-primary);
  background: rgba(255,255,255,0.04);
  cursor: pointer;
  font-size: 12px;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.recompute-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.07);
  border-color: rgba(255,255,255,0.2);
}
.recompute-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.recompute-btn .material-symbols-outlined { font-size: 16px; color: var(--text-secondary); }
.recompute-btn .spinning { animation: retrospect-spin 0.9s linear infinite; }

@keyframes retrospect-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .recompute-btn .spinning { animation: none; }
  .granularity-tabs button,
  .recompute-btn { transition: none; }
}

.retrospect-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px 24px 32px;
}

.state-box { padding: 56px; text-align: center; color: var(--text-secondary); }
.state-box.error { color: #e57373; }

.empty-hero,
.summary-card,
.panel {
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: var(--bg-secondary, rgba(255,255,255,0.025));
  border-radius: 14px;
}

.empty-hero {
  padding: 56px 24px;
  text-align: center;
  color: var(--text-secondary);
}
.empty-hero .material-symbols-outlined { font-size: 42px; color: var(--color-primary); }
.empty-hero h2 { margin: 12px 0 6px; font-size: 18px; color: var(--text-primary); }
.empty-hero p { margin: 0; }

.summary-card { padding: 20px 22px; margin-bottom: 16px; }
.summary-card span { font-size: 12px; color: var(--color-primary); }
.summary-card h2 { margin: 8px 0; font-size: 20px; line-height: 1.4; }
.summary-card p { margin: 0; font-size: 12px; color: var(--text-secondary); }

.grid { display: grid; gap: 16px; margin-bottom: 16px; }
.grid.two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.panel { padding: 16px; }
.panel h3 { margin: 0 0 12px; font-size: 14px; }
.panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.panel-heading h3 { margin-bottom: 4px; }
.panel-heading p { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.panel-heading.compact { align-items: center; margin-bottom: 12px; }
.panel-heading.compact h3 { margin: 0; }
.scope-pill {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(61,140,65,0.16);
  color: var(--color-primary, #3D8C41);
  font-size: 11px;
  font-weight: 600;
}
.muted { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.portrait-text { margin: 0 0 14px; color: var(--text-secondary); line-height: 1.75; font-size: 14px; }
.dimension-list { display: grid; gap: 8px; }
.dimension-row { display: grid; gap: 3px; padding: 9px 10px; border-radius: 10px; background: rgba(255,255,255,0.035); }
.dimension-row strong { font-size: 12px; }
.dimension-row span { color: var(--text-secondary); font-size: 12px; line-height: 1.5; }

.mini-tabs {
  display: inline-flex;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  border-radius: 8px;
  overflow: hidden;
}
.mini-tabs button {
  height: 28px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}
.mini-tabs button.active {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary, #3D8C41) 12%, transparent);
}
.mood-chart { width: 100%; height: 180px; border-radius: 10px; background: rgba(0,0,0,0.12); }
.zero-line { stroke: rgba(255,255,255,0.16); stroke-width: 1; }
.vad-line { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.legend { display: flex; gap: 12px; margin-top: 8px; font-size: 12px; }
.affect-range { margin-top: 6px; color: var(--text-tertiary, var(--text-secondary)); font-size: 11px; }

.theme-list { display: grid; gap: 10px; }
.theme-row { padding: 10px; border-radius: 10px; background: rgba(255,255,255,0.035); }
.theme-row strong { display: block; font-size: 13px; }
.theme-row span { display: block; margin-top: 3px; font-size: 11px; color: var(--text-secondary); }
.evidence-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.evidence-row button {
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.04);
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}

.mirror-card { padding: 12px; border-radius: 12px; background: color-mix(in srgb, var(--color-primary, #3D8C41) 10%, transparent); }
.mirror-card p { margin: 8px 0 0; color: var(--text-secondary); line-height: 1.6; }
.mirror-dim { color: var(--color-primary); font-size: 12px; }

.timeline-panel { margin-top: 2px; }
.stream-timeline { display: grid; gap: 10px; }
.stream-item { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.stream-item:last-child { border-bottom: 0; }
.stream-item time { color: var(--text-tertiary, var(--text-secondary)); font-size: 12px; }
.stream-tag { font-size: 11px; color: var(--color-primary); }
.stream-item p { margin: 5px 0 0; font-size: 13px; line-height: 1.65; color: var(--text-secondary); }

@media (max-width: 1120px) {
  .page-header {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: 10px;
  }
  .header-controls {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .header-main p {
    white-space: normal;
    overflow: visible;
  }
}

@media (max-width: 980px) {
  .grid.two { grid-template-columns: 1fr; }
}
</style>
