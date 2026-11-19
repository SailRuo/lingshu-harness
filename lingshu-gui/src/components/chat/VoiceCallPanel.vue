<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import IconMute from '@arco-design/web-vue/es/icon/icon-mute';
import IconSound from '@arco-design/web-vue/es/icon/icon-sound';
import IconDesktop from '@arco-design/web-vue/es/icon/icon-desktop';
import {
  VOICE_CALL_STATE_STORAGE_KEY,
  focusMainWindow,
  saveIslandPosition,
  type VoiceCallWindowState,
} from '../../utils/voiceCallWindow';

const state = ref<VoiceCallWindowState>({
  avatar: '',
  name: '灵枢',
  connecting: false,
  active: true,
  assistantSpeaking: false,
  level: 0,
  isMuted: false,
  isScreenSharing: false,
  speechActive: false,
  connectionHint: '',
  isThinking: false,
});

const isUserSpeaking = computed(() => {
  return state.value.speechActive || state.value.connectionHint === '正在聆听你说话' || state.value.connectionHint === '检测到人声';
});

const avatarLoadFailed = ref(false);
function handleAvatarError() {
  avatarLoadFailed.value = true;
}

const barHeights = ref([0.35, 0.55, 0.8, 0.45, 0.65, 0.35, 0.25]);
let animFrameId: number | null = null;

function startAnimation() {
  if (animFrameId !== null) return;
  const update = () => {
    if (!state.value.active && !state.value.connecting) {
      animFrameId = null;
      return;
    }
    const t = Date.now() / 1000;
    let heights = [0.35, 0.55, 0.8, 0.45, 0.65, 0.35, 0.25];

    if (state.value.isMuted) {
      heights = [0.35, 0.55, 0.8, 0.45, 0.65, 0.35, 0.25];
    } else if (state.value.connecting && !state.value.active) {
      heights = [
        0.2 + Math.max(0, Math.sin(t * 10 - 0) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 0.4) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 0.8) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 1.2) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 1.6) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 2.0) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 2.4) * 0.5),
      ];
    } else if (state.value.assistantSpeaking) {
      heights = [
        0.2 + Math.abs(Math.sin(t * 14)) * 0.7,
        0.3 + Math.abs(Math.cos(t * 16)) * 0.7,
        0.2 + Math.abs(Math.sin(t * 18)) * 0.8,
        0.4 + Math.abs(Math.cos(t * 14)) * 0.6,
        0.2 + Math.abs(Math.sin(t * 20)) * 0.75,
        0.3 + Math.abs(Math.cos(t * 15)) * 0.65,
        0.2 + Math.abs(Math.sin(t * 12)) * 0.6,
      ];
    } else if (isUserSpeaking.value) {
      const lvl = Math.max(0.1, state.value.level ?? 0);
      const amp = Math.min(1.0, lvl * 1.5);
      heights = [
        0.2 + Math.abs(Math.sin(t * 16)) * 0.7 * amp,
        0.25 + Math.abs(Math.sin(t * 20 + 0.5)) * 0.75 * amp,
        0.3 + Math.abs(Math.sin(t * 24 + 1.0)) * 0.7 * amp,
        0.35 + Math.abs(Math.sin(t * 18 + 1.5)) * 0.65 * amp,
        0.3 + Math.abs(Math.sin(t * 22 + 2.0)) * 0.7 * amp,
        0.25 + Math.abs(Math.sin(t * 19 + 2.5)) * 0.75 * amp,
        0.2 + Math.abs(Math.sin(t * 15 + 3.0)) * 0.7 * amp,
      ];
    }
    barHeights.value = heights;
    animFrameId = requestAnimationFrame(update);
  };
  animFrameId = requestAnimationFrame(update);
}

