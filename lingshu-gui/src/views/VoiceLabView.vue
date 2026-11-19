<script setup lang="ts">
import { computed } from 'vue';
import { useVoiceLab } from '../composables/useVoiceLab';
import { useVoiceAsrStatus } from '../composables/useVoiceAsrStatus';

defineOptions({ name: 'VoiceLabView' });

const { backendAsrProvider } = useVoiceAsrStatus();

const asrSourceCopy = computed(() => {
  const provider = backendAsrProvider.value;
  if (provider === 'xiaomi') return '小米 MiMo 云端识别';
  if (provider === 'aliyun') return '阿里云 DashScope 识别';
  return '本地 Sherpa-ONNX 识别';
});

const {
  isConnecting,
  isActive,
  activeMode,
  inputLevel,
  punctuationEnabled,
  latestTranscript,
  latestRawTranscript,
  latestPunctuatedTranscript,
  latestMetrics,
  asrReady,
  asrMessage,
  statusText,
  lastError,
  events,
  startSession,
  stopSession,
  clearEvents,
  setPunctuationEnabled,
} = useVoiceLab();

const energyBars = computed(() =>
  Array.from({ length: 12 }, (_, index) => {
    const wobble = Math.abs(Math.sin(index * 0.72));
    return Math.max(8, 8 + inputLevel.value * 34 * wobble);
  }),
);

const haloStyle = computed(() => ({
  transform: `scale(${1 + inputLevel.value * 0.12})`,
  opacity: `${0.16 + inputLevel.value * 0.38}`,
}));

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function handleMainToggle() {
  if (isActive.value) {
    void stopSession(true);
    return;
  }
  void startSession('call');
}

function handleHoldStart() {
  void startSession('push');
}

function handleHoldEnd() {
  if (activeMode.value === 'push' && isActive.value) {
    void stopSession();
  }
}
</script>

