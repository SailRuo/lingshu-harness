<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useChatStore } from '../../stores/chat';

type EchoTab = 'streams' | 'seeds' | 'portrait' | 'rules';

interface ScoreBreakdown {
  resonance?: number;
  salience?: number;
  importance?: number;
  selected?: number;
  similarity?: number;
  [key: string]: number | undefined;
}

interface MemoryEchoSnippet {
  id: string;
  text: string;
  source?: string;
  sourceId?: string | null;
  memoryType?: string;
  scoreBreakdown?: ScoreBreakdown;
  dropReason?: string;
  similarity?: number;
}

interface StreamRecallCandidate {
  id: string;
  narrative?: string;
  about?: string;
  type?: string;
  similarity?: number;
  selected?: boolean;
  kind?: string;
  reason?: string;
}

interface PersonaActivationCandidate {
  seedId?: string;
  wakeText?: string;
  wakeScore?: number;
  fieldBoost?: number;
  fieldGuard?: number;
  fieldSuppress?: number;
  seedBoost?: number;
  seedSuppress?: number;
  finalScore?: number;
  reason?: string;
  active?: boolean;
  injected?: boolean;
  innerInjected?: boolean;
  outerInjected?: boolean;
  innerOrientation?: string;
  outerExpression?: string;
}

interface PersonaActivationSnapshot {
  field?: {
    wakeText?: string;
    wakeQueries?: string[];
    boostText?: string;
    suppressText?: string;
    source?: string;
  };
  params?: Record<string, number | string>;
  candidates?: PersonaActivationCandidate[];
  activeSeedIds?: string[];
  injectedSeedIds?: string[];
}

interface UserPortraitSnapshot {
  narrative?: string;
  dimensions?: Record<string, unknown>;
  evidenceIds?: string[];
  version?: number | null;
}

interface MemoryEchoEntry {
  turnId: string;
  sessionId: string;
  userMessage?: string;
  assistantMessage?: string;
  timestamp?: string;
  snapshot: {
    snippets?: MemoryEchoSnippet[];
    streams?: Array<{ id: string; narrative: string; type?: string; about?: string; when?: string; similarity?: number }>;
    seeds?: Array<{ id: string; content: string; subject?: string }>;
    facts?: Array<{ id: string; description?: string; object?: string }>;
    memoryFacts?: Array<{ text: string; kind?: string }>;
    constraints?: string[];
    candidateCount?: number;
    selectedCount?: number;
    droppedCandidates?: MemoryEchoSnippet[];
    selfState?: Record<string, unknown>;
    personaActivation?: PersonaActivationSnapshot;
    streamRecall?: {
      candidates?: StreamRecallCandidate[];
      selectedIds?: string[];
      annCount?: number;
      selectedCount?: number;
      queries?: Array<{ role?: string; text?: string }>;
    };
    userPortrait?: UserPortraitSnapshot;
    query?: string;
  };
}

const TABS: Array<{ id: EchoTab; label: string }> = [
  { id: 'streams', label: '意识流' },
  { id: 'seeds', label: '种子' },
  { id: 'portrait', label: '画像' },
  { id: 'rules', label: '规则' },
];

const SEED_REASON_LABELS: Record<string, string> = {
  active: '可现行',
  wake_below_floor: '唤醒分不足',
  suppressed_below_floor: '被压低',
  final_below_threshold: '未过现行阈',
  missing_portrait: '画像不全',
  budget_truncated: '预算截断',
};

const STREAM_KIND_LABELS: Record<string, string> = {
  direct: '直召',
  expanded: '簇扩展',
  ann: 'ANN',
};

const chatStore = useChatStore();
const router = useRouter();

const activeTab = ref<EchoTab>('streams');

const entries = computed(() => (chatStore.currentMemoryEchoes || []) as MemoryEchoEntry[]);

/** 只看最新一轮召回，不提供历史回合切换。 */
const selectedEntry = computed(() => entries.value[0] ?? null);

const personaActivation = computed(
  () => selectedEntry.value?.snapshot?.personaActivation ?? null,
);

const wakeQueryLines = computed(() => {
  const field = personaActivation.value?.field;
  if (!field) return [] as string[];
  const queries = (field.wakeQueries || [])
    .map((q) => String(q || '').trim())
    .filter(Boolean);
  if (queries.length) return queries;
  const wake = String(field.wakeText || '').trim();
  if (!wake) return [];
  const split = wake.split('\n').map((q) => q.trim()).filter(Boolean);
  return split.length > 1 ? split : [];
});