function stopAnimation() {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

watch(
  () => state.value.active || state.value.connecting,
  (active) => {
    if (active) {
      startAnimation();
    } else {
      stopAnimation();
    }
  },
  { immediate: true }
);

function applyIncomingState(payload: Partial<VoiceCallWindowState>) {
  state.value = {
    ...state.value,
    ...payload,
    avatar: payload.avatar ?? state.value.avatar,
    name: payload.name ?? state.value.name,
    active: payload.active ?? state.value.active,
    connecting: payload.connecting ?? state.value.connecting,
    assistantSpeaking: payload.assistantSpeaking ?? state.value.assistantSpeaking,
    level: payload.level ?? state.value.level,
    isMuted: payload.isMuted ?? state.value.isMuted,
    isScreenSharing: payload.isScreenSharing ?? state.value.isScreenSharing,
    speechActive: payload.speechActive ?? state.value.speechActive,
    connectionHint: payload.connectionHint ?? state.value.connectionHint,
    isThinking: payload.isThinking ?? state.value.isThinking,
  };
}

const dockMode = ref<'island' | 'taskbar'>('island');
const isSnappingNearBottom = ref<boolean>(false);

function restorePersistedState() {
  try {
    const raw = localStorage.getItem(VOICE_CALL_STATE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VoiceCallWindowState>;
      if (parsed && typeof parsed === 'object') {
        applyIncomingState(parsed);
      }
    }
    const posRaw = localStorage.getItem('lingshu.voice_call_window.pos');
    if (posRaw) {
      const posParsed = JSON.parse(posRaw) as { dockMode?: 'island' | 'taskbar' };
      if (posParsed?.dockMode === 'taskbar') {
        dockMode.value = 'taskbar';
      }
    }
  } catch (error) {
    console.warn('[VoiceCallIsland] Failed to restore persisted state:', error);
  }
}

let unlistenState: (() => void) | null = null;

async function emitEvent(eventName: string) {
  if (!('__TAURI_INTERNALS__' in window)) {
    console.warn('[VoiceCallIsland] NOT in Tauri runtime, skip emit:', eventName);
    return;
  }
  try {
    const { emit, emitTo } = await import('@tauri-apps/api/event');
    console.log('[VoiceCallIsland] emitting event:', eventName);
    const results = await Promise.allSettled([
      emit(eventName),
      emitTo('main', eventName),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.warn(`[VoiceCallIsland] emit[${i}] failed:`, r.reason);
      else console.log(`[VoiceCallIsland] emit[${i}] ok`);
    });
  } catch (e) {
    console.warn('[VoiceCallIsland] emitEvent failed:', e);
  }
}

function handleInterrupt() {
  if (state.value.assistantSpeaking) {
    void emitEvent('voice-call:interrupt');
  }
}

let lastMuteClick = 0;
async function handleToggleMute() {
  const now = Date.now();
  if (now - lastMuteClick < 250) return;
  lastMuteClick = now;

  const targetMuted = !state.value.isMuted;
  console.log('[VoiceCallIsland] handleToggleMute clicked, setting isMuted to:', targetMuted);
  state.value = { ...state.value, isMuted: targetMuted };

  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('island_toggle_mute', { muted: targetMuted });
      console.log('[VoiceCallIsland] Rust island_toggle_mute invoked with:', targetMuted);
    } catch (e) {
      console.warn('[VoiceCallIsland] Rust island_toggle_mute error, fallback emit:', e);
      void emitEvent('voice-call:toggle-mute');
    }
  } else {
    void emitEvent('voice-call:toggle-mute');
  }
}

let lastScreenShareClick = 0;
async function handleToggleScreenShare() {
  const now = Date.now();
  if (now - lastScreenShareClick < 250) return;
  lastScreenShareClick = now;

  const targetScreenSharing = !state.value.isScreenSharing;
  console.log('[VoiceCallIsland] handleToggleScreenShare clicked, setting isScreenSharing to:', targetScreenSharing);
  state.value = { ...state.value, isScreenSharing: targetScreenSharing };

  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('island_toggle_screen_share', { screenSharing: targetScreenSharing });
      console.log('[VoiceCallIsland] Rust island_toggle_screen_share invoked with:', targetScreenSharing);
    } catch (e) {
      console.warn('[VoiceCallIsland] Rust island_toggle_screen_share error, fallback emit:', e);
      void emitEvent('voice-call:toggle-screen-share');
    }
  } else {
    void emitEvent('voice-call:toggle-screen-share');
  }
}

async function handleHangup() {
  console.log('[VoiceCallIsland] User clicked hangup button');
  void emitEvent('voice-call:hangup');

  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('hangup_voice_call');
    } catch (err) {
      console.warn('[VoiceCallIsland] Rust hangup_voice_call fallback:', err);
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const win = getCurrentWebviewWindow();
        await win.hide();
        await win.close();
      } catch {}
    }
  }
}