<template>
  <div class="voice-lab-view">
    <header class="voice-lab-header">
      <div class="voice-lab-copy">
        <h1>语音实验</h1>
        <p>桌面端 Tauri 采集音频与 VAD，{{ asrSourceCopy }}。本页只测端侧 VAD + ASR，不走聊天发送链路。</p>
      </div>
      <div class="voice-lab-actions">
        <label class="toggle-chip">
          <input
            type="checkbox"
            :checked="punctuationEnabled"
            :disabled="isActive || isConnecting"
            @change="setPunctuationEnabled(($event.target as HTMLInputElement).checked)"
          />
          <span>标点恢复</span>
        </label>
        <button
          class="toolbar-btn"
          :disabled="isConnecting || !asrReady"
          @click="clearEvents"
        >
          清空记录
        </button>
      </div>
    </header>

    <section class="voice-lab-band hero-band">
      <div class="control-shell">
        <div class="status-row">
          <span class="mode-chip">{{ activeMode === 'call' ? '持续监听' : '按住说话' }}</span>
          <span class="status-copy">{{ asrReady ? statusText : asrMessage }}</span>
        </div>

        <div class="mic-zone">
          <div class="energy-halo" :class="{ active: isActive }" :style="haloStyle"></div>
          <button
            class="mic-button"
            :class="{ active: isActive, waiting: isConnecting, disabled: !asrReady }"
            :disabled="isConnecting || !asrReady"
            @click="handleMainToggle"
          >
            <span class="material-symbols-outlined">
              {{ isActive ? 'mic_off' : 'mic' }}
            </span>
          </button>
        </div>

        <div class="energy-bars" aria-hidden="true">
          <span
            v-for="(height, index) in energyBars"
            :key="index"
            class="energy-bar"
            :style="{ height: `${height}px`, opacity: isActive ? 1 : 0.35 }"
          />
        </div>

        <div class="primary-actions">
          <button
            class="action-btn primary"
            :disabled="!asrReady || isActive || isConnecting"
            @click="() => void startSession('call')"
          >
            启动持续监听
          </button>
          <button
            class="action-btn"
            :disabled="!asrReady || isConnecting"
            @mousedown.left.prevent="handleHoldStart"
            @mouseup.left.prevent="handleHoldEnd"
            @mouseleave="handleHoldEnd"
          >
            按住说话
          </button>
          <button
            class="action-btn danger"
            :disabled="!isActive && !isConnecting"
            @click="() => void stopSession(true)"
          >
            停止
          </button>
        </div>
      </div>
    </section>

    <section class="voice-lab-grid">
      <div class="voice-lab-band transcript-band">
        <div class="band-heading">
          <h2>最新识别</h2>
          <span>final text</span>
        </div>
        <div class="transcript-body" :class="{ empty: !latestTranscript }">
          {{ latestTranscript || (isActive ? '系统正在等待完整语句。' : '启动后，说一句完整的话试试看。') }}
        </div>
        <div class="transcript-compare">
          <div class="compare-item">
            <span class="compare-label">原始 ASR</span>
            <p>{{ latestRawTranscript || '--' }}</p>
          </div>
          <div class="compare-item">
            <span class="compare-label">标点恢复</span>
            <p>{{ latestPunctuatedTranscript || '--' }}</p>
          </div>
        </div>
      </div>

      <div class="voice-lab-band metrics-band">
      <div class="band-heading">
        <h2>解码指标</h2>
        <span>paraformer</span>
      </div>
        <div class="metrics-grid">
          <div
            v-for="metric in latestMetrics"
            :key="metric.label"
            class="metric-item"
          >
            <span class="metric-label">{{ metric.label }}</span>
            <span class="metric-value">{{ metric.value }}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="voice-lab-band events-band">
      <div class="band-heading">
        <h2>事件流</h2>
        <span>{{ events.length }} entries</span>
      </div>
      <div v-if="events.length" class="event-list">
        <article
          v-for="event in events"
          :key="event.id"
          class="event-row"
        >
          <div class="event-dot" :class="event.type"></div>
          <div class="event-main">
            <div class="event-meta">
              <span class="event-type">{{ event.type }}</span>
              <span class="event-time">{{ formatTime(event.createdAt) }}</span>
            </div>
            <p class="event-text">{{ event.text }}</p>
            <div v-if="event.meta?.utteranceId || typeof event.meta?.rtf === 'number'" class="event-inline-metrics">
              <span v-if="event.meta?.utteranceId">ID {{ event.meta.utteranceId }}</span>
              <span v-if="typeof event.meta?.rtf === 'number'">RTF {{ event.meta.rtf.toFixed(3) }}</span>
              <span v-if="typeof event.meta?.durationS === 'number'">Duration {{ event.meta.durationS.toFixed(2) }} s</span>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="empty-state">
        还没有事件，启动一次持续监听或者按住说话。
      </div>
    </section>

    <section v-if="lastError" class="voice-lab-band error-band">
      <div class="band-heading">
        <h2>最近错误</h2>
        <span>error</span>
      </div>
      <p class="error-text">{{ lastError }}</p>
    </section>
  </div>
</template>

<style scoped>
.voice-lab-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 18px 20px 20px;
  gap: 16px;
  background: var(--bg-chat-window);
  overflow: auto;
}

.voice-lab-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.voice-lab-copy h1,
.band-heading h2 {
  margin: 0;
  color: var(--text-primary);
}

.voice-lab-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.voice-lab-copy h1 {
  font-size: 20px;
  line-height: 1.3;
  font-weight: 600;
}

.voice-lab-copy p {
  margin: 0;
  max-width: 720px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.toolbar-btn,
.action-btn {
  min-height: 36px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-message-other);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast), transform var(--transition-fast);
}

.toggle-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--bg-message-other);
  color: var(--text-primary);
  font-size: 13px;
}

.toggle-chip input {
  margin: 0;
}

.toolbar-btn:hover,
.action-btn:hover {
  background: var(--bg-hover);
}

.toolbar-btn:active,
.action-btn:active {
  transform: scale(0.98);
}

