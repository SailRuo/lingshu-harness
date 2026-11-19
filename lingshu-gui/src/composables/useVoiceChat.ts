import { ref, readonly } from 'vue';
import Message from '@arco-design/web-vue/es/message';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  normalizeLocalVoiceEvent,
  type VoiceEngineEvent,
  type VoiceMode,
  type VoiceTranscriptMeta,
} from './voiceEvents';
import { bootstrapVoiceAsrStatus, getVoiceAsrSnapshot, refreshVoiceAsrSnapshot, useVoiceAsrStatus } from './useVoiceAsrStatus';
import { asrLanguageOption, getActiveAsrProvider } from './asrProvider';
import { humanizeAsrStatusMessage, VOICE_HINT } from './voiceConnectionCopy';
import { AsrStreamAbortedError, AsrStreamClient, type AsrStreamServerEvent } from '../services/asrStreamClient';
import { useTts } from './useTts';
import { getSharedAudioContext, getTtsReferenceFrame } from '../utils/sharedAudioContext';
import { closeVoiceCallWindow } from '../utils/voiceCallWindow';

type TranscriptHandler = (text: string, mode: Exclude<VoiceMode, null>, meta?: VoiceTranscriptMeta) => Promise<void> | void;
type VadStartHandler = (mode: Exclude<VoiceMode, null>, utteranceId?: string) => Promise<void> | void;
type PushToTalkTranscriptHandler = (text: string, meta?: VoiceTranscriptMeta) => Promise<void> | void;

export interface HoldVoiceResult {
  text: string;
  durationMs: number;
  meta?: VoiceTranscriptMeta;
}

interface PendingHold {
  startedAt: number;
  released: boolean;
  canceled: boolean;
  text: string;
  finalizedSegments: string[];
  currentPartial: string;
  meta?: VoiceTranscriptMeta;
  resolve: (result: HoldVoiceResult | null) => void;
  timeoutId: number | null;
}



const isConnecting = ref(false);
const isPushToTalkActive = ref(false);
const isCallActive = ref(false);
/** True only after getUserMedia + the AudioWorklet graph are actually live. */
const micReady = ref(false);
// 通话“正在接通”态：已点通话、等 AI 问候首字，期间不采集麦克风。
const isCallConnecting = ref(false);
const isCallPanelOpen = ref(false);
const liveTranscript = ref('');
/** 通話模式下當前句子的輸入框預覽（final 後清空，僅供 UI 展示） */
const callDraftPreview = ref('');
const lastError = ref('');
const inputLevel = ref(0);
const connectionLabel = ref('端侧语音');
const connectionHint = ref<string>(VOICE_HINT.idle);
const lastTranscriptMeta = ref<VoiceTranscriptMeta | null>(null);
const isMuted = ref(false);

let currentMode: VoiceMode = null;
let capturePaused = false;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let mediaSource: MediaStreamAudioSourceNode | null = null;
let processorNode: AudioWorkletNode | null = null;
let muteGainNode: GainNode | null = null;

const WORKLET_CODE = `
class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      const length = channelData.length;

      for (let i = 0; i < length; i++) {
        this.buffer[this.bufferIndex] = channelData[i];
        this.bufferIndex++;

        if (this.bufferIndex >= this.bufferSize) {
          let sum = 0;
          for (let j = 0; j < this.bufferSize; j++) {
            sum += this.buffer[j] * this.buffer[j];
          }
          const rms = Math.sqrt(sum / this.bufferSize);

          const downsampled = this.downsample(this.buffer, sampleRate, 16000);
          const pcm16 = this.floatTo16BitPCM(downsampled);

          this.port.postMessage({
            type: 'audio',
            rms: rms,
            pcm: Array.from(pcm16)
          });

          this.bufferIndex = 0;
        }
      }
    }
    return true;
  }

  downsample(buffer, inputSampleRate, outputSampleRate) {
    if (outputSampleRate >= inputSampleRate) {
      return buffer;
    }
    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
        accum += buffer[i];
        count += 1;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }

  floatTo16BitPCM(float32Array) {
    const pcm = new Int16Array(float32Array.length);
    for (let index = 0; index < float32Array.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, float32Array[index]));
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return pcm;
  }
}

registerProcessor('voice-processor', VoiceProcessor);
`;

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}


let transcriptHandler: TranscriptHandler | null = null;
/**
 * 上传门禁旁路：仅在用户显式发起的会话（如设置页「测试识别」）里开启。
 * 开启后每帧音频都直送 ASR（等同用户已同意录音），JS VAD 只用于停顿断句；
 * 聊天模式保持原规则——VAD 确认说话前，空闲音频不出本机。
 */
let asrGateBypass = false;
function setAsrGateBypass(enabled: boolean) {
  asrGateBypass = enabled;
}

/** 测试诊断：采集链路各层的计数，定位丢音频发生在哪一层。 */
export interface VoiceDiagnostics {
  framesReceived: number;      // worklet 送达的帧数
  firstFrameLatencyMs: number | null; // 点击到第一帧的延迟
  framesForwarded: number;     // 实际进入 ASR 通道的帧数
  framesBuffered: number;      // apple 会话未就绪时暂存的帧数
  sessionReadyAtMs: number | null;    // apple 会话就绪耗时
}

const voiceDiag = {
  graphStartedAt: 0,
  framesReceived: 0,
  firstFrameLatencyMs: null as number | null,
  framesForwarded: 0,
  framesBuffered: 0,
  sessionReadyAtMs: null as number | null,
};

