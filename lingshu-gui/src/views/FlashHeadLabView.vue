<script setup lang="ts">
/**
 * FlashHead 数字人调试页：
 * 文本 → TTS PCM → FlashHead WS（stream_mode=frames）→ canvas 连续帧 + Web Audio。
 * 不传音频文件；不要改通话主链路。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Message from '@arco-design/web-vue/es/message';
import { FlashHeadPcmClient } from '../services/flashHeadPcmClient';
import {
  FlashHeadFramePlayer,
  parseFrameBatchBinary,
} from '../utils/flashHeadFramePlayer';
import { getFullUrl } from '../utils/apiConfig';
import { consumeSseBuffer, flushTrailingSseBuffer } from '../utils/sse.js';
import {
  playPcmStreamFromUrl,
  resolvePcmStreamMode,
} from '../utils/ttsPcmStream';
import { useChatStore } from '../stores/chat';

defineOptions({ name: 'FlashHeadLabView' });

const wsUrl = ref(localStorage.getItem('fh_ws_url') || 'ws://127.0.0.1:8765/ws');
const modelType = ref<'lite' | 'pro'>((localStorage.getItem('fh_model_type') as 'lite' | 'pro') || 'lite');
const sampleRate = ref(Number(localStorage.getItem('fh_sample_rate') || 24000));
const aspectRatio = ref(localStorage.getItem('fh_aspect_ratio') || '1:1');
const maxLongSide = ref(Number(localStorage.getItem('fh_max_long_side') || 1024));
const condImagePath = ref(localStorage.getItem('fh_cond_image') || '');
const text = ref('你好，我是灵枢数字人测试。');
const statusText = ref('idle');
const logLines = ref<string[]>([]);
const logText = computed(() => logLines.value.join('\n'));
const busy = ref(false);
const connected = ref(false);
const playingChunkIdx = ref<number | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const logBox = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const aspectOptions = [
  { value: 'original', label: '原图尺寸' },
  { value: '1:1', label: '1:1 (512×512)' },
  { value: '3:4', label: '3:4 (384×512)' },
  { value: '4:3', label: '4:3 (512×384)' },
  { value: '9:16', label: '9:16 (288×512)' },
  { value: '16:9', label: '16:9 (512×288)' },
];

const maxLongSideOptions = [
  { value: 768, label: '768（更快更省显存）' },
  { value: 1024, label: '1024（默认）' },
  { value: 1280, label: '1280（更清晰更慢）' },
];

const showMaxLongSide = computed(() => aspectRatio.value === 'original');

/** CSS aspect-ratio for preview; updated from server ready when using 原图. */
const previewBoxRatio = ref('1 / 1');

const previewAspectStyle = computed(() => ({
  aspectRatio: previewBoxRatio.value,
}));

function syncPreviewRatioFromAspect() {
  if (aspectRatio.value === 'original') return;
  const [a, b] = aspectRatio.value.split(':').map(Number);
  const w = Number.isFinite(a) && a > 0 ? a : 1;
  const h = Number.isFinite(b) && b > 0 ? b : 1;
  previewBoxRatio.value = `${w} / ${h}`;
}

syncPreviewRatioFromAspect();

const client = new FlashHeadPcmClient();
const framePlayer = new FlashHeadFramePlayer();
let abortCtrl: AbortController | null = null;
/** Serialize frame decode so batches stay in arrival order. */
let frameBatchChain: Promise<void> = Promise.resolve();
/** performance.now() when user clicked run — for TTFF logs */
let runStartPerf = 0;
let loggedPlayoutStart = false;

function clearLogs() {
  logLines.value = [];
}

