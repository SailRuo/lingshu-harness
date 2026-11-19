<script setup lang="ts">
import ChatHeader from './ChatHeader.vue';
import MessageList from './MessageList.vue';
import InputArea from './InputArea.vue';
import ToolApprovalModal from './ToolApprovalModal.vue';
import RightPanel from './RightPanel.vue';
import GroupChatWorkbench from '../group-chat/GroupChatWorkbench.vue';
import { useChatStore } from '../../stores/chat';
import { useGroupChatStore } from '../../stores/groupChat';
import { useSettingsStore } from '../../stores/settings';
import { useUIStore } from '../../stores/ui';
import { useTts } from '../../composables/useTts';
import { useVoiceChat } from '../../composables/useVoiceChat';
import { watch, ref, computed, onMounted, onUnmounted } from 'vue';
import { readComposerMode, writeComposerMode } from '../../utils/composerModePersistence.js';
import {
  showVoiceCallIslandWindow,
  hideVoiceCallIslandWindow,
  closeVoiceCallWindow,
  syncVoiceCallWindow,
  listenVoiceCallEvents,
  type VoiceCallWindowState,
} from '../../utils/voiceCallWindow';
import { getVoiceDuplexWsUrl } from '../../utils/apiConfig';
import { captureScreenFrame } from '../../utils/screenCapture';

const props = defineProps<{
  /** 当前选中的群聊 ID（来自 /chat?group= 深链）。为空表示私聊模式。 */
  activeGroupId?: string;
}>();

const emit = defineEmits<{
  (event: 'open-group-settings'): void;
}>();

const chatStore = useChatStore();
const groupStore = useGroupChatStore();
const settingsStore = useSettingsStore();
const uiStore = useUIStore();

/** 群聊模式：当前选中群已加载完成时返回详情，供 GroupChatWorkbench 渲染。 */
const groupDetail = computed(() => (
  props.activeGroupId && groupStore.currentGroup?.group.id === props.activeGroupId
    ? groupStore.currentGroup
    : null
));

const { autoTtsEnabled, isPlaying, currentPlayingId, syncMessageTts, speak, stop } = useTts();
const {
  isConnecting,
  isCallActive,
  isCallConnecting,
  isPushToTalkActive,
  inputLevel,
  connectionHint,
  isMuted,
  speechActive,
  toggleMute,
  setTranscriptHandler,
  setVadStartHandler,
  startCall,
  endCall,
  activateCall,
} = useVoiceChat();
// 通话接通超时兜底：问候迟迟不来也别卡在“正在接通”
let callConnectTimeout: ReturnType<typeof setTimeout> | null = null;
function clearCallConnectTimeout() {
  if (callConnectTimeout !== null) {
    clearTimeout(callConnectTimeout);
    callConnectTimeout = null;
  }
}

// 记录通话开始时间，用于计算通话时长
let callStartTime: number | null = null;

/** AI end_voice_call：道别 TTS 播完后再挂断（对齐 gui-v2 / 本地 App）。 */
let pendingAiHangup = false;
let hangupWaitTimer: ReturnType<typeof setInterval> | null = null;
function clearHangupWait() {
  if (hangupWaitTimer !== null) {
    clearInterval(hangupWaitTimer);
    hangupWaitTimer = null;
  }
}
function scheduleHangupAfterFarewellTts() {
  pendingAiHangup = true;
  clearHangupWait();
  const startedAt = Date.now();
  let sawPlayback = isPlaying.value;
  let idleMs = 0;
  hangupWaitTimer = setInterval(() => {
    if (!pendingAiHangup) {
      clearHangupWait();
      return;
    }
    if (isPlaying.value) {
      sawPlayback = true;
      idleMs = 0;
      return;
    }
    // DONE 常早于 TTS 首包：给一段时间等开播，再等播完。
    if (!sawPlayback && Date.now() - startedAt < 8_000) return;
    idleMs += 200;
    const timedOut = Date.now() - startedAt > 60_000;
    if (idleMs >= 400 || timedOut) {
      pendingAiHangup = false;
      clearHangupWait();
      void terminateCall();
    }
  }, 200);
}
const approvalModalRef = ref<InstanceType<typeof ToolApprovalModal> | null>(null);
const composerMode = ref<'auto' | 'task' | 'chat'>(
  readComposerMode(typeof window !== 'undefined' ? window.localStorage : null) as 'auto' | 'task' | 'chat'
);
const isScreenSharing = ref<boolean>(
  typeof window !== 'undefined' && window.localStorage.getItem('voice_call_screen_share_enabled') === 'true'
);

