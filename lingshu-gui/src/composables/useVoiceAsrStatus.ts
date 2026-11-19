import { computed, readonly, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { fetchBackendAsrStatus, type BackendAsrStatus } from '../services/asrStreamClient';
import { normalizeLocalVoiceEvent, type VoiceAsrState, type VoiceAsrStatusPayload } from './voiceEvents';
import { getActiveAsrProvider } from './asrProvider';

const TAURI_EVENT_NAME = 'voice-engine-event';

const vadState = ref<VoiceAsrState>('unavailable');
const vadMessage = ref('端侧 VAD 暂不可用');
const vadProgress = ref<number | null>(null);
const backendAsrReady = ref(false);
const backendAsrMessage = ref('正在检查服务端 ASR…');
const backendAsrModel = ref('');
const backendAsrProvider = ref<'local' | 'xiaomi' | 'aliyun'>('local');
const backendAsrProviderLabel = ref('');

/** macOS 系统识别（Speech 框架）状态；null 表示尚未查询。 */
export interface AppleSpeechStatus {
  available: boolean;
  authorized: boolean;
  authorization: string;
  onDevice: boolean;
  locale: string;
  message?: string | null;
}
const appleSpeechStatus = ref<AppleSpeechStatus | null>(null);

let listenerPromise: Promise<UnlistenFn> | null = null;
let bootstrapped = false;

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function defaultVadMessage(state: VoiceAsrState) {
  if (state === 'ready') return '端侧 VAD 已就绪';
  if (state === 'error') return '内置 VAD 模型缺失，请重新打包应用';
  return '端侧 VAD 暂不可用';
}

function applyVadStatus(payload: VoiceAsrStatusPayload) {
  vadState.value = payload.state;
  vadMessage.value = payload.message || defaultVadMessage(payload.state);
  vadProgress.value =
    typeof payload.progress === 'number' ? payload.progress : payload.state === 'ready' ? 1 : null;
}

function applyBackendStatus(payload: BackendAsrStatus) {
  backendAsrReady.value = payload.ready === true;
  backendAsrMessage.value = payload.message || (payload.ready ? '服务端流式 ASR 已就绪' : '服务端 ASR 不可用');
  backendAsrModel.value = payload.model || '';
  backendAsrProvider.value = payload.provider || 'local';
  backendAsrProviderLabel.value = payload.providerLabel || '';
}

async function refreshVadStatus() {
  if (!isTauriRuntime()) return;
  const status = await invoke<VoiceAsrStatusPayload>('voice_get_status');
  applyVadStatus(status);
}

async function refreshBackendStatus() {
  applyBackendStatus(await fetchBackendAsrStatus());
}

export async function refreshAppleSpeechStatus(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    appleSpeechStatus.value = await invoke<AppleSpeechStatus>('apple_speech_status');
  } catch {
    appleSpeechStatus.value = null;
  }
}

async function ensureListener() {
  if (!isTauriRuntime()) return;
  if (!listenerPromise) {
    listenerPromise = listen<Record<string, unknown>>(TAURI_EVENT_NAME, (event) => {
      const voiceEvent = normalizeLocalVoiceEvent(event.payload || {});
      if (voiceEvent?.type === 'voice.asr_status') {
        applyVadStatus(voiceEvent.status);
      }
    });
  }
  await listenerPromise;
}

export async function bootstrapVoiceAsrStatus() {
  if (bootstrapped) return;
  bootstrapped = true;
  await Promise.all([
    (async () => {
      if (!isTauriRuntime()) return;
      await ensureListener();
      await refreshVadStatus();
    })(),
    refreshBackendStatus(),
    refreshAppleSpeechStatus(),
  ]);
}

/**
 * 刷新全部状态源并返回当前快照。开始语音会话前调用，
 * 保证 apple 授权/可用性是最新值。
 */
export async function refreshVoiceAsrSnapshot() {
  await bootstrapVoiceAsrStatus();
  await Promise.all([refreshVadStatus(), refreshBackendStatus(), refreshAppleSpeechStatus()]);
  return getVoiceAsrSnapshot();
}

function appleSpeechState(): VoiceAsrState {
  const status = appleSpeechStatus.value;
  if (!status) return 'error';
  if (!status.available) return 'error';
  return status.authorized ? 'ready' : 'error';
}

