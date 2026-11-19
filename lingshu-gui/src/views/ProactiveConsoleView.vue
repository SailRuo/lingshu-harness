<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { getFullUrl } from '../utils/apiConfig';
import { useAgentsStore } from '../stores/agents';
import { useChatStore } from '../stores/chat';

interface PoolEntry {
  streamId: string;
  narrative: string;
  candidateWeight: number;
  significance?: number;
  pressure: number;
  ready: boolean;
  blockedReason: string | null;
  cooldownUntil: string | null;
  engagedUntil: string | null;
  streamCreatedAt?: string | null;
  pressureFormula?: string;
  initialPressure?: number;
  effectiveGrowthPerTick?: number;
  estimatedGrowthTicks?: number;
  pressureThreshold?: number;
}

interface CandidatePreview {
  streamId: string;
  narrative: string;
  revisitCount: number;
  freshness: number;
  significance: number;
  penalty: number;
  candidateWeight: number;
  inPool: boolean;
  rejectReason: string | null;
  lastProactiveAt: string | null;
  revisitLastAt: string | null;
  streamCreatedAt?: string | null;
}

interface PoolGroup {
  agentId: number;
  agentDisplayName?: string | null;
  agentName?: string | null;
  proactiveEnabled?: boolean | null;
  isActive?: boolean | null;
  userId: string;
  threadId: number;
  entryCount: number;
  maxPressure: number;
  externalStreamCount?: number;
  eligibleCandidateCount?: number;
  entries: PoolEntry[];
  candidates?: CandidatePreview[];
  deliveryGate?: {
    allowed: boolean;
    reason: string;
  };
  userSilence?: {
    hoursSinceLastUserMessage?: number | null;
    growthFactor: number;
    effectiveGrowthPerTick: number;
  };
}

interface PoolSnapshot {
  serverTime: string;
  config: Record<string, number | boolean>;
  hasRuntimeOverrides: boolean;
  hasPersistedOverrides?: boolean;
  runtimeOverrides: Record<string, number>;
  persistedOverrides?: Record<string, number>;
  poolCount: number;
  scopes: number;
  pools: PoolGroup[];
  schedulerRunning?: boolean;
  lastTickAt?: string | null;
  tickCount?: number;
  effectiveTickSeconds?: number;
}

const refreshing = ref(false);
const acting = ref(false);
const errorText = ref('');
const sseConnected = ref(false);
const snapshot = ref<PoolSnapshot | null>(null);

const CONSOLE_AGENT_STORAGE_KEY = 'lingshu-console-agent-id';
const agentsStore = useAgentsStore();
const chatStore = useChatStore();