const streamRecallQueries = computed(() => {
  const queries = selectedEntry.value?.snapshot?.streamRecall?.queries;
  if (!Array.isArray(queries) || !queries.length) return [] as Array<{ role: string; text: string }>;
  return queries
    .map((item) => ({
      role: String(item?.role || '').trim() || 'user',
      text: String(item?.text || '').trim(),
    }))
    .filter((item) => item.text);
});

const streamRecallCandidates = computed((): StreamRecallCandidate[] => {
  const fromAudit = selectedEntry.value?.snapshot?.streamRecall?.candidates;
  if (Array.isArray(fromAudit) && fromAudit.length) {
    return fromAudit.map((item) => ({
      ...item,
      narrative: String(item.narrative || '').trim(),
    }));
  }
  const streams = selectedEntry.value?.snapshot?.streams || [];
  return streams.map((item) => ({
    id: item.id,
    narrative: String(item.narrative || '').trim(),
    about: item.about,
    type: item.type,
    similarity: item.similarity,
    selected: true,
    kind: 'direct',
    reason: '',
  }));
});

const selectedStreams = computed(() => streamRecallCandidates.value.filter((item) => item.selected));
const candidateStreams = computed(() => streamRecallCandidates.value.filter((item) => !item.selected));

const personaCandidates = computed(() => personaActivation.value?.candidates ?? []);

const promptInjection = computed(() => {
  const snap = selectedEntry.value?.snapshot as Record<string, unknown> | undefined;
  const block = snap?.promptInjection;
  if (!block || typeof block !== 'object') {
    return { innerRippleLines: [] as string[], speakingStyleLines: [] as string[] };
  }
  const rec = block as Record<string, unknown>;
  return {
    innerRippleLines: Array.isArray(rec.innerRippleLines)
      ? rec.innerRippleLines.map((line) => String(line || '')).filter(Boolean)
      : [],
    speakingStyleLines: Array.isArray(rec.speakingStyleLines)
      ? rec.speakingStyleLines.map((line) => String(line || '')).filter(Boolean)
      : [],
  };
});

const injectedLineCount = computed(
  () => promptInjection.value.innerRippleLines.length + promptInjection.value.speakingStyleLines.length,
);

const userPortrait = computed(() => selectedEntry.value?.snapshot?.userPortrait ?? null);
const ruleLines = computed(() => {
  const lines = selectedEntry.value?.snapshot?.constraints;
  return Array.isArray(lines) ? lines.filter((line) => String(line || '').trim()) : [];
});

const UUID_SEED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function seedDisplayLabel(row: PersonaActivationCandidate): string {
  const wake = String(row.wakeText || '').replace(/\n/g, ' ').trim();
  if (wake) return wake.length > 48 ? `${wake.slice(0, 48)}…` : wake;
  const id = String(row.seedId || '').trim();
  if (id && !UUID_SEED_RE.test(id)) return id;
  const inner = String(row.innerOrientation || '').replace(/\n/g, ' ').trim();
  if (inner) return inner.length > 48 ? `${inner.slice(0, 48)}…` : inner;
  return '习得种子';
}

function seedReasonLabel(reason?: string): string {
  if (!reason) return '';
  return SEED_REASON_LABELS[reason] || reason;
}

function streamKindLabel(kind?: string): string {
  if (!kind) return '';
  return STREAM_KIND_LABELS[kind] || kind;
}

watch(
  () => chatStore.currentConversationId,
  () => {
    activeTab.value = 'streams';
  },
  { immediate: true },
);

function formatScore(value?: number): string {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(3);
}

function openStream(id?: string) {
  if (!id) return;
  router.push({ path: '/memory-streams', query: { id } });
}

function openSeed(id?: string) {
  if (!id) return;
  router.push({ path: '/memory-seeds', query: { id } });
}
</script>