function resetVoiceDiagnostics(): void {
  voiceDiag.graphStartedAt = performance.now();
  voiceDiag.framesReceived = 0;
  voiceDiag.firstFrameLatencyMs = null;
  voiceDiag.framesForwarded = 0;
  voiceDiag.framesBuffered = 0;
  voiceDiag.sessionReadyAtMs = null;
}

function getVoiceDiagnostics(): VoiceDiagnostics {
  return { ...voiceDiag };
}
let vadStartHandler: VadStartHandler | null = null;
let pushToTalkTranscriptHandler: PushToTalkTranscriptHandler | null = null;
let dispatchQueue: Promise<void> = Promise.resolve();
let pendingHold: PendingHold | null = null;
let pendingHoldPromise: Promise<HoldVoiceResult | null> | null = null;
let asrStreamClient: AsrStreamClient | null = null;
// apple 会话就绪前的 PCM 缓冲：开麦先行、会话握手并行，握手期间的帧全部暂存，
// start_session 返回后按序灌入，保证点击后开口的第一个字不丢。
let appleSessionReady = false;
let applePendingPcm: Int16Array[] = [];

async function drainApplePendingPcm(): Promise<void> {
  const pending = applePendingPcm;
  applePendingPcm = [];
  for (const chunk of pending) {
    try {
      await invoke('apple_speech_push_pcm', { samples: Array.from(chunk) });
    } catch (error) {
      console.error('[Voice] Apple speech drain failed:', error);
    }
  }
}
const contextWorkletPromises = new WeakMap<AudioContext, Promise<void>>();

async function ensureVoiceProcessorWorklet(context: AudioContext): Promise<void> {
  const cached = contextWorkletPromises.get(context);
  if (cached) {
    await cached;
    return;
  }

  const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
  const loading = context.audioWorklet.addModule(blobUrl).finally(() => URL.revokeObjectURL(blobUrl));
  contextWorkletPromises.set(context, loading);
  try {
    await loading;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('already registered') && !message.includes('has already been loaded')) {
      contextWorkletPromises.delete(context);
      throw error;
    }
    contextWorkletPromises.set(context, Promise.resolve());
  }
}

/** Load the audio graph while idle so the first press only has to open the mic. */
export function prewarmVoiceCapture(): void {
  try {
    const context = getSharedAudioContext();
    void ensureVoiceProcessorWorklet(context).catch(() => undefined);
  } catch {
    // Pre-warm is best effort; startAudioGraph still sets everything up.
  }
}

// JS-based VAD parameters & state
const SPEECH_START_FRAMES = 4;
const SPEECH_START_FRAMES_DURING_TTS = 5;
// Call handoff must feel conversational. Keep enough tail silence to avoid
// splitting ordinary pauses (increased from 600ms to 1000ms to prevent splitting full sentences).
const SPEECH_END_MS = 1000;
const MIN_SPEECH_MS_TO_FLUSH = 300;
// A syllable often decays below the level gate before it has actually ended.
// Once an utterance is confirmed, retain a short tail so the last phoneme
// reaches ASR; idle microphone audio is still never uploaded.
const ASR_SPEECH_TAIL_MS = 300;
const SPEECH_LEVEL_THRESHOLD = 0.05;
const SPEECH_LEVEL_THRESHOLD_DURING_TTS = 0.095;
const MAX_SPEECH_ZERO_CROSSING_RATE = 0.45;
const MAX_CLICK_CREST_FACTOR = 16.0;
const NOISE_FLOOR_LERP = 0.012;
// Keep raw microphone audio (not just frames that already pass the energy
// gate) before the VAD confirms speech. Unvoiced consonants and soft onsets
// are the first phoneme of the utterance but sit below the gate; dropping them
// clips the first characters in ASR. The buffer stays local unless speech is
// confirmed, so idle audio is still never uploaded.
const ASR_PRE_ROLL_MS = 1000;
const ASR_SAMPLE_RATE = 16_000;
const ASR_PRE_ROLL_MAX_SAMPLES = Math.round(ASR_SAMPLE_RATE * ASR_PRE_ROLL_MS / 1000);

const speechActive = ref(false);
let speechFrameCount = 0;
let silentMs = 0;
let noiseFloor = 0.005;
let candidateSpeechMs = 0;
let activeSpeechMs = 0;
let bargeInTriggered = false;
interface AsrPreRollFrame {
  pcm: Int16Array;
  echo: boolean;
}
let asrPreRollFrames: AsrPreRollFrame[] = [];
let asrPreRollSampleCount = 0;
let asrForwardedFrameCount = 0;
const ECHO_REFERENCE_HISTORY_FRAMES = 8;
const ECHO_CORRELATION_THRESHOLD = 0.72;
const ECHO_REFERENCE_MIN_RMS = 0.006;
let ttsReferenceHistory: Float32Array[] = [];

function resetAsrPreRoll(): void {
  asrPreRollFrames = [];
  asrPreRollSampleCount = 0;
}

function resetTtsReferenceHistory(): void {
  ttsReferenceHistory = [];
}

function rememberTtsReference(): void {
  const frame = getTtsReferenceFrame();
  if (!frame) return;
  ttsReferenceHistory.unshift(frame);
  if (ttsReferenceHistory.length > ECHO_REFERENCE_HISTORY_FRAMES) {
    ttsReferenceHistory.length = ECHO_REFERENCE_HISTORY_FRAMES;
  }
}

