<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { Message, Modal } from '@arco-design/web-vue';
import IconUpload from '@arco-design/web-vue/es/icon/icon-upload';
import IconRobot from '@arco-design/web-vue/es/icon/icon-robot';
import IconFile from '@arco-design/web-vue/es/icon/icon-file';
import { useAgentsStore } from '../../stores/agents';
import { useChatStore } from '../../stores/chat';
import { getFullUrl } from '../../utils/apiConfig';
import { parseImportTimeStr, parseUnixTimestamp } from '../../utils/dateTime';

const props = defineProps<{
  initialAgentId?: number;
}>();

const agentsStore = useAgentsStore();
const chatStore = useChatStore();

const selectedAgentId = shallowRef<number | undefined>(props.initialAgentId);

watch(() => props.initialAgentId, (newId) => {
  if (newId) {
    selectedAgentId.value = newId;
  }
});
const selectedFileName = shallowRef('');
const selectedFileSize = shallowRef(0);
const fileContent = shallowRef('');
const isReadingFile = shallowRef(false);
const isImporting = shallowRef(false);
const isRetryingDigest = shallowRef(false);
const selectedImportRange = shallowRef<'recent_1_week' | 'recent_1_month' | 'recent_3_months' | 'recent_6_months' | 'all'>('recent_3_months');
const selectedDigestBatchSize = shallowRef(100);
const importProgressVisible = shallowRef(false);
const importResultSummary = shallowRef<{
  importedMessages: number;
  importedTurns: number;
  skippedOutOfRange: number;
  digestScheduled: boolean;
}>({
  importedMessages: 0,
  importedTurns: 0,
  skippedOutOfRange: 0,
  digestScheduled: false,
});
const digestProgress = shallowRef<ImportDigestProgress | null>(null);
const currentDigestAgentId = shallowRef<number | undefined>();
let digestEventSource: EventSource | null = null;
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024 * 1024;

interface JsonImportItem {
  userType?: number | string;
  sender?: string;
  content?: string;
  timestamp?: number;
  timeStr?: string;
  index_in_conv?: string | number;
}

interface ImportDigestProgress {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'limited' | 'missing';
  phase?: 'digest' | 'retrospect' | 'completed' | string;
  totalTurns: number;
  maxTurns: number;
  targetTurns: number;
  processedTurns: number;
  pendingTurns: number;
  totalWork?: number;
  processedWork?: number;
  retrospectTotal?: number;
  retrospectProcessed?: number;
  batches: number;
  message: string;
  error?: string | null;
}

const agentOptions = computed(() =>
  agentsStore.agents
    .filter((agent) => agent.id && agent.isActive)
    .map((agent) => ({
      label: agent.displayName || agent.name,
      value: agent.id as number,
    })),
);

const importRangeOptions = [
  { label: '近一周', value: 'recent_1_week' },
  { label: '近一月', value: 'recent_1_month' },
  { label: '近三个月', value: 'recent_3_months' },
  { label: '近半年', value: 'recent_6_months' },
  { label: '全部', value: 'all' },
];

const digestBatchOptions = [
  { label: '20 轮', value: 20 },
  { label: '50 轮', value: 50 },
  { label: '100 轮', value: 100 },
  { label: '200 轮', value: 200 },
  { label: '500 轮', value: 500 },
];

function resolveJsonItems(content: string): JsonImportItem[] {
  const text = content.trim();
  if (!text.startsWith('[') && !text.startsWith('{')) return [];
  try {
    const data = JSON.parse(text) as unknown;
    const rawItems = Array.isArray(data)
      ? data
      : (
        data && typeof data === 'object'
          ? (data as { messages?: unknown; data?: unknown; items?: unknown }).messages
            || (data as { data?: unknown }).data
            || (data as { items?: unknown }).items
          : []
      );
    if (!Array.isArray(rawItems)) return [];
    return rawItems.filter((item): item is JsonImportItem => Boolean(item && typeof item === 'object'));
  } catch {
    return [];
  }
}

function isJsonUserMessage(item: JsonImportItem): boolean {
  if (item.userType === 1 || item.userType === '1') return true;
  const sender = String(item.sender || '').trim().toLowerCase();
  return sender === '用户' || sender === 'user' || sender === 'human';
}