.toolbar-btn:disabled,
.action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.action-btn.primary {
  background: color-mix(in srgb, var(--color-primary) 18%, var(--bg-message-other));
  border-color: color-mix(in srgb, var(--color-primary) 28%, var(--border-color));
}

.action-btn.danger {
  color: var(--color-danger-text, #c8342f);
}

.voice-lab-band {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-message-other);
}

.hero-band {
  padding: 22px 24px;
}

.control-shell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
}

.mode-chip {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 12px;
}

.status-copy {
  font-size: 13px;
  color: var(--text-secondary);
}

.mic-zone {
  position: relative;
  width: 156px;
  height: 156px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.energy-halo {
  position: absolute;
  inset: 10px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  filter: blur(14px);
  opacity: 0.16;
  transition: transform 0.18s ease, opacity 0.18s ease;
}

.energy-halo.active {
  opacity: 0.28;
}

.mic-button {
  position: relative;
  z-index: 1;
  width: 112px;
  height: 112px;
  border: none;
  border-radius: 50%;
  background: var(--color-primary);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 18px 34px color-mix(in srgb, var(--color-primary) 25%, transparent);
  cursor: pointer;
  transition: transform 0.18s ease, filter 0.18s ease, background-color 0.18s ease;
}

.mic-button.waiting {
  filter: grayscale(0.12);
}

.mic-button.active {
  background: var(--color-danger, #d74f45);
}

.mic-button .material-symbols-outlined {
  font-size: 40px;
  font-variation-settings:
    'FILL' 1,
    'wght' 350,
    'GRAD' 0,
    'opsz' 24;
}

.energy-bars {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  align-items: end;
  gap: 6px;
  width: min(340px, 100%);
  height: 44px;
}

.energy-bar {
  display: block;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 48%, transparent);
  transition: height 0.14s ease, opacity 0.14s ease;
}

.primary-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}

.voice-lab-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.95fr);
  gap: 16px;
}

.transcript-band,
.metrics-band,
.events-band,
.error-band {
  padding: 18px 20px;
}

.band-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.band-heading h2 {
  font-size: 15px;
  line-height: 1.35;
  font-weight: 600;
}

.band-heading span {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.transcript-body {
  margin-top: 16px;
  min-height: 120px;
  padding: 16px;
  border-radius: 8px;
  background: var(--bg-input, var(--bg-secondary));
  color: var(--text-primary);
  font-size: 16px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.transcript-body.empty {
  color: var(--text-tertiary);
}

.transcript-compare {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.compare-item {
  min-height: 88px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-input, var(--bg-secondary));
}

.compare-label {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.compare-item p {
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 16px;
}

.metric-item {
  min-height: 74px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-input, var(--bg-secondary));
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
}

.metric-label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.metric-value {
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-primary);
  word-break: break-word;
}

.event-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}

.event-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
}

.event-row:first-child {
  border-top: none;
  padding-top: 0;
}

.event-dot {
  width: 10px;
  height: 10px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
  flex-shrink: 0;
}

.event-dot.vad_start {
  background: #4d8cf7;
}

.event-dot.vad_end {
  background: #6fa8ff;
}

.event-dot.final {
  background: #22a06b;
}

.event-dot.error {
  background: #d74f45;
}

.event-main {
  min-width: 0;
  flex: 1;
}

.event-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.event-type,
.event-time {
  font-size: 11px;
  color: var(--text-tertiary);
}

.event-text {
  margin: 6px 0 0;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.event-inline-metrics {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.empty-state,
.error-text {
  margin-top: 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.error-band {
  border-color: color-mix(in srgb, var(--color-danger, #d74f45) 32%, var(--border-color));
}

.error-text {
  color: var(--color-danger-text, #b73232);
}

@media (max-width: 1100px) {
  .voice-lab-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .voice-lab-view {
    padding: 14px;
  }

  .hero-band,
  .transcript-band,
  .metrics-band,
  .events-band,
  .error-band {
    padding: 16px;
  }

  .metrics-grid {
    grid-template-columns: 1fr;
  }

  .transcript-compare {
    grid-template-columns: 1fr;
  }
}
</style>