function toggleScreenShare() {
  isScreenSharing.value = !isScreenSharing.value;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('voice_call_screen_share_enabled', String(isScreenSharing.value));
  }
}
const voiceSocket = ref<WebSocket | null>(null);
let voiceSocketReadyPromise: Promise<WebSocket> | null = null;
let resolveVoiceSocketReady: ((socket: WebSocket) => void) | null = null;
let rejectVoiceSocketReady: ((reason?: unknown) => void) | null = null;
let unlistenIslandEvents: (() => void) | null = null;
let unlistenTauriFocus: (() => void) | null = null;
const isMainWindowFocused = ref<boolean>(true);
const interruptedTtsMessageIds = new Set<string>();

const isThinking = computed(() => {
  if (!isCallActive.value && !isCallConnecting.value) return false;
  if (isPlaying.value) return false;
  if (speechActive.value) return false;
  const hasSendingAssistant = chatStore.currentMessages.some((m) => !m.isSelf && m.status === 'sending');
  if (hasSendingAssistant) return true;
  if (connectionHint.value?.includes('想') || connectionHint.value?.includes('思考') || connectionHint.value?.includes('整理')) return true;
  return false;
});

function getCurrentCallIslandState(): VoiceCallWindowState {
  return {
    avatar: chatStore.currentConversation?.avatar,
    name: chatStore.currentConversation?.name || '语音通话',
    active: isCallActive.value,
    connecting: isCallConnecting.value || isConnecting.value,
    assistantSpeaking: isPlaying.value,
    level: inputLevel.value,
    isMuted: isMuted.value,
    isScreenSharing: isScreenSharing.value,
    speechActive: speechActive.value,
    connectionHint: isThinking.value ? '让我想想' : connectionHint.value,
    isThinking: isThinking.value,
  };
}

async function handleWindowBlur() {
  isMainWindowFocused.value = false;
  if (isCallActive.value || isCallConnecting.value || isConnecting.value) {
    await showVoiceCallIslandWindow(getCurrentCallIslandState());
  }
}

async function handleWindowFocus() {
  isMainWindowFocused.value = true;
  await hideVoiceCallIslandWindow();
}

function closeVoiceSocket() {
  if (voiceSocket.value) {
    voiceSocket.value.close();
  }
  voiceSocket.value = null;
  voiceSocketReadyPromise = null;
  resolveVoiceSocketReady = null;
  rejectVoiceSocketReady = null;
}