function isJsonAiMessage(item: JsonImportItem): boolean {
  if (item.userType === 2 || item.userType === '2') return true;
  const sender = String(item.sender || '').trim().toLowerCase();
  return ['ai', 'assistant', '助手', '豆包ai', '豆包'].includes(sender);
}

function formatImportTime(item: JsonImportItem): string {
  if (item.timeStr) {
    const date = parseImportTimeStr(String(item.timeStr));
    if (date) return date.toLocaleString();
    return String(item.timeStr);
  }
  if (typeof item.timestamp === 'number') {
    const date = parseUnixTimestamp(item.timestamp);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  return '';
}

function parseImportDate(item: JsonImportItem): Date | null {
  if (typeof item.timestamp === 'number') {
    const date = parseUnixTimestamp(item.timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (item.timeStr) {
    return parseImportTimeStr(String(item.timeStr));
  }
  return null;
}

function filterJsonItemsBySelectedRange(items: JsonImportItem[]): JsonImportItem[] {
  const cutoff = importRangeCutoff.value;
  if (!cutoff) return items;
  return items.filter((item) => {
    const date = parseImportDate(item);
    return !date || date >= cutoff;
  });
}

function buildRangedImportContent(content: string): string {
  const text = content.trim();
  if (!text.startsWith('[') && !text.startsWith('{')) return content;
  const cutoff = importRangeCutoff.value;
  if (!cutoff) return content;

  try {
    const data = JSON.parse(text) as unknown;
    if (Array.isArray(data)) {
      return JSON.stringify(filterJsonItemsBySelectedRange(data as JsonImportItem[]));
    }
    if (data && typeof data === 'object') {
      const obj = data as { messages?: unknown; data?: unknown; items?: unknown };
      for (const key of ['messages', 'data', 'items'] as const) {
        if (Array.isArray(obj[key])) {
          return JSON.stringify({
            ...obj,
            [key]: filterJsonItemsBySelectedRange(obj[key] as JsonImportItem[]),
          });
        }
      }
    }
  } catch {
    return content;
  }
  return content;
}

const importRangeCutoff = computed(() => {
  const now = Date.now();
  if (selectedImportRange.value === 'recent_1_week') return new Date(now - 7 * 24 * 60 * 60 * 1000);
  if (selectedImportRange.value === 'recent_1_month') return new Date(now - 30 * 24 * 60 * 60 * 1000);
  if (selectedImportRange.value === 'recent_3_months') return new Date(now - 90 * 24 * 60 * 60 * 1000);
  if (selectedImportRange.value === 'recent_6_months') return new Date(now - 180 * 24 * 60 * 60 * 1000);
  return null;
});

const parsedPreview = computed(() => {
  const jsonItems = resolveJsonItems(fileContent.value);
  if (jsonItems.length) {
    const importableItems = jsonItems.filter((item) => String(item.content || '').trim());
    const cutoff = importRangeCutoff.value;
    const rangedItems = cutoff
      ? importableItems.filter((item) => {
        const date = parseImportDate(item);
        return !date || date >= cutoff;
      })
      : importableItems;
    const firstTime = importableItems.map(formatImportTime).find(Boolean) || '';
    const lastTime = [...importableItems].reverse().map(formatImportTime).find(Boolean) || '';
    return {
      userCount: rangedItems.filter(isJsonUserMessage).length,
      aiCount: rangedItems.filter(isJsonAiMessage).length,
      total: importableItems.filter((item) => isJsonUserMessage(item) || isJsonAiMessage(item)).length,
      inRangeTotal: rangedItems.filter((item) => isJsonUserMessage(item) || isJsonAiMessage(item)).length,
      skippedOutOfRange: importableItems.length - rangedItems.length,
      format: 'json',
      timeRange: firstTime && lastTime ? `${firstTime} - ${lastTime}` : '',
    };
  }

  return {
    userCount: 0,
    aiCount: 0,
    total: 0,
    inRangeTotal: 0,
    skippedOutOfRange: 0,
    format: 'json',
    timeRange: '',
  };
});

const canImport = computed(() =>
  Boolean(selectedAgentId.value && fileContent.value.trim() && !isReadingFile.value && !isImporting.value),
);

const digestProgressPercent = computed(() => {
  const progress = digestProgress.value;
  if (!progress) return 0;
  const total = progress.totalWork || progress.totalTurns || 0;
  const processed = progress.processedWork ?? progress.processedTurns ?? 0;
  if (!total) return 0;
  return Math.min(1, Math.max(0, processed / total));
});

const digestProgressPercentText = computed(() => Math.round(digestProgressPercent.value * 100));
const digestProgressWidth = computed(() => `${digestProgressPercentText.value}%`);

const digestTerminalStatuses = ['completed', 'failed', 'skipped', 'limited', 'missing'];

const isDigestTerminal = computed(() => (
  !importResultSummary.value.digestScheduled
  || digestTerminalStatuses.includes(digestProgress.value?.status || '')
));

const digestProgressStatus = computed(() => {
  const status = digestProgress.value?.status;
  if (status === 'failed' || status === 'missing') return 'danger';
  if (status === 'completed') return 'success';
  return 'normal';
});

const digestProgressClass = computed(() => ({
  'progress-track--danger': digestProgressStatus.value === 'danger',
  'progress-track--success': digestProgressStatus.value === 'success',
}));

const digestProgressCountText = computed(() => {
  const progress = digestProgress.value;
  if (!progress) {
    return `待处理 ${importResultSummary.value.importedTurns} 轮`;
  }
  if (progress.phase === 'retrospect') {
    return `时间镜像 ${progress.retrospectProcessed || 0} / ${progress.retrospectTotal || 0}`;
  }
  if (progress.status === 'completed') {
    return `已完成 ${progress.processedTurns || 0} 轮`;
  }
  return `已处理 ${progress.processedTurns || 0} 轮 / 待处理 ${progress.pendingTurns ?? importResultSummary.value.importedTurns} 轮`;
});

const digestStatusText = computed(() => {
  const status = digestProgress.value?.status;
  if (status === 'completed') return '处理完成';
  if (status === 'failed') return '处理失败';
  if (status === 'skipped') return '已跳过';
  if (status === 'limited') return '达到本次上限';
  if (status === 'running') return '处理中';
  if (status === 'pending') return '等待处理';
  return importResultSummary.value.digestScheduled ? '连接进度中' : '未安排后台处理';
});

const canRetryDigest = computed(() => {
  const status = digestProgress.value?.status;
  return Boolean(
    currentDigestAgentId.value
    && digestProgress.value?.jobId
    && ['failed', 'limited', 'skipped'].includes(status || '')
    && !isRetryingDigest.value,
  );
});

const retryDigestLabel = computed(() => (
  digestProgress.value?.status === 'limited' ? '继续处理' : '重试剩余'
));

function formatFileSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file, 'utf-8');
  });
}