function echoCorrelation(mic: Int16Array, reference: Float32Array): { correlation: number; referenceRms: number } {
  const length = Math.min(mic.length, reference.length);
  if (length < 32) return { correlation: 0, referenceRms: 0 };
  let dot = 0;
  let micEnergy = 0;
  let referenceEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    const micValue = mic[index] / 32768;
    const referenceValue = reference[index];
    dot += micValue * referenceValue;
    micEnergy += micValue * micValue;
    referenceEnergy += referenceValue * referenceValue;
  }
  return {
    correlation: Math.abs(dot) / Math.sqrt(Math.max(1e-12, micEnergy * referenceEnergy)),
    referenceRms: Math.sqrt(referenceEnergy / length),
  };
}

function isLikelyTtsEcho(mic: Int16Array): boolean {
  for (const reference of ttsReferenceHistory) {
    const { correlation, referenceRms } = echoCorrelation(mic, reference);
    if (referenceRms >= ECHO_REFERENCE_MIN_RMS && correlation >= ECHO_CORRELATION_THRESHOLD) {
      return true;
    }
  }
  return false;
}

function retainAsrPreRoll(frame: Int16Array, echo: boolean): void {
  const retained: AsrPreRollFrame = { pcm: Int16Array.from(frame), echo };
  asrPreRollFrames.push(retained);
  asrPreRollSampleCount += retained.pcm.length;
  while (asrPreRollSampleCount > ASR_PRE_ROLL_MAX_SAMPLES && asrPreRollFrames.length > 0) {
    const dropped = asrPreRollFrames.shift();
    asrPreRollSampleCount -= dropped?.pcm.length || 0;
  }
}

/** 测试诊断用：记录实际送入 ASR 的 PCM，停止后合成 WAV 供回放比对。 */
let asrCaptureChunks: Int16Array[] | null = null;

function startAsrCapture(): void {
  asrCaptureChunks = [];
}

function stopAsrCapture(): { wavUrl: string | null; seconds: number } {
  const chunks = asrCaptureChunks;
  asrCaptureChunks = null;
  if (!chunks || chunks.length === 0) return { wavUrl: null, seconds: 0 };
  const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0);
  const seconds = totalSamples / ASR_SAMPLE_RATE;
  const wavUrl = buildWavDataUrl(chunks, ASR_SAMPLE_RATE);
  return { wavUrl, seconds };
}