function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logLines.value = [...logLines.value, line].slice(-200);
  void nextTick(() => {
    const el = logBox.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

async function copyLogs() {
  const text = logText.value || '';
  if (!text) {
    Message.warning('暂无日志');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    Message.success('日志已复制');
  } catch {
    logBox.value?.select();
    Message.info('请用 Ctrl+C 复制');
  }
}

client.onStatus = (s, detail) => {
  // Don't clobber live playout status with PCM transport states.
  if (framePlayer.started && (s === 'streaming' || s === 'flushing' || s === 'done')) {
    return;
  }
  if (s === 'closed' && busy.value) {
    log('WS closed unexpectedly before flush/done — 请重启 start_pcm_server.bat 后再连');
    connected.value = false;
  }
  const next = detail ? `${s}: ${detail}` : s;
  if (next === statusText.value) return;
  statusText.value = next;
  if (s === 'streaming') return;
  log(`status → ${statusText.value}`);
};

client.onFrameBatch = (batch) => {
  frameBatchChain = frameBatchChain
    .then(async () => {
      const { audio, jpegBlobs } = parseFrameBatchBinary(batch.payload);
      const frames: ImageBitmap[] = [];
      for (let i = 0; i < jpegBlobs.length; i++) {
        frames.push(await createImageBitmap(jpegBlobs[i]));
        // Yield so the browser can handle WS pongs / paint during long batches.
        if (i % 6 === 5) await Promise.resolve();
      }
      log(
        `frame_batch #${batch.chunkIdx} frames=${batch.nFrames} pts0=${batch.pts0.toFixed(2)}s ` +
          `${batch.elapsedSec.toFixed(2)}s`,
      );
      await framePlayer.pushBatch({
        chunkIdx: batch.chunkIdx,
        pts0: batch.pts0,
        fps: batch.fps,
        height: batch.height,
        width: batch.width,
        audioSampleRate: batch.audioSampleRate,
        audio,
        frames,
        elapsedSec: batch.elapsedSec,
      });
      if (batch.chunkIdx === 0) {
        log(
          `gen_rtf≈${(batch.elapsedSec / (batch.nFrames / Math.max(1, batch.fps))).toFixed(2)} ` +
            `live_buffer=${framePlayer.targetBufferSec.toFixed(1)}s`,
        );
      }
    })
    .catch((e) => {
      console.error('[FlashHeadLab] frame_batch decode failed', e);
      log(`frame_batch decode error: ${e instanceof Error ? e.message : String(e)}`);
    });
};

client.onInfo = (info) => {
  if (info.type === 'ready') {
    const h = Number(info.height);
    const w = Number(info.width);
    if (Number.isFinite(h) && Number.isFinite(w) && h > 0 && w > 0) {
      previewBoxRatio.value = `${w} / ${h}`;
    }
    log(
      `ready session=${info.session_id} chunk_seconds=${info.chunk_seconds} ` +
        `size=${info.height}x${info.width} stream_mode=${info.stream_mode || '-'} ` +
        `aspect=${info.aspect_ratio || '-'} max_long_side=${info.max_long_side ?? '-'}`,
    );
  }
};

function attachFramePlayer() {
  framePlayer.configure({
    minBufferSec: 0.9, // first micro-chunk (~0.96s) → start immediately
    leadInSec: 0.08,
  });
  if (!canvasEl.value) return;
  framePlayer.attach(
    canvasEl.value,
    (idx) => {
      playingChunkIdx.value = idx;
    },
    ({ bufferedSec, started, rebuffering }) => {
      if (!started) {
        statusText.value = `预缓冲 ${bufferedSec.toFixed(1)}/${framePlayer.targetBufferSec.toFixed(1)}s → 开播`;
        return;
      }
      if (!loggedPlayoutStart) {
        loggedPlayoutStart = true;
        const ttff = runStartPerf ? (performance.now() - runStartPerf) / 1000 : 0;
        log(
          `playout start ttff=${ttff.toFixed(2)}s buffered=${bufferedSec.toFixed(2)}s ` +
            `(ttff=点击→开播；日志里单块 Xs 只是 GPU 推理)`,
        );
      }
      if (rebuffering) {
        statusText.value = `追帧中（生成稍慢，定格等下一批） buffered=${bufferedSec.toFixed(1)}s`;
        return;
      }
      statusText.value = 'playing (live stream)';
    },
  );
}

onMounted(() => {
  attachFramePlayer();
});

onBeforeUnmount(() => {
  stopAll();
  framePlayer.detach();
  client.close();
});

function persistConfig() {
  localStorage.setItem('fh_ws_url', wsUrl.value.trim());
  localStorage.setItem('fh_model_type', modelType.value);
  localStorage.setItem('fh_sample_rate', String(sampleRate.value));
  localStorage.setItem('fh_aspect_ratio', aspectRatio.value);
  localStorage.setItem('fh_max_long_side', String(maxLongSide.value));
  if (condImagePath.value) localStorage.setItem('fh_cond_image', condImagePath.value);
  syncPreviewRatioFromAspect();
}

async function connect() {
  try {
    persistConfig();
    await client.connect(wsUrl.value.trim());
    connected.value = true;
    Message.success('已连接 FlashHead WS');
  } catch (e) {
    connected.value = false;
    Message.error(e instanceof Error ? e.message : String(e));
  }
}

function disconnect() {
  stopAll();
  client.close();
  connected.value = false;
  log('disconnected');
}

async function onPickImage(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!connected.value) {
    Message.warning('请先连接 WebSocket');
    return;
  }
  try {
    busy.value = true;
    const path = await client.uploadImage(file);
    condImagePath.value = path;
    localStorage.setItem('fh_cond_image', path);
    Message.success(`人像已上传: ${path}`);
    log(`uploaded ${path}`);
  } catch (e) {
    Message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

function stopAll() {
  abortCtrl?.abort();
  abortCtrl = null;
  frameBatchChain = Promise.resolve();
  loggedPlayoutStart = false;
  framePlayer.reset();
  attachFramePlayer();
  playingChunkIdx.value = null;
  busy.value = false;
}

async function runSpeak() {
  const content = text.value.trim();
  if (!content) {
    Message.warning('请输入文本');
    return;
  }
  if (!connected.value) {
    Message.warning('请先连接 FlashHead');
    return;
  }

  persistConfig();
  stopAll();
  clearLogs();
  runStartPerf = performance.now();
  loggedPlayoutStart = false;
  log('run start (stream_mode=frames)');
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;
  busy.value = true;

  try {
    await client.start({
      condImage: condImagePath.value || undefined,
      modelType: modelType.value,
      sampleRate: sampleRate.value,
      fmt: 's16le',
      streamMode: 'frames',
      jpegQuality: 55,
      // Wire preview ≤512: 768 infer keeps quality path warm, stream stays closer to realtime.
      streamMaxLongSide: 512,
      sendMp4Binary: false,
      muxAudio: false,
      emitOnFlushOnly: false,
      aspectRatio: aspectRatio.value,
      maxLongSide: Number(maxLongSide.value) || 1024,
    });

    const chatStore = useChatStore();
    const playbackId = `fh-lab-${Date.now()}`;
    const response = await fetch(getFullUrl('/api/tts/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: content,
        messageId: playbackId,
        agentId: chatStore.currentAgentId ?? undefined,
        sessionId: chatStore.currentConversationId
          ? Number(chatStore.currentConversationId)
          : undefined,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`TTS stream failed (${response.status})`);

    await consumeAndDrive(response, signal);
    await client.flush(true);
    await frameBatchChain;
    framePlayer.notifyProducerDone();
    log(
      `flush done buffered=${framePlayer.bufferedSec().toFixed(2)}s started=${framePlayer.started}`,
    );
    if (!framePlayer.started) {
      Message.warning('生成结束但仍未开播，请看日志');
    }
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError' || signal.aborted) {
      log('aborted');
      return;
    }
    console.error(e);
    Message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

type TtsSeg = {
  segmentId?: string;
  text?: string;
  audioUrl?: string;
  audioBase64?: string;
  mimeType?: string;
  format?: string;
  sampleRate?: number;
};

async function consumeAndDrive(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No TTS stream reader');

  const decoder = new TextDecoder();
  let buffer = '';
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new AudioContextClass({ sampleRate: sampleRate.value });
  if (ctx.state === 'suspended') await ctx.resume();

  const playSegment = async (seg: TtsSeg) => {
    const format = seg.format;
    const mimeType = seg.mimeType;
    const pcmMode = resolvePcmStreamMode(mimeType, format);
    if (!pcmMode) {
      throw new Error(
        `TTS 返回的不是 PCM/WAV（format=${format || '-'}, mime=${mimeType || '-'}）。请在设置里把 TTS 输出格式改为 PCM。`,
      );
    }

    let audioUrl = '';
    let revoke = false;
    if (seg.audioBase64) {
      const binary = atob(seg.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      audioUrl = URL.createObjectURL(
        new Blob([bytes], { type: mimeType || 'application/octet-stream' }),
      );
      revoke = true;
    } else if (seg.audioUrl) {
      audioUrl = getFullUrl(seg.audioUrl);
    } else {
      return;
    }

    const sr = seg.sampleRate ?? sampleRate.value;
    try {
      await playPcmStreamFromUrl(audioUrl, ctx, {
        mode: pcmMode,
        sampleRate: sr,
        signal,
        muteLocalPlayback: true,
        onPcmChunk: (bytes) => {
          try {
            client.sendPcm(bytes);
          } catch (err) {
            console.warn('[FlashHeadLab] sendPcm failed', err);
          }
        },
      });
    } finally {
      if (revoke) URL.revokeObjectURL(audioUrl);
    }
  };

  const handleEvent = async (jsonStr: string) => {
    const eventData = JSON.parse(jsonStr) as {
      type?: string;
      metadata?: TtsSeg;
    } & TtsSeg;
    if (eventData.type === 'tts_segment') {
      const seg = { ...(eventData.metadata || {}), ...eventData };
      log(`tts_segment format=${seg.format || '-'} sr=${seg.sampleRate ?? '-'}`);
      await playSegment(seg);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = consumeSseBuffer(buffer);
      buffer = rest;
      for (const jsonStr of payloads) {
        await handleEvent(jsonStr);
      }
    }
    for (const jsonStr of flushTrailingSseBuffer(buffer)) {
      await handleEvent(jsonStr);
    }
  } finally {
    if (ctx.state !== 'closed') void ctx.close();
  }
}
</script>

<template>
  <div class="fh-lab">
    <header class="fh-lab__header">
      <div>
        <h2>FlashHead 数字人测试</h2>
        <p class="sub">
          长文本也会<strong>边生成边播</strong>：预缓冲约 1.5s 后开播；若生成稍慢会短暂定格等下一批，不会等整段说完才播。
          请先启动 <code>start_pcm_server.bat</code>，TTS 格式设为 <b>PCM</b>。
        </p>
      </div>
      <a-tag :color="connected ? 'green' : 'red'">{{ connected ? 'WS 已连接' : '未连接' }}</a-tag>
    </header>

    <section class="fh-lab__grid">
      <div class="panel">
        <h3>配置</h3>
        <label>WebSocket URL</label>
        <a-input v-model="wsUrl" size="small" />

        <div class="row2">
          <div>
            <label>Model</label>
            <a-select v-model="modelType" size="small" :options="[
              { value: 'lite', label: 'lite' },
              { value: 'pro', label: 'pro' },
            ]" />
          </div>
          <div>
            <label>画面比例</label>
            <a-select
              v-model="aspectRatio"
              size="small"
              :options="aspectOptions"
              @change="syncPreviewRatioFromAspect"
            />
          </div>
        </div>

        <div v-if="showMaxLongSide" class="row2">
          <div>
            <label>原图长边上限</label>
            <a-select v-model="maxLongSide" size="small" :options="maxLongSideOptions" />
          </div>
          <div>
            <label>TTS / PCM sample_rate</label>
            <a-input-number v-model="sampleRate" size="small" :min="8000" :max="48000" :step="50" style="width: 100%" />
          </div>
        </div>

        <template v-else>
          <label>TTS / PCM sample_rate</label>
          <a-input-number v-model="sampleRate" size="small" :min="8000" :max="48000" :step="50" style="width: 100%" />
        </template>

        <label>服务端 cond_image 路径（上传后自动填）</label>
        <a-input v-model="condImagePath" size="small" placeholder="examples/girl.png 或上传后的 stream_uploads/..." />

        <div class="actions">
          <a-button type="primary" size="small" :disabled="busy" @click="connect">连接</a-button>
          <a-button size="small" @click="disconnect">断开</a-button>
          <a-button size="small" :disabled="!connected || busy" @click="fileInput?.click()">上传人像</a-button>
          <input ref="fileInput" type="file" accept="image/*" hidden @change="onPickImage" />
        </div>

        <label>朗读文本</label>
        <a-textarea v-model="text" :auto-size="{ minRows: 3, maxRows: 6 }" />

        <div class="actions">
          <a-button type="primary" :loading="busy" :disabled="!connected" @click="runSpeak">
            朗读并驱动数字人
          </a-button>
          <a-button status="danger" :disabled="!busy" @click="stopAll">停止</a-button>
        </div>

        <div class="status">状态：{{ statusText }} · 正在播 chunk：{{ playingChunkIdx ?? '-' }}</div>
      </div>

      <div class="panel preview">
        <h3>连续视频预览（低延迟连续播）</h3>
        <div class="player-stage" :style="previewAspectStyle">
          <canvas ref="canvasEl" class="player is-active" />
        </div>
        <div class="logs">
          <div class="logs__title">
            <span>日志</span>
            <div class="logs__actions">
              <a-button size="mini" @click="copyLogs">复制</a-button>
              <a-button size="mini" @click="clearLogs">清空</a-button>
            </div>
          </div>
          <textarea
            ref="logBox"
            class="logs__body"
            readonly
            :value="logText"
            placeholder="暂无日志"
            spellcheck="false"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.fh-lab {
  padding: 12px 16px 16px;
  height: 100%;
  min-height: 0;
  overflow: auto;
  box-sizing: border-box;
  background: #0f1115;
  color: #e8eaed;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fh-lab__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-shrink: 0;
}
.fh-lab__header h2 {
  margin: 0 0 4px;
  font-size: 18px;
}
.sub {
  margin: 0;
  color: #9aa0a6;
  font-size: 12px;
  line-height: 1.4;
  max-width: 720px;
}
.fh-lab__grid {
  display: grid;
  grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  flex: 1;
  min-height: 0;
}
.panel {
  background: #1a1d24;
  border: 1px solid #2a2f3a;
  border-radius: 12px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.panel h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
label {
  font-size: 12px;
  color: #9aa0a6;
}
.row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.status {
  font-size: 12px;
  color: #bdc1c6;
  margin-top: 4px;
}
.player-stage {
  position: relative;
  height: 70vh;
  width: auto;
  max-width: 100%;
  max-height: 70vh;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
}
.logs {
  width: 100%;
  max-width: 100%;
  height: 140px;
  display: flex;
  flex-direction: column;
  background: #12151b;
  border-radius: 8px;
  overflow: hidden;
}
.preview .player {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.logs__title {
  flex-shrink: 0;
  padding: 6px 8px 0;
  font-size: 12px;
  color: #bdc1c6;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.logs__actions {
  display: flex;
  gap: 6px;
}
.logs__body {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  border: 0;
  outline: none;
  resize: none;
  overflow: auto;
  padding: 4px 8px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  color: #9aa0a6;
  background: transparent;
  user-select: text;
  -webkit-user-select: text;
}
@media (max-width: 960px) {
  .fh-lab__grid {
    grid-template-columns: 1fr;
  }
}
</style>
