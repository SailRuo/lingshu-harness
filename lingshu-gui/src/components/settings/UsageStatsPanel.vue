<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Message from '@arco-design/web-vue/es/message';
import Modal from '@arco-design/web-vue/es/modal';
import IconRefresh from '@arco-design/web-vue/es/icon/icon-refresh';
import IconDelete from '@arco-design/web-vue/es/icon/icon-delete';
import IconBarChart from '@arco-design/web-vue/es/icon/icon-bar-chart';
import { getApiBaseUrl } from '../../utils/apiConfig';

interface DailyTokenItem {
  date: string;
  model: string;
  dimension: string;
  inputCached: number;
  inputUncached: number;
  output: number;
  total: number;
  calls: number;
}

interface DailyTtsItem {
  date: string;
  provider: string;
  chars: number;
  calls: number;
}

interface UsageTotals {
  cached: number;
  uncached: number;
  output: number;
  total: number;
  calls: number;
  ttsChars: number;
  ttsCalls: number;
}

interface UsageBucket extends UsageTotals {
  key: string;
  start: string;
  end: string;
}

interface ModelOption {
  value: string;
  label: string;
  type: 'llm' | 'tts';
}

interface ModelRow {
  name: string;
  type: 'chat' | 'memory' | 'tts';
  calls: number;
  cached: number;
  uncached: number;
  output: number;
  amount: number;
  unit: 'Tokens' | '字符';
  sharePct: number;
}

type PresetKey = 'today' | '7d' | '30d' | 'month' | 'custom';
type UsageDimension = 'chat' | 'memory';
type KindFilter = 'all' | 'chat' | 'memory' | 'tts';

const loading = ref(false);
const loaded = ref(false);
const resetting = ref(false);
const tokenDaily = ref<DailyTokenItem[]>([]);
const ttsDaily = ref<DailyTtsItem[]>([]);

const activePreset = ref<PresetKey>('today');
const kindFilter = ref<KindFilter>('all');
const selectedModel = ref<string>('all');
const activeBucketKey = ref<string | null>(null);

const presetOptions: Array<{ key: PresetKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'month', label: '本月' },
  { key: 'custom', label: '自定义' },
];

const kindOptions: Array<{ key: KindFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'chat', label: '对话' },
  { key: 'memory', label: '记忆' },
  { key: 'tts', label: '语音合成' },
];

const showTokens = computed(() => kindFilter.value !== 'tts');
const showTts = computed(() => kindFilter.value === 'all' || kindFilter.value === 'tts');

/** 历史数据只有 total；统一归入“对话”，新数据按 chat / memory 落库。 */
function normalizeDimension(value: string | null | undefined): UsageDimension {
  return value === 'memory' ? 'memory' : 'chat';
}

// ---------- 本地日期工具（避免 toISOString 带来的时区偏移） ----------
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year || 1970, (month || 1) - 1, day || 1);
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + amount);
  return next;
}

function dayDiff(start: string, end: string): number {
  const a = parseDateKey(start);
  const b = parseDateKey(end);
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
      - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000,
  );
}