function buildWavDataUrl(chunks: Int16Array[], sampleRate: number): string | null {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  if (total <= 0) return null;
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1, offset += 2) view.setInt16(offset, chunk[i], true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function asrDiag_framesReceived(): void {
  voiceDiag.framesReceived += 1;
  if (voiceDiag.firstFrameLatencyMs === null) {
    voiceDiag.firstFrameLatencyMs = Math.round(performance.now() - voiceDiag.graphStartedAt);
  }
}

function forwardPcmToAsr(frame: Int16Array): void {
  if (asrCaptureChunks) asrCaptureChunks.push(Int16Array.from(frame));
  voiceDiag.framesForwarded += 1;
  if (getActiveAsrProvider() === 'apple') {
    // macOS 系统识别：PCM 交给 Rust 侧 Speech 框架（线程安全），结果经 voice-engine-event 回来
    if (!appleSessionReady) {
      // 会话握手未完成：先暂存，就绪后按序灌入
      applePendingPcm.push(Int16Array.from(frame));
      voiceDiag.framesBuffered += 1;
      return;
    }
    void invoke('apple_speech_push_pcm', { samples: Array.from(frame) }).catch((error) => {
      console.error('[Voice] Apple speech push failed:', error);
    });
    return;
  }
  asrStreamClient?.sendPcm(frame);
  asrForwardedFrameCount += 1;
}

function sendConfirmedSpeechWithPreRoll(): void {
  for (const frame of asrPreRollFrames) {
    if (!frame.echo) forwardPcmToAsr(frame.pcm);
  }
  resetAsrPreRoll();
}
if (isTauriRuntime()) {
  void bootstrapVoiceAsrStatus().then(() => {
    const asr = getVoiceAsrSnapshot();
    if (!asr.ready) {
      connectionHint.value = humanizeAsrStatusMessage(asr.message, asr.state);
    }
  });
}

function setCapturePaused(paused: boolean) {
  capturePaused = paused;
}

function setTranscriptHandler(handler: TranscriptHandler | null) {
  transcriptHandler = handler;
}

function setVadStartHandler(handler: VadStartHandler | null) {
  vadStartHandler = handler;
}

function setPushToTalkTranscriptHandler(handler: PushToTalkTranscriptHandler | null) {
  pushToTalkTranscriptHandler = handler;
}

function buildStreamMeta(event: Extract<AsrStreamServerEvent, { type: 'asr_final' }>): VoiceTranscriptMeta {
  return {
    source: event.asrProvider && event.asrProvider !== 'local' ? 'cloud_asr' : 'backend_asr',
    transport: 'websocket_stream',
    utteranceId: event.utteranceId,
    rawText: event.rawText,
    punctuatedText: event.punctuatedText,
    durationS: event.durationS,
    sampleRate: event.sampleRate,
    asrModel: event.asrModel,
    audioBase64: event.audioBase64,
    audioMimeType: event.audioMimeType,
    voiceprintScore: event.voiceprintScore,
    voiceprintPassed: event.voiceprintPassed,
    voiceprintEnabled: event.voiceprintEnabled,
    isGuest: event.isGuest,
    platform: 'desktop',
  };
}

function handleAsrStreamEvent(event: AsrStreamServerEvent) {
  if (event.type === 'error') {
    lastError.value = event.detail;
    connectionHint.value = VOICE_HINT.error;
    Message.error(event.detail);
    return;
  }
  if (event.type === 'ready') {
    return;
  }
  if (event.type === 'asr_partial') {
    const partial = event.text.trim();
    if (!partial) return;
    connectionHint.value = VOICE_HINT.listening;
    if (currentMode === 'push' && pendingHold) {
      pendingHold.currentPartial = partial;
      syncPendingHoldTranscript(pendingHold, {
        source: 'backend_asr',
        transport: 'websocket_stream',
        utteranceId: event.utteranceId,
        platform: 'desktop',
      });
    } else {
      liveTranscript.value = partial;
      if (currentMode === 'call') {
        callDraftPreview.value = partial;
      }
    }
    return;
  }
  if (event.type === 'asr_final') {
    const meta = buildStreamMeta(event);
    applyVoiceEngineEvent({
      type: 'voice.asr_final',
      text: event.text.trim(),
      meta,
    });
  }
}

async function ensureAsrStream() {
  if (!asrStreamClient) {
    asrStreamClient = new AsrStreamClient();
  }
  await asrStreamClient.connect(handleAsrStreamEvent);
}

// macOS 系统识别：识别结果与错误都从 Rust 的 voice-engine-event 事件回来，
// 复用 normalizeLocalVoiceEvent 归一后走与 WS 相同的 applyVoiceEngineEvent 链路。
let appleEventListenerPromise: Promise<void> | null = null;

async function ensureAppleEventListener(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (!appleEventListenerPromise) {
    appleEventListenerPromise = listen<Record<string, unknown>>('voice-engine-event', (event) => {
      const voiceEvent = normalizeLocalVoiceEvent(event.payload || {});
      if (!voiceEvent) return;
      if (voiceEvent.type === 'voice.asr_status') {
        // 状态事件由 useVoiceAsrStatus 处理
        return;
      }
      applyVoiceEngineEvent(voiceEvent);
    }).then(() => undefined);
  }
  await appleEventListenerPromise;
}

async function closeAsrStream(flush = false) {
  if (getActiveAsrProvider() === 'apple') {
    appleSessionReady = false;
    applePendingPcm = [];
    if (flush) {
      try {
        await invoke('apple_speech_flush');
        // 等待 final 结果事件回来（pendingHold 自带 3s 超时兜底）
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      } catch (error) {
        console.error('[Voice] Apple speech flush failed:', error);
      }
    }
    try {
      await invoke('apple_speech_stop_session');
    } catch (error) {
      console.error('[Voice] Apple speech stop failed:', error);
    }
    return;
  }
  const client = asrStreamClient;
  if (!client) return;
  asrStreamClient = null;
  if (flush) {
    client.flush();
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }
  client.close();
}

function flushAsrTransport(): void {
  if (getActiveAsrProvider() === 'apple') {
    void invoke('apple_speech_flush').catch((error) => {
      console.error('[Voice] Apple speech flush failed:', error);
    });
    return;
  }
  asrStreamClient?.flush();
}

function composeHoldTranscript(finalizedSegments: string[], currentPartial: string) {
  return `${finalizedSegments.join('')}${currentPartial.trim()}`.trim();
}

function commitHoldFinalSegment(pending: PendingHold, text: string) {
  const clean = text.trim();
  if (!clean) {
    pending.currentPartial = '';
    return;
  }
  const last = pending.finalizedSegments[pending.finalizedSegments.length - 1];
  if (last !== clean) {
    pending.finalizedSegments.push(clean);
  }
  pending.currentPartial = '';
}

function syncPendingHoldTranscript(pending: PendingHold, meta?: VoiceTranscriptMeta) {
  pending.text = composeHoldTranscript(pending.finalizedSegments, pending.currentPartial);
  if (meta) {
    pending.meta = meta;
  }
  if (!pending.text) return;
  liveTranscript.value = pending.text;
  connectionHint.value = VOICE_HINT.listening;
  if (pushToTalkTranscriptHandler) {
    void Promise.resolve(pushToTalkTranscriptHandler(pending.text, pending.meta)).catch((error) => {
      console.error('[Voice] Push-to-talk transcript handler failed:', error);
    });
  }
}








let audioStateListener: (() => void) | null = null;
let audioKeepAliveTimer: number | null = null;
let windowFocusListener: (() => void) | null = null;
let visibilityChangeListener: (() => void) | null = null;

function resumeAudioIfActive() {
  if (audioContext && audioContext.state === 'suspended' && (isCallActive.value || isPushToTalkActive.value)) {
    console.warn('[VoiceChat] Resuming suspended AudioContext');
    void audioContext.resume().catch((err) => {
      console.warn('[VoiceChat] Failed to resume AudioContext:', err);
    });
  }
}

function setupAudioContextKeepAlive(ctx: AudioContext) {
  teardownAudioContextKeepAlive();

  audioStateListener = () => {
    resumeAudioIfActive();
  };
  ctx.addEventListener('statechange', audioStateListener);

  windowFocusListener = () => {
    resumeAudioIfActive();
  };
  window.addEventListener('focus', windowFocusListener);

  visibilityChangeListener = () => {
    if (document.visibilityState === 'visible') {
      resumeAudioIfActive();
    }
  };
  document.addEventListener('visibilitychange', visibilityChangeListener);

  audioKeepAliveTimer = window.setInterval(() => {
    resumeAudioIfActive();
  }, 1000);
}

function teardownAudioContextKeepAlive() {
  if (audioKeepAliveTimer !== null) {
    window.clearInterval(audioKeepAliveTimer);
    audioKeepAliveTimer = null;
  }
  if (audioContext && audioStateListener) {
    audioContext.removeEventListener('statechange', audioStateListener);
    audioStateListener = null;
  }
  if (windowFocusListener) {
    window.removeEventListener('focus', windowFocusListener);
    windowFocusListener = null;
  }
  if (visibilityChangeListener) {
    document.removeEventListener('visibilitychange', visibilityChangeListener);
    visibilityChangeListener = null;
  }
}

async function cleanupAudioGraph() {
  teardownAudioContextKeepAlive();
  processorNode?.disconnect();
  mediaSource?.disconnect();
  muteGainNode?.disconnect();

  processorNode = null;
  mediaSource = null;
  muteGainNode = null;

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
  }
  mediaStream = null;

  const context = audioContext;
  audioContext = null;
  if (context) {
    await context.close();
  }
  inputLevel.value = 0;
}

