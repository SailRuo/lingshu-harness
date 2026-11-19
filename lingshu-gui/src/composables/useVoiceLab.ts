import { computed, onUnmounted, readonly, ref } from 'vue';
import Message from '@arco-design/web-vue/es/message';
import { type VoiceEngineEvent, type VoiceTranscriptMeta } from './voiceEvents';
import { bootstrapVoiceAsrStatus, getVoiceAsrSnapshot, useVoiceAsrStatus } from './useVoiceAsrStatus';
import { AsrStreamClient, type AsrStreamServerEvent } from '../services/asrStreamClient';
import { getFullUrl } from '../utils/apiConfig';

type VoiceLabMode = 'call' | 'push';
type VoiceLabEventType = 'status' | 'vad_start' | 'vad_end' | 'partial' | 'final' | 'error';

export interface VoiceLabEvent {
  id: string;
  type: VoiceLabEventType;
  text: string;
  createdAt: number;
  meta?: VoiceTranscriptMeta;
}




const isConnecting = ref(false);
const isActive = ref(false);
const activeMode = ref<VoiceLabMode>('call');
const inputLevel = ref(0);
const latestTranscript = ref('');
const latestRawTranscript = ref('');
const latestPunctuatedTranscript = ref('');
const latestMeta = ref<VoiceTranscriptMeta | null>(null);
const statusText = ref('待命');
const lastError = ref('');
const events = ref<VoiceLabEvent[]>([]);
const punctuationEnabled = ref(true);

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
let asrStreamClient: AsrStreamClient | null = null;

// JS-based VAD parameters & state
const SPEECH_START_FRAMES = 4;
const SPEECH_END_MS = 1000;
const MIN_SPEECH_MS_TO_FLUSH = 300;
const SPEECH_LEVEL_THRESHOLD = 0.05;
const MAX_SPEECH_ZERO_CROSSING_RATE = 0.45;
const MAX_CLICK_CREST_FACTOR = 16.0;
const NOISE_FLOOR_LERP = 0.012;

let speechActive = false;
let speechFrameCount = 0;
let silentMs = 0;
let noiseFloor = 0.005;
let candidateSpeechMs = 0;
let activeSpeechMs = 0;
let bargeInTriggered = false;



function pushEvent(type: VoiceLabEventType, text: string, meta?: VoiceTranscriptMeta) {
  events.value = [
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type,
      text,
      meta,
      createdAt: Date.now(),
    },
    ...events.value,
  ].slice(0, 40);
}







async function cleanupAudioGraph() {
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

  if (audioContext) {
    await audioContext.close();
  }
  audioContext = null;
  inputLevel.value = 0;
}

async function startAudioGraph() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  audioContext = new AudioContext();
  mediaSource = audioContext.createMediaStreamSource(mediaStream);

  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  processorNode = new AudioWorkletNode(audioContext, 'voice-processor');
  muteGainNode = audioContext.createGain();
  muteGainNode.gain.value = 0;

  processorNode.port.onmessage = (event) => {
    const { type, rms, pcm } = event.data;
    if (type === 'audio') {
      inputLevel.value = Math.min(1, rms * 6);

      asrStreamClient?.sendPcm(pcm);

      // Local JS-based VAD (for Voice Lab)
      const int16Array = Int16Array.from(pcm);
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

      // No TTS player in Lab page, so always use base threshold
      const baseThreshold = SPEECH_LEVEL_THRESHOLD;
      if (!speechActive && pcmLevel < baseThreshold) {
        noiseFloor = noiseFloor * (1 - NOISE_FLOOR_LERP) + pcmRms * NOISE_FLOOR_LERP;
      }
      const threshold = Math.max(
        baseThreshold,
        noiseFloor * 3.5 * 6,
      );
      const startFrames = SPEECH_START_FRAMES;
      const zeroCrossingRate = zeroCrossings / Math.max(1, int16Array.length - 1);
      const crestFactor = peak / Math.max(pcmRms, 0.0001);

      const looksLikeHumanVoice =
        pcmLevel >= threshold &&
        zeroCrossingRate <= MAX_SPEECH_ZERO_CROSSING_RATE &&
        crestFactor <= MAX_CLICK_CREST_FACTOR;
      const frameDurationMs = (int16Array.length / 16000) * 1000;

      const wasSpeechActive = speechActive;
      if (looksLikeHumanVoice) {
        speechFrameCount += 1;
        candidateSpeechMs += frameDurationMs;
        silentMs = 0;
        if (!speechActive && speechFrameCount >= startFrames) {
          speechActive = true;
          activeSpeechMs = candidateSpeechMs;
          if (!bargeInTriggered) {
            bargeInTriggered = true;
            console.log(`[VAD-Lab] Speech detected! level=${pcmLevel.toFixed(4)}, threshold=${threshold.toFixed(4)}`);
            applyVoiceEngineEvent({
              type: 'voice.vad_start',
              utteranceId: `js-local-vad-${Date.now()}`,
            });
          }
        }
      } else {
        silentMs += frameDurationMs;
        speechFrameCount = 0;
        candidateSpeechMs = 0;
        if (speechActive && silentMs >= SPEECH_END_MS) {
          const shouldFlush = activeSpeechMs >= MIN_SPEECH_MS_TO_FLUSH;
          console.log(`[VAD-Lab] Silence detected! activeSpeechMs=${activeSpeechMs.toFixed(0)}, shouldFlush=${shouldFlush}`);
          speechActive = false;
          activeSpeechMs = 0;
          bargeInTriggered = false;
          applyVoiceEngineEvent({
            type: 'voice.vad_end',
            utteranceId: `js-local-vad-${Date.now()}`,
          });
          if (shouldFlush) {
            asrStreamClient?.flush();
          }
        }
      }

      if ((speechActive || wasSpeechActive) && looksLikeHumanVoice) {
        activeSpeechMs += frameDurationMs;
      }
    }
  };

  mediaSource.connect(processorNode);
  processorNode.connect(muteGainNode);
  muteGainNode.connect(audioContext.destination);
}