function readStoredAgentId(): number | null {
  const raw = localStorage.getItem(CONSOLE_AGENT_STORAGE_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const selectedAgentId = ref<number | undefined>(readStoredAgentId() ?? undefined);

const configForm = reactive({
  pressureThreshold: 1,
  growthPerTick: 0.1,
  initFactor: 0.15,
  topK: 5,
  cooldownHours: 48,
  engagedHours: 168,
  tickSeconds: 300,
  dailyLimit: 100,
  userSilencePeakGrowth: 0.35,
  userSilenceMinGrowth: 0.01,
  userSilenceDecayDays: 7,
});

let snapshotEventSource: EventSource | null = null;

function applySnapshot(data: PoolSnapshot, options?: { syncConfig?: boolean }) {
  snapshot.value = data;
  if (options?.syncConfig !== false) {
    applyConfigToForm(data.config);
  }
  ensureSelectedAgent();
  errorText.value = '';
}

function closeSnapshotStream() {
  if (snapshotEventSource) {
    snapshotEventSource.close();
    snapshotEventSource = null;
  }
  sseConnected.value = false;
}

function connectSnapshotStream() {
  closeSnapshotStream();
  errorText.value = '';

  const source = new EventSource(getFullUrl('/api/system/proactive-pool/stream'));
  snapshotEventSource = source;

  source.addEventListener('snapshot', (event) => {
    sseConnected.value = true;
    try {
      const isFirst = snapshot.value === null;
      applySnapshot(JSON.parse(event.data) as PoolSnapshot, { syncConfig: isFirst });
    } catch (err) {
      errorText.value = err instanceof Error ? err.message : String(err);
    }
  });

  source.addEventListener('error', (event) => {
    const messageEvent = event as MessageEvent;
    if (messageEvent.data) {
      try {
        const payload = JSON.parse(messageEvent.data) as { message?: string };
        errorText.value = payload.message ?? 'SSE 连接异常';
      } catch {
        errorText.value = 'SSE 连接异常';
      }
    }
  });

  source.onerror = () => {
    sseConnected.value = false;
    if (!errorText.value) {
      errorText.value = 'SSE 连接断开，可点「刷新」重连';
    }
    closeSnapshotStream();
  };
}

function applyConfigToForm(config: Record<string, number | boolean>) {
  configForm.pressureThreshold = Number(config.pressureThreshold ?? 1);
  configForm.growthPerTick = Number(config.growthPerTick ?? 0.1);
  configForm.initFactor = Number(config.initFactor ?? 0.15);
  configForm.topK = Number(config.topK ?? 5);
  configForm.cooldownHours = Number(config.cooldownHours ?? 48);
  configForm.engagedHours = Number(config.engagedHours ?? 168);
  configForm.tickSeconds = Number(config.tickSeconds ?? 300);
  configForm.dailyLimit = Number(config.dailyLimit ?? 100);
  configForm.userSilencePeakGrowth = Number(config.userSilencePeakGrowth ?? 0.35);
  configForm.userSilenceMinGrowth = Number(config.userSilenceMinGrowth ?? 0.01);
  configForm.userSilenceDecayDays = Number(config.userSilenceDecayDays ?? 7);
}

async function loadSnapshot() {
  refreshing.value = true;
  errorText.value = '';
  try {
    const res = await fetch(getFullUrl('/api/system/proactive-pool'));
    if (!res.ok) {
      throw new Error(await res.text());
    }
    applySnapshot((await res.json()) as PoolSnapshot);
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err);
  } finally {
    refreshing.value = false;
  }
}

async function refreshSnapshot() {
  await loadSnapshot();
}

async function saveConfig() {
  acting.value = true;
  try {
    const res = await fetch(getFullUrl('/api/system/proactive-pool/config'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...configForm }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = await res.json();
    if (data?.config) {
      applyConfigToForm(data.config);
    }
    Message.success('阈值已保存到系统配置（重启后仍生效）');
  } catch (err) {
    Message.error(err instanceof Error ? err.message : String(err));
  } finally {
    acting.value = false;
  }
}

async function resetConfig() {
  acting.value = true;
  try {
    const res = await fetch(getFullUrl('/api/system/proactive-pool/config/reset'), { method: 'POST' });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    Message.success('已恢复默认阈值并清除系统配置');
  } catch (err) {
    Message.error(err instanceof Error ? err.message : String(err));
  } finally {
    acting.value = false;
  }
}

async function forceTick() {
  acting.value = true;
  try {
    const res = await fetch(getFullUrl('/api/system/proactive-pool/tick'), { method: 'POST' });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = await res.json();
    const delivered = Array.isArray(data?.results)
      ? data.results.some((item: { delivered?: boolean }) => item.delivered)
      : false;
    Message.info(delivered ? '本轮 tick 已触发主动发送' : '本轮 tick 完成，未达发送条件');
    snapshot.value = data.snapshot ?? snapshot.value;
    if (data?.snapshot?.config) {
      applyConfigToForm(data.snapshot.config);
    }
  } catch (err) {
    Message.error(err instanceof Error ? err.message : String(err));
  } finally {
    acting.value = false;
  }
}

async function testQqPush() {
  if (selectedAgentId.value == null) {
    Message.warning('请先选择智能体');
    return;
  }
  acting.value = true;
  try {
    const res = await fetch(getFullUrl('/api/system/proactive-pool/test-qq-push'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: selectedAgentId.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.detail === 'string' ? data.detail : await res.text());
    }
    if (data?.ok) {
      Message.success(`QQ 推送成功 · c2c ${data?.route?.targetId ?? ''}`);
    } else {
      const detail = [data?.reason, data?.detail].filter(Boolean).join('：');
      Message.error(detail || 'QQ 推送失败');
    }
  } catch (err) {
    Message.error(err instanceof Error ? err.message : String(err));
  } finally {
    acting.value = false;
  }
}

async function reloadPools() {
  acting.value = true;
  try {
    const res = await fetch(getFullUrl('/api/system/proactive-pool/reload'), { method: 'POST' });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    snapshot.value = (await res.json()) as PoolSnapshot;
    if (snapshot.value?.config) {
      applyConfigToForm(snapshot.value.config);
    }
    Message.success('池子已重载');
  } catch (err) {
    Message.error(err instanceof Error ? err.message : String(err));
  } finally {
    acting.value = false;
  }
}

const overrideHint = computed(() => (
  snapshot.value?.hasPersistedOverrides || snapshot.value?.hasRuntimeOverrides
    ? '当前使用系统配置表覆盖'
    : '当前使用后端默认配置'
));

const agentOptions = computed(() => (
  agentsStore.agents
    .filter((agent) => agent.id != null && agent.isActive)
    .map((agent) => ({
      label: `${agent.displayName || agent.name}（id ${agent.id}）`,
      value: agent.id as number,
    }))
));

const visiblePool = computed(() => {
  if (selectedAgentId.value == null) return null;
  return snapshot.value?.pools.find((pool) => pool.agentId === selectedAgentId.value) ?? null;
});

function ensureSelectedAgent() {
  const validIds = new Set(agentOptions.value.map((option) => option.value));
  if (selectedAgentId.value != null && validIds.has(selectedAgentId.value)) {
    return;
  }

  const poolIds = (snapshot.value?.pools ?? []).map((pool) => pool.agentId);
  const candidates = [
    chatStore.currentAgentId,
    readStoredAgentId(),
    poolIds[0],
    agentOptions.value[0]?.value ?? null,
  ];

  const next = candidates.find(
    (id): id is number => id != null && validIds.has(id),
  ) ?? agentOptions.value[0]?.value;

  selectedAgentId.value = next;
  if (next != null) {
    localStorage.setItem(CONSOLE_AGENT_STORAGE_KEY, String(next));
  }
}

function onAgentChange(
  value: string | number | boolean | Record<string, unknown> | Array<string | number | boolean | Record<string, unknown>>,
) {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  const id = Number(value);
  if (!Number.isFinite(id)) return;
  selectedAgentId.value = id;
  localStorage.setItem(CONSOLE_AGENT_STORAGE_KEY, String(id));
}

function formatUserLabel(userId: string) {
  if (userId === 'default_user') {
    return '本机用户';
  }
  return userId;
}

function formatServerTime(iso: string | undefined) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function formatAgentTitle(pool: PoolGroup) {
  const name = pool.agentDisplayName || pool.agentName || `智能体 #${pool.agentId}`;
  return name;
}

function formatRejectReason(reason: string | null | undefined) {
  if (!reason) return '—';
  const map: Record<string, string> = {
    stale_stream: '写入已久、新鲜度太低',
    proactive_c_penalty: 'C 降权（24h 内主动说过）',
    weight_zero: '权重为 0',
  };
  return map[reason] ?? reason;
}

function formatDeliveryGateReason(pool: PoolGroup) {
  const gate = pool.deliveryGate;
  if (!gate) return '';
  if (gate.allowed) return '发送门槛：通过';
  const map: Record<string, string> = {
    dnd_window: '免打扰时段',
    daily_cap: '今日主动上限已满',
    global_disabled: '全局主动问候已关',
    agent_disabled: '智能体主动问候已关',
    user_opt_out: '用户要求别主动发',
    license: '授权未开通 proactive',
    stream_proactive_disabled: '意识流主动池已禁用',
  };
  return `发送被挡：${map[gate.reason] ?? gate.reason}`;
}

onMounted(async () => {
  await agentsStore.fetchAgents();
  ensureSelectedAgent();
  connectSnapshotStream();
});

watch(() => agentsStore.agents, () => {
  ensureSelectedAgent();
});

onBeforeUnmount(() => {
  closeSnapshotStream();
});
</script>

<template>
  <div class="console-page">
    <header class="console-header">
      <div>
        <h1>主动池控制台</h1>
        <p class="sub">
          查看惦记池状态、调阈值验证触发。打开页面时 SSE 实时推送，关闭后不再请求。
          <span class="hint">{{ overrideHint }}</span>
          <span v-if="sseConnected" class="hint sse-live">· 已连接</span>
        </p>
      </div>
      <div class="header-actions">
        <a-button :loading="refreshing" @click="refreshSnapshot">刷新</a-button>
        <a-button :loading="acting" @click="reloadPools">重载池</a-button>
        <a-button :loading="acting" @click="testQqPush">测 QQ 推送</a-button>
        <a-button type="primary" :loading="acting" @click="forceTick">手动 tick</a-button>
      </div>
    </header>

    <div class="console-scroll">
    <a-alert v-if="errorText" type="error" :title="errorText" show-icon class="mb-16" />

    <section class="panel">
      <h2>阈值（运行时）</h2>
      <div class="config-grid">
        <label>
          <span>触发阈值 pressureThreshold</span>
          <a-input-number v-model="configForm.pressureThreshold" :min="0.01" :step="0.05" />
        </label>
        <label>
          <span>每 tick 增长 growthPerTick</span>
          <a-input-number v-model="configForm.growthPerTick" :min="0.01" :step="0.05" />
        </label>
        <label>
          <span>初始惦记 initFactor</span>
          <a-input-number v-model="configForm.initFactor" :min="0" :step="0.05" />
        </label>
        <label>
          <span>候选 TopK</span>
          <a-input-number v-model="configForm.topK" :min="1" :max="20" />
        </label>
        <label>
          <span>冷却小时 cooldownHours</span>
          <a-input-number v-model="configForm.cooldownHours" :min="0" />
        </label>
        <label>
          <span>用户回话冷却 engagedHours</span>
          <a-input-number v-model="configForm.engagedHours" :min="0" />
        </label>
        <label>
          <span>自动 tick 秒 tickSeconds</span>
          <a-input-number v-model="configForm.tickSeconds" :min="1" :step="1" />
        </label>
        <label>
          <span>日上限 dailyLimit</span>
          <a-input-number v-model="configForm.dailyLimit" :min="0" />
        </label>
        <label>
          <span>刚聊过峰值系数 userSilencePeakGrowth</span>
          <a-input-number v-model="configForm.userSilencePeakGrowth" :min="0.01" :max="1" :step="0.05" />
        </label>
        <label>
          <span>静默下限 userSilenceMinGrowth</span>
          <a-input-number v-model="configForm.userSilenceMinGrowth" :min="0" :max="1" :step="0.01" />
        </label>
        <label>
          <span>衰减天数 userSilenceDecayDays</span>
          <a-input-number v-model="configForm.userSilenceDecayDays" :min="1" :step="1" />
        </label>
      </div>
      <div class="config-actions">
        <a-button type="primary" :loading="acting" @click="saveConfig">应用阈值</a-button>
        <a-button :loading="acting" @click="resetConfig">恢复默认</a-button>
      </div>
      <p class="tip">惦记值只在后端 tick 时增长，SSE 推送不会单独涨值。验证：threshold 降到 0.1 → 应用 → 重载池 → 连点「手动 tick」看惦记值变化。</p>
    </section>

    <section class="panel" v-if="snapshot">
      <h2>概览</h2>
      <div class="stats">
        <div class="stat-card stat-card--time">
          <div class="label">服务时间</div>
          <div class="value">{{ formatServerTime(snapshot.serverTime) }}</div>
        </div>
        <div class="stat-card"><div class="label">作用域</div><div class="value">{{ snapshot.scopes }}</div></div>
        <div class="stat-card"><div class="label">内存池</div><div class="value">{{ snapshot.poolCount }}</div></div>
        <div class="stat-card"><div class="label">已启用</div><div class="value">{{ snapshot.config.enabled ? '是' : '否' }}</div></div>
        <div class="stat-card"><div class="label">自动调度</div><div class="value">{{ snapshot.schedulerRunning ? '运行中' : '未运行' }}</div></div>
        <div class="stat-card stat-card--time">
          <div class="label">上次 tick</div>
          <div class="value">{{ snapshot.lastTickAt ? formatServerTime(snapshot.lastTickAt) : '从未' }}</div>
        </div>
        <div class="stat-card"><div class="label">tick 次数</div><div class="value">{{ snapshot.tickCount ?? 0 }}</div></div>
        <div class="stat-card"><div class="label">tick 间隔</div><div class="value">{{ snapshot.effectiveTickSeconds ?? snapshot.config.tickSeconds }}s</div></div>
      </div>
    </section>

    <section class="panel" v-if="snapshot">
      <div class="panel-toolbar">
        <h2>惦记池</h2>
        <a-select
          v-model="selectedAgentId"
          :options="agentOptions"
          placeholder="选择智能体"
          allow-search
          :style="{ width: '300px' }"
          @change="onAgentChange"
        />
      </div>

      <template v-if="visiblePool">
        <h3 class="pool-title">
          {{ formatAgentTitle(visiblePool) }}
          <span class="muted">
            {{ visiblePool.agentName ? `${visiblePool.agentName} · ` : '' }}id {{ visiblePool.agentId }}
            · {{ formatUserLabel(visiblePool.userId) }}
            · thread {{ visiblePool.threadId }}
            · max {{ visiblePool.maxPressure }}
          </span>
        </h3>
        <div class="pool-meta">
          <a-tag :color="visiblePool.proactiveEnabled ? 'green' : 'gray'">
            主动问候 {{ visiblePool.proactiveEnabled ? '开' : '关' }}
          </a-tag>
          <a-tag :color="visiblePool.isActive ? 'arcoblue' : 'gray'">
            {{ visiblePool.isActive ? '已启用' : '未启用' }}
          </a-tag>
          <span class="meta-stat">external 意识流 {{ visiblePool.externalStreamCount ?? 0 }}</span>
          <span class="meta-stat">可入池候选 {{ visiblePool.eligibleCandidateCount ?? 0 }}</span>
          <span class="meta-stat">池中 {{ visiblePool.entryCount }}</span>
          <a-tag v-if="visiblePool.deliveryGate" :color="visiblePool.deliveryGate.allowed ? 'green' : 'orangered'">
            {{ formatDeliveryGateReason(visiblePool) }}
          </a-tag>
          <span v-if="visiblePool.userSilence" class="meta-stat">
            用户静默 {{ visiblePool.userSilence.hoursSinceLastUserMessage ?? '—' }}h
            · 增长系数 {{ visiblePool.userSilence.growthFactor }}
            · 实增 {{ visiblePool.userSilence.effectiveGrowthPerTick }}/tick
          </span>
        </div>
        <a-table
          v-if="visiblePool.entries.length"
          :data="visiblePool.entries"
          :pagination="false"
          size="small"
          :bordered="{ cell: true }"
        >
          <template #columns>
            <a-table-column title="惦记值" data-index="pressure" :width="90" />
            <a-table-column title="惦记公式" :width="360">
              <template #cell="{ record }">
                <span class="formula">{{ record.pressureFormula || '—' }}</span>
              </template>
            </a-table-column>
            <a-table-column title="候选权重" data-index="candidateWeight" :width="100" />
            <a-table-column title="分量" data-index="significance" :width="70" />
            <a-table-column title="可触发" :width="80">
              <template #cell="{ record }">
                <a-tag :color="record.ready ? 'green' : 'gray'">{{ record.ready ? '是' : '否' }}</a-tag>
              </template>
            </a-table-column>
            <a-table-column title="阻塞" data-index="blockedReason" :width="100" />
            <a-table-column title="意识流时间" :width="160">
              <template #cell="{ record }">
                {{ formatServerTime(record.streamCreatedAt) }}
              </template>
            </a-table-column>
            <a-table-column title="回忆" data-index="narrative" />
          </template>
        </a-table>
        <template v-else>
          <p class="empty">
            池中暂无条目。
            <template v-if="(visiblePool.externalStreamCount ?? 0) === 0">
              该作用域没有 external 意识流（需先有对话产生的意识流记忆）。
            </template>
            <template v-else-if="(visiblePool.eligibleCandidateCount ?? 0) === 0">
              有 {{ visiblePool.externalStreamCount }} 条 external 意识流，但候选权重均为 0（多为 C 降权或写入太久新鲜度太低）。
            </template>
            <template v-else>
              有 {{ visiblePool.eligibleCandidateCount }} 条可入池候选，点「重载池」刷新。
            </template>
          </p>
          <h4 v-if="visiblePool.candidates?.length" class="sub-heading">候选诊断（Top {{ visiblePool.candidates.length }}）</h4>
          <a-table
            v-if="visiblePool.candidates?.length"
            :data="visiblePool.candidates"
            :pagination="false"
            size="small"
            :bordered="{ cell: true }"
          >
            <template #columns>
              <a-table-column title="权重" data-index="candidateWeight" :width="80" />
              <a-table-column title="新鲜度" data-index="freshness" :width="80" />
              <a-table-column title="分量" data-index="significance" :width="70" />
              <a-table-column title="C 系数" data-index="penalty" :width="70" />
              <a-table-column title="召回次" data-index="revisitCount" :width="70" />
              <a-table-column title="入池" :width="60">
                <template #cell="{ record }">
                  <a-tag :color="record.inPool ? 'green' : 'gray'">{{ record.inPool ? '是' : '否' }}</a-tag>
                </template>
              </a-table-column>
              <a-table-column title="未入池原因" :width="180">
                <template #cell="{ record }">
                  {{ formatRejectReason(record.rejectReason) }}
                </template>
              </a-table-column>
              <a-table-column title="意识流时间" :width="160">
                <template #cell="{ record }">
                  {{ formatServerTime(record.streamCreatedAt) }}
                </template>
              </a-table-column>
              <a-table-column title="回忆" data-index="narrative" />
            </template>
          </a-table>
        </template>
      </template>
      <p v-else class="empty">
        该智能体暂无主动池作用域（需开启「主动问候」且存在对话线程）。
      </p>
    </section>
    </div>
  </div>
</template>

<style scoped>
.console-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-chat-window);
  color: var(--text-primary);
}