async function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
    Message.warning('请选择 JSON 文件');
    return;
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    Message.warning('文件不能超过 5GB');
    return;
  }

  isReadingFile.value = true;
  try {
    fileContent.value = await readTextFile(file);
    selectedFileName.value = file.name;
    selectedFileSize.value = file.size;
    if (!parsedPreview.value.total) {
      Message.warning('没有识别到可导入消息，请确认 JSON 结构');
    }
  } catch (err) {
    Message.error(err instanceof Error ? err.message : '文件读取失败');
  } finally {
    isReadingFile.value = false;
  }
}

function closeDigestEventSource() {
  if (digestEventSource) {
    digestEventSource.close();
    digestEventSource = null;
  }
}

function closeImportProgressModal() {
  if (!isDigestTerminal.value) return;
  importProgressVisible.value = false;
  closeDigestEventSource();
}

function startDigestProgressStream(agentId: number, jobId: string) {
  closeDigestEventSource();
  currentDigestAgentId.value = agentId;
  digestProgress.value = {
    jobId,
    status: 'pending',
    totalTurns: importResultSummary.value.importedTurns,
    maxTurns: selectedDigestBatchSize.value,
    targetTurns: importResultSummary.value.importedTurns,
    processedTurns: 0,
    pendingTurns: importResultSummary.value.importedTurns,
    totalWork: importResultSummary.value.importedTurns,
    processedWork: 0,
    retrospectTotal: 0,
    retrospectProcessed: 0,
    batches: 0,
    message: '等待开始处理',
  };

  digestEventSource = new EventSource(
    getFullUrl(`/api/v1/chat/agents/${agentId}/import-history/digest/${jobId}/stream`),
  );
  digestEventSource.addEventListener('progress', (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as ImportDigestProgress;
      digestProgress.value = data;
      if (['completed', 'failed', 'skipped', 'limited', 'missing'].includes(data.status)) {
        closeDigestEventSource();
      }
    } catch {
      // Ignore malformed progress packets; the next SSE event will refresh state.
    }
  });
  digestEventSource.onerror = () => {
    if (digestProgress.value && !['completed', 'failed', 'skipped', 'limited'].includes(digestProgress.value.status)) {
      digestProgress.value = {
        ...digestProgress.value,
        status: 'failed',
        message: '进度连接中断',
      };
    }
    closeDigestEventSource();
  };
}