async function resetVoiceState(showToast = false) {
  capturePaused = false;
  isMuted.value = false;
  micReady.value = false;
  await closeAsrStream(false);
  await cleanupAudioGraph();

  // Reset local JS VAD state variables
  speechActive.value = false;
  speechFrameCount = 0;
  silentMs = 0;
  noiseFloor = 0.005;
  candidateSpeechMs = 0;
  activeSpeechMs = 0;
  bargeInTriggered = false;
  resetAsrPreRoll();
  asrForwardedFrameCount = 0;
  resetTtsReferenceHistory();

  if (currentMode === 'push') {
    isPushToTalkActive.value = false;
  }
  if (currentMode === 'call') {
    isCallActive.value = false;
    isCallConnecting.value = false;
    isCallPanelOpen.value = false;
    void closeVoiceCallWindow();
  }
  isConnecting.value = false;
  currentMode = null;
  liveTranscript.value = '';
  callDraftPreview.value = '';
  connectionHint.value = VOICE_HINT.idle;
  lastTranscriptMeta.value = null;
  if (showToast) {
    Message.info('语音会话已结束');
  }
}

async function closeTransport(showToast = false) {
  await resetVoiceState(showToast);
}

function resolvePendingHold(result: HoldVoiceResult | null) {
  if (!pendingHold) return;
  if (pendingHold.timeoutId !== null) {
    window.clearTimeout(pendingHold.timeoutId);
  }
  const resolver = pendingHold.resolve;
  pendingHold = null;
  pendingHoldPromise = null;
  resolver(result);
}

function completePendingHoldIfReady() {
  if (!pendingHold || !pendingHold.released) return;

  if (pendingHold.canceled) {
    resolvePendingHold(null);
    void closeTransport(false);
    return;
  }

  const text = pendingHold.text.trim();
  if (!text && !pendingHold.meta?.audioBase64) return;

  resolvePendingHold({
    text,
    durationMs: Math.max(250, Date.now() - pendingHold.startedAt),
    meta: pendingHold.meta,
  });
  void closeTransport(false);
}

async function stopCaptureOnly() {
  micReady.value = false;
  teardownAudioContextKeepAlive();
  processorNode?.disconnect();
  mediaSource?.disconnect();
  muteGainNode?.disconnect();

  processorNode = null;
  mediaSource = null;
  muteGainNode = null;

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
  }
  mediaStream = null;
  audioContext = null;
  inputLevel.value = 0;
}