function applyVoiceEngineEvent(event: VoiceEngineEvent) {
  if (event.type === 'voice.asr_status') {
    statusText.value = event.status.message || statusText.value;
    if (event.status.state === 'ready') {
      pushEvent('status', '端侧 ASR 已就绪');
    }
    if (event.status.state === 'error') {
      lastError.value = event.status.message || '本地语音模型缺失';
    }
    return;
  }

  if (event.type === 'voice.ready') {
    isConnecting.value = false;
    isActive.value = true;
    statusText.value = activeMode.value === 'call' ? '持续监听中' : '按住说话中';
    pushEvent('status', '端侧语音引擎已就绪');
    return;
  }

  if (event.type === 'voice.vad_start') {
    statusText.value = '检测到人声';
    pushEvent('vad_start', `VAD 起点${event.utteranceId ? ` · ${event.utteranceId}` : ''}`);
    return;
  }

  if (event.type === 'voice.vad_end') {
    statusText.value = '正在整理语音';
    pushEvent('vad_end', `VAD 终点${event.utteranceId ? ` · ${event.utteranceId}` : ''}`);
    return;
  }

  if (event.type === 'voice.asr_partial') {
    latestTranscript.value = event.text;
    statusText.value = '识别中…';
    pushEvent('partial', event.text);
    return;
  }

  if (event.type === 'voice.asr_final') {
    latestTranscript.value = event.text;
    latestRawTranscript.value = event.meta.rawText || event.text;
    latestPunctuatedTranscript.value = event.meta.punctuatedText || event.text;
    latestMeta.value = event.meta;
    statusText.value = isActive.value
      ? activeMode.value === 'call'
        ? '持续监听中'
        : '等待松手结束'
      : '已停止';
    pushEvent('final', event.text || '(空结果)', event.meta);
    return;
  }

  if (event.type === 'voice.error') {
    applyFatalError(event.detail);
    return;
  }

  if (event.type === 'voice.closed') {
    isConnecting.value = false;
    isActive.value = false;
    statusText.value = '已停止';
    pushEvent('status', '语音会话已关闭');
  }
}

async function applyFatalError(detail: string) {
  lastError.value = detail;
  statusText.value = '异常中断';
  pushEvent('error', detail);
  Message.error(detail);
  await stopSession(false);
}

async function ensureAsrStream() {
  if (!asrStreamClient) {
    asrStreamClient = new AsrStreamClient();
  }
  await asrStreamClient.connect((event: AsrStreamServerEvent) => {
    if (event.type === 'asr_partial') {
      applyVoiceEngineEvent({
        type: 'voice.asr_partial',
        text: event.text.trim(),
        meta: { source: 'backend_asr', transport: 'websocket_stream', utteranceId: event.utteranceId },
      });
      return;
    }
    if (event.type === 'asr_final') {
      const audioBase64 = event.audioBase64;
      // 如果有音频数据，请求声纹验证比对与情感识别
      if (audioBase64) {
        try {
          fetch(getFullUrl('/api/v1/user/voiceprint/verify'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64 }),
          })
            .then((res) => res.json())
            .then((vpData) => {
              if (vpData && vpData.enrolled) {
                pushEvent(
                  vpData.matched ? 'status' : 'error',
                  `[声纹检测] ${vpData.message} (得分: ${(vpData.score * 100).toFixed(0)}%, 门限: ${(vpData.threshold * 100).toFixed(0)}%)`
                );
              }
            })
            .catch(() => {});
        } catch {}

        try {
          fetch(getFullUrl('/api/v1/asr/emotion'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64 }),
          })
            .then((res) => res.json())
            .then((emoData) => {
              if (emoData && typeof emoData.valence === 'number') {
                pushEvent(
                  'status',
                  `[三维情感感知] ${emoData.note || '语气解析'} | Valence(愉悦): ${(emoData.valence * 100).toFixed(0)}% | Arousal(能量): ${(emoData.arousal * 100).toFixed(0)}% | Dominance(掌控): ${(emoData.dominance * 100).toFixed(0)}%`
                );
              }
            })
            .catch(() => {});
        } catch {}
      }

      applyVoiceEngineEvent({
        type: 'voice.asr_final',
        text: event.text.trim(),
        meta: {
          source: 'backend_asr',
          transport: 'websocket_stream',
          utteranceId: event.utteranceId,
          rawText: event.rawText,
          punctuatedText: event.punctuatedText,
          durationS: event.durationS,
          sampleRate: event.sampleRate,
          asrModel: event.asrModel,
          audioBase64: event.audioBase64,
          audioMimeType: event.audioMimeType,
        },
      });
    }
  });
}