function handleVoiceSocketMessage(raw: string) {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    console.error('[ChatWindow] Failed to parse voice WS payload:', error, raw);
    return;
  }

  const eventType = String(payload.type || '');
  if (eventType === 'voice.session_ready') {
    resolveVoiceSocketReady?.(voiceSocket.value as WebSocket);
    resolveVoiceSocketReady = null;
    rejectVoiceSocketReady = null;
    return;
  }
  if (eventType === 'voice.cancelled') {
    console.info('[BARGE_IN] server cancel acknowledged', {
      messageIds: payload.messageIds,
      cancelReason: payload.cancelReason,
    });
    return;
  }
  if (eventType === 'pong') return;
  if (eventType === 'voice.error') {
    const detail = String(payload.detail || 'unknown error');
    console.error('[ChatWindow] Voice WS error:', detail);
    const assistantMessageId =
      typeof payload.messageId === 'string' ? payload.messageId : undefined;
    if (chatStore.currentConversationId && assistantMessageId) {
      chatStore.markAssistantMessageFailed(
        chatStore.currentConversationId,
        assistantMessageId,
        `语音通道错误：${detail}`,
      );
    }
    return;
  }
  if (eventType === 'voice.voiceprint_rejected') {
    const msgId = typeof payload.messageId === 'string' ? payload.messageId : undefined;
    if (chatStore.currentConversationId && msgId) {
      chatStore.markAssistantMessageFailed(
        chatStore.currentConversationId,
        msgId,
        '已自动过滤：检测到非主人声纹（旁人或背景音）',
      );
    }
    return;
  }
  if (eventType === 'voice_asr_echo') {
    const msgId = typeof payload.messageId === 'string' ? payload.messageId : undefined;
    const echoText = typeof payload.content === 'string' ? payload.content : '';
    if (msgId && echoText) {
      chatStore.updateVoiceUserMessage(msgId, echoText);
    }
    return;
  }
  if (!chatStore.currentConversationId) return;

  const messageId = payload.messageId != null ? String(payload.messageId) : '';
  // 打断后服务端仍可能有一帧在途：旧消息的 TTS 事件一律丢弃，避免重新入队或误触发停止。
  if (
    (eventType === 'tts_segment' || eventType === 'tts_stop')
    && messageId
    && interruptedTtsMessageIds.has(messageId)
  ) {
    console.info('[BARGE_IN] discarded late TTS event', { eventType, messageId });
    return;
  }

  // 通话接通问候：服务端发起，带 callGreeting 标记。通用 dispatch 会丢弃，这里专门处理：
  // 文本事件建气泡；tts 事件直接喂播放队列（通话里音频本就该播，不看自动播放开关）。
  const meta = payload.metadata as Record<string, unknown> | undefined;
  if (meta && meta.callGreeting) {
    if (!messageId) return;
    if (eventType === 'text_delta' || eventType === 'text') {
      // 问候首字到达 = 接通：进入正式通话态、开麦
      if (isCallConnecting.value) {
        clearCallConnectTimeout();
        callStartTime = Date.now();
        void activateCall();
      }
      chatStore.appendCallGreetingBubble(
        chatStore.currentConversationId,
        messageId,
        String(payload.content || ''),
      );
    } else if (eventType === 'tts_segment') {
      syncMessageTts(messageId, [{
        segmentId: String(meta.segmentId || ''),
        audioUrl: meta.audioUrl as string | undefined,
        text: meta.text as string | undefined,
        seq: meta.seq as number | undefined,
        mimeType: meta.mimeType as string | undefined,
        format: meta.format as string | undefined,
        sampleRate: typeof meta.sampleRate === 'number' ? meta.sampleRate : undefined,
        audioBase64: meta.audioBase64 as string | undefined,
      }], null);
    } else if (eventType === 'tts_stop') {
      const stopToken = (payload.eventId as string) || `greeting-stop-${Date.now()}`;
      syncMessageTts(messageId, [], stopToken);
    }
    return;
  }

  // 模型调用 end_voice_call：先播完挂断语再关通话。
  if (
    eventType === 'done'
    && meta?.pendingHangup === true
    && (isCallActive.value || isCallConnecting.value)
  ) {
    scheduleHangupAfterFarewellTts();
  }

  chatStore.dispatchIncomingChatEvent(chatStore.currentConversationId, payload);
}

function ensureVoiceSocket(): Promise<WebSocket> {
  if (voiceSocket.value && voiceSocket.value.readyState === WebSocket.OPEN) {
    return Promise.resolve(voiceSocket.value);
  }
  if (voiceSocketReadyPromise) {
    return voiceSocketReadyPromise;
  }

  closeVoiceSocket();
  const socket = new WebSocket(getVoiceDuplexWsUrl());
  voiceSocket.value = socket;
  voiceSocketReadyPromise = new Promise<WebSocket>((resolve, reject) => {
    resolveVoiceSocketReady = resolve;
    rejectVoiceSocketReady = reject;
  });

  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      handleVoiceSocketMessage(event.data);
    }
  });
  socket.addEventListener('error', (event) => {
    rejectVoiceSocketReady?.(event);
    voiceSocketReadyPromise = null;
  });
  socket.addEventListener('close', () => {
    rejectVoiceSocketReady?.(new Error('voice websocket closed'));
    resolveVoiceSocketReady = null;
    rejectVoiceSocketReady = null;
    voiceSocketReadyPromise = null;
    if (voiceSocket.value === socket) {
      voiceSocket.value = null;
    }
  });

  return voiceSocketReadyPromise;
}