let appWindow: any = null;

async function getAppWindow() {
  if (appWindow) return appWindow;
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      appWindow = getCurrentWebviewWindow();
    } catch {}
  }
  return appWindow;
}

// --- 自管理 Pointer 拖拽与任务栏磁吸贴附 ---
let isDragging = false;
let dragStartTime = 0;
let dragStartScreenX = 0;
let dragStartScreenY = 0;
let dragStartLogicalX = 0;
let dragStartLogicalY = 0;
let dragBoundsMinX = 0;
let dragBoundsMaxX = 9999;
let dragBoundsMinY = 0;
let dragBoundsMaxY = 9999;
let dragLastX = 0;
let dragLastY = 0;
let dragIsClick = false;

// 预缓存，避免每次 pointermove 动态 import（耗时）
let cachedLogicalPosition: any = null;
let rafPending = false;
let pendingX = 0;
let pendingY = 0;

async function handleIslandPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('.island-btn') || target?.closest('.avatar-wrap.is-interruptable')) return;

  const win = await getAppWindow();
  if (!win) return;

  try {
    // 预热 LogicalPosition（首次 import 较慢，后续从 module cache 直接取）
    if (!cachedLogicalPosition) {
      const dpiMod = await import('@tauri-apps/api/dpi');
      cachedLogicalPosition = dpiMod.LogicalPosition;
    }

    const factor: number = (await win.scaleFactor?.()) || 1;
    const physPos = await win.outerPosition();
    if (!physPos) return;

    dragStartLogicalX = Math.round(physPos.x / factor);
    dragStartLogicalY = Math.round(physPos.y / factor);
    dragLastX = dragStartLogicalX;
    dragLastY = dragStartLogicalY;
    dragStartScreenX = e.screenX;
    dragStartScreenY = e.screenY;
    dragStartTime = Date.now();
    dragIsClick = true;

    // 预取当前显示器边界
    const { currentMonitor, primaryMonitor } = await import('@tauri-apps/api/window');
    const mon = (await currentMonitor()) || (await primaryMonitor());
    if (mon) {
      const mf = mon.scaleFactor || factor;
      const monX = Math.round(mon.position.x / mf);
      const monY = Math.round(mon.position.y / mf);
      const sw = mon.size.width / mf;
      const sh = mon.size.height / mf;
      dragBoundsMinX = monX + 8;
      dragBoundsMaxX = monX + Math.max(8, sw - 290 - 8);
      dragBoundsMinY = monY + 8;
      dragBoundsMaxY = monY + Math.max(8, sh - 40);
    } else {
      dragBoundsMinX = 8;
      dragBoundsMaxX = 1912;
      dragBoundsMinY = 8;
      dragBoundsMaxY = 1040;
    }

    isDragging = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  } catch (err) {
    console.warn('[VoiceCallIsland] drag init failed:', err);
  }
}

function handleIslandPointerMove(e: PointerEvent) {
  if (!isDragging) return;
  e.preventDefault();

  const dx = e.screenX - dragStartScreenX;
  const dy = e.screenY - dragStartScreenY;
  if (Math.hypot(dx, dy) > 4) dragIsClick = false;

  const rawTargetX = dragStartLogicalX + dx;
  const rawTargetY = dragStartLogicalY + dy;

  // 靠近屏幕底部（32px 以内）触发磁吸任务栏预览
  const distToBottom = dragBoundsMaxY - rawTargetY;
  if (distToBottom <= 32) {
    isSnappingNearBottom.value = true;
    dockMode.value = 'taskbar';
  } else {
    isSnappingNearBottom.value = false;
    if (distToBottom > 50) {
      dockMode.value = 'island';
    }
  }

  const targetX = Math.round(Math.min(Math.max(dragBoundsMinX, rawTargetX), dragBoundsMaxX));
  const targetY = Math.round(Math.min(Math.max(dragBoundsMinY, rawTargetY), dragBoundsMaxY));

  if (targetX === dragLastX && targetY === dragLastY) return;
  dragLastX = targetX;
  dragLastY = targetY;
  pendingX = targetX;
  pendingY = targetY;

  // rAF 节流：每帧最多调用一次 setPosition，避免 IPC 堆积
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const win = appWindow;
      if (!win || !isDragging) return;
      const Pos = cachedLogicalPosition;
      if (!Pos) return;
      // fire-and-forget，不 await，避免阻塞
      void win.setPosition(new Pos(pendingX, pendingY));
    });
  }
}

