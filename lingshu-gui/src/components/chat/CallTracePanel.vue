<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useChatStore } from '../../stores/chat';
import { getFullUrl } from '../../utils/apiConfig';
import Message from '@arco-design/web-vue/es/message';

interface ParsedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  cacheCreationTokens: number;
  cachedOutputTokens: number | null;
  reasoningTokens: number;
  reported: boolean;
}

interface CallTrace {
  id: string;
  threadId: number;
  turnId: string | null;
  kind: 'llm' | 'tool';
  model: string | null;
  provider: string | null;
  toolName: string | null;
  request: unknown;
  response: unknown;
  usage: ParsedUsage | null;
  error: string | null;
  createdAt: string;
  inputCacheHitRate: number | null;
  outputCacheHitRate: number | null;
}

type Filter = 'all' | 'llm' | 'tool';

const chatStore = useChatStore();

const traces = ref<CallTrace[]>([]);
const loading = ref(false);
const filter = ref<Filter>('all');
const expandedId = ref<string | null>(null);
const payloadTab = ref<'request' | 'response'>('request');

const visibleTraces = computed(() => {
  if (filter.value === 'all') return traces.value;
  return traces.value.filter((trace) => trace.kind === filter.value);
});

/** Aggregate cache hit rate over the LLM calls of this conversation. */
const cacheSummary = computed(() => {
  const llmTraces = traces.value.filter((trace) => trace.kind === 'llm' && trace.usage?.reported);
  if (!llmTraces.length) return null;
  let promptTokens = 0;
  let cachedPrompt = 0;
  let completionTokens = 0;
  let cachedOutput = 0;
  let outputReported = false;
  for (const trace of llmTraces) {
    const usage = trace.usage as ParsedUsage;
    promptTokens += usage.promptTokens || 0;
    cachedPrompt += usage.cachedPromptTokens || 0;
    completionTokens += usage.completionTokens || 0;
    if (usage.cachedOutputTokens !== null && usage.cachedOutputTokens !== undefined) {
      outputReported = true;
      cachedOutput += usage.cachedOutputTokens;
    }
  }
  return {
    calls: llmTraces.length,
    promptTokens,
    cachedPrompt,
    inputRate: promptTokens > 0 ? cachedPrompt / promptTokens : null,
    completionTokens,
    cachedOutput,
    outputRate: outputReported && completionTokens > 0 ? cachedOutput / completionTokens : null,
    outputReported,
  };
});

function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString('zh-CN');
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '（无）';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const expandedTrace = computed(
  () => visibleTraces.value.find((trace) => trace.id === expandedId.value) || null,
);

const activePayload = computed(() => {
  const trace = expandedTrace.value;
  if (!trace) return null;
  return payloadTab.value === 'request' ? trace.request : trace.response;
});

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

async function copyActivePayload() {
  const payload = activePayload.value;
  if (payload === null || payload === undefined) {
    Message.warning('没有可复制的内容');
    return;
  }
  const ok = await writeClipboard(pretty(payload));
  if (ok) Message.success('请求报文已复制到剪贴板');
  else Message.error('复制失败，请手动选择内容复制');
}

function toggle(trace: CallTrace) {
  if (expandedId.value === trace.id) {
    expandedId.value = null;
    return;
  }
  expandedId.value = trace.id;
  payloadTab.value = 'request';
}

function traceTitle(trace: CallTrace): string {
  if (trace.kind === 'tool') return trace.toolName || 'tool';
  return trace.model || 'LLM';
}