async function closeAsrStream(flush = false) {
  const client = asrStreamClient;
  if (!client) return;
  asrStreamClient = null;
  if (flush) client.flush();
  client.close();
}

async function startSession(mode: VoiceLabMode) {
  if (isActive.value || isConnecting.value) return;

  isConnecting.value = true;
  activeMode.value = mode;
  statusText.value = mode === 'call' ? '正在启动持续监听...' : '正在启动按住说话...';
  lastError.value = '';

  try {
    await bootstrapVoiceAsrStatus();
    const asr = getVoiceAsrSnapshot();
    if (!asr.ready) {
      statusText.value = asr.message;
      Message.warning(asr.message || '端侧 ASR 不可用：请先将语音模型放到 .lingshu/models');
      isConnecting.value = false;
      return;
    }
    await ensureAsrStream();
    await startAudioGraph();
    applyVoiceEngineEvent({ type: 'voice.ready' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await applyFatalError(detail);
  }
}

async function stopSession(showToast = false) {
  const wasWorking = isActive.value || isConnecting.value;
  try {
    await cleanupAudioGraph();
    await closeAsrStream(true);

    // Reset local JS VAD state variables
    speechActive = false;
    speechFrameCount = 0;
    silentMs = 0;
    noiseFloor = 0.005;
    candidateSpeechMs = 0;
    activeSpeechMs = 0;
    bargeInTriggered = false;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lastError.value = detail;
    pushEvent('error', detail);
  } finally {
    isConnecting.value = false;
    isActive.value = false;
    inputLevel.value = 0;
    statusText.value = '已停止';
    if (wasWorking) {
      pushEvent('status', activeMode.value === 'push' ? '按住说话已结束' : '持续监听已结束');
      if (showToast) {
        Message.info('语音实验已停止');
      }
    }
  }
}

function clearEvents() {
  events.value = [];
  latestTranscript.value = '';
  latestRawTranscript.value = '';
  latestPunctuatedTranscript.value = '';
  latestMeta.value = null;
  lastError.value = '';
}

function setPunctuationEnabled(enabled: boolean) {
  punctuationEnabled.value = enabled;
}

const latestMetrics = computed(() => [
  {
    label: '采样率',
    value: latestMeta.value?.sampleRate ? `${latestMeta.value.sampleRate} Hz` : '--',
  },
  {
    label: 'RTF',
    value: typeof latestMeta.value?.rtf === 'number' ? latestMeta.value.rtf.toFixed(3) : '--',
  },
  {
    label: '片段时长',
    value: typeof latestMeta.value?.durationS === 'number' ? `${latestMeta.value.durationS.toFixed(2)} s` : '--',
  },
  {
    label: '解码耗时',
    value: typeof latestMeta.value?.decodeS === 'number' ? `${latestMeta.value.decodeS.toFixed(2)} s` : '--',
  },
  {
    label: '总耗时',
    value: typeof latestMeta.value?.serviceS === 'number' ? `${latestMeta.value.serviceS.toFixed(2)} s` : '--',
  },
  {
    label: '模型',
    value: latestMeta.value?.asrModel || '--',
  },
  {
    label: '标点',
    value: latestMeta.value?.punctModel || (punctuationEnabled.value ? '启用中' : '未启用'),
  },
]);

onUnmounted(() => {
  void stopSession();
});

export function useVoiceLab() {
  const { asrReady, asrMessage, asrState, asrProgress } = useVoiceAsrStatus();

  return {
    asrReady,
    asrMessage,
    asrState,
    asrProgress,
    isConnecting: readonly(isConnecting),
    isActive: readonly(isActive),
    activeMode: readonly(activeMode),
    inputLevel: readonly(inputLevel),
    punctuationEnabled: readonly(punctuationEnabled),
    latestTranscript: readonly(latestTranscript),
    latestRawTranscript: readonly(latestRawTranscript),
    latestPunctuatedTranscript: readonly(latestPunctuatedTranscript),
    latestMeta: readonly(latestMeta),
    latestMetrics,
    statusText: readonly(statusText),
    lastError: readonly(lastError),
    events: readonly(events),
    startSession,
    stopSession,
    clearEvents,
    setPunctuationEnabled,
  };
}