async function retryDigestJob() {
  const agentId = currentDigestAgentId.value;
  const jobId = digestProgress.value?.jobId;
  if (!agentId || !jobId) return;

  isRetryingDigest.value = true;
  try {
    const res = await fetch(
      getFullUrl(`/api/v1/chat/agents/${agentId}/import-history/digest/${jobId}/retry`),
      { method: 'POST' },
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(detail || `重试失败 (${res.status})`);
    }
    const data = await res.json() as ImportDigestProgress;
    digestProgress.value = data;
    startDigestProgressStream(agentId, jobId);
  } catch (err) {
    Message.error(err instanceof Error ? err.message : '重试失败');
  } finally {
    isRetryingDigest.value = false;
  }
}

async function handleImport() {
  if (!selectedAgentId.value) {
    Message.warning('请选择智能体');
    return;
  }
  if (!fileContent.value.trim()) {
    Message.warning('请选择聊天记录文件');
    return;
  }

  isImporting.value = true;
  let hasMessages = false;
  try {
    const checkRes = await fetch(
      getFullUrl(`/api/v1/chat/agents/${selectedAgentId.value}/messages?userId=${encodeURIComponent(chatStore.userId)}`)
    );
    if (checkRes.ok) {
      const messages = await checkRes.json();
      if (Array.isArray(messages) && messages.length > 0) {
        hasMessages = true;
      }
    }
  } catch (err) {
    console.error('Check existing messages failed', err);
  }

  if (hasMessages) {
    isImporting.value = false;
    Modal.confirm({
      title: '覆盖确认',
      content: '该智能体当前已存在对话记录。导入新记录前将清空现有所有对话记录，以及由旧对话整理出的意识流、事实、种子和时间镜像，再从新记录重新整理，是否继续？',
      okText: '确认并清空导入',
      cancelText: '取消',
      onOk: async () => {
        await executeImport(true);
      },
    });
  } else {
    await executeImport(false);
  }
}