.console-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  flex-shrink: 0;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-chat-window);
  z-index: 10;
}

.console-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 24px 40px;
}

.console-header h1 {
  margin: 0 0 6px;
  font-size: 22px;
  color: var(--text-primary);
}

.sub {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.hint {
  margin-left: 8px;
  color: var(--color-primary);
}

.sse-live {
  color: var(--success-color, var(--color-primary));
}

.header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}

.panel h2 {
  margin: 0 0 12px;
  font-size: 16px;
  color: var(--text-primary);
}

.panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.panel-toolbar h2 {
  margin: 0;
}

.pool-title {
  margin: 0 0 12px;
  font-size: 15px;
  color: var(--text-primary);
}

.muted {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: normal;
  margin-left: 8px;
}

.pool-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

.meta-stat {
  font-size: 12px;
  color: var(--text-secondary);
}

.sub-heading {
  margin: 12px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.config-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.config-grid label > span {
  color: var(--text-secondary);
}

.config-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.tip {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.stats {
  display: grid;
  grid-template-columns: minmax(190px, 2fr) repeat(3, minmax(88px, 1fr));
  gap: 10px;
}

.stat-card {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  min-width: 0;
}

.stat-card--time .value {
  font-size: 14px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.stat-card .label {
  font-size: 12px;
  color: var(--text-secondary);
}

.stat-card .value {
  margin-top: 4px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.formula {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
  color: var(--text-secondary);
}

.empty {
  color: var(--text-secondary);
  font-size: 13px;
}

.mb-16 {
  margin-bottom: 16px;
}
</style>
