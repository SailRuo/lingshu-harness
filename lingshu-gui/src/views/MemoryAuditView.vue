<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Message, Modal } from '@arco-design/web-vue';
import MemoryPageShell from '../components/memory/MemoryPageShell.vue';
import { useMemoryApiContext, type MemoryAgentFilter } from '../composables/useMemoryApiContext';
import { useAgentsStore } from '../stores/agents';
import { useChatStore } from '../stores/chat';

interface TickLogItem {
  id: string;
  tickType: string;
  outcome: string;
  triggeredAt: string;
  payload: Record<string, unknown>;
  error: string | null;
}

interface MemoryStats {
  distribution: {
    entities: number;
    facts: number;
    streams?: number;
    seeds?: number;
    entityTypes?: Record<string, number>;
  };
}

const PAGE_SIZE = 50;

const LEGACY_TICK_TYPES = [
  'layer2_heartbeat',
  'layer3_reflection',
  'overflow_dispatcher',
  'short_window_followup',
] as const;

const OUTCOMES = ['digested', 'nothing'] as const;

const TICK_TYPE_LABEL: Record<string, string> = {
  layer1_silent: 'Layer1 · 后台消化',
  layer2_heartbeat: 'Layer2 · 慢心跳（历史）',
  layer3_reflection: 'Layer3 · 反思（历史）',
  overflow_dispatcher: '溢出调度（历史）',
  short_window_followup: '短窗追发（历史）',
};

const OUTCOME_LABEL: Record<string, string> = {
  digested: '已消化',
  nothing: '无操作',
};

const chatStore = useChatStore();
const agentsStore = useAgentsStore();
const router = useRouter();
const agentFilter = ref<MemoryAgentFilter>(0);
const { memoryQueryParams, getFullUrl } = useMemoryApiContext({ agentFilter });

const loading = ref(false);
const statsLoading = ref(false);
const errorText = ref('');
const items = ref<TickLogItem[]>([]);
const total = ref(0);
const pageOffset = ref(0);
const stats = ref<MemoryStats | null>(null);
const newEventCount = ref(0);
const streamOpen = ref(true);
const showLegacyTicks = ref(false);
const selectedTick = ref<TickLogItem | null>(null);
const liveItems = ref<TickLogItem[]>([]);

const selectedOutcome = ref<string | null>(null);
const sinceDate = ref('');
const untilDate = ref('');

let eventSource: EventSource | null = null;

const selectedPayload = computed(() => selectedTick.value?.payload ?? {});

interface ExtractedConstraintRow {
  action?: string;
  ruleType?: string;
  description?: string;
  evidence?: string | null;
  targetId?: number | null;
}

const selectedConstraintsExtracted = computed<ExtractedConstraintRow[]>(() => {
  const raw = selectedPayload.value.constraintsExtracted;
  return Array.isArray(raw) ? (raw as ExtractedConstraintRow[]) : [];
});

const entityTypeEntries = computed(() => {
  const raw = stats.value?.distribution?.entityTypes || {};
  return Object.entries(raw).sort((a, b) => b[1] - a[1]);
});

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const currentPage = computed(() => Math.floor(pageOffset.value / PAGE_SIZE) + 1);

function formatTickType(val: string): string {
  return TICK_TYPE_LABEL[val] || val;
}

function formatOutcome(val: string): string {
  return OUTCOME_LABEL[val] || val;
}

function formatTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function payloadSummary(row: TickLogItem): string {
  const payload = row.payload || {};
  if (row.tickType === 'layer1_silent') {
    if (row.outcome === 'digested') {
      const parts = [
        `消化 ${payload.markedDigested ?? payload.turnIds ? (payload.turnIds as unknown[]).length : 0} 轮`,
        payload.factsProcessed ? `便签 ${payload.factsProcessed}` : '',
        payload.constraintsProcessed ? `相处约束 ${payload.constraintsProcessed}` : '',
      ].filter(Boolean);
      return parts.join(' · ') || '后台消化完成';
    }
    if (row.outcome === 'nothing') {
      return row.error || String(payload.skippedReason || payload.reason || '本轮无需消化');
    }
  }
  if (LEGACY_TICK_TYPES.includes(row.tickType as typeof LEGACY_TICK_TYPES[number])) {
    return '旧时代 tick（Phase5 前），仅作历史留痕';
  }
  const text = JSON.stringify(payload);
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

function isCurrentTick(row: TickLogItem): boolean {
  return row.tickType === 'layer1_silent';
}

async function loadStats() {
  statsLoading.value = true;
  try {
    const params = memoryQueryParams();
    const res = await fetch(getFullUrl(`/api/v1/memory/stats?${params}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    stats.value = await res.json();
  } catch {
    stats.value = null;
  } finally {
    statsLoading.value = false;
  }
}

async function loadTickLogs() {
  loading.value = true;
  errorText.value = '';
  try {
    const params = memoryQueryParams({ limit: PAGE_SIZE, offset: pageOffset.value });
    params.append('tickType', 'layer1_silent');
    if (showLegacyTicks.value) {
      for (const legacy of LEGACY_TICK_TYPES) {
        params.append('tickType', legacy);
      }
    }
    if (selectedOutcome.value) {
      params.append('outcome', selectedOutcome.value);
    }
    if (sinceDate.value) {
      params.set('since', new Date(sinceDate.value).toISOString());
    }
    if (untilDate.value) {
      params.set('until', new Date(untilDate.value).toISOString());
    }
    const res = await fetch(getFullUrl(`/api/v1/memory/tick-log?${params}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    items.value = Array.isArray(data.items) ? data.items : [];
    total.value = Number(data.total ?? items.value.length);
    newEventCount.value = 0;
  } catch (error) {
    errorText.value = (error as Error).message || '加载失败';
  } finally {
    loading.value = false;
  }
}

function goPage(page: number) {
  const next = Math.max(0, Math.min(pageCount.value - 1, page - 1)) * PAGE_SIZE;
  if (next === pageOffset.value) return;
  pageOffset.value = next;
  void loadTickLogs();
}

function resetPageAndLoad() {
  pageOffset.value = 0;
  void loadTickLogs();
}

function openDigestTarget(path: string) {
  router.push(path);
}

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function connectStream() {
  closeStream();
  if (!streamOpen.value) return;
  const params = memoryQueryParams();
  eventSource = new EventSource(getFullUrl(`/api/v1/memory/tick-log/stream?${params}`));
  eventSource.addEventListener('tick', (event) => {
    try {
      const payload = JSON.parse(event.data) as TickLogItem;
      if (!showLegacyTicks.value && !isCurrentTick(payload)) return;
      liveItems.value = [payload, ...liveItems.value].slice(0, 20);
      newEventCount.value += 1;
    } catch {
      // ignore malformed payloads
    }
  });
  eventSource.onerror = () => {
    closeStream();
    window.setTimeout(connectStream, 3000);
  };
}

const clearing = ref(false);
const clearingLogs = ref(false);
const clearingConversations = ref(false);

async function handleClearMemory() {
  Modal.confirm({
    title: '清空陪伴记忆？',
    content:
      '将删除当前智能体与该用户之间的 Kuzu 实体/事实，以及 companion SQLite 关系状态。对话原文与审计日志默认保留。不可撤销。',
    okText: '确定清空',
    okButtonProps: { status: 'danger' },
    cancelText: '取消',
    onOk: async () => {
      clearing.value = true;
      try {
        const params = memoryQueryParams();
        const res = await fetch(getFullUrl(`/api/v1/memory/clear-all?${params}`), { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        Message.success(data.message || '陪伴记忆已清空');
        await Promise.all([loadStats(), loadTickLogs()]);
      } catch (error) {
        Message.error((error as Error).message || '清空失败');
      } finally {
        clearing.value = false;
      }
    },
  });
}

async function handleClearTickLogs() {
  Modal.confirm({
    title: '清空审计日志？',
    content: '仅删除 tick 运行记录，不影响 Kuzu 记忆与对话。',
    okText: '确定清空',
    okButtonProps: { status: 'danger' },
    cancelText: '取消',
    onOk: async () => {
      clearingLogs.value = true;
      try {
        const params = memoryQueryParams();
        const res = await fetch(getFullUrl(`/api/v1/memory/tick-log/clear?${params}`), { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        Message.success('审计日志已清空');
        items.value = [];
        total.value = 0;
        selectedTick.value = null;
      } catch (error) {
        Message.error((error as Error).message || '清空失败');
      } finally {
        clearingLogs.value = false;
      }
    },
  });
}

async function handleClearConversations() {
  Modal.confirm({
    title: '清空对话记录？',
    content: '删除该智能体与当前用户之间的所有会话与回合，不删 Kuzu 记忆与审计日志。',
    okText: '确定清空',
    okButtonProps: { status: 'danger' },
    cancelText: '取消',
    onOk: async () => {
      clearingConversations.value = true;
      try {
        const params = memoryQueryParams();
        const agentId = params.get('agentId');
        const uid = params.get('userId') || 'default_user';
        const res = await fetch(
          getFullUrl(`/api/v1/chat/agents/${agentId}/threads/clear-all?userId=${encodeURIComponent(uid)}`),
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        Message.success(data.message || '对话记录已清空');
        await chatStore.loadConversations();
      } catch (error) {
        Message.error((error as Error).message || '清空失败');
      } finally {
        clearingConversations.value = false;
      }
    },
  });
}

watch(agentFilter, () => {
  pageOffset.value = 0;
  void loadStats();
  void loadTickLogs();
  connectStream();
});
watch([selectedOutcome, sinceDate, untilDate, showLegacyTicks], () => { resetPageAndLoad(); });
watch(streamOpen, (open) => {
  if (open) connectStream();
  else closeStream();
});

onMounted(() => {
  void agentsStore.fetchAgents();
  void loadStats();
  void loadTickLogs();
  connectStream();
});

onBeforeUnmount(() => {
  closeStream();
});
</script>

<template>
  <MemoryPageShell v-model:agent-filter="agentFilter" title="记忆审计" subtitle="Layer1 后台消化与 Kuzu 记忆存量">
    <template #actions>
      <button class="action-btn danger" :disabled="clearing" @click="handleClearMemory">
        {{ clearing ? '清空中…' : '清空陪伴记忆' }}
      </button>
      <button class="action-btn" :disabled="clearingLogs" @click="handleClearTickLogs">
        {{ clearingLogs ? '清空中…' : '清空审计日志' }}
      </button>
      <button class="action-btn" :disabled="clearingConversations" @click="handleClearConversations">
        {{ clearingConversations ? '清空中…' : '清空对话' }}
      </button>
    </template>

    <div class="memory-audit-view">
    <section class="audit-toolbar">
      <div class="stat-strip">
        <span class="stat-pill">实体 <strong>{{ statsLoading ? '…' : (stats?.distribution?.entities ?? 0) }}</strong></span>
        <span class="stat-pill">事实 <strong>{{ statsLoading ? '…' : (stats?.distribution?.facts ?? 0) }}</strong></span>
        <span class="stat-pill">意识流 <strong>{{ statsLoading ? '…' : (stats?.distribution?.streams ?? 0) }}</strong></span>
        <span class="stat-pill">印象 <strong>{{ statsLoading ? '…' : (stats?.distribution?.seeds ?? 0) }}</strong></span>
        <template v-if="entityTypeEntries.length">
          <span v-for="[type, count] in entityTypeEntries" :key="type" class="stat-pill muted">{{ type }} {{ count }}</span>
        </template>
      </div>
      <div class="filter-strip">
        <div class="chip-group">
          <span class="chip-label">结果</span>
          <button
            v-for="outcome in OUTCOMES"
            :key="outcome"
            class="chip"
            :class="{ active: selectedOutcome === outcome }"
            @click="selectedOutcome = selectedOutcome === outcome ? null : outcome"
          >
            {{ formatOutcome(outcome) }}
          </button>
        </div>
        <label class="legacy-toggle">
          <input v-model="showLegacyTicks" type="checkbox" />
          历史 tick
        </label>
        <label class="date-filter">
          起始
          <input v-model="sinceDate" type="datetime-local" />
        </label>
        <label class="date-filter">
          截止
          <input v-model="untilDate" type="datetime-local" />
        </label>
      </div>
    </section>

    <div v-if="newEventCount > 0" class="refresh-banner" @click="resetPageAndLoad">
      有 {{ newEventCount }} 条新事件，点击刷新列表
    </div>

    <div class="audit-layout">
      <section class="table-panel">
        <div v-if="loading" class="state-text">加载中…</div>
        <div v-else-if="errorText" class="state-text error">{{ errorText }}</div>
        <table v-else class="tick-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>结果</th>
              <th>摘要</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in items"
              :key="row.id"
              class="tick-row"
              :class="{ selected: selectedTick?.id === row.id, legacy: !isCurrentTick(row) }"
              @click="selectedTick = row"
            >
              <td>{{ formatTime(row.triggeredAt) }}</td>
              <td>{{ formatTickType(row.tickType) }}</td>
              <td>{{ formatOutcome(row.outcome) }}</td>
              <td class="mono">{{ payloadSummary(row) }}</td>
              <td>{{ row.error || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!loading && !errorText" class="table-meta">
          共 {{ total }} 条 · 第 {{ currentPage }} / {{ pageCount }} 页
        </p>
        <div v-if="!loading && !errorText && pageCount > 1" class="pager">
          <button class="pager-btn" :disabled="pageOffset === 0" @click="goPage(currentPage - 1)">上一页</button>
          <button class="pager-btn" :disabled="currentPage >= pageCount" @click="goPage(currentPage + 1)">下一页</button>
        </div>
      </section>

      <aside class="detail-panel">
        <header class="panel-header">
          <h3>事件详情</h3>
        </header>
        <div v-if="!selectedTick" class="panel-placeholder">
          <p>点击左侧一行查看 payload</p>
        </div>
        <div v-else class="panel-body">
          <dl class="meta-list">
            <div class="meta-row"><dt>时间</dt><dd>{{ formatTime(selectedTick.triggeredAt) }}</dd></div>
            <div class="meta-row"><dt>类型</dt><dd>{{ formatTickType(selectedTick.tickType) }}</dd></div>
            <div class="meta-row"><dt>结果</dt><dd>{{ formatOutcome(selectedTick.outcome) }}</dd></div>
          </dl>

          <template v-if="selectedTick.tickType === 'layer1_silent' && selectedTick.outcome === 'digested'">
            <h4 class="section-title">消化结果</h4>
            <dl class="meta-list">
              <div class="meta-row"><dt>会话</dt><dd class="mono">{{ selectedPayload.sessionId ?? '—' }}</dd></div>
              <div class="meta-row"><dt>标记消化轮次</dt><dd>{{ selectedPayload.markedDigested ?? '—' }}</dd></div>
              <div class="meta-row"><dt>便签</dt><dd>{{ selectedPayload.factsProcessed ?? 0 }}</dd></div>
              <div class="meta-row"><dt>相处约束</dt><dd>{{ selectedPayload.constraintsProcessed ?? 0 }}</dd></div>
            </dl>
            <template v-if="selectedConstraintsExtracted.length">
              <h4 class="section-title">相处约束抽取</h4>
              <ul class="constraint-audit-list">
                <li v-for="(row, idx) in selectedConstraintsExtracted" :key="idx">
                  <span class="constraint-action">{{ row.action || 'new' }}</span>
                  <span class="constraint-rule">{{ row.ruleType === 'do' ? '可以' : '不要' }}</span>
                  <p class="constraint-desc">{{ row.description }}</p>
                  <p v-if="row.evidence" class="constraint-evidence">原话：{{ row.evidence }}</p>
                </li>
              </ul>
            </template>
            <div class="digest-links">
              <button
                v-if="Number(selectedPayload.factsProcessed ?? 0) > 0"
                type="button"
                class="digest-link"
                @click="openDigestTarget('/memory-graph')"
              >
                查看便签图谱 →
              </button>
              <button
                v-if="Number(selectedPayload.constraintsProcessed ?? 0) > 0"
                type="button"
                class="digest-link"
                @click="openDigestTarget('/memory-boundaries')"
              >
                查看相处约束 →
              </button>
            </div>
            <h4 v-if="selectedPayload.transcript" class="section-title">工作记忆原文</h4>
            <pre v-if="selectedPayload.transcript" class="transcript">{{ selectedPayload.transcript }}</pre>
          </template>

          <template v-else>
            <h4 class="section-title">原始 payload</h4>
            <pre class="transcript">{{ JSON.stringify(selectedPayload, null, 2) }}</pre>
          </template>

          <p v-if="selectedTick.error" class="error-line">{{ selectedTick.error }}</p>
        </div>

        <div v-if="streamOpen && liveItems.length" class="live-block">
          <h4 class="section-title">实时（最近 {{ liveItems.length }} 条）</h4>
          <ul class="live-list">
            <li v-for="item in liveItems" :key="item.id">
              <span class="live-time">{{ formatTime(item.triggeredAt) }}</span>
              {{ payloadSummary(item) }}
            </li>
          </ul>
        </div>
      </aside>
    </div>
    </div>
  </MemoryPageShell>
</template>

<style scoped>
.memory-audit-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 16px 24px 24px;
  color: var(--text-primary);
  overflow: hidden;
}

.audit-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: nowrap;
  overflow-x: auto;
  flex-shrink: 0;
  padding-bottom: 2px;
  scrollbar-width: thin;
}

.stat-strip,
.filter-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.filter-strip {
  margin-left: auto;
}

.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  background: rgba(255, 255, 255, 0.02);
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.stat-pill strong {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}

.stat-pill.muted {
  font-size: 11px;
  opacity: 0.85;
}

.pager {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.pager-btn {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: var(--text-primary);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}

.pager-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.digest-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 12px;
}

.digest-link {
  border: none;
  background: color-mix(in srgb, var(--color-primary, #3d8c41) 12%, transparent);
  color: var(--color-primary, #3d8c41);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.constraint-audit-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.constraint-audit-list li {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.02);
}

.constraint-action,
.constraint-rule {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.06);
}

.constraint-desc {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.45;
}

.constraint-evidence {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.stat-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.chip-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.chip-label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.chip {
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.chip.active {
  border-color: var(--primary-color);
  color: var(--primary-color);
  background: color-mix(in srgb, var(--primary-color) 12%, transparent);
}

.legacy-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.date-range {
  display: flex;
  gap: 10px;
  margin-left: auto;
}

.date-filter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.refresh-banner {
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--primary-color) 14%, transparent);
  color: var(--primary-color);
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
}

.audit-layout {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
}

.table-panel {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  overflow: auto;
  padding: 0 0 8px;
}

.tick-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.tick-table th,
.tick-table td {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  text-align: left;
  vertical-align: top;
}

.tick-table th {
  position: sticky;
  top: 0;
  background: var(--bg-primary, #252525);
  color: var(--text-tertiary);
  font-weight: 600;
}

.tick-row {
  cursor: pointer;
}

.tick-row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.tick-row.selected {
  background: color-mix(in srgb, var(--primary-color) 10%, transparent);
}

.tick-row.legacy {
  opacity: 0.65;
}

.mono {
  font-family: ui-monospace, monospace;
  word-break: break-word;
}

.table-meta,
.state-text {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.state-text.error {
  color: #f53f3f;
}

.detail-panel {
  width: 380px;
  flex-shrink: 0;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.panel-header h3 {
  margin: 0;
  font-size: 15px;
}

.panel-placeholder {
  padding: 24px 16px;
  color: var(--text-tertiary);
  font-size: 13px;
}

.panel-body {
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.meta-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
}

.meta-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}

.meta-row dt {
  color: var(--text-secondary);
}

.meta-row dd {
  margin: 0;
  text-align: right;
  color: var(--text-primary);
}

.transcript {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow: auto;
}

.error-line {
  color: #f53f3f;
  font-size: 12px;
}

.live-block {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding: 12px 16px 16px;
}

.live-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 160px;
  overflow-y: auto;
}

.live-list li {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.live-time {
  display: block;
  color: var(--text-tertiary);
  margin-bottom: 2px;
}

@media (max-width: 1100px) {
  .stats-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .audit-layout {
    flex-direction: column;
  }

  .detail-panel {
    width: 100%;
    max-height: 40vh;
  }
}
</style>