async function startAudioGraph() {
  const startedAt = performance.now();
  // Prepare the context and worklet before opening the microphone. Opening the
  // mic first and then waiting for addModule() discards everything the mic
  // captured during that window.
  audioContext = getSharedAudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  await ensureVoiceProcessorWorklet(audioContext);
  setupAudioContextKeepAlive(audioContext);

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  mediaSource = audioContext.createMediaStreamSource(mediaStream);

  processorNode = new AudioWorkletNode(audioContext, 'voice-processor');
  muteGainNode = audioContext.createGain();
  muteGainNode.gain.value = 0;

  processorNode.port.onmessage = (event) => {
    const { type, rms, pcm } = event.data;
    if (type === 'audio') {
      if (isMuted.value) {
        inputLevel.value = 0;
        return;
      }
      inputLevel.value = Math.min(1, rms * 6);

      if (capturePaused) return;

      // Local VAD is the first ASR gate: microphone frames are not uploaded
      // until consecutive frames have confirmed a human-voice candidate.
      const int16Array = Int16Array.from(pcm);
      asrDiag_framesReceived();
      if (asrGateBypass && !speechActive.value) {
        // 旁路模式：VAD 确认前的帧也直接上传，避免测试/显式会话丢首字
        forwardPcmToAsr(int16Array);
      }
      rememberTtsReference();
      let sum = 0;
      let peak = 0;
      let zeroCrossings = 0;
      let previousSample = 0;
      for (let i = 0; i < int16Array.length; i += 1) {
        const sample = int16Array[i] / 32768;
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
        if (i > 0 && ((sample >= 0 && previousSample < 0) || (sample < 0 && previousSample >= 0))) {
          zeroCrossings += 1;
        }
        previousSample = sample;
      }
      const pcmRms = Math.sqrt(sum / Math.max(1, int16Array.length));
      const pcmLevel = Math.min(1, pcmRms * 6);

      const { isPlaying } = useTts();
      const ttsPlaying = isPlaying.value;
      const baseThreshold = ttsPlaying ? SPEECH_LEVEL_THRESHOLD_DURING_TTS : SPEECH_LEVEL_THRESHOLD;
      if (!speechActive.value && pcmLevel < baseThreshold) {
        noiseFloor = noiseFloor * (1 - NOISE_FLOOR_LERP) + pcmRms * NOISE_FLOOR_LERP;
      }
      const threshold = Math.max(
        baseThreshold,
        noiseFloor * (ttsPlaying ? 4.8 : 3.5) * 6,
      );
      const startFrames = ttsPlaying ? SPEECH_START_FRAMES_DURING_TTS : SPEECH_START_FRAMES;
      const zeroCrossingRate = zeroCrossings / Math.max(1, int16Array.length - 1);
      const crestFactor = peak / Math.max(pcmRms, 0.0001);
      const ttsEcho = ttsPlaying && isLikelyTtsEcho(int16Array);

      const looksLikeHumanVoice =
        pcmLevel >= threshold &&
        zeroCrossingRate <= MAX_SPEECH_ZERO_CROSSING_RATE &&
        crestFactor <= MAX_CLICK_CREST_FACTOR &&
        !ttsEcho;
      const frameDurationMs = (int16Array.length / 16000) * 1000;
      const wasSpeechActive = speechActive.value;
      // Retain every frame before the gate opens, including the soft/unvoiced
      // onset that does not pass the energy test yet.
      if (!wasSpeechActive) retainAsrPreRoll(int16Array, ttsEcho);
      if (looksLikeHumanVoice) {
        speechFrameCount += 1;
        candidateSpeechMs += frameDurationMs;
        silentMs = 0;
        if (!speechActive.value && speechFrameCount >= startFrames) {
          speechActive.value = true;
          activeSpeechMs = candidateSpeechMs;
          if (asrGateBypass) {
            // 帧已在旁路模式下直送，仅清掉预滚缓冲防重发
            resetAsrPreRoll();
          } else {
            sendConfirmedSpeechWithPreRoll();
          }
          if (!bargeInTriggered) {
            bargeInTriggered = true;
            applyVoiceEngineEvent({
              type: 'voice.vad_start',
              utteranceId: `js-local-vad-${Date.now()}`,
            });
          }
        } else if (wasSpeechActive) {
          forwardPcmToAsr(int16Array);
        }
      } else {
        // Keep only the first short non-voice tail of a confirmed utterance.
        // This prevents final low-energy syllables from being clipped while
        // preserving the VAD rule that idle audio must not be uploaded.
        const shouldForwardSpeechTail = speechActive.value && (asrGateBypass || silentMs < ASR_SPEECH_TAIL_MS);
        if (shouldForwardSpeechTail) {
          forwardPcmToAsr(int16Array);
        }
        silentMs += frameDurationMs;
        // A single low-energy frame must not discard the candidate or the
        // retained onset; let the counter decay instead of resetting.
        speechFrameCount = Math.max(0, speechFrameCount - 1);
        if (speechFrameCount === 0) candidateSpeechMs = 0;
        if (speechActive.value && silentMs >= SPEECH_END_MS) {
          const shouldFlush = activeSpeechMs >= MIN_SPEECH_MS_TO_FLUSH;
          speechActive.value = false;
          activeSpeechMs = 0;
          bargeInTriggered = false;
          resetAsrPreRoll();
          asrForwardedFrameCount = 0;
          applyVoiceEngineEvent({
            type: 'voice.vad_end',
            utteranceId: `js-local-vad-${Date.now()}`,
          });
          if (shouldFlush) {
            flushAsrTransport();
          }
        }
      }

      if ((speechActive.value || wasSpeechActive) && looksLikeHumanVoice) {
        activeSpeechMs += frameDurationMs;
      }
    }
  };

  mediaSource.connect(processorNode);
  processorNode.connect(muteGainNode);
  muteGainNode.connect(audioContext.destination);
  if (import.meta.env.DEV) {
    console.info(`[voice] audio graph ready in ${Math.round(performance.now() - startedAt)}ms`);
  }
}

function queueTranscript(text: string, mode: Exclude<VoiceMode, null>, meta?: VoiceTranscriptMeta) {
  const cleanText = text.trim();
  if ((!cleanText && !meta?.audioBase64) || !transcriptHandler) return;
  dispatchQueue = dispatchQueue
    .then(async () => {
      await transcriptHandler?.(cleanText, mode, meta);
    })
    .catch((error) => {
      console.error('[Voice] Transcript dispatch failed:', error);
      Message.error('语音识别后的消息发送失败');
    });
}