async function handleIslandPointerUp(e: PointerEvent) {
  if (!isDragging) return;
  isDragging = false;
  try {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {}

  const win = await getAppWindow();

  // 释放时如果处于任务栏磁吸区域，自动贴附对齐到任务栏
  if (isSnappingNearBottom.value || dragLastY >= dragBoundsMaxY - 32) {
    dockMode.value = 'taskbar';
    isSnappingNearBottom.value = false;
    dragLastY = dragBoundsMaxY;
    if (win) {
      const { LogicalPosition } = await import('@tauri-apps/api/dpi');
      await win.setPosition(new LogicalPosition(dragLastX, dragBoundsMaxY));
    }
  } else {
    isSnappingNearBottom.value = false;
  }

  saveIslandPosition({ x: dragLastX, y: dragLastY, dockMode: dockMode.value });

  if (dragIsClick && Date.now() - dragStartTime < 350) {
    void focusMainWindow();
  }
}

onMounted(async () => {
  const win = await getAppWindow();
  restorePersistedState();
  if (!('__TAURI_INTERNALS__' in window)) return;

  // 挂载时强制置顶，防止系统/任务栏抢占
  if (win) {
    try { await win.setAlwaysOnTop(true); } catch {}
  }

  const { listen } = await import('@tauri-apps/api/event');
  unlistenState = await listen<VoiceCallWindowState>('voice-call:state', (event) => {
    applyIncomingState(event.payload);
  });

  // 监听窗口失焦：一旦失去焦点就重新强制置顶
  if (win) {
    try {
      await win.onFocusChanged(async (event: any) => {
        const focused = typeof event === 'boolean' ? event : Boolean(event?.payload);
        if (!focused) {
          // 失焦后稍延迟重新 setAlwaysOnTop，保证始终在上层
          setTimeout(async () => {
            try { await win.setAlwaysOnTop(true); } catch {}
          }, 50);
        }
      });
    } catch {}
  }

  void emitEvent('voice-call:ready');
});

onUnmounted(() => {
  isDragging = false;
  stopAnimation();
  unlistenState?.();
  unlistenState = null;
});

const displayStatusLabel = computed(() => {
  if (isSnappingNearBottom.value) return '吸附至任务栏';
  if (state.value.connecting && !state.value.active) return '接通中';
  if (state.value.assistantSpeaking) return '说话中';
  if (state.value.isThinking || state.value.connectionHint?.includes('想') || state.value.connectionHint?.includes('思考') || state.value.connectionHint?.includes('整理')) {
    return '让我想想';
  }
  if (state.value.speechActive || isUserSpeaking.value) return '我在听';
  if (state.value.connectionHint && state.value.connectionHint !== '通话中' && state.value.connectionHint !== '随时可以聊聊' && !state.value.connectionHint.includes('我在听')) {
    return state.value.connectionHint;
  }
  return '我在听';
});
</script>

<template>
  <div class="island-container" @dragstart.prevent>
    <div
      v-if="state.active || state.connecting"
      class="calling-island"
      :class="{
        'is-ai-speaking': state.assistantSpeaking,
        'is-user-speaking': !state.assistantSpeaking && isUserSpeaking,
        'is-thinking': !state.assistantSpeaking && !isUserSpeaking && (state.isThinking || displayStatusLabel === '让我想想'),
        'dock-mode-taskbar': dockMode === 'taskbar',
        'dock-mode-island': dockMode === 'island',
        'is-snapping-preview': isSnappingNearBottom,
      }"
      @dragstart.prevent
      @pointerdown="handleIslandPointerDown"
      @pointermove="handleIslandPointerMove"
      @pointerup="handleIslandPointerUp"
      @pointercancel="handleIslandPointerUp"
      :title="dockMode === 'taskbar' ? '已吸附至任务栏 (向上拖动可恢复为灵动岛)' : '点击返回主界面，按住可拖动 (拖至底部可吸附任务栏)'"
    >
      <!-- 任务栏形态下的微型拖动把手条 -->
      <div v-if="dockMode === 'taskbar'" class="taskbar-drag-handle" title="按住向上拖出任务栏"></div>

      <!-- 左侧：智能体头像（带状态光晕与小波形角标） -->
      <div
        class="avatar-wrap"
        :class="{
          'is-ai-speaking': state.assistantSpeaking,
          'is-user-speaking': !state.assistantSpeaking && isUserSpeaking,
          'is-thinking': !state.assistantSpeaking && !isUserSpeaking && (state.isThinking || displayStatusLabel === '让我想想'),
          'is-interruptable': state.assistantSpeaking
        }"
        :title="state.assistantSpeaking ? '点击打断发言' : undefined"
        @click.stop="handleInterrupt"
      >
        <img
          v-if="state.avatar && !avatarLoadFailed"
          class="agent-avatar"
          :src="state.avatar"
          :alt="state.name || '智能体'"
          @error="handleAvatarError"
        />
        <div v-else class="agent-avatar-fallback">
          {{ (state.name || '灵')[0] }}
        </div>

        <!-- 说话中的动态声波微指示 -->
        <div v-if="state.assistantSpeaking || isUserSpeaking" class="speaking-badge">
          <span class="mini-bar" :style="{ transform: `scaleY(${barHeights[1]})` }"></span>
          <span class="mini-bar" :style="{ transform: `scaleY(${barHeights[2]})` }"></span>
          <span class="mini-bar" :style="{ transform: `scaleY(${barHeights[3]})` }"></span>
        </div>
      </div>

      <!-- 中间：角色名与实时状态文本 -->
      <div class="island-info">
        <span class="agent-name">{{ state.name || '灵枢' }}</span>
        <span class="agent-status">{{ displayStatusLabel }}</span>
      </div>

      <!-- 右侧：操作区 -->
      <div class="island-actions" @pointerdown.stop @mousedown.stop>
        <!-- 静音按钮 -->
        <button
          class="island-btn mute-btn"
          :class="{ 'is-muted': state.isMuted }"
          type="button"
          :title="state.isMuted ? '取消静音' : '静音'"
          @pointerdown.stop
          @click.stop="handleToggleMute"
        >
          <IconMute v-if="state.isMuted" class="btn-icon" />
          <IconSound v-else class="btn-icon" />
        </button>

        <!-- 屏幕共享按钮 -->
        <button
          class="island-btn screen-share-btn"
          :class="{ 'is-active': state.isScreenSharing }"
          type="button"
          :title="state.isScreenSharing ? '关闭屏幕共享' : '开启屏幕共享'"
          @pointerdown.stop
          @click.stop="handleToggleScreenShare"
        >
          <IconDesktop class="btn-icon" />
        </button>

        <!-- 挂断按钮（app-local 经典红色圆钮） -->
        <button
          class="island-btn hangup-btn"
          type="button"
          title="挂断通话"
          @pointerdown.stop
          @click.stop="handleHangup"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" class="hangup-icon">
            <path d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.island-container {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
}