<template>
  <div class="memory-echo-panel">
    <header class="panel-head">
      <h3>本轮想起了什么</h3>
      <p v-if="!entries.length" class="hint">聊几轮后，召回记录会出现在这里</p>
      <p v-else-if="selectedEntry" class="hint">
        最新一轮
        <template v-if="selectedEntry.userMessage">
          · 用户：{{ selectedEntry.userMessage.length > 24
            ? `${selectedEntry.userMessage.slice(0, 24)}…`
            : selectedEntry.userMessage }}
        </template>
      </p>
    </header>

    <template v-if="selectedEntry">
      <div class="echo-tabs">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          class="echo-tab"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <template v-if="activeTab === 'streams'">
        <div class="counts">
          <span>候选 {{ streamRecallCandidates.length }}</span>
          <span>入选 {{ selectedStreams.length }}</span>
        </div>

        <section v-if="streamRecallQueries.length" class="section compact">
          <h4>召回 query（分路原文）</h4>
          <p
            v-for="(q, index) in streamRecallQueries"
            :key="`sq-${index}`"
            class="self-line wake-query"
          >
            · {{ q.role === 'assistant' ? '我' : 'ta' }}：{{ q.text }}
          </p>
        </section>
        <section v-else class="section compact">
          <h4>召回 query</h4>
          <p class="self-line">
            {{ selectedEntry?.userMessage
              ? `本轮用户句：${selectedEntry.userMessage}`
              : '（未记录分路 query）' }}
          </p>
        </section>

        <section class="section">
          <h4>入选</h4>
          <div v-if="!selectedStreams.length" class="empty-block">本轮没有入选意识流</div>
          <article
            v-for="item in selectedStreams"
            :key="`sel-${item.id}`"
            class="snippet-card selected"
            @click="openStream(item.id)"
          >
            <div class="card-head">
              <span class="snippet-type">{{ item.type === 'internal' ? '内心' : '对话' }}</span>
              <span v-if="item.about" class="about-pill">{{ item.about }}</span>
              <span class="score-pill selected">{{ streamKindLabel(item.kind) || '入选' }}</span>
              <span class="score-text">sim {{ formatScore(item.similarity) }}</span>
            </div>
            <p class="snippet-text">{{ item.narrative || '（无叙述文本）' }}</p>
          </article>
        </section>

        <section class="section">
          <h4>候选（未入选）</h4>
          <div v-if="!candidateStreams.length" class="empty-block">没有落选候选</div>
          <article
            v-for="item in candidateStreams"
            :key="`cand-${item.id}`"
            class="snippet-card muted"
            @click="openStream(item.id)"
          >
            <div class="card-head">
              <span class="snippet-type">{{ item.type === 'internal' ? '内心' : '对话' }}</span>
              <span v-if="item.about" class="about-pill">{{ item.about }}</span>
              <span class="score-pill">未入选</span>
              <span class="score-text">sim {{ formatScore(item.similarity) }}</span>
            </div>
            <p class="snippet-text">{{ item.narrative || '（无叙述文本）' }}</p>
            <span v-if="item.reason" class="drop-reason">{{ item.reason }}</span>
          </article>
        </section>
      </template>

      <template v-else-if="activeTab === 'seeds'">
        <div class="counts">
          <span>候选 {{ personaCandidates.length }}</span>
          <span>现行 {{ personaActivation?.activeSeedIds?.length ?? 0 }}</span>
          <span>进提示词 {{ injectedLineCount }} 段</span>
        </div>

        <section v-if="personaActivation?.field" class="section compact">
          <h4>本轮场画像</h4>
          <template v-if="wakeQueryLines.length">
            <p class="self-line">唤醒（分路）：</p>
            <p
              v-for="(line, index) in wakeQueryLines"
              :key="`wake-${index}`"
              class="self-line wake-query"
            >
              · {{ line }}
            </p>
          </template>
          <p v-else-if="personaActivation.field.wakeText" class="self-line wake-query">
            唤醒：{{ personaActivation.field.wakeText }}
          </p>
          <p v-if="personaActivation.field.boostText" class="self-line">
            推高：{{ personaActivation.field.boostText }}
          </p>
          <p v-if="personaActivation.field.suppressText" class="self-line">
            压低：{{ personaActivation.field.suppressText }}
          </p>
        </section>

        <section class="section">
          <h4>真正写入提示词</h4>
          <div v-if="!injectedLineCount" class="empty-block">本轮提示词未写入种子涟漪/风格</div>
          <template v-else>
            <article
              v-for="(line, index) in promptInjection.innerRippleLines"
              :key="`ripple-${index}`"
              class="snippet-card selected static"
            >
              <div class="card-head">
                <span class="score-pill selected"># 我心里产生的涟漪</span>
              </div>
              <p class="snippet-text">{{ line }}</p>
            </article>
            <article
              v-for="(line, index) in promptInjection.speakingStyleLines"
              :key="`style-${index}`"
              class="snippet-card selected static"
            >
              <div class="card-head">
                <span class="score-pill selected"># 我说话时的风格</span>
              </div>
              <p class="snippet-text">{{ line }}</p>
            </article>
          </template>
        </section>

        <section class="section">
          <h4>动力场判定</h4>
          <div v-if="!personaCandidates.length" class="empty-block">本轮没有种子候选</div>
          <article
            v-for="row in personaCandidates"
            :key="row.seedId || row.innerOrientation"
            class="snippet-card"
            :class="{
              selected: row.injected,
              muted: !row.injected,
            }"
            @click="openSeed(row.seedId)"
          >
            <div class="card-head">
              <span class="snippet-type">{{ seedDisplayLabel(row) }}</span>
              <span class="score-pill" :class="{ selected: row.injected }">
                {{ row.injected ? '已写入提示词' : (seedReasonLabel(row.reason) || '未写入') }}
              </span>
            </div>
            <div class="score-grid">
              <span>wake {{ formatScore(row.wakeScore) }}</span>
              <span>final {{ formatScore(row.finalScore) }}</span>
              <span v-if="row.active">active</span>
            </div>
            <p v-if="row.innerOrientation" class="snippet-text">内在：{{ row.innerOrientation }}</p>
            <p v-if="row.outerExpression" class="snippet-text">外在：{{ row.outerExpression }}</p>
          </article>
        </section>
      </template>

      <template v-else-if="activeTab === 'portrait'">
        <section class="section">
          <h4>我眼中的他</h4>
          <div v-if="!userPortrait?.narrative" class="empty-block">本轮没有注入用户画像</div>
          <article v-else class="snippet-card static">
            <p class="snippet-text">{{ userPortrait.narrative }}</p>
            <div v-if="userPortrait.version != null" class="meta-line">version {{ userPortrait.version }}</div>
            <div
              v-if="userPortrait.dimensions && Object.keys(userPortrait.dimensions).length"
              class="dim-list"
            >
              <div
                v-for="(value, key) in userPortrait.dimensions"
                :key="String(key)"
                class="dim-row"
              >
                <span class="dim-key">{{ key }}</span>
                <span class="dim-val">{{ Array.isArray(value) ? value.join('；') : value }}</span>
              </div>
            </div>
          </article>
        </section>
      </template>

      <template v-else>
        <section class="section">
          <h4>他的相处偏好</h4>
          <div v-if="!ruleLines.length" class="empty-block">本轮没有相处规则</div>
          <article
            v-for="(line, index) in ruleLines"
            :key="`rule-${index}`"
            class="snippet-card static"
          >
            <p class="snippet-text">{{ line }}</p>
          </article>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.memory-echo-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px 16px;
}
.panel-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.echo-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.echo-tab {
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.echo-tab.active {
  color: var(--color-primary, #3D8C41);
  border-color: color-mix(in srgb, var(--color-primary, #3D8C41) 40%, transparent);
  background: color-mix(in srgb, var(--color-primary, #3D8C41) 10%, transparent);
}
.counts {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-secondary);
}
.section h4 {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
.empty-block {
  padding: 12px 10px;
  margin-bottom: 8px;
  border-radius: 8px;
  border: 1px dashed var(--border-color, rgba(255,255,255,0.1));
  font-size: 12px;
  color: var(--text-secondary);
}
.snippet-card {
  padding: 10px;
  margin-bottom: 8px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: var(--bg-hover, rgba(255,255,255,0.03));
  cursor: pointer;
  transition: border-color 0.15s;
}
.snippet-card:hover {
  border-color: color-mix(in srgb, var(--color-primary, #3D8C41) 35%, transparent);
}
.snippet-card.static { cursor: default; }
.snippet-card.muted { opacity: 0.9; }
.snippet-card.selected {
  border-color: rgba(34, 197, 94, 0.4);
  background: rgba(34, 197, 94, 0.06);
}
.snippet-card.injected {
  background: color-mix(in srgb, var(--color-primary, #3D8C41) 10%, transparent);
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.snippet-type {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-tertiary, var(--text-secondary));
}
.about-pill {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255,255,255,0.06);
  color: var(--text-secondary);
}
.score-pill {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(255,255,255,0.06);
  color: var(--text-secondary);
}
.score-pill.selected {
  background: rgba(34, 197, 94, 0.18);
  color: #86efac;
}
.score-text {
  font-size: 10px;
  color: var(--text-tertiary, var(--text-secondary));
  font-variant-numeric: tabular-nums;
}
.snippet-text {
  margin: 6px 0 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
}
.drop-reason, .meta-line {
  font-size: 10px;
  color: var(--text-secondary);
}
.self-line { margin: 0 0 4px; font-size: 12px; color: var(--text-secondary); }
.score-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  font-size: 10px;
  color: var(--text-tertiary, var(--text-secondary));
  font-family: ui-monospace, monospace;
}
.dim-list { margin-top: 8px; display: grid; gap: 6px; }
.dim-row { font-size: 11px; line-height: 1.45; }
.dim-key {
  display: inline-block;
  min-width: 4.5em;
  color: var(--text-secondary);
  margin-right: 6px;
}
.dim-val { color: var(--text-primary); }
</style>