function applyVoiceEngineEvent(event: VoiceEngineEvent) {
  if (event.type === 'voice.asr_status') {
    if (event.status.state === 'ready') {
      connectionHint.value = VOICE_HINT.asrReady;
    } else if (event.status.state === 'error') {
      connectionHint.value = humanizeAsrStatusMessage(
        event.status.message || '',
        'error',
      );
    } else {
      connectionHint.value = humanizeAsrStatusMessage(
        event.status.message || '',
        'unavailable',
      );
    }
    return;
  }

  if (event.type === 'voice.ready') {
    isConnecting.value = false;
    lastError.value = '';
    connectionHint.value = VOICE_HINT.connected;
    return;
  }

  if (event.type === 'voice.vad_start') {
    liveTranscript.value = VOICE_HINT.liveListening;
    connectionHint.value = VOICE_HINT.listening;
    if (currentMode && vadStartHandler) {
      void Promise.resolve(vadStartHandler(currentMode, event.utteranceId)).catch((error) => {
        console.error('[Voice] VAD start handler failed:', error);
      });
    }
    return;
  }

  if (event.type === 'voice.vad_end') {
    connectionHint.value = VOICE_HINT.thinking;
    return;
  }

  if (event.type === 'voice.asr_partial') {
    const partial = event.text.trim();
    if (!partial) return;
    liveTranscript.value = partial;
    connectionHint.value = VOICE_HINT.listening;
    return;
  }

  if (event.type === 'voice.asr_final') {
    liveTranscript.value = event.text;
    connectionHint.value = currentMode === 'call' ? VOICE_HINT.thinking : VOICE_HINT.recognized;
    lastTranscriptMeta.value = event.meta;
    if (currentMode === 'push' && pendingHold) {
      commitHoldFinalSegment(pendingHold, event.text);
      syncPendingHoldTranscript(pendingHold, event.meta);
      completePendingHoldIfReady();
      return;
    }
    if (currentMode === 'call') {
      callDraftPreview.value = '';
    }

    const cleanText = event.text.trim();
    if (!cleanText) {
      // 文本为空（被声纹过滤抹除或无有效文本），直接返回，不创建气泡不触发发送
      if (event.meta?.voiceprintEnabled && event.meta?.voiceprintPassed === false) {
        Message.warning('已自动过滤旁人或背景人声');
      }
      return;
    }

    if (currentMode) {
      queueTranscript(cleanText, currentMode, event.meta);
    }
    return;
  }

  if (event.type === 'voice.error') {
    lastError.value = event.detail;
    connectionHint.value = VOICE_HINT.error;
    resolvePendingHold(null);
    Message.error(event.detail);
    void closeTransport(false);
    return;
  }

  if (event.type === 'voice.closed') {
    connectionHint.value = VOICE_HINT.disconnected;
    resolvePendingHold(null);
    void resetVoiceState();
  }
}