async function executeImport(shouldClear: boolean) {
  isImporting.value = true;
  try {
    if (shouldClear) {
      const clearRes = await fetch(
        getFullUrl(`/api/v1/chat/agents/${selectedAgentId.value}/threads/clear-all?userId=${encodeURIComponent(chatStore.userId)}`),
        { method: 'POST' }
      );
      if (!clearRes.ok) {
        throw new Error('清空现有对话记录失败');
      }
    }

    const res = await fetch(getFullUrl(`/api/v1/chat/agents/${selectedAgentId.value}/import-history`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: chatStore.userId,
        content: buildRangedImportContent(fileContent.value),
        importRange: selectedImportRange.value,
        digestAfterImport: true,
        maxDigestTurns: selectedDigestBatchSize.value,
        resetMemoryBeforeImport: shouldClear,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(detail || `导入失败 (${res.status})`);
    }
    const result = await res.json();
    importResultSummary.value = {
      importedMessages: result.importedMessages || 0,
      importedTurns: result.importedTurns || 0,
      skippedOutOfRange: Math.max(result.skippedOutOfRange || 0, parsedPreview.value.skippedOutOfRange || 0),
      digestScheduled: Boolean(result.digestScheduled),
    };
    importProgressVisible.value = true;
    if (result.digestScheduled && result.digestJobId && selectedAgentId.value) {
      startDigestProgressStream(selectedAgentId.value, result.digestJobId);
    } else {
      closeDigestEventSource();
      digestProgress.value = null;
    }
    await chatStore.loadConversations();
    if (result.threadId) {
      await chatStore.selectConversation(String(result.threadId));
    }
    const digestText = result.digestScheduled ? '，后台将继续整理长期记忆' : '';
    Message.success(`已导入 ${result.importedMessages || 0} 条消息${digestText}`);
    selectedFileName.value = '';
    selectedFileSize.value = 0;
    fileContent.value = '';
  } catch (err) {
    Message.error(err instanceof Error ? err.message : '导入失败');
  } finally {
    isImporting.value = false;
  }
}

onMounted(async () => {
  await agentsStore.fetchAgents();
  if (!selectedAgentId.value) {
    const defaultAgent = agentsStore.agents.find((agent) => agent.isDefault) || agentsStore.agents[0];
    selectedAgentId.value = defaultAgent?.id;
  }
});

onBeforeUnmount(() => {
  closeDigestEventSource();
});
</script>

<template>
  <div class="chat-history-import">
    <div class="section-header">
      <h3 class="section-title">聊天记录导入</h3>
      <a-button type="primary" size="small" :disabled="!canImport" :loading="isImporting" @click="handleImport">
        确认导入
      </a-button>
    </div>

    <div class="import-panel">
      <div class="import-row">
        <div class="row-label">
          <span class="main-text">选择智能体</span>
          <span class="sub-text">导入内容会进入该智能体与当前用户的聊天线程</span>
        </div>
        <div class="row-action">
          <a-select
            v-model="selectedAgentId"
            :options="agentOptions"
            :loading="agentsStore.isLoading"
            placeholder="选择智能体"
            :style="{ width: '240px' }"
          >
            <template #prefix><IconRobot /></template>
          </a-select>
        </div>
      </div>

      <div class="import-row import-row--file">
        <div class="row-label">
          <span class="main-text">选择 JSON 文件</span>
          <span class="sub-text">按 userType 识别用户和 AI，并保留原始时间</span>
        </div>
        <div class="row-action file-action">
          <a-select
            v-model="selectedImportRange"
            :options="importRangeOptions"
            size="small"
            :style="{ width: '128px' }"
          />
          <label class="file-picker">
            <input type="file" accept=".json,application/json" @change="handleFileChange" />
            <IconUpload />
            <span>选择文件</span>
          </label>
        </div>
      </div>

      <div class="import-row">
        <div class="row-label">
          <span class="main-text">整理批大小</span>
          <span class="sub-text">每次海马体 LLM 处理的对话回合数，默认 100</span>
        </div>
        <div class="row-action">
          <a-select
            v-model="selectedDigestBatchSize"
            :options="digestBatchOptions"
            :style="{ width: '128px' }"
          />
        </div>
      </div>
    </div>

    <div v-if="selectedFileName" class="file-summary">
      <div class="file-icon"><IconFile /></div>
      <div class="file-meta">
        <div class="file-name">{{ selectedFileName }}</div>
        <div class="file-detail">
          {{ formatFileSize(selectedFileSize) }} · JSON · 范围内用户 {{ parsedPreview.userCount }} 段 · AI {{ parsedPreview.aiCount }} 段
        </div>
        <div v-if="parsedPreview.skippedOutOfRange" class="file-detail">
          已按当前范围跳过 {{ parsedPreview.skippedOutOfRange }} 条较早消息
        </div>
        <div v-if="parsedPreview.timeRange" class="file-detail">
          {{ parsedPreview.timeRange }}
        </div>
      </div>
    </div>

    <div class="format-sample">
      <div class="sample-title">文件格式</div>
      <div class="sample-note">仅支持 JSON 数组。userType=1 表示用户，userType=2 表示 AI；timestamp 会作为聊天时间写入。</div>

      <div class="sample-block">
        <div class="sample-label">JSON 文件示例</div>
        <pre class="sample-code">[
  {
    "timestamp": 1757777576,
    "timeStr": "2025/9/13 23:32:56",
    "sender": "用户",
    "userType": 1,
    "content": "今天发生了一件事……"
  },
  {
    "timestamp": 1757777586,
    "sender": "AI",
    "userType": 2,
    "content": "我在听，你慢慢说。"
  }
]
        </pre>
      </div>
    </div>

    <a-modal
      v-model:visible="importProgressVisible"
      :footer="false"
      :mask-closable="false"
      :esc-to-close="isDigestTerminal"
      :closable="isDigestTerminal"
      width="420px"
      modal-class="import-progress-modal"
      @cancel="closeImportProgressModal"
    >
      <template #title>聊天记录导入</template>
      <div class="progress-modal-body">
        <div class="progress-status-row">
          <span class="progress-status">{{ digestStatusText }}</span>
          <span class="progress-count">{{ digestProgressCountText }}</span>
        </div>
        <div class="progress-track" :class="digestProgressClass">
          <div class="progress-fill" :style="{ width: digestProgressWidth }" />
        </div>
        <div class="progress-percent-text">{{ digestProgressPercentText }}%</div>
        <div class="progress-detail">
          已导入 {{ importResultSummary.importedMessages }} 条消息，{{ importResultSummary.importedTurns }} 个对话回合。
        </div>
        <div v-if="importResultSummary.skippedOutOfRange" class="progress-detail">
          已按数据范围跳过 {{ importResultSummary.skippedOutOfRange }} 条较早消息。
        </div>
        <div v-if="digestProgress?.message" class="progress-detail">
          {{ digestProgress.message }}
        </div>
        <div v-if="digestProgress?.error" class="progress-error">
          {{ digestProgress.error }}
        </div>
        <div class="progress-actions">
          <a-button
            v-if="canRetryDigest"
            type="primary"
            size="small"
            :loading="isRetryingDigest"
            @click="retryDigestJob"
          >
            {{ retryDigestLabel }}
          </a-button>
          <a-button size="small" :disabled="!isDigestTerminal" @click="closeImportProgressModal">知道了</a-button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.chat-history-import {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
}

.section-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.import-panel,
.format-sample,
.file-summary {
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 12px;
}

.import-panel {
  padding: 4px 0;
}

.import-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--border-color);
}