function appleSpeechMessage(): string {
  const status = appleSpeechStatus.value;
  if (!status) return '无法获取 macOS 系统语音识别状态';
  if (!status.available) return status.message || '此系统不支持所选语言的系统语音识别';
  if (!status.authorized) return '需要在系统设置中允许语音识别（首次使用会弹出授权）';
  return status.onDevice
    ? `macOS 系统语音识别已就绪（设备端 · ${status.locale}）`
    : status.message || `macOS 系统语音识别已就绪（${status.locale}）`;
}

export function useVoiceAsrStatus() {
  void bootstrapVoiceAsrStatus();

  const asrState = computed<VoiceAsrState>(() => {
    if (!isTauriRuntime()) return 'unavailable';
    if (vadState.value !== 'ready') return vadState.value;
    if (getActiveAsrProvider() === 'apple') return appleSpeechState();
    return backendAsrReady.value ? 'ready' : 'error';
  });

  const asrMessage = computed(() => {
    if (!isTauriRuntime()) return '当前语音识别仅支持 Tauri 桌面端';
    if (vadState.value !== 'ready') return vadMessage.value;
    if (getActiveAsrProvider() === 'apple') return appleSpeechMessage();
    if (!backendAsrReady.value) return backendAsrMessage.value;
    const source = backendAsrProviderLabel.value || (backendAsrProvider.value === 'local' ? '本地模型' : '云端');
    return backendAsrModel.value
      ? `端侧 VAD + ${source} ASR 已就绪（${backendAsrModel.value}）`
      : `端侧 VAD + ${source} ASR 已就绪`;
  });

  return {
    asrState,
    asrMessage,
    vadState: readonly(vadState),
    vadMessage: readonly(vadMessage),
    vadProgress: readonly(vadProgress),
    appleSpeechStatus: readonly(appleSpeechStatus),
    backendAsrReady: readonly(backendAsrReady),
    backendAsrMessage: readonly(backendAsrMessage),
    backendAsrModel: readonly(backendAsrModel),
    backendAsrProvider: readonly(backendAsrProvider),
    backendAsrProviderLabel: readonly(backendAsrProviderLabel),
    asrProgress: readonly(vadProgress),
    asrReady: computed(() => {
      if (!isTauriRuntime() || vadState.value !== 'ready') return false;
      if (getActiveAsrProvider() === 'apple') return appleSpeechState() === 'ready';
      return backendAsrReady.value;
    }),
    refreshStatus: async () => {
      await Promise.all([refreshVadStatus(), refreshBackendStatus(), refreshAppleSpeechStatus()]);
    },
  };
}

export function getVoiceAsrSnapshot() {
  const provider = getActiveAsrProvider();
  const isApple = provider === 'apple';
  const appleState = appleSpeechState();
  const ready = isTauriRuntime()
    && vadState.value === 'ready'
    && (isApple ? appleState === 'ready' : backendAsrReady.value);
  let message = asrMessageFromParts();
  let state: VoiceAsrState = 'unavailable';
  if (!isTauriRuntime()) {
    message = '当前语音识别仅支持 Tauri 桌面端';
  } else if (vadState.value !== 'ready') {
    state = vadState.value;
    message = vadMessage.value;
  } else if (isApple && appleState !== 'ready') {
    state = appleState;
    message = appleSpeechMessage();
  } else if (!isApple && !backendAsrReady.value) {
    state = 'error';
    message = backendAsrMessage.value;
  } else {
    state = 'ready';
  }
  return {
    state,
    message,
    progress: vadProgress.value,
    ready,
    provider,
    backendAsrReady: backendAsrReady.value,
    vadReady: vadState.value === 'ready',
  };
}

function asrMessageFromParts() {
  if (!isTauriRuntime()) return '当前语音识别仅支持 Tauri 桌面端';
  if (vadState.value !== 'ready') return vadMessage.value;
  if (getActiveAsrProvider() === 'apple') return appleSpeechMessage();
  if (!backendAsrReady.value) return backendAsrMessage.value;
  return backendAsrModel.value
    ? `端侧 VAD + 服务端 ASR 已就绪（${backendAsrModel.value}）`
    : '端侧 VAD + 服务端 ASR 已就绪';
}