.calling-island {
  position: relative;
  display: flex;
  align-items: center;
  background: rgba(18, 24, 32, 0.94);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.18);
  padding: 3px 8px 3px 10px;
  border-radius: 999px;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  height: 38px;
  box-sizing: border-box;
  gap: 8px;
  transition: border-color 0.25s ease, box-shadow 0.25s ease, border-radius 0.2s ease, height 0.2s ease, background 0.2s ease;
  overflow: hidden;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
}

.calling-island:active {
  cursor: grabbing;
}

/* 任务栏形态（真正置于任务栏内，与汽水音乐同规格） */
.calling-island.dock-mode-taskbar {
  border-radius: 6px;
  height: 34px;
  padding: 0 8px;
  background: rgba(22, 27, 35, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow:
    0 1px 6px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

.taskbar-drag-handle {
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  width: 22px;
  height: 2px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.3);
  pointer-events: none;
}

/* 磁吸贴附预览高亮态 */
.calling-island.is-snapping-preview {
  border: 1.5px dashed rgba(64, 128, 255, 0.9) !important;
  box-shadow:
    0 0 18px rgba(64, 128, 255, 0.5),
    inset 0 0 10px rgba(64, 128, 255, 0.2) !important;
  animation: snap-pulse 1s ease-in-out infinite;
}

@keyframes snap-pulse {
  0%, 100% {
    box-shadow: 0 0 12px rgba(64, 128, 255, 0.4), inset 0 0 8px rgba(64, 128, 255, 0.15);
  }
  50% {
    box-shadow: 0 0 22px rgba(64, 128, 255, 0.7), inset 0 0 14px rgba(64, 128, 255, 0.3);
  }
}

.calling-island.is-ai-speaking,
.calling-island.is-user-speaking {
  border-color: rgba(0, 180, 42, 0.5);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.4),
    0 0 14px rgba(0, 180, 42, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

.calling-island.is-thinking {
  border-color: rgba(22, 93, 255, 0.5);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.4),
    0 0 14px rgba(22, 93, 255, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

/* 左侧：智能体圆形头像容器 */
.avatar-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  flex-shrink: 0;
  box-sizing: border-box;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.16);
  transition: all 0.25s ease;
}

.avatar-wrap.is-ai-speaking {
  border-color: #00b42a;
  box-shadow: 0 0 10px rgba(0, 180, 42, 0.6);
}

.avatar-wrap.is-user-speaking {
  border-color: #00b42a;
  box-shadow: 0 0 8px rgba(0, 180, 42, 0.4);
}

.avatar-wrap.is-thinking {
  border-color: #165dff;
  box-shadow: 0 0 10px rgba(22, 93, 255, 0.6);
  animation: thinking-glow 1.5s ease-in-out infinite;
}

@keyframes thinking-glow {
  0%, 100% {
    box-shadow: 0 0 4px rgba(22, 93, 255, 0.3);
    border-color: rgba(22, 93, 255, 0.4);
  }
  50% {
    box-shadow: 0 0 12px rgba(22, 93, 255, 0.7);
    border-color: rgba(22, 93, 255, 0.9);
  }
}

.avatar-wrap.is-interruptable {
  cursor: pointer;
}

.avatar-wrap.is-interruptable:hover {
  border-color: #ff7d00;
  box-shadow: 0 0 10px rgba(255, 125, 0, 0.7);
}

.agent-avatar {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}

.agent-avatar-fallback {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: #ffffff;
  background: linear-gradient(135deg, #165dff, #00b42a);
}

/* 说话中的小声波角标 */
.speaking-badge {
  position: absolute;
  bottom: -2px;
  right: -2px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid rgba(0, 180, 42, 0.6);
  border-radius: 6px;
  padding: 1px 2px;
  height: 10px;
}

.mini-bar {
  width: 1.5px;
  height: 6px;
  border-radius: 1px;
  background-color: #00b42a;
  transform-origin: bottom;
  transition: transform 0.08s ease;
}

/* 中间信息列 */
.island-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 60px;
  max-width: 95px;
  overflow: hidden;
  line-height: 1.2;
}

.agent-name {
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: 0.2px;
}

.agent-status {
  color: rgba(255, 255, 255, 0.72);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}

.calling-island.is-ai-speaking .agent-status {
  color: #00b42a;
}

.calling-island.is-user-speaking .agent-status {
  color: #00b42a;
}

.calling-island.is-thinking .agent-status {
  color: #4080ff;
}

/* 右侧操作按钮组 */
.island-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.island-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.9);
  transition: background-color 0.2s ease, transform 0.1s ease;
  padding: 0;
}

.island-btn:hover {
  background-color: rgba(255, 255, 255, 0.22);
  color: #ffffff;
}

.island-btn:active {
  transform: scale(0.92);
}

.btn-icon {
  width: 13px !important;
  height: 13px !important;
  font-size: 13px !important;
  display: inline-block !important;
}

.hangup-icon {
  transform: rotate(135deg);
}

.screen-share-btn.is-active {
  background-color: rgba(22, 93, 255, 0.4);
  color: #4080ff;
}

.screen-share-btn.is-active:hover {
  background-color: rgba(22, 93, 255, 0.6);
  color: #689fff;
}

.mute-btn.is-muted {
  background-color: rgba(255, 125, 0, 0.28);
  color: #ff7d00;
}

.mute-btn.is-muted:hover {
  background-color: rgba(255, 125, 0, 0.45);
  color: #ff8e24;
}

/* 经典红底圆钮挂断 */
.hangup-btn {
  background-color: #e5484a;
  color: #ffffff;
}

.hangup-btn:hover {
  background-color: #f75555;
}
</style>

