import type { VoiceAsrState } from './voiceEvents';

/** 语音通话 / 端侧识别 — 面向用户的状态文案（偏温暖、少术语） */

export const VOICE_HINT = {
  idle: '随时可以聊聊',
  connecting: '正在接通语音…',
  connected: '已接通，我在听',
  listening: '正在聆听你说话',
  liveListening: '正在听你说…',
  processing: '让我想想',
  thinking: '让我想想',
  recognized: '听清楚了',
  speaking: '正在回应你',
  onCall: '通话中',
  error: '通话有点不稳，稍后再试',
  disconnected: '通话已结束',
  micUnavailable: '还没听到你的声音',
  asrReady: '语音已准备好',
  asrUnavailable: '语音还不可用，稍后再试',
  asrError: '还没找到语音模型，装好就能通话啦',
} as const;

/** 旧版技术向文案 → 展示文案 */
const LEGACY_HINT_MAP: Record<string, string> = {
  待命: VOICE_HINT.idle,
  '正在连接端侧语音...': VOICE_HINT.connecting,
  '正在连接端侧语音…': VOICE_HINT.connecting,
  '正在连接...': VOICE_HINT.connecting,
  '正在连接…': VOICE_HINT.connecting,
  端侧识别已连接: VOICE_HINT.connected,
  '端侧 ASR 已就绪': VOICE_HINT.asrReady,
  '端侧 ASR 不可用': VOICE_HINT.asrUnavailable,
  '端侧 ASR 暂不可用': VOICE_HINT.asrUnavailable,
  检测到人声: VOICE_HINT.listening,
  '端侧正在聆听...': VOICE_HINT.liveListening,
  '端侧正在聆听…': VOICE_HINT.liveListening,
  '正在整理语音...': VOICE_HINT.processing,
  '正在整理语音…': VOICE_HINT.processing,
  已完成识别: VOICE_HINT.recognized,
  连接异常: VOICE_HINT.error,
  已断开: VOICE_HINT.disconnected,
  麦克风不可用: VOICE_HINT.micUnavailable,
  正在说话: VOICE_HINT.speaking,
  '正在聆听...': VOICE_HINT.listening,
  '正在聆听…': VOICE_HINT.listening,
  通话中: VOICE_HINT.onCall,
  正在连接: VOICE_HINT.connecting,
  正在准备: VOICE_HINT.connecting,
  '正在连接语音通道...': VOICE_HINT.connecting,
  '正在连接语音通道…': VOICE_HINT.connecting,
  持续监听中: VOICE_HINT.connected,
  通话已结束: VOICE_HINT.disconnected,
};

export function humanizeVoiceConnectionHint(
  hint?: string | null,
  options?: { isConnecting?: boolean; assistantSpeaking?: boolean },
): string {
  if (options?.assistantSpeaking) return VOICE_HINT.speaking;
  if (options?.isConnecting) return VOICE_HINT.connecting;
  const raw = (hint || '').trim();
  if (!raw) return VOICE_HINT.onCall;
  return LEGACY_HINT_MAP[raw] ?? raw;
}

/** ASR 引导信息：连接栏展示用；技术细节仍走 Message / 日志 */
export function humanizeAsrStatusMessage(message: string, state: VoiceAsrState): string {
  if (state === 'ready') return VOICE_HINT.asrReady;
  if (state === 'error') {
    // Cloud-provider problems (missing key, auth, quota, network) must keep the
    // actionable text; only "local model missing" collapses into the friendly hint.
    if (/API\s*Key|小米|阿里云|云端|鉴权|401|403|额度|quota|余额|网络/i.test(message)) return message;
    if (/models|模型|\.lingshu/i.test(message)) return VOICE_HINT.asrError;
    return VOICE_HINT.asrUnavailable;
  }
  return humanizeVoiceConnectionHint(message) || VOICE_HINT.asrUnavailable;
}