function monthDay(key: string): string {
  if (!key || key.length < 10) return key;
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatDateHuman(key: string, withWeekday = false): string {
  const date = parseDateKey(key);
  const now = new Date();
  const yearPrefix = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  const base = `${yearPrefix}${date.getMonth() + 1}月${date.getDate()}日`;
  return withWeekday ? `${base} ${WEEKDAY_LABELS[date.getDay()]}` : base;
}

// ---------- 时间范围 ----------
const customRange = ref<[string, string]>([
  dateKey(addDays(new Date(), -29)),
  dateKey(new Date()),
]);

const isCustomRange = computed(() => activePreset.value === 'custom');

const currentRange = computed<{ start: string; end: string }>(() => {
  const now = new Date();
  switch (activePreset.value) {
    case 'today': {
      const key = dateKey(now);
      return { start: key, end: key };
    }
    case '7d':
      return { start: dateKey(addDays(now, -6)), end: dateKey(now) };
    case 'month':
      return {
        start: dateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
        end: dateKey(now),
      };
    case 'custom': {
      const [rawStart, rawEnd] = customRange.value;
      if (!rawStart || !rawEnd) {
        return { start: dateKey(addDays(now, -29)), end: dateKey(now) };
      }
      return rawStart <= rawEnd
        ? { start: rawStart, end: rawEnd }
        : { start: rawEnd, end: rawStart };
    }
    case '30d':
    default:
      return { start: dateKey(addDays(now, -29)), end: dateKey(now) };
  }
});

const rangeDays = computed(() => Math.max(1, dayDiff(currentRange.value.start, currentRange.value.end) + 1));
const isSingleDay = computed(() => rangeDays.value === 1);

const rangeLabel = computed(() => {
  const { start, end } = currentRange.value;
  if (start === end) return formatDateHuman(start);
  return `${formatDateHuman(start)} – ${formatDateHuman(end)}`;
});

const rangeSummary = computed(() => {
  if (activePreset.value === 'today') return '今天';
  if (activePreset.value === 'month') return '本月';
  return `${rangeDays.value} 天`;
});

const granularityLabel = computed(() => {
  if (rangeDays.value === 1) return '单日';
  return rangeDays.value > 31 ? '按周汇总' : '按日汇总';
});

const previousRange = computed(() => {
  const length = rangeDays.value;
  const previousEnd = addDays(parseDateKey(currentRange.value.start), -1);
  const previousStart = addDays(previousEnd, -(length - 1));
  return { start: dateKey(previousStart), end: dateKey(previousEnd) };
});

const rangeShortcuts = [
  { label: '今天', value: () => [new Date(), new Date()] },
  { label: '近 7 天', value: () => [addDays(new Date(), -6), new Date()] },
  { label: '近 30 天', value: () => [addDays(new Date(), -29), new Date()] },
  {
    label: '本月',
    value: () => {
      const now = new Date();
      return [new Date(now.getFullYear(), now.getMonth(), 1), now];
    },
  },
];

function disabledRangeDate(current: Date): boolean {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const earliest = addDays(new Date(), -179);
  earliest.setHours(0, 0, 0, 0);
  return current.getTime() > today.getTime() || current.getTime() < earliest.getTime();
}

function selectPreset(key: PresetKey) {
  activePreset.value = key;
  activeBucketKey.value = null;
}

function handleCustomRangeChange(value: Array<string | number | Date | undefined> | undefined) {
  if (!Array.isArray(value) || value.length < 2) return;
  const start = String(value[0] ?? '');
  const end = String(value[1] ?? '');
  if (!start || !end) return;
  customRange.value = start <= end ? [start, end] : [end, start];
  activeBucketKey.value = null;
}

// ---------- 筛选 ----------
const scopedTokenRows = computed(() => {
  if (!showTokens.value) return [];
  return tokenDaily.value.filter((row) => {
    if (selectedModel.value !== 'all' && row.model !== selectedModel.value) return false;
    if (kindFilter.value === 'all') return true;
    return normalizeDimension(row.dimension) === kindFilter.value;
  });
});

const scopedTtsRows = computed(() => {
  if (!showTts.value) return [];
  return ttsDaily.value.filter(
    (row) => selectedModel.value === 'all' || row.provider === selectedModel.value,
  );
});

const modelsInRange = computed(() => {
  if (!showTokens.value) return [];
  const { start, end } = currentRange.value;
  const set = new Set<string>();
  for (const row of tokenDaily.value) {
    if (row.date < start || row.date > end) continue;
    if (kindFilter.value !== 'all' && normalizeDimension(row.dimension) !== kindFilter.value) continue;
    set.add(row.model);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
});

const ttsProvidersInRange = computed(() => {
  if (!showTts.value) return [];
  const { start, end } = currentRange.value;
  const set = new Set<string>();
  for (const row of ttsDaily.value) {
    if (row.date >= start && row.date <= end) set.add(row.provider);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
});

const modelOptions = computed<ModelOption[]>(() => [
  ...modelsInRange.value.map((model) => ({ value: model, label: model, type: 'llm' as const })),
  ...ttsProvidersInRange.value.map((provider) => ({ value: provider, label: provider, type: 'tts' as const })),
]);

watch(modelOptions, (options) => {
  if (selectedModel.value === 'all') return;
  if (!options.some((option) => option.value === selectedModel.value)) {
    selectedModel.value = 'all';
  }
});

function selectKind(key: KindFilter) {
  if (hasDraggedGlobal) return;
  if (kindFilter.value === key) return;
  kindFilter.value = key;
  selectedModel.value = 'all';
  activeBucketKey.value = null;
}

function selectModel(model: string) {
  if (hasDraggedGlobal) return;
  selectedModel.value = model;
  activeBucketKey.value = null;
}

// ---------- 聚合 ----------
function emptyTotals(): UsageTotals {
  return { cached: 0, uncached: 0, output: 0, total: 0, calls: 0, ttsChars: 0, ttsCalls: 0 };
}

function aggregateRange(start: string, end: string): UsageTotals {
  const totals = emptyTotals();
  for (const row of scopedTokenRows.value) {
    if (row.date < start || row.date > end) continue;
    totals.cached += Number(row.inputCached) || 0;
    totals.uncached += Number(row.inputUncached) || 0;
    totals.output += Number(row.output) || 0;
    totals.total += Number(row.total) || 0;
    totals.calls += Number(row.calls) || 0;
  }
  for (const row of scopedTtsRows.value) {
    if (row.date < start || row.date > end) continue;
    totals.ttsChars += Number(row.chars) || 0;
    totals.ttsCalls += Number(row.calls) || 0;
  }
  return totals;
}

const currentTotals = computed(() => aggregateRange(currentRange.value.start, currentRange.value.end));
const previousTotals = computed(() => aggregateRange(previousRange.value.start, previousRange.value.end));

const inputTotal = computed(() => currentTotals.value.cached + currentTotals.value.uncached);
const hasAnyData = computed(() => currentTotals.value.total > 0 || currentTotals.value.ttsChars > 0);

const cacheRate = computed<number | null>(() => {
  if (inputTotal.value <= 0) return null;
  return (currentTotals.value.cached / inputTotal.value) * 100;
});

const cacheRateText = computed(() => (cacheRate.value === null ? '—' : `${cacheRate.value.toFixed(1)}%`));


const outputPerCall = computed(() => {
  if (currentTotals.value.calls <= 0) return 0;
  return Math.round(currentTotals.value.output / currentTotals.value.calls);
});

const ttsAvgChars = computed(() => {
  if (currentTotals.value.ttsCalls <= 0) return 0;
  return Math.round(currentTotals.value.ttsChars / currentTotals.value.ttsCalls);
});

const ttsTopProvider = computed(() => {
  const { start, end } = currentRange.value;
  const totals = new Map<string, number>();
  for (const row of scopedTtsRows.value) {
    if (row.date < start || row.date > end) continue;
    totals.set(row.provider, (totals.get(row.provider) || 0) + (Number(row.chars) || 0));
  }
  let name = '';
  let chars = 0;
  for (const [provider, amount] of totals) {
    if (amount > chars) {
      name = provider;
      chars = amount;
    }
  }
  return { name, chars };
});

function percentDelta(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}

const tokenDelta = computed(() => percentDelta(currentTotals.value.total, previousTotals.value.total));
const ttsDelta = computed(() => percentDelta(currentTotals.value.ttsChars, previousTotals.value.ttsChars));

function deltaText(value: number | null): string {
  if (value === null) return '上期无数据';
  if (Math.abs(value) < 0.05) return '与上期持平';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function deltaArrow(value: number | null): string {
  if (value === null) return '·';
  if (value > 0.05) return '↑';
  if (value < -0.05) return '↓';
  return '→';
}

function deltaSentence(value: number | null): string {
  if (value === null) return '上期无数据';
  if (Math.abs(value) < 0.05) return '与上期持平';
  return `较上期 ${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

// ---------- 图表分桶 ----------
function createBucket(start: string, end: string): UsageBucket {
  return { key: start, start, end, ...emptyTotals() };
}

const buckets = computed<UsageBucket[]>(() => {
  const { start, end } = currentRange.value;
  const totalDays = dayDiff(start, end) + 1;
  const chunkSize = totalDays <= 31 ? 1 : 7;
  const list: UsageBucket[] = [];
  const lastDate = parseDateKey(end);
  let cursor = parseDateKey(start);

  while (cursor <= lastDate) {
    let bucketEnd = addDays(cursor, chunkSize - 1);
    if (bucketEnd > lastDate) bucketEnd = lastDate;
    list.push(createBucket(dateKey(cursor), dateKey(bucketEnd)));
    cursor = addDays(cursor, chunkSize);
  }

  const dayMap = new Map<string, UsageBucket>();
  for (const bucket of list) {
    const bucketEnd = parseDateKey(bucket.end);
    let day = parseDateKey(bucket.start);
    while (day <= bucketEnd) {
      dayMap.set(dateKey(day), bucket);
      day = addDays(day, 1);
    }
  }

  for (const row of scopedTokenRows.value) {
    const bucket = dayMap.get(row.date);
    if (!bucket) continue;
    bucket.cached += Number(row.inputCached) || 0;
    bucket.uncached += Number(row.inputUncached) || 0;
    bucket.output += Number(row.output) || 0;
    bucket.total += Number(row.total) || 0;
    bucket.calls += Number(row.calls) || 0;
  }
  for (const row of scopedTtsRows.value) {
    const bucket = dayMap.get(row.date);
    if (!bucket) continue;
    bucket.ttsChars += Number(row.chars) || 0;
    bucket.ttsCalls += Number(row.calls) || 0;
  }

  return list;
});

const hasBucketTokenData = computed(() => buckets.value.some((bucket) => bucket.total > 0));
const hasBucketTtsData = computed(() => buckets.value.some((bucket) => bucket.ttsChars > 0));

function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const normalized = raw / base;
  let step = 1;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 2.5) step = 2.5;
  else if (normalized <= 5) step = 5;
  else step = 10;
  return step * base;
}

const tokenAxisMax = computed(() => {
  const max = Math.max(0, ...buckets.value.map((bucket) => bucket.total));
  if (max <= 0) return 1;
  return niceStep(max / 4) * 4;
});

const axisTicks = computed(() => [1, 0.75, 0.5, 0.25, 0].map((ratio) => ({
  ratio,
  value: tokenAxisMax.value * ratio,
})));

function barHeightPct(bucket: UsageBucket): number {
  if (bucket.total <= 0) return 0;
  return Math.max(2, (bucket.total / tokenAxisMax.value) * 100);
}

const ttsAxisMax = computed(() => {
  const max = Math.max(0, ...buckets.value.map((bucket) => bucket.ttsChars));
  if (max <= 0) return 1;
  return niceStep(max / 2) * 2;
});

function ttsBarHeightPct(bucket: UsageBucket): number {
  if (bucket.ttsChars <= 0) return 0;
  return Math.max(3, (bucket.ttsChars / ttsAxisMax.value) * 100);
}

const xLabelStep = computed(() => (
  buckets.value.length > 18
    ? Math.max(1, Math.ceil(buckets.value.length / 12))
    : 1
));
function showXLabel(index: number): boolean {
  return index === 0
    || index === buckets.value.length - 1
    || index % xLabelStep.value === 0;
}

const activeBucket = computed<UsageBucket | null>(() => {
  const found = buckets.value.find((bucket) => bucket.key === activeBucketKey.value);
  if (found) return found;
  const lastWithData = [...buckets.value]
    .reverse()
    .find((bucket) => bucket.total > 0 || bucket.ttsChars > 0);
  return lastWithData || buckets.value[buckets.value.length - 1] || null;
});

function bucketFullLabel(bucket: UsageBucket): string {
  if (bucket.start === bucket.end) return formatDateHuman(bucket.start, true);
  return `${formatDateHuman(bucket.start)} – ${formatDateHuman(bucket.end)}`;
}

function tickStyle(ratio: number) {
  const top = (1 - ratio) * 100;
  const transform = ratio === 1
    ? 'translateY(0)'
    : ratio === 0
      ? 'translateY(-100%)'
      : 'translateY(-50%)';
  return { top: `${top}%`, transform };
}

function bucketAriaLabel(bucket: UsageBucket): string {
  const parts = [formatDateHuman(bucket.start, true)];
  if (showTokens.value) {
    parts.push(`总 Token ${formatToken(bucket.total)}`);
    parts.push(`缓存命中 ${formatCacheRate(bucket.cached, bucket.uncached)}`);
  }
  if (showTts.value && bucket.ttsChars > 0) {
    parts.push(`TTS ${formatToken(bucket.ttsChars)} 字符`);
  }
  return parts.join('，');
}

// ---------- 单日构成 ----------
const compositionItems = computed(() => {
  const total = currentTotals.value.total;
  return [
    { key: 'cached', label: '输入 · 命中缓存', value: currentTotals.value.cached },
    { key: 'uncached', label: '输入 · 未命中', value: currentTotals.value.uncached },
    { key: 'output', label: '模型输出', value: currentTotals.value.output },
  ].map((item) => ({
    ...item,
    pct: total > 0 ? (item.value / total) * 100 : 0,
  }));
});

const visibleCompositionItems = computed(() => compositionItems.value.filter((item) => item.value > 0));

// ---------- 按模型 / 服务商 ----------
const modelRows = computed<ModelRow[]>(() => {
  const { start, end } = currentRange.value;
  const map = new Map<string, ModelRow>();
  const amountTotals = new Map<ModelRow['type'], number>();

  for (const row of scopedTokenRows.value) {
    if (row.date < start || row.date > end) continue;
    const dimension = normalizeDimension(row.dimension);
    const key = `${dimension}:${row.model}`;
    const item: ModelRow = map.get(key) ?? {
      name: row.model,
      type: dimension,
      calls: 0,
      cached: 0,
      uncached: 0,
      output: 0,
      amount: 0,
      unit: 'Tokens',
      sharePct: 0,
    };
    item.calls += Number(row.calls) || 0;
    item.cached += Number(row.inputCached) || 0;
    item.uncached += Number(row.inputUncached) || 0;
    item.output += Number(row.output) || 0;
    item.amount += Number(row.total) || 0;
    amountTotals.set(dimension, (amountTotals.get(dimension) || 0) + (Number(row.total) || 0));
    map.set(key, item);
  }

  for (const row of scopedTtsRows.value) {
    if (row.date < start || row.date > end) continue;
    const key = `tts:${row.provider}`;
    const item: ModelRow = map.get(key) ?? {
      name: row.provider,
      type: 'tts',
      calls: 0,
      cached: 0,
      uncached: 0,
      output: 0,
      amount: 0,
      unit: '字符',
      sharePct: 0,
    };
    item.calls += Number(row.calls) || 0;
    item.amount += Number(row.chars) || 0;
    amountTotals.set('tts', (amountTotals.get('tts') || 0) + (Number(row.chars) || 0));
    map.set(key, item);
  }

  const rows = [...map.values()];
  for (const row of rows) {
    const total = amountTotals.get(row.type) || 0;
    row.sharePct = total > 0 ? (row.amount / total) * 100 : 0;
  }

  const typeOrder: Record<ModelRow['type'], number> = { chat: 0, memory: 1, tts: 2 };
  return rows.sort((a, b) => {
    if (a.type !== b.type) return typeOrder[a.type] - typeOrder[b.type];
    return b.amount - a.amount;
  });
});

const showBreakdown = computed(() => selectedModel.value === 'all' && modelRows.value.length > 0);

// ---------- 格式化 ----------
const numberFormatter = new Intl.NumberFormat('zh-CN');

function formatToken(value: number): string {
  return numberFormatter.format(Math.round(Number(value) || 0));
}

function formatCompact(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1000000) {
    const digits = absolute >= 10000000 ? 0 : 1;
    return `${(value / 1000000).toFixed(digits).replace(/\.0$/, '')}M`;
  }
  if (absolute >= 1000) {
    const digits = absolute >= 100000 ? 0 : 1;
    return `${(value / 1000).toFixed(digits).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(value));
}

/** KPI 大数字使用 K / M 缩写，完整数值放在 title 中。 */
function formatCompactAmount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1000000) {
    return `${(value / 1000000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (absolute >= 10000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return formatToken(value);
}

function formatCacheRate(cached: number, uncached: number): string {
  const input = cached + uncached;
  if (input <= 0) return '—';
  return `${((cached / input) * 100).toFixed(1)}%`;
}

function typeLabel(type: ModelRow['type']): string {
  if (type === 'tts') return '语音合成';
  if (type === 'memory') return '记忆';
  return '对话';
}

const chartTitle = computed(() => {
  if (isSingleDay.value) {
    if (!showTokens.value) return '今日语音合成';
    return activePreset.value === 'today' ? '今日用量构成' : '单日用量构成';
  }
  return showTokens.value ? '用量趋势' : '语音合成用量';
});

const emptyTitle = computed(() => (activePreset.value === 'today' ? '今天还没有用量记录' : '该时间范围内暂无用量记录'));
const emptyHint = '产生对话、记忆或语音合成用量后，会自动汇总到这里。';

// ---------- 数据读取 ----------
async function fetchStats() {
  loading.value = true;
  try {
    const url = new URL('/api/v1/usage/stats?days=180', getApiBaseUrl()).toString();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tokenDaily.value = Array.isArray(data.tokenDaily) ? data.tokenDaily : [];
    ttsDaily.value = Array.isArray(data.ttsDaily) ? data.ttsDaily : [];
  } catch (err) {
    Message.error(err instanceof Error ? `读取用量失败: ${err.message}` : '读取用量失败');
  } finally {
    loading.value = false;
    loaded.value = true;
  }
}

function handleResetStats() {
  Modal.confirm({
    title: '重置用量统计',
    content: '确定重置当前的对话、记忆与语音合成用量统计吗？这不会删除聊天记录、记忆或底层调用审计日志。',
    okText: '确定重置',
    cancelText: '取消',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      resetting.value = true;
      try {
        const url = new URL('/api/v1/usage/reset', getApiBaseUrl()).toString();
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clearToken: true, clearTts: true }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        Message.success('用量统计已重置');
        await fetchStats();
      } catch (err) {
        Message.error(err instanceof Error ? `重置失败: ${err.message}` : '重置失败');
      } finally {
        resetting.value = false;
      }
    },
  });
}

// ---------- 横向拖动筛选条 ----------
let hasDraggedGlobal = false;

const vDragScroll = {
  mounted(el: HTMLElement) {
    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;

    const onMouseDown = (event: MouseEvent) => {
      isDown = true;
      hasDraggedGlobal = false;
      startX = event.clientX;
      scrollLeft = el.scrollLeft;
      el.style.cursor = 'grabbing';
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!isDown) return;
      event.preventDefault();
      const deltaX = event.clientX - startX;
      if (Math.abs(deltaX) > 4) hasDraggedGlobal = true;
      el.scrollLeft = scrollLeft - deltaX;
    };

    const onMouseUp = () => {
      if (!isDown) return;
      isDown = false;
      el.style.cursor = 'grab';
      window.setTimeout(() => {
        hasDraggedGlobal = false;
      }, 60);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0 && el.scrollWidth > el.clientWidth) {
        event.preventDefault();
        el.scrollLeft += event.deltaY;
      }
    };

    el.style.cursor = 'grab';
    el.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    (el as any)._cleanup = () => {
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('wheel', onWheel);
    };
  },
  unmounted(el: HTMLElement) {
    (el as any)._cleanup?.();
  },
};

onMounted(() => {
  void fetchStats();
});
</script>

<template>
  <div class="usage-stats-panel" :aria-busy="loading">
    <header class="page-head">
      <div class="head-copy">
        <h2>用量统计</h2>
        <p>模型调用与语音合成的本地用量，按选择的时间范围汇总</p>
      </div>
      <div class="head-tools">
        <div class="range-switch" role="tablist" aria-label="时间范围">
          <button
            v-for="preset in presetOptions"
            :key="preset.key"
            type="button"
            role="tab"
            class="range-tab"
            :class="{ active: activePreset === preset.key }"
            :aria-selected="activePreset === preset.key"
            @click="selectPreset(preset.key)"
          >
            {{ preset.label }}
          </button>
        </div>
        <div class="head-actions">
          <a-tooltip content="刷新数据">
            <a-button
              class="refresh-btn"
              shape="circle"
              size="small"
              :loading="loading"
              aria-label="刷新数据"
              @click="fetchStats"
            >
              <IconRefresh />
            </a-button>
          </a-tooltip>
          <a-button
            size="small"
            status="danger"
            type="text"
            :loading="resetting"
            @click="handleResetStats"
          >
            <template #icon><IconDelete /></template>
            重置统计
          </a-button>
        </div>
      </div>
    </header>

    <transition name="range-slide">
      <div v-if="isCustomRange" class="custom-range-bar">
        <span class="custom-range-label">自定义范围</span>
        <a-range-picker
          v-model="customRange"
          class="custom-range-picker"
          size="small"
          value-format="YYYY-MM-DD"
          format="YYYY-MM-DD"
          :allow-clear="false"
          :shortcuts="rangeShortcuts"
          :disabled-date="disabledRangeDate"
          @change="handleCustomRangeChange"
        />
        <span class="custom-range-hint">最近 180 天可选，跨度超过 31 天时自动按周汇总</span>
      </div>
    </transition>

    <div v-if="!loaded" class="usage-loading">
      <a-spin />
      <span>正在读取用量数据…</span>
    </div>

    <template v-else>
      <!-- KPI 总览 -->
      <section v-if="showTokens && !isSingleDay" class="kpi-grid">
        <article class="kpi-card is-total">
          <div class="kpi-top">
            <span class="kpi-label">总消耗</span>
            <span class="delta-chip" :title="`对比 ${previousRange.start} 至 ${previousRange.end}`">
              <template v-if="tokenDelta === null">上期无数据</template>
              <template v-else-if="Math.abs(tokenDelta) < 0.05">与上期持平</template>
              <template v-else>
                <span class="delta-arrow">{{ deltaArrow(tokenDelta) }}</span>
                {{ deltaText(tokenDelta) }}
                <span class="delta-caption">较上期</span>
              </template>
            </span>
          </div>
          <div class="kpi-value">
            <strong :title="formatToken(currentTotals.total)">{{ formatCompactAmount(currentTotals.total) }}</strong>
            <span class="unit">Tokens</span>
          </div>
          <div v-if="currentTotals.total > 0" class="mini-stack" aria-hidden="true">
            <span
              v-if="currentTotals.cached > 0"
              class="mini-seg cached"
              :style="{ width: `${(currentTotals.cached / currentTotals.total) * 100}%` }"
            />
            <span
              v-if="currentTotals.uncached > 0"
              class="mini-seg uncached"
              :style="{ width: `${(currentTotals.uncached / currentTotals.total) * 100}%` }"
            />
            <span
              v-if="currentTotals.output > 0"
              class="mini-seg output"
              :style="{ width: `${(currentTotals.output / currentTotals.total) * 100}%` }"
            />
          </div>
          <div v-if="currentTotals.total > 0" class="kpi-meta composition-legend">
            <span><i class="legend-dot cached" />命中 {{ formatCompactAmount(currentTotals.cached) }}</span>
            <span><i class="legend-dot uncached" />未命中 {{ formatCompactAmount(currentTotals.uncached) }}</span>
            <span><i class="legend-dot output" />输出 {{ formatCompactAmount(currentTotals.output) }}</span>
          </div>
        </article>

        <article class="kpi-card">
          <span class="kpi-label">输入缓存命中率</span>
          <div class="kpi-value">
            <strong>{{ cacheRateText }}</strong>
            <span class="unit">命中率</span>
          </div>
          <div v-if="inputTotal > 0" class="split-meter cache-meter" aria-hidden="true">
            <span class="mini-seg cached" :style="{ width: `${cacheRate || 0}%` }" />
            <span class="mini-seg uncached" :style="{ width: `${100 - (cacheRate || 0)}%` }" />
          </div>
          <div class="kpi-meta">输入共 {{ formatCompactAmount(inputTotal) }} Tokens</div>
        </article>

        <article class="kpi-card">
          <span class="kpi-label">输出与调用</span>
          <div class="kpi-value">
            <strong :title="formatToken(currentTotals.output)">{{ formatCompactAmount(currentTotals.output) }}</strong>
            <span class="unit">Tokens</span>
          </div>
          <div class="kpi-meta">平均 {{ formatToken(outputPerCall) }} Tokens/次</div>
          <div class="kpi-meta secondary-meta">
            <span>调用 {{ formatToken(currentTotals.calls) }} 次</span>
            <span v-if="showTts && currentTotals.ttsCalls > 0">
              TTS {{ formatToken(currentTotals.ttsCalls) }} 次 · {{ formatCompactAmount(currentTotals.ttsChars) }} 字符
            </span>
          </div>
        </article>
      </section>

      <section v-else-if="!showTokens && !isSingleDay" class="kpi-grid tts-kpis">
        <article class="kpi-card is-total">
          <span class="kpi-label">合成字符</span>
          <div class="kpi-value">
            <strong :title="formatToken(currentTotals.ttsChars)">{{ formatCompactAmount(currentTotals.ttsChars) }}</strong>
            <span class="unit">字符</span>
          </div>
          <div class="kpi-meta">{{ formatToken(currentTotals.ttsCalls) }} 次合成调用</div>
        </article>
        <article class="kpi-card">
          <span class="kpi-label">平均每次合成</span>
          <div class="kpi-value">
            <strong>{{ formatToken(ttsAvgChars) }}</strong>
            <span class="unit">字符</span>
          </div>
          <div class="kpi-meta">{{ deltaSentence(ttsDelta) }}</div>
        </article>
        <article class="kpi-card">
          <span class="kpi-label">主要服务商</span>
          <div class="kpi-value provider-value">
            <strong :title="ttsTopProvider.name || '暂无'">{{ ttsTopProvider.name || '暂无' }}</strong>
          </div>
          <div class="kpi-meta">
            <span v-if="ttsTopProvider.chars > 0">{{ formatCompactAmount(ttsTopProvider.chars) }} 字符</span>
            <span v-else>当前范围暂无合成记录</span>
          </div>
          <div class="kpi-meta secondary-meta">来自 {{ ttsProvidersInRange.length }} 个服务商</div>
        </article>
      </section>

      <!-- 筛选 -->
      <section class="filter-card">
        <div class="filter-row">
          <span class="filter-key">类型</span>
          <div class="filter-pills">
            <button
              v-for="option in kindOptions"
              :key="option.key"
              type="button"
              class="pill"
              :class="{ active: kindFilter === option.key }"
              @click="selectKind(option.key)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div class="filter-row">
          <span class="filter-key">模型</span>
          <div v-drag-scroll class="filter-pills">
            <button
              type="button"
              class="pill"
              :class="{ active: selectedModel === 'all' }"
              @click="selectModel('all')"
            >
              全部
            </button>
            <button
              v-for="option in modelOptions"
              :key="`${option.type}:${option.value}`"
              type="button"
              class="pill"
              :class="{ active: selectedModel === option.value }"
              :title="option.label"
              @click="selectModel(option.value)"
            >
              {{ option.label }}
              <em v-if="option.type === 'tts'">TTS</em>
            </button>
          </div>
        </div>
      </section>

      <!-- 趋势图表 -->
      <section v-if="hasAnyData" class="panel-card chart-card">
        <header class="card-head">
          <div>
            <h3>{{ chartTitle }}</h3>
            <p>{{ rangeLabel }} · {{ rangeSummary }} · {{ granularityLabel }}</p>
          </div>
          <div v-if="showTokens && hasBucketTokenData && !isSingleDay" class="chart-legend">
            <span class="legend-item"><i class="legend-dot cached" />输入（命中缓存）</span>
            <span class="legend-item"><i class="legend-dot uncached" />输入（未命中缓存）</span>
            <span class="legend-item"><i class="legend-dot output" />输出</span>
            <span v-if="showTts && hasBucketTtsData" class="legend-item"><i class="legend-dot tts" />TTS 字符</span>
          </div>
        </header>

        <div v-if="activeBucket && !isSingleDay" class="chart-inspector">
          <span class="inspector-date">{{ bucketFullLabel(activeBucket) }}</span>
          <span v-if="showTokens" class="inspector-item">
            总 Token <b>{{ formatToken(activeBucket.total) }}</b>
          </span>
          <span v-if="showTokens" class="inspector-item">
            缓存命中 <b>{{ formatCacheRate(activeBucket.cached, activeBucket.uncached) }}</b>
          </span>
          <span v-if="showTokens" class="inspector-item">
            输出 <b>{{ formatToken(activeBucket.output) }}</b>
          </span>
          <span v-if="showTts && activeBucket.ttsChars > 0" class="inspector-item tts">
            TTS <b>{{ formatToken(activeBucket.ttsChars) }}</b> 字符
          </span>
          <span class="inspector-hint">悬浮或聚焦柱状条查看其它时段</span>
        </div>

        <!-- 单日：构成条 -->
        <div v-if="isSingleDay" class="single-day">
          <div v-if="showTokens" class="single-head">
            <span class="single-date">{{ rangeLabel }}</span>
            <strong class="single-total" :title="formatToken(currentTotals.total)">{{ formatCompactAmount(currentTotals.total) }}</strong>
            <span class="single-unit">Tokens</span>
            <span class="single-calls">
              {{ formatToken(currentTotals.calls) }} 次调用 · 平均 {{ formatToken(outputPerCall) }} Tokens/次
            </span>
            <span class="delta-chip single-delta" :title="`对比 ${previousRange.start} 至 ${previousRange.end}`">
              <template v-if="tokenDelta === null">上期无数据</template>
              <template v-else-if="Math.abs(tokenDelta) < 0.05">与上期持平</template>
              <template v-else>
                <span class="delta-arrow">{{ deltaArrow(tokenDelta) }}</span>
                {{ deltaText(tokenDelta) }}
                <span class="delta-caption">较上期</span>
              </template>
            </span>
          </div>
          <div v-else class="single-head">
            <span class="single-date">{{ rangeLabel }}</span>
            <strong class="single-total" :title="formatToken(currentTotals.ttsChars)">{{ formatCompactAmount(currentTotals.ttsChars) }}</strong>
            <span class="single-unit">字符</span>
            <span class="single-calls">
              {{ formatToken(currentTotals.ttsCalls) }} 次合成 · 平均 {{ formatToken(ttsAvgChars) }} 字符/次
            </span>
            <span class="delta-chip single-delta" :title="`对比 ${previousRange.start} 至 ${previousRange.end}`">
              <template v-if="ttsDelta === null">上期无数据</template>
              <template v-else-if="Math.abs(ttsDelta) < 0.05">与上期持平</template>
              <template v-else>
                <span class="delta-arrow">{{ deltaArrow(ttsDelta) }}</span>
                {{ deltaText(ttsDelta) }}
                <span class="delta-caption">较上期</span>
              </template>
            </span>
          </div>
          <template v-if="showTokens && currentTotals.total > 0">
            <div class="comp-track" aria-hidden="true">
              <span
                v-for="item in visibleCompositionItems"
                :key="item.key"
                class="comp-seg"
                :class="item.key"
                :style="{ width: `${item.pct}%` }"
              />
            </div>
            <div class="comp-legend">
              <div v-for="item in visibleCompositionItems" :key="item.key" class="comp-item">
                <span class="comp-item-top">
                  <i class="legend-dot" :class="item.key" />{{ item.label }}
                </span>
                <b :title="formatToken(item.value)">{{ formatCompactAmount(item.value) }}</b>
                <em>{{ item.pct.toFixed(1) }}%</em>
              </div>
            </div>
          </template>
          <div v-else-if="showTokens" class="single-empty">该日暂无 Token 记录</div>
          <div v-if="showTokens && showTts && currentTotals.ttsChars > 0" class="single-tts">
            <span class="single-tts-label">语音合成</span>
            <span><b :title="formatToken(currentTotals.ttsChars)">{{ formatCompactAmount(currentTotals.ttsChars) }}</b> 字符 · {{ formatToken(currentTotals.ttsCalls) }} 次</span>
            <span class="single-tts-delta">{{ deltaSentence(ttsDelta) }}</span>
          </div>
        </div>

        <template v-else>
          <div v-if="showTokens && hasBucketTokenData" class="chart-body">
            <div class="y-axis" aria-hidden="true">
              <span
                v-for="tick in axisTicks"
                :key="tick.ratio"
                class="y-tick"
                :style="tickStyle(tick.ratio)"
              >
                {{ formatCompact(tick.value) }}
              </span>
            </div>
            <div class="chart-main">
              <div class="plot-area">
                <div class="gridlines" aria-hidden="true">
                  <i
                    v-for="tick in axisTicks"
                    :key="tick.ratio"
                    class="gridline"
                    :style="{ top: `${tick.ratio * 100}%` }"
                  />
                </div>
                <div class="bars">
                  <button
                    v-for="bucket in buckets"
                    :key="bucket.key"
                    type="button"
                    class="bar-col"
                    :class="{ active: activeBucket?.key === bucket.key }"
                    :aria-label="bucketAriaLabel(bucket)"
                    @mouseenter="activeBucketKey = bucket.key"
                    @focus="activeBucketKey = bucket.key"
                    @click="activeBucketKey = bucket.key"
                  >
                    <span
                      class="bar"
                      :class="{ 'is-empty': bucket.total === 0 }"
                      :style="bucket.total > 0 ? { height: `${barHeightPct(bucket)}%` } : undefined"
                    >
                      <span v-if="bucket.output > 0" class="seg output" :style="{ flexGrow: bucket.output }" />
                      <span v-if="bucket.uncached > 0" class="seg uncached" :style="{ flexGrow: bucket.uncached }" />
                      <span v-if="bucket.cached > 0" class="seg cached" :style="{ flexGrow: bucket.cached }" />
                    </span>
                  </button>
                </div>
              </div>
              <div class="x-labels" aria-hidden="true">
                <span v-for="(bucket, index) in buckets" :key="bucket.key" class="x-label">
                  {{ showXLabel(index) ? monthDay(bucket.start) : '' }}
                </span>
              </div>
            </div>
          </div>

          <div v-if="showTokens && !hasBucketTokenData && showTts && hasBucketTtsData" class="chart-note">
            该时间范围内没有 Token 记录，仅显示语音合成用量。
          </div>

          <div v-if="showTts && hasBucketTtsData" class="tts-strip" :class="{ 'tts-only': !showTokens }">
            <div class="tts-strip-label">
              <span>TTS 字符</span>
              <b>峰值 {{ formatCompact(ttsAxisMax) }}</b>
            </div>
            <div class="tts-plot-wrap">
              <div class="tts-plot">
                <div class="tts-bars">
                  <button
                    v-for="bucket in buckets"
                    :key="bucket.key"
                    type="button"
                    class="tts-bar-col"
                    :class="{ active: activeBucket?.key === bucket.key }"
                    :aria-label="`TTS ${formatDateHuman(bucket.start, true)}，${formatToken(bucket.ttsChars)} 字符`"
                    @mouseenter="activeBucketKey = bucket.key"
                    @focus="activeBucketKey = bucket.key"
                    @click="activeBucketKey = bucket.key"
                  >
                    <span class="tts-bar" :style="{ height: `${ttsBarHeightPct(bucket)}%` }" />
                  </button>
                </div>
              </div>
              <div v-if="!showTokens" class="x-labels">
                <span v-for="(bucket, index) in buckets" :key="bucket.key" class="x-label">
                  {{ showXLabel(index) ? monthDay(bucket.start) : '' }}
                </span>
              </div>
            </div>
          </div>
        </template>
      </section>

      <section v-else class="panel-card empty-card">
        <div class="empty-icon"><IconBarChart :size="24" /></div>
        <strong>{{ emptyTitle }}</strong>
        <p>{{ emptyHint }}</p>
        <a-button v-if="activePreset !== '30d'" size="small" @click="selectPreset('30d')">查看近 30 天</a-button>
      </section>

      <!-- 按模型 / 服务商 -->
      <section v-if="showBreakdown" class="panel-card breakdown-card">
        <header class="card-head">
          <div>
            <h3>按模型 / 服务商</h3>
            <p>同一类型内的消耗占比，按用量从高到低排列</p>
          </div>
          <div class="breakdown-summary">
            <span v-if="showTokens">Token 合计 <b :title="formatToken(currentTotals.total)">{{ formatCompactAmount(currentTotals.total) }}</b></span>
            <span v-if="showTts && currentTotals.ttsChars > 0">语音 <b :title="formatToken(currentTotals.ttsChars)">{{ formatCompactAmount(currentTotals.ttsChars) }}</b> 字符</span>
          </div>
        </header>
        <div class="table-scroll">
          <table class="usage-table">
            <thead>
              <tr>
                <th>模型 / 服务商</th>
                <th>类型</th>
                <th class="num">调用</th>
                <th v-if="showTokens" class="num">输入缓存</th>
                <th v-if="showTokens" class="num">输入未缓存</th>
                <th v-if="showTokens" class="num">输出</th>
                <th class="num">{{ showTokens ? '合计' : '字符' }}</th>
                <th class="share-col">占比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in modelRows" :key="`${row.type}:${row.name}`">
                <td>
                  <span class="model-name" :title="row.name">{{ row.name }}</span>
                </td>
                <td>
                  <span class="type-tag" :class="row.type">{{ typeLabel(row.type) }}</span>
                </td>
                <td class="num">{{ formatToken(row.calls) }}</td>
                <td v-if="showTokens" class="num">{{ row.type === 'tts' ? '—' : formatToken(row.cached) }}</td>
                <td v-if="showTokens" class="num">{{ row.type === 'tts' ? '—' : formatToken(row.uncached) }}</td>
                <td v-if="showTokens" class="num">{{ row.type === 'tts' ? '—' : formatToken(row.output) }}</td>
                <td class="num amount-cell">
                  {{ formatToken(row.amount) }} <small>{{ row.unit }}</small>
                </td>
                <td class="share-col">
                  <div class="share-wrap">
                    <span class="share-track" aria-hidden="true">
                      <i class="share-fill" :class="{ tts: row.type === 'tts', memory: row.type === 'memory' }" :style="{ width: `${row.sharePct}%` }" />
                    </span>
                    <span class="share-val">{{ row.sharePct.toFixed(1) }}%</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <footer class="usage-footer">
        <span>
          统计自模型与 TTS 服务商返回的 <code>usage</code> 字段；未返回用量的服务不做估算。
        </span>
        <span>数据仅保存在本机。</span>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.usage-stats-panel {
  --usage-card: var(--color-bg-2, #ffffff);
  --usage-border: var(--color-border-2, #e5e6eb);
  --usage-text: var(--color-text-1, #1d2129);
  --usage-text-2: var(--color-text-2, #4e5969);
  --usage-text-3: var(--color-text-3, #86909c);
  --usage-cached: #6fc47a;
  --usage-uncached: #dfa23f;
  --usage-output: #2f8f46;
  --usage-tts: #1fafb6;
  --usage-accent-text: var(--color-primary, #07c160);
  --bar-gap: clamp(3px, 0.45vw, 8px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 0 24px;
}

[data-theme='dark'] .usage-stats-panel {
  --usage-card: var(--color-bg-2, #2a2a2a);
  --usage-border: var(--color-border-2, #3d3d3d);
  --usage-cached: #83d48e;
  --usage-uncached: #e8b45a;
  --usage-output: #4fae5c;
  --usage-tts: #3fc9cf;
  --usage-accent-text: #8ed99a;
}

/* ---------- 页头 ---------- */
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
  padding: 2px 2px 0;
}

.head-copy h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--usage-text);
}

.head-copy p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--usage-text-3);
}

.head-tools {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.range-switch {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 10px;
  border: 1px solid var(--usage-border);
  background: var(--color-fill-2, #f2f3f5);
}

.range-tab {
  border: 0;
  background: transparent;
  padding: 6px 11px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.2;
  color: var(--usage-text-2);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}

.range-tab:hover {
  color: var(--usage-text);
}

.range-tab:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

.range-tab.active {
  background: var(--usage-card);
  color: var(--usage-accent-text);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.14);
}

[data-theme='dark'] .range-tab.active {
  background: #3a3a3a;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.refresh-btn {
  color: var(--usage-text-2);
}

/* ---------- 自定义范围 ---------- */
.custom-range-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px dashed color-mix(in srgb, var(--color-primary) 36%, var(--usage-border));
  background: color-mix(in srgb, var(--color-primary) 5%, var(--usage-card));
}

.custom-range-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--usage-text-2);
}

.custom-range-picker {
  width: 260px;
}

.custom-range-hint {
  font-size: 11px;
  color: var(--usage-text-3);
}

.range-slide-enter-active,
.range-slide-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.range-slide-enter-from,
.range-slide-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ---------- 加载 ---------- */
.usage-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 260px;
  font-size: 12px;
  color: var(--usage-text-3);
}

/* ---------- KPI ---------- */
.kpi-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr 1.15fr;
  gap: 12px;
}

.kpi-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 136px;
  padding: 15px 16px;
  border-radius: 14px;
  border: 1px solid var(--usage-border);
  background: var(--usage-card);
  overflow: hidden;
}

.kpi-card.is-total {
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 10%, var(--usage-card)), var(--usage-card) 68%);
}

.kpi-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.kpi-label {
  font-size: 13px;
  line-height: 1.3;
  color: var(--usage-text-2);
}

.kpi-value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin-top: 3px;
}

.kpi-value strong {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.02em;
  color: var(--usage-text);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kpi-value .unit {
  font-size: 13px;
  color: var(--usage-text-2);
  flex-shrink: 0;
}

.kpi-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  line-height: 1.5;
  color: var(--usage-text-2);
  font-variant-numeric: tabular-nums;
}

.composition-legend {
  gap: 14px;
  margin-top: 2px;
}

.composition-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.cache-meter {
  height: 6px;
  margin-top: 8px;
}

.secondary-meta {
  margin-top: -2px;
  font-size: 12.5px;
}

.delta-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--color-fill-2, #f2f3f5);
  color: var(--usage-text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.delta-arrow {
  font-size: 11px;
  font-weight: 700;
}

.delta-caption {
  color: var(--usage-text-3);
}

.mini-stack,
.split-meter {
  display: flex;
  width: 100%;
  height: 5px;
  margin-top: 4px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--color-fill-2, #f2f3f5);
  gap: 1px;
}

.mini-seg {
  display: block;
  height: 100%;
  min-width: 0;
}

.mini-seg.cached,
.comp-seg.cached,
.legend-dot.cached {
  background: var(--usage-cached);
}

.mini-seg.uncached,
.comp-seg.uncached,
.legend-dot.uncached {
  background: var(--usage-uncached);
}

.mini-seg.output,
.comp-seg.output,
.legend-dot.output {
  background: var(--usage-output);
}

.legend-dot.tts {
  background: var(--usage-tts);
}

.legend-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex-shrink: 0;
}

.provider-value strong {
  font-size: 17px;
}

/* ---------- 筛选 ---------- */
.filter-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 14px;
  border: 1px solid var(--usage-border);
  background: var(--usage-card);
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.filter-key {
  width: 38px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--usage-text-2);
}

.filter-pills {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 0;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  user-select: none;
  -webkit-user-select: none;
}

.filter-pills::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.pill {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--usage-border);
  background: transparent;
  color: var(--usage-text-2);
  font-size: 12px;
  line-height: 1.3;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.pill:hover {
  border-color: var(--color-primary);
  color: var(--usage-accent-text);
}

.pill:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

.pill.active {
  background: color-mix(in srgb, var(--color-primary) 13%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
  color: var(--usage-accent-text);
  font-weight: 600;
}

.pill em {
  font-style: normal;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--usage-tts) 16%, transparent);
  color: var(--usage-tts);
  font-size: 9px;
  line-height: 1.5;
}

/* ---------- 卡片 ---------- */
.panel-card {
  border-radius: 14px;
  border: 1px solid var(--usage-border);
  background: var(--usage-card);
  padding: 16px 18px;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.card-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--usage-text);
}

.card-head p {
  margin: 3px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--usage-text-2);
}

/* ---------- 图表 ---------- */
.chart-card {
  padding-bottom: 14px;
}

.chart-legend {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding-top: 2px;
  font-size: 11.5px;
  color: var(--usage-text-2);
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.chart-inspector {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 8px 12px;
  margin-bottom: 12px;
  border-radius: 10px;
  border: 1px solid var(--usage-border);
  background: var(--color-fill-1, #f7f8fa);
  font-size: 12px;
  color: var(--usage-text-2);
  font-variant-numeric: tabular-nums;
}

[data-theme='dark'] .chart-inspector {
  background: #242424;
}

.inspector-date {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--usage-text);
  padding-right: 12px;
  border-right: 1px solid var(--usage-border);
}

.inspector-item b {
  margin-left: 2px;
  font-weight: 650;
  color: var(--usage-text);
}

.inspector-item.tts b {
  color: var(--usage-tts);
}

.inspector-hint {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--usage-text-3);
  opacity: 0.9;
}

.chart-body {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.y-axis {
  position: relative;
  width: 50px;
  height: 190px;
  flex-shrink: 0;
}

.y-tick {
  position: absolute;
  right: 0;
  font-size: 10px;
  line-height: 1;
  color: var(--usage-text-2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.chart-main {
  flex: 1;
  min-width: 0;
}

.plot-area {
  position: relative;
  height: 190px;
}

.gridlines {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.gridline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--usage-border);
  opacity: 0.75;
}

.gridline:last-child {
  border-top-style: solid;
  opacity: 1;
}

.bars {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  gap: var(--bar-gap);
  padding: 0 2px;
}

.bar-col {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px 6px 0 0;
  background: transparent;
  cursor: pointer;
  transition: background 0.15s ease;
}

.bar-col:hover,
.bar-col.active {
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
}

.bar-col:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

.bar {
  width: min(100%, 18px);
  display: flex;
  flex-direction: column-reverse;
  overflow: hidden;
  border-radius: 4px 4px 2px 2px;
  transition: height 0.24s ease;
}

.bar.is-empty {
  height: 2px;
  background: var(--color-fill-2, #f2f3f5);
}

.seg {
  display: block;
  width: 100%;
  min-height: 0;
}

.seg.cached {
  background: var(--usage-cached);
}

.seg.uncached {
  background: var(--usage-uncached);
}

.seg.output {
  background: var(--usage-output);
}

.x-labels {
  display: flex;
  gap: var(--bar-gap);
  padding: 6px 2px 0;
  height: 20px;
}

.x-label {
  flex: 1 1 0;
  min-width: 0;
  text-align: center;
  font-size: 10.5px;
  line-height: 1.2;
  color: var(--usage-text-2);
  white-space: nowrap;
  overflow: visible;
  font-variant-numeric: tabular-nums;
}

.chart-note {
  margin-top: 10px;
  font-size: 11px;
  color: var(--usage-text-3);
}

/* TTS 副图 */
.tts-strip {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--usage-border);
}

.tts-strip-label {
  width: 50px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10px;
  line-height: 1.35;
  color: var(--usage-text-2);
}

.tts-strip-label b {
  font-size: 10px;
  font-weight: 600;
  color: var(--usage-tts);
  font-variant-numeric: tabular-nums;
}

.tts-plot-wrap {
  flex: 1;
  min-width: 0;
}

.tts-plot {
  flex: 1;
  min-width: 0;
  height: 44px;
  display: flex;
  align-items: flex-end;
}

.tts-strip.tts-only .tts-plot {
  height: 150px;
}

.tts-strip.tts-only {
  border-top: 0;
  padding-top: 0;
  margin-top: 4px;
}

.tts-bars {
  display: flex;
  align-items: flex-end;
  gap: var(--bar-gap);
  width: 100%;
  height: 100%;
  padding: 0 2px;
}

.tts-bar-col {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.tts-bar-col:focus-visible {
  outline: 2px solid var(--usage-tts);
  outline-offset: 1px;
}

.tts-bar {
  display: block;
  width: min(100%, 13px);
  border-radius: 3px 3px 1px 1px;
  background: var(--usage-tts);
  opacity: 0.8;
  transition: height 0.2s ease, opacity 0.15s ease;
}

.tts-bar-col.active .tts-bar {
  opacity: 1;
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--usage-tts) 55%, transparent);
}

/* 单日构成 */
.single-day {
  padding: 2px 0 0;
}

.single-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.single-date {
  font-size: 12px;
  color: var(--usage-text-3);
  padding-right: 12px;
  border-right: 1px solid var(--usage-border);
}

.single-total {
  font-size: 32px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--usage-text);
  font-variant-numeric: tabular-nums;
}

.single-unit {
  font-size: 12px;
  color: var(--usage-text-3);
}

.single-calls {
  font-size: 12.5px;
  color: var(--usage-text-2);
  font-variant-numeric: tabular-nums;
}

.single-delta {
  align-self: center;
  margin-left: 4px;
}

.comp-track {
  display: flex;
  gap: 2px;
  width: 100%;
  height: 14px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--color-fill-2, #f2f3f5);
}

.comp-seg {
  display: block;
  height: 100%;
  min-width: 0;
}

.comp-legend {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.comp-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--usage-border);
  background: var(--color-fill-1, #f7f8fa);
}

[data-theme='dark'] .comp-item {
  background: #242424;
}

.comp-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--usage-text-3);
}

.comp-item b {
  font-size: 15px;
  font-weight: 650;
  color: var(--usage-text);
  font-variant-numeric: tabular-nums;
}

.comp-item em {
  font-style: normal;
  font-size: 10px;
  color: var(--usage-text-3);
}

.single-empty {
  padding: 18px 0 8px;
  font-size: 12px;
  color: var(--usage-text-3);
}

.single-tts {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--usage-tts) 9%, transparent);
  font-size: 11.5px;
  color: var(--usage-text-2);
  font-variant-numeric: tabular-nums;
}

.single-tts-label {
  font-weight: 600;
  color: var(--usage-tts);
}

.single-tts-delta {
  font-size: 12px;
  color: var(--usage-text-3);
}

.single-tts b {
  font-size: 14px;
  color: var(--usage-text);
}

/* 空状态 */
.empty-card {
  min-height: 268px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  color: var(--usage-text-3);
}

.empty-icon {
  width: 50px;
  height: 50px;
  display: grid;
  place-items: center;
  margin-bottom: 4px;
  border-radius: 16px;
  background: var(--color-fill-1, #f7f8fa);
  color: var(--usage-accent-text);
}

[data-theme='dark'] .empty-icon {
  background: #242424;
}

.empty-card strong {
  font-size: 14px;
  color: var(--usage-text);
}

.empty-card p {
  margin: 0 0 6px;
  font-size: 11.5px;
}

/* ---------- 明细表 ---------- */
.breakdown-card {
  padding-bottom: 6px;
}

.breakdown-summary {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--usage-text-3);
  font-variant-numeric: tabular-nums;
}

.breakdown-summary b {
  color: var(--usage-text);
  font-weight: 650;
}

.table-scroll {
  overflow-x: auto;
}

.usage-table {
  width: 100%;
  min-width: 660px;
  border-collapse: collapse;
  font-size: 12px;
}

.usage-table th {
  padding: 8px 10px;
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  color: var(--usage-text-3);
  white-space: nowrap;
  border-bottom: 1px solid var(--usage-border);
}

.usage-table td {
  padding: 10px;
  color: var(--usage-text-2);
  vertical-align: middle;
  border-bottom: 1px solid color-mix(in srgb, var(--usage-border) 62%, transparent);
}

.usage-table tbody tr:last-child td {
  border-bottom: none;
}

.usage-table tbody tr:hover td {
  background: var(--color-fill-1, #f7f8fa);
}

[data-theme='dark'] .usage-table tbody tr:hover td {
  background: #242424;
}

.usage-table .num {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.usage-table .amount-cell {
  color: var(--usage-text);
  font-weight: 600;
}

.usage-table .amount-cell small {
  font-size: 9.5px;
  font-weight: 400;
  color: var(--usage-text-3);
}

.model-name {
  display: block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--usage-text);
  font-weight: 500;
}

.type-tag {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--usage-accent-text);
  font-size: 9.5px;
  white-space: nowrap;
}

.type-tag.memory {
  background: color-mix(in srgb, var(--usage-uncached) 14%, transparent);
  color: var(--usage-uncached);
}

.type-tag.tts {
  background: color-mix(in srgb, var(--usage-tts) 13%, transparent);
  color: var(--usage-tts);
}

.share-col {
  width: 132px;
  min-width: 118px;
}

.share-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.share-track {
  flex: 1;
  height: 5px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--color-fill-2, #f2f3f5);
}

.share-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--usage-output);
}

.share-fill.memory {
  background: var(--usage-uncached);
}

.share-fill.tts {
  background: var(--usage-tts);
}

.share-val {
  min-width: 38px;
  text-align: right;
  font-size: 10px;
  color: var(--usage-text-3);
  font-variant-numeric: tabular-nums;
}

/* ---------- 页脚 ---------- */
.usage-footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 2px 4px 6px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--usage-text-3);
}

.usage-footer code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--color-fill-2, #f2f3f5);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--usage-text-2);
}

/* ---------- 响应式 ---------- */
@media (max-width: 900px) {
  .kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .kpi-grid > :last-child:nth-child(3) {
    grid-column: 1 / -1;
  }
}

@media (max-width: 760px) {
  .page-head {
    flex-direction: column;
  }

  .head-tools {
    width: 100%;
    justify-content: space-between;
  }

  .range-switch {
    width: 100%;
    overflow-x: auto;
  }

  .range-tab {
    flex: 1;
  }

  .kpi-grid,
  .comp-legend {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .custom-range-picker {
    width: 100%;
  }

  .inspector-hint {
    display: none;
  }
}

@media (max-width: 520px) {
  .kpi-grid,
  .comp-legend {
    grid-template-columns: minmax(0, 1fr);
  }

  .kpi-grid > :last-child:nth-child(3) {
    grid-column: auto;
  }

  .filter-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .filter-key {
    width: auto;
  }

  .filter-pills {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .range-tab,
  .pill,
  .bar,
  .tts-bar,
  .filter-pills,
  .range-slide-enter-active,
  .range-slide-leave-active {
    transition: none;
  }
}
</style>