.import-row:last-child {
  border-bottom: none;
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.main-text {
  font-size: 14px;
  color: var(--text-primary);
}

.sub-text {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary);
}

.row-action {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.file-action {
  gap: 12px;
}

.file-picker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--color-primary);
  border-radius: 6px;
  color: var(--color-primary);
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.2s;
}

.file-picker:hover {
  background-color: var(--color-primary-light-1);
}

.file-picker input {
  display: none;
}

.file-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
}

.file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  color: var(--color-primary);
  background-color: var(--color-primary-light-1);
  flex-shrink: 0;
}

.file-meta {
  min-width: 0;
}

.file-name {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-detail {
  margin-top: 3px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.format-sample {
  padding: 16px;
}

.sample-title {
  margin-bottom: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.sample-note {
  margin-bottom: 14px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.5;
}

.sample-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sample-block + .sample-block {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border-color);
}

.sample-label {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}

.sample-code {
  margin: 0;
  padding: 14px;
  border-radius: 8px;
  background-color: var(--bg-chat-window);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.progress-modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.progress-status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.progress-status {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
}

.progress-count,
.progress-detail {
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.5;
}

.progress-track {
  position: relative;
  width: 100%;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
}

.progress-fill {
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--color-primary), #65d6ad);
  box-shadow: 0 0 12px rgba(64, 158, 255, 0.35);
  transition: width 0.28s ease;
}

.progress-track--success .progress-fill {
  background: linear-gradient(90deg, #2fbf71, #78e0a3);
}

.progress-track--danger .progress-fill {
  background: linear-gradient(90deg, var(--color-danger), #ff9a8a);
}

.progress-percent-text {
  margin-top: -8px;
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: right;
}

.progress-error {
  color: var(--color-danger);
  font-size: 12px;
  line-height: 1.5;
}

.progress-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}

@media (max-width: 760px) {
  .import-row {
    align-items: stretch;
    flex-direction: column;
    gap: 12px;
  }

  .row-action,
  .row-action :deep(.arco-select) {
    width: 100%;
  }

  .file-picker {
    width: 100%;
  }
}
</style>