async function fetchTraces() {
  const threadId = Number(chatStore.currentConversationId);
  if (!Number.isInteger(threadId) || threadId <= 0) {
    traces.value = [];
    return;
  }
  loading.value = true;
  try {
    const res = await fetch(
      getFullUrl(`/api/v1/chat/traces?threadId=${threadId}&limit=80`),
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    traces.value = Array.isArray(data?.traces) ? data.traces : [];
  } catch (err) {
    traces.value = [];
    Message.error(err instanceof Error ? `读取调用记录失败: ${err.message}` : '读取调用记录失败');
  } finally {
    loading.value = false;
  }
}

async function clearTraces() {
  const threadId = Number(chatStore.currentConversationId);
  if (!Number.isInteger(threadId) || threadId <= 0) return;
  try {
    await fetch(getFullUrl(`/api/v1/chat/traces?threadId=${threadId}`), { method: 'DELETE' });
    traces.value = [];
  } catch {
    Message.error('清空调用记录失败');
  }
}

watch(
  () => chatStore.currentConversationId,
  () => {
    expandedId.value = null;
    void fetchTraces();
  },
  { immediate: true },
);
</script>

<template>
  <div class="call-trace-panel">
    <header class="panel-head">
      <div class="head-title">
        <span class="head-label">请求报文</span>
        <button class="icon-btn" type="button" title="刷新" @click="fetchTraces">↻</button>
      </div>
      <p v-if="!traces.length && !loading" class="hint">这一轮还没有可查看的请求报文</p>
      <p v-else-if="cacheSummary" class="hint">
        模型调用 {{ cacheSummary.calls }} 次 · 输入缓存命中
        <b>{{ formatRate(cacheSummary.inputRate) }}</b>
        ({{ formatTokens(cacheSummary.cachedPrompt) }}/{{ formatTokens(cacheSummary.promptTokens) }})
        · 输出缓存命中
        <b
          :title="cacheSummary.outputReported
            ? '输出 token 命中的缓存量 / 输出 token 总量'
            : '当前服务商只上报输入缓存计数，usage 里没有输出缓存字段，所以无法计算输出缓存命中率'"
        >{{ cacheSummary.outputReported ? formatRate(cacheSummary.outputRate) : '服务商未上报' }}</b>
      </p>
    </header>

    <div class="toolbar">
      <button
        v-for="option in ([['all', '全部'], ['llm', '模型'], ['tool', '工具']] as const)"
        :key="option[0]"
        type="button"
        class="filter-btn"
        :class="{ active: filter === option[0] }"
        @click="filter = option[0]"
      >
        {{ option[1] }}
      </button>
      <button
        v-if="traces.length"
        class="filter-btn danger"
        type="button"
        @click="clearTraces"
      >
        清空
      </button>
    </div>

    <div v-if="loading && !traces.length" class="empty-block">读取中…</div>

    <div v-for="(trace, index) in visibleTraces" :key="trace.id" class="trace-card">
      <button class="trace-head" type="button" @click="toggle(trace)">
        <span class="trace-index">#{{ visibleTraces.length - index }}</span>
        <span class="trace-kind" :class="trace.kind">{{ trace.kind === 'tool' ? '工具' : '模型' }}</span>
        <span class="trace-title">{{ traceTitle(trace) }}</span>
        <span class="trace-time">{{ formatTime(trace.createdAt) }}</span>
        <span class="trace-caret">{{ expandedId === trace.id ? '▾' : '▸' }}</span>
      </button>

      <div v-if="trace.kind === 'llm' && trace.usage?.reported" class="usage-line">
        <span>输入 {{ formatTokens(trace.usage.promptTokens) }}</span>
        <span class="usage-cache" :class="{ hit: (trace.usage.cachedPromptTokens || 0) > 0 }">
          缓存 {{ formatTokens(trace.usage.cachedPromptTokens) }}（{{ formatRate(trace.inputCacheHitRate) }}）
        </span>
        <span>输出 {{ formatTokens(trace.usage.completionTokens) }}</span>
        <span
          class="usage-cache"
          :class="{ hit: (trace.usage.cachedOutputTokens || 0) > 0 }"
          :title="trace.usage.cachedOutputTokens === null
            ? '该服务商的 usage 里没有输出缓存字段（只有 prompt_tokens_details.cached_tokens），因此输出缓存命中率无法计算'
            : '输出 token 命中的缓存量 / 输出 token 总量'"
        >
          缓存 {{ trace.usage.cachedOutputTokens === null ? '服务商未上报' : formatTokens(trace.usage.cachedOutputTokens) }}
          <template v-if="trace.usage.cachedOutputTokens !== null">
            （{{ formatRate(trace.outputCacheHitRate) }}）
          </template>
        </span>
      </div>
      <div v-else-if="trace.kind === 'llm'" class="usage-line muted">该次调用没有返回 usage 数据</div>

      <p v-if="trace.error" class="trace-error">{{ trace.error }}</p>

      <div v-if="expandedId === trace.id" class="trace-body">
        <div class="payload-tabs">
          <button
            type="button"
            class="payload-tab"
            :class="{ active: payloadTab === 'request' }"
            @click="payloadTab = 'request'"
          >
            请求报文
          </button>
          <button
            type="button"
            class="payload-tab"
            :class="{ active: payloadTab === 'response' }"
            @click="payloadTab = 'response'"
          >
            响应
          </button>
          <button
            type="button"
            class="copy-btn"
            :disabled="!activePayload"
            @click="copyActivePayload"
          >
            复制
          </button>
        </div>
        <pre class="payload">{{ pretty(activePayload) }}</pre>
      </div>
    </div>

    <div v-if="!loading && !visibleTraces.length" class="empty-block">没有匹配的调用记录</div>
  </div>
</template>

<style scoped>
.call-trace-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px 8px;
}
.panel-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.head-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.head-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.icon-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.icon-btn:hover {
  background: color-mix(in srgb, var(--text-primary) 10%, transparent);
  color: var(--text-primary);
}
.hint {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.hint b {
  color: var(--text-primary);
  font-weight: 600;
}
.toolbar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.filter-btn {
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.filter-btn.active {
  color: var(--color-primary, #3D8C41);
  border-color: color-mix(in srgb, var(--color-primary, #3D8C41) 40%, transparent);
  background: color-mix(in srgb, var(--color-primary, #3D8C41) 10%, transparent);
}
.filter-btn.danger:hover {
  color: var(--color-error, #f53f3f);
  border-color: color-mix(in srgb, var(--color-error, #f53f3f) 40%, transparent);
}
.empty-block {
  padding: 12px 10px;
  border-radius: 8px;
  border: 1px dashed var(--border-color, rgba(255, 255, 255, 0.1));
  font-size: 12px;
  color: var(--text-secondary);
}
.trace-card {
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  background: var(--bg-hover, rgba(255, 255, 255, 0.03));
  overflow: hidden;
}
.trace-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.trace-head:hover {
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
}
.trace-index {
  font-size: 10px;
  color: var(--text-tertiary, var(--text-secondary));
  font-variant-numeric: tabular-nums;
}
.trace-kind {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-secondary);
  flex-shrink: 0;
}
.trace-kind.tool {
  background: rgba(250, 173, 20, 0.16);
  color: #fbbf24;
}
.trace-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trace-time {
  font-size: 10px;
  color: var(--text-tertiary, var(--text-secondary));
  font-variant-numeric: tabular-nums;
}
.trace-caret {
  font-size: 10px;
  color: var(--text-secondary);
}
.usage-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 0 9px 7px;
  font-size: 10px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.usage-line.muted {
  font-style: italic;
  opacity: 0.75;
}
.usage-cache.hit {
  color: #4ade80;
}
.trace-error {
  margin: 0;
  padding: 0 9px 7px;
  font-size: 10px;
  color: var(--color-error, #f53f3f);
  word-break: break-all;
}
.trace-body {
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  padding: 8px 9px 10px;
}
.payload-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
  align-items: center;
}
.payload-tab {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 5px;
  cursor: pointer;
}
.payload-tab.active {
  color: var(--text-primary);
  background: color-mix(in srgb, var(--text-primary) 10%, transparent);
}
.copy-btn {
  margin-left: auto;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1;
  padding: 3px 10px;
  border-radius: 5px;
  cursor: pointer;
}
.copy-btn:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--text-primary) 28%, transparent);
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
}
.copy-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.payload {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.28);
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-primary);
}
</style>