async function openTransport(mode: Exclude<VoiceMode, null>) {
  if (currentMode || isConnecting.value) return;

  isConnecting.value = true;
  lastError.value = '';
  liveTranscript.value = '';
  currentMode = mode;
  connectionLabel.value = '语音';
  connectionHint.value = VOICE_HINT.connecting;
  lastTranscriptMeta.value = null;
  micReady.value = false;
  if (mode === 'push') {
    isPushToTalkActive.value = true;
  } else {
    isCallActive.value = true;
    isCallPanelOpen.value = true;
  }

  try {
    // 先开麦：麦克风打开越早，用户点击后立刻说话丢失的越少。
    // 状态检查与 ASR 会话握手并行进行；apple 的握手期 PCM 由前端缓冲兜底。
    appleSessionReady = false;
    applePendingPcm = [];
    resetVoiceDiagnostics();
    const graphPromise = startAudioGraph();
    const asr = await refreshVoiceAsrSnapshot();
    if (!asr.ready) {
      connectionHint.value = humanizeAsrStatusMessage(asr.message, asr.state);
      Message.warning(asr.message || '语音不可用：请检查端侧 VAD 与服务端 ASR 模型');
      await graphPromise.catch(() => undefined);
      await resetVoiceState();
      return;
    }
    if (getActiveAsrProvider() === 'apple') {
      await invoke('apple_speech_start_session', { language: asrLanguageOption() });
      appleSessionReady = true;
      voiceDiag.sessionReadyAtMs = Math.round(performance.now() - voiceDiag.graphStartedAt);
      await drainApplePendingPcm();
      await ensureAppleEventListener();
    } else {
      await ensureAsrStream();
    }
    await graphPromise;
    if (currentMode === mode) {
      micReady.value = true;
      connectionHint.value = VOICE_HINT.listening;
    }
  } catch (error) {
    const aborted = error instanceof AsrStreamAbortedError
      || pendingHold?.canceled
      || (pendingHold?.released && !isPushToTalkActive.value);
    if (aborted) {
      resolvePendingHold(null);
      await resetVoiceState(false);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    lastError.value = detail;
    connectionHint.value = VOICE_HINT.micUnavailable;
    Message.error(detail);
    await closeTransport(false);
  }
}

async function startPushToTalk() {
  if (isCallActive.value || isPushToTalkActive.value) return;
  await openTransport('push');
}

async function stopPushToTalk() {
  if (currentMode !== 'push') return;
  try {
    await stopCaptureOnly();
    await closeAsrStream(true);
    await closeTransport(false);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lastError.value = detail;
    connectionHint.value = VOICE_HINT.error;
    Message.error(detail);
    await closeTransport(false);
  }
}

async function startHoldRecording() {
  if (pendingHold || isCallActive.value || isPushToTalkActive.value) return;

  prewarmVoiceCapture();
  const { stop: stopTts } = useTts();
  stopTts();

  let resolver: (result: HoldVoiceResult | null) => void = () => undefined;
  pendingHoldPromise = new Promise<HoldVoiceResult | null>((resolve) => {
    resolver = resolve;
  });
  pendingHold = {
    startedAt: Date.now(),
    released: false,
    canceled: false,
    text: '',
    finalizedSegments: [],
    currentPartial: '',
    meta: undefined,
    resolve: resolver,
    timeoutId: null,
  };

  await openTransport('push');

  if (!isPushToTalkActive.value || currentMode !== 'push') {
    resolvePendingHold(null);
  }
}

async function finishHoldRecording(canceled = false): Promise<HoldVoiceResult | null> {
  if (!pendingHold) return null;

  const resultPromise = pendingHoldPromise;
  pendingHold.released = true;
  pendingHold.canceled = canceled;

  if (canceled) {
    resolvePendingHold(null);
    await closeTransport();
    return resultPromise ?? null;
  }

  try {
    await stopCaptureOnly();
    await closeAsrStream(true);
    completePendingHoldIfReady();

    if (pendingHold) {
      pendingHold.timeoutId = window.setTimeout(() => {
        resolvePendingHold(null);
        void closeTransport(false);
      }, 3000);
    }
  } catch (error) {
    resolvePendingHold(null);
    const detail = error instanceof Error ? error.message : String(error);
    lastError.value = detail;
    connectionHint.value = VOICE_HINT.error;
    Message.error(detail);
    await closeTransport(false);
  }

  return resultPromise ?? null;
}

// 启动通话采集（接通后才调）。沿用 openTransport 的 ASR/音频就绪逻辑。
async function startCaptureForCall(): Promise<boolean> {
  try {
    micReady.value = false;
    appleSessionReady = false;
    applePendingPcm = [];
    resetVoiceDiagnostics();
    const graphPromise = startAudioGraph();
    const asr = await refreshVoiceAsrSnapshot();
    if (!asr.ready) {
      connectionHint.value = humanizeAsrStatusMessage(asr.message, asr.state);
      Message.warning(asr.message || '语音不可用：请检查端侧 VAD 与服务端 ASR 模型');
      await graphPromise.catch(() => undefined);
      await resetVoiceState();
      return false;
    }
    if (getActiveAsrProvider() === 'apple') {
      await invoke('apple_speech_start_session', { language: asrLanguageOption() });
      appleSessionReady = true;
      voiceDiag.sessionReadyAtMs = Math.round(performance.now() - voiceDiag.graphStartedAt);
      await drainApplePendingPcm();
      await ensureAppleEventListener();
    } else {
      await ensureAsrStream();
    }
    await graphPromise;
    micReady.value = true;
    return true;
  } catch (error) {
    const aborted = error instanceof AsrStreamAbortedError || pendingHold?.canceled;
    if (aborted) {
      await resetVoiceState(false);
      return false;
    }
    const detail = error instanceof Error ? error.message : String(error);
    lastError.value = detail;
    connectionHint.value = VOICE_HINT.micUnavailable;
    Message.error(detail);
    await closeTransport(false);
    return false;
  }
}

// 从“正在接通”进入正式通话：AI 问候首字到达（或超时兜底）时调用，此刻才开麦。
async function activateCall() {
  if (!isCallConnecting.value) return; // 已挂断或已接通
  isCallConnecting.value = false;
  isCallActive.value = true;
  isConnecting.value = false;
  connectionHint.value = VOICE_HINT.listening;
  await startCaptureForCall();
}

async function startCall() {
  if (isPushToTalkActive.value || isCallActive.value || isCallConnecting.value) {
    isCallPanelOpen.value = true;
    return;
  }
  // 进入“正在接通”：先不采集，等 AI 问候首字（由 activateCall 推进）
  currentMode = 'call';
  isCallConnecting.value = true;
  isCallPanelOpen.value = true;
  isConnecting.value = true;
  lastError.value = '';
  liveTranscript.value = '';
  lastTranscriptMeta.value = null;
  connectionLabel.value = '语音';
  connectionHint.value = VOICE_HINT.connecting;
}

async function endCall() {
  if (currentMode !== 'call') {
    isCallPanelOpen.value = false;
    return;
  }
  // 接通期挂断：还没开始采集，直接清理
  if (isCallConnecting.value && !isCallActive.value) {
    await resetVoiceState(false);
    return;
  }
  try {
    await stopCaptureOnly();
    await closeAsrStream(true);
    await closeTransport(false);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lastError.value = detail;
    connectionHint.value = VOICE_HINT.error;
    Message.error(detail);
    await closeTransport(true);
  }
}

export function useVoiceChat() {
  const { asrReady, asrMessage, asrState, asrProgress } = useVoiceAsrStatus();

  return {
    asrReady,
    asrMessage,
    asrState,
    asrProgress,
    speechActive: readonly(speechActive),
    isConnecting: readonly(isConnecting),
    isPushToTalkActive: readonly(isPushToTalkActive),
    isCallActive: readonly(isCallActive),
    micReady: readonly(micReady),
    isCallConnecting: readonly(isCallConnecting),
    isCallPanelOpen: readonly(isCallPanelOpen),
    liveTranscript: readonly(liveTranscript),
    callDraftPreview: readonly(callDraftPreview),
    lastError: readonly(lastError),
    inputLevel: readonly(inputLevel),
    connectionLabel: readonly(connectionLabel),
    connectionHint: readonly(connectionHint),
    lastTranscriptMeta: readonly(lastTranscriptMeta),
    isMuted: readonly(isMuted),
    toggleMute: () => { isMuted.value = !isMuted.value; },
    setCapturePaused,
    setTranscriptHandler,
    setVadStartHandler,
    setPushToTalkTranscriptHandler,
    setAsrGateBypass,
    startAsrCapture,
    stopAsrCapture,
    getVoiceDiagnostics,
    startPushToTalk,
    stopPushToTalk,
    startHoldRecording,
    finishHoldRecording,
    startCall,
    endCall,
    activateCall,
    prewarmVoiceCapture,
  };
}