type VoiceImageRef = {
  uploadId: string;
  url: string;
  mimeType: string;
  fileName?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  summaryText?: string | null;
};

async function sendVoiceTranscript(
  text: string,
  mode: 'push' | 'call',
  meta?: {
    source?: string;
    transport?: string;
    utteranceId?: string;
    durationS?: number;
    decodeS?: number;
    rtf?: number;
    serviceS?: number;
    startS?: number;
    sampleRate?: number;
    platform?: string;
    asrModel?: string;
    audioBase64?: string;
    audioMimeType?: string;
    isGuest?: boolean;
    voiceprintScore?: number;
    voiceprintPassed?: boolean;
    voiceprintEnabled?: boolean;
    images?: VoiceImageRef[];
    attachments?: any[];
  } | null,
) {
  const conversation = chatStore.currentConversation;
  if (!conversation) return;

  latestSendTime.value = Date.now();
  // 新一轮语音输入即打断上一轮：旧消息此后到达的 TTS 帧一律丢弃。
  if (currentPlayingId.value) {
    interruptedTtsMessageIds.add(currentPlayingId.value);
  }
  stop();

  const optimisticContent = text.trim() || (meta?.audioBase64 ? '...' : '');
  const optimisticTurn = chatStore.createOptimisticVoiceTurn(optimisticContent, {
    mode,
    source: meta?.source,
    transport: meta?.transport,
    utteranceId: meta?.utteranceId,
    durationMs: typeof meta?.durationS === 'number' ? Math.max(1, Math.round(meta.durationS * 1000)) : undefined,
    sampleRate: meta?.sampleRate,
    decodeS: meta?.decodeS,
    rtf: meta?.rtf,
    serviceS: meta?.serviceS,
    startS: meta?.startS,
    platform: meta?.platform,
    asrModel: meta?.asrModel,
    audioMimeType: meta?.audioMimeType,
    attachments: meta?.attachments,
  });
  if (!optimisticTurn) return;

  let images: VoiceImageRef[] = meta?.images || [];
  if ((meta?.attachments || []).some((item) => item.type === 'image')) {
    try {
      images = await chatStore.uploadVoiceAttachmentImages(
        optimisticTurn.conversationId,
        meta?.attachments || [],
        optimisticTurn.optimisticImageMessageIds || [],
        optimisticTurn.assistantMessageId,
      );
    } catch (error) {
      console.error('[ChatWindow] Voice image upload failed:', error);
      return;
    }
  }

  // 检查是否开启共享屏幕，如果是则捕获一帧屏幕截图
  let ephemeralVisionDataUrl: string | undefined;
  if (mode === 'call' && isScreenSharing.value) {
    try {
      const screenshot = await captureScreenFrame();
      if (screenshot) {
        ephemeralVisionDataUrl = screenshot;
        console.log('[ChatWindow] Screen capture attached to voice input');
      }
    } catch (error) {
      console.warn('[ChatWindow] Screen capture failed:', error);
    }
  }

  try {
    const socket = await ensureVoiceSocket();
    socket.send(JSON.stringify({
      type: 'voice.input',
      payload: {
        message: text.trim(),
        sessionId: Number(conversation.id),
        agentId: conversation.metadata?.agentId,
        userId: chatStore.userId,
        mode: 'chat',
        source: meta?.source || 'backend_asr',
        inputKind: 'text',
        correctionMode: 'none',
        transport: meta?.transport,
        utteranceId: meta?.utteranceId,
        durationMs: typeof meta?.durationS === 'number' ? Math.max(1, Math.round(meta.durationS * 1000)) : undefined,
        sampleRate: meta?.sampleRate,
        decodeS: meta?.decodeS,
        rtf: meta?.rtf,
        serviceS: meta?.serviceS,
        startS: meta?.startS,
        platform: meta?.platform,
        asrModel: meta?.asrModel,
        audioBase64: meta?.audioBase64,
        audioMimeType: meta?.audioMimeType,
        clientHints: {
          isGuest: Boolean(meta?.isGuest),
        },
        messageId: optimisticTurn.assistantMessageId,
        images,
        ephemeralVisionDataUrl, // 发送临时视觉数据给大模型，不显示在消息记录中
      },
    }));
  } catch (error) {
    console.error('[ChatWindow] Voice WS send failed:', error);
    chatStore.markAssistantMessageFailed(
      optimisticTurn.conversationId,
      optimisticTurn.assistantMessageId,
      `语音消息发送失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// 切换会话时重置处理记录，防止误触发
watch(
  () => chatStore.currentConversationId,
  () => {
    stop();
    closeVoiceSocket();
  },
);

watch(
  () => chatStore.pendingApproval,
  (approval) => {
    if (!approval) return;
    approvalModalRef.value?.open(approval.callId, approval.toolName, approval.args, approval.taskId);
    chatStore.clearPendingApproval();
  },
  { deep: true }
);

onMounted(() => {
  setTranscriptHandler(async (text, mode, meta) => {
    if (mode !== 'call') return;
    await sendVoiceTranscript(text, mode, meta || null);
  });
  setVadStartHandler((mode) => {
    if (mode !== 'call') return;
    const wasPlaying = isPlaying.value;
    const activeVoiceSocket = voiceSocket.value;
    const voiceSocketOpen = activeVoiceSocket?.readyState === WebSocket.OPEN;
    const playingMessageId = currentPlayingId.value;

    console.info('[BARGE_IN] VAD confirmed', { wasPlaying, playingMessageId, voiceSocketOpen });
    if (wasPlaying && playingMessageId) {
      interruptedTtsMessageIds.add(playingMessageId);
    }

    stop(); // 立即打断/停止本地 TTS 音频播放
    console.info('[BARGE_IN] local playback stopped', { wasPlaying, playingMessageId });

    // 只有当 AI 正在说话（播放音频）时，用户开口才视为“打断”发送 cancel 信号；
    // 如果 AI 还没开始说话，说明是连续说话，让后端的串行锁锁住并排队，不予打断。
    if (wasPlaying && voiceSocketOpen) {
      latestSendTime.value = Date.now();
      activeVoiceSocket.send(JSON.stringify({ type: 'voice.cancel', cancelReason: 'vad_barge_in' }));
      console.info('[BARGE_IN] voice.cancel sent', { playingMessageId });
    }
  });

  void listenVoiceCallEvents({
    onReady: async () => {
      console.log('[ChatWindow] Island window is ready, syncing initial state');
      if (isCallActive.value || isCallConnecting.value || isConnecting.value) {
        await syncVoiceCallWindow(getCurrentCallIslandState());
      }
    },
    onHangup: async () => {
      console.log('[ChatWindow] onHangup received, terminating call completely');
      await terminateCall();
    },
    onToggleMute: (payload?: any) => {
      console.log('[ChatWindow] onToggleMute received! isMuted before:', isMuted.value, 'payload:', payload);
      if (typeof payload?.muted === 'boolean') {
        if (isMuted.value !== payload.muted) {
          toggleMute();
        }
      } else {
        toggleMute();
      }
      console.log('[ChatWindow] isMuted after toggleMute:', isMuted.value);
      if (!isMainWindowFocused.value) {
        void syncVoiceCallWindow(getCurrentCallIslandState());
      }
    },
    onToggleScreenShare: (payload?: any) => {
      console.log('[ChatWindow] onToggleScreenShare received! isScreenSharing before:', isScreenSharing.value, 'payload:', payload);
      if (typeof payload?.screenSharing === 'boolean') {
        if (isScreenSharing.value !== payload.screenSharing) {
          toggleScreenShare();
        }
      } else {
        toggleScreenShare();
      }
      console.log('[ChatWindow] isScreenSharing after toggle:', isScreenSharing.value);
    },
    onInterrupt: () => {
      handleInterrupt();
    },
  }).then((dispose) => {
    unlistenIslandEvents = dispose;
  });

  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void (async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const curWin = getCurrentWebviewWindow();
        isMainWindowFocused.value = await curWin.isFocused().catch(() => true);
        unlistenTauriFocus = await curWin.onFocusChanged(async (event: any) => {
          const focused = typeof event === 'boolean' ? event : Boolean(event?.payload);
          if (focused) {
            await handleWindowFocus();
          } else {
            await handleWindowBlur();
          }
        });
      } catch (e) {
        console.warn('[ChatWindow] Failed to bind Tauri focus listener:', e);
      }
    })();
  } else if (typeof window !== 'undefined') {
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
  }
});
onUnmounted(() => {
  setTranscriptHandler(null);
  setVadStartHandler(null);
  pendingAiHangup = false;
  clearHangupWait();
  clearCallConnectTimeout();
  window.removeEventListener('blur', handleWindowBlur);
  window.removeEventListener('focus', handleWindowFocus);
  unlistenTauriFocus?.();
  unlistenTauriFocus = null;
  unlistenIslandEvents?.();
  unlistenIslandEvents = null;
  void closeVoiceCallWindow();
  closeVoiceSocket();
});

const latestSendTime = ref<number>(Date.now());

function shouldAutoPlayTts(): boolean {
  // 通话链路在 latestTtsSignal 的 watch 中单独放行（不看自动朗读开关）；
  // 此处仅约束普通文字聊天：总开关必须开启，自动朗读或本地快捷开关任一开启才自动播放。
  return settingsStore.tts.enabled && (autoTtsEnabled.value || settingsStore.tts.autoRead);
}



watch(
  () => chatStore.currentConversationId,
  () => {
    latestSendTime.value = Date.now();
  }
);

// 监听通话状态变化：开始时记录时间，结束时计算时长并上报
watch(
  () => isCallActive.value,
  (active, oldActive) => {
    if (active === true && !oldActive) {
      callStartTime = Date.now();
    } else if (oldActive === true && active === false) {
      const audio = new Audio('/audio/disconnect.wav');
      audio.play().catch((err) => {
        console.warn('[ChatWindow] Failed to play disconnect audio:', err);
      });
      // 通话结束时注入系统消息（真实时长）
      if (chatStore.currentConversationId) {
        const durationSec = callStartTime ? Math.max(1, Math.floor((Date.now() - callStartTime) / 1000)) : 1;
        void chatStore.appendVoiceCallSystemMessage(
          chatStore.currentConversationId,
          'voice_call_summary',
          durationSec,
          'user',
        );
        callStartTime = null;
      }
    }
  }
);

// “正在接通”：开语音 WS 并发 thread.bind 触发后端问候；问候首字到达后由 activateCall 进通话。
watch(
  () => isCallConnecting.value,
  async (connecting, prev) => {
    if (connecting !== true || prev === true) return;
    const conv = chatStore.currentConversation;
    if (!conv) return;
    latestSendTime.value = Date.now();
    // 超时兜底：8s 还没等到问候就直接进通话，别卡住
    clearCallConnectTimeout();
    callConnectTimeout = setTimeout(() => {
      callConnectTimeout = null;
      if (isCallConnecting.value) {
        console.warn('[ChatWindow] call greeting timed out, entering call anyway');
        void activateCall();
      }
    }, 8000);
    try {
      const socket = await ensureVoiceSocket();
      socket.send(JSON.stringify({
        type: 'thread.bind',
        payload: {
          userId: chatStore.userId,
          sessionId: Number(conv.id),
          agentId: conv.metadata?.agentId,
          greet: true,
        },
      }));
    } catch (error) {
      console.error('[ChatWindow] call greeting bind failed:', error);
      // 连不上也别卡在接通中
      clearCallConnectTimeout();
      void activateCall();
    }
  }
);

// 通话结束时清理接通超时
watch(
  () => isCallActive.value,
  (active) => {
    if (!active) clearCallConnectTimeout();
  }
);

async function handleSend(content: string, attachments: any[]) {
  stop(); // 停止上一轮的 TTS 播放
  latestSendTime.value = Date.now();

  // 通话中须与 ASR 自动发话同走 voice-duplex + createOptimisticVoiceTurn；
  // 若仍走 session chat.send，会与 voice-duplex 并存，出现多个「...」占位和乱序碎片气泡。
  if (isCallActive.value) {
    const text = content.trim();
    const imageAttachments = attachments.filter((item) => item.type === 'image');
    if (!text && imageAttachments.length === 0) return;
    await sendVoiceTranscript(text, 'call', {
      source: 'manual_text',
      transport: 'keyboard',
      attachments,
    });
    return;
  }

  await chatStore.sendMessage(content, attachments, composerMode.value);
}

function handleModeChange(mode: 'auto' | 'task' | 'chat') {
  composerMode.value = mode;
  writeComposerMode(typeof window !== 'undefined' ? window.localStorage : null, mode);
}

async function terminateCall() {
  pendingAiHangup = false;
  clearHangupWait();
  clearCallConnectTimeout();
  stop();
  closeVoiceSocket();
  await endCall();
  await closeVoiceCallWindow();
}

async function handleToggleCall() {
  try {
    if (isCallActive.value || isCallConnecting.value || isConnecting.value) {
      await terminateCall();
      return;
    }
    pendingAiHangup = false;
    clearHangupWait();
    await startCall();
  } catch (error) {
    console.error('[ChatWindow] Toggle call failed:', error);
  }
}

function handleInterrupt() {
  // 立即停止本地 TTS 音频播放；旧消息的 TTS 帧随后到达也不再入队。
  if (currentPlayingId.value) {
    interruptedTtsMessageIds.add(currentPlayingId.value);
  }
  stop();
  latestSendTime.value = Date.now();
  // 向后端发送打断信号，中止大模型和 TTS 片段生成
  if (voiceSocket.value && voiceSocket.value.readyState === WebSocket.OPEN) {
    voiceSocket.value.send(JSON.stringify({ type: 'voice.cancel' }));
  }
}

// 监听最新的 TTS 片段流信号，按顺序追加到同一播放队列，完美屏蔽高频 text_delta/输入打字引起的深层递归扫描
watch(
  () => chatStore.latestTtsSignal,
  (signal) => {
    if (!signal) return;
    // 通话中的音频是服务端按句流式推送的，必须无视「自动朗读」开关；
    // 普通文字聊天仍沿用原有自动播放策略。
    const inCall = isCallActive.value || isCallConnecting.value;
    if (!inCall && !shouldAutoPlayTts()) return;
    if (chatStore.isLoadingMessages || isPushToTalkActive.value) return;

    const { messageId, segments, stopToken } = signal;
    if (!messageId) return;

    syncMessageTts(messageId, segments, stopToken);
  }
);

watch(
  () => isPushToTalkActive.value,
  (active) => {
    if (active) {
      latestSendTime.value = Date.now();
      stop();
    }
  }
);

watch(
  () => autoTtsEnabled.value,
  (enabled) => {
    if (enabled) return;
    stop();
  }
);

// 关闭「自动朗读」时立即停止当前文字聊天的语音播放（通话不受影响，其音频不走此队列）。
watch(
  () => shouldAutoPlayTts(),
  (enabled) => {
    if (enabled) return;
    if (isCallActive.value) return;
    stop();
  }
);

// 开场白朗读：开场白经 HTTP 入库、不走流式 tts_segment，这里按自动播放策略主动合成播放
watch(
  () => chatStore.latestGreetingSpeakSignal,
  (signal) => {
    if (!signal || !shouldAutoPlayTts()) return;
    if (signal.conversationId !== chatStore.currentConversationId) return;
    if (signal.timestamp < latestSendTime.value) return;
    void speak(signal.content, signal.messageId, signal.agentId);
  }
);

// 为了支持通话过程中的双向打断（用户说话即打断 TTS 播放），不再在 TTS 播放期间暂停麦克风采集
// watch(
//   () => isPlaying.value,
//   (playing) => {
//     if (isCallActive.value) {
//       setCapturePaused(playing);
//     }
//   }
// );

// 通话状态同步与失焦悬浮岛联动
watch(
  [
    () => isCallActive.value,
    () => isCallConnecting.value,
    () => isConnecting.value,
    () => isPlaying.value,
    () => inputLevel.value,
    () => isMuted.value,
    () => isScreenSharing.value,
    () => speechActive.value,
    () => connectionHint.value,
    () => isThinking.value,
    () => chatStore.currentMessages,
    () => chatStore.currentConversation,
  ],
  async ([callActive, callConnecting, connecting]) => {
    const inCall = Boolean(callActive || callConnecting || connecting);
    if (!inCall) {
      await closeVoiceCallWindow();
      return;
    }
    const state = getCurrentCallIslandState();
    if (!isMainWindowFocused.value) {
      await syncVoiceCallWindow(state);
    }
  },
  { deep: true }
);
</script>

<template>
  <main class="chat-window">
    <!-- 群聊模式：渲染群聊工作台（自带消息区与输入区，不渲染私聊 Header/输入框/审批/RightPanel） -->
    <GroupChatWorkbench
      v-if="props.activeGroupId && groupDetail"
      :detail="groupDetail"
      :messages="groupStore.messages"
      :sending="groupStore.sending"
      :loading-messages="groupStore.loadingMessages"
      :has-more-older="groupStore.hasMoreOlder"
      :director-phase="groupStore.directorPhase"
      :member-status="groupStore.memberStatus"
      :last-error="groupStore.lastError"
      @open-settings="emit('open-group-settings')"
    />
    <div v-else-if="props.activeGroupId" class="group-loading">
      <a-spin :size="24" tip="正在打开群聊…" />
    </div>
    <template v-else-if="chatStore.currentConversation">
      <ChatHeader
        :conversation="chatStore.currentConversation"
        :call-active="isCallActive"
        :is-connecting="isCallConnecting"
        :input-level="inputLevel"
        :assistant-speaking="isPlaying"
        :connection-hint="connectionHint"
        :speech-active="speechActive"
        :is-muted="isMuted"
        :is-screen-sharing="isScreenSharing"
        :is-focused="isMainWindowFocused"
        @toggle-call="handleToggleCall"
        @toggle-mute="toggleMute"
        @toggle-screen-share="toggleScreenShare"
        @interrupt="handleInterrupt"
      />
      
      <div class="chat-body-layout">
        <div class="chat-main-area">
          <MessageList
            :key="chatStore.currentConversationId || 'no-conversation'"
            :messages="chatStore.currentMessages"
            :has-more="Boolean(chatStore.currentConversationId && chatStore.hasMoreHistoryMap[chatStore.currentConversationId])"
            :loading-older="chatStore.isLoadingOlderMessages"
            @load-older="chatStore.currentConversationId && chatStore.loadOlderMessages(chatStore.currentConversationId)"
          />
          <InputArea
            :session-id="chatStore.currentConversationId"
            :mode="composerMode"
            @send="handleSend"
            @update:mode="handleModeChange"
          />
        </div>
        <RightPanel v-if="uiStore.showMemoryPanel" />
      </div>
      
      <ToolApprovalModal ref="approvalModalRef" />
    </template>
    <div v-else class="empty-chat" id="chat-empty-state">
      <div class="empty-content">
        <svg class="empty-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
          <path d="M896 128H128c-35.3 0-64 28.7-64 64v512c0 35.3 28.7 64 64 64h192l192 128 192-128h192c35.3 0 64-28.7 64-64V192c0-35.3-28.7-64-64-64z" fill="currentColor"/>
          <path d="M320 384h384v64H320zM320 512h256v64H320z" fill="var(--bg-chat-window)"/>
        </svg>
        <p class="empty-text">选择一个会话开始聊天</p>
      </div>
    </div>
  </main>
</template>

<style scoped>
.chat-window {
  flex: 1;
  min-width: 0; /* 允许在 Flex 容器中正常收缩 */
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-chat-window);
  overflow: hidden;
  position: relative;
}

.chat-body-layout {
  flex: 1;
  display: flex;
  position: relative;
  overflow: hidden;
  width: 100%;
}

.chat-main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

.empty-chat {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-4); /* 使用 Arco Design 变量或 CSS 变量 */
}

.group-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  opacity: 0.6;
}

.empty-icon {
  width: 80px;
  height: 80px;
  color: var(--color-fill-3);
}

.empty-text {
  font-size: 14px;
  color: var(--color-text-3);
}
</style>
