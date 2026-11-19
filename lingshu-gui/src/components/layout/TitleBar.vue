<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { asrModelState, isAsrModelBusy } from '../../services/asrModelWatcher';
import { useSettingsStore } from '../../stores/settings';

const router = useRouter();
const settings = useSettingsStore();

// The download pill only makes sense while the local model is the active engine.
const cloudAsr = computed(() => settings.asr.provider !== 'local');
const asrBusy = computed(() => !cloudAsr.value && isAsrModelBusy(asrModelState.value));

const asrPercent = computed(() => {
  const status = asrModelState.value;
  if (!status) return 0;
  if (status.phase === 'installing') return 100;
  if (status.phase !== 'downloading') return 0;
  if (!status.totalBytes) return 0;
  return Math.min(100, Math.max(0, Math.round((status.downloadedBytes / status.totalBytes) * 100)));
});

const asrLabel = computed(() => {
  const status = asrModelState.value;
  if (!status) return '';
  if (status.phase === 'installing') return '语音识别 · 安装中';
  return `语音识别 · ${asrPercent.value}%`;
});

function openAsrSettings() {
  try {
    localStorage.setItem('lingshu_settings_active_tab', 'asr');
  } catch {
    /* ignore storage failures */
  }
  void router.push({ path: '/settings', query: { tab: 'asr' } });
}

const isMaximized = ref(false);
const isAlwaysOnTop = ref(false);
let appWindow: any = null;

async function ensureAppWindow() {
  if (appWindow) return appWindow;
  // Tauri v2 环境检测
  const isTauri = !!(window as any).__TAURI_INTERNALS__;
  if (!isTauri) {
    console.warn('Not running in Tauri environment, window controls disabled.');
    return null;
  }
  
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    appWindow = getCurrentWindow();
    return appWindow;
  } catch (e) {
    console.error('Failed to load Tauri window API:', e);
    return null;
  }
}

const checkMaximized = async () => {
  const currentWindow = await ensureAppWindow();
  if (!currentWindow) return;
  isMaximized.value = await currentWindow.isMaximized();
};

onMounted(async () => {
  const currentWindow = await ensureAppWindow();
  if (!currentWindow) return;
  await checkMaximized();
  await currentWindow.onResized(() => checkMaximized());
});

const handleDoubleClick = () => {
  ensureAppWindow().then((currentWindow) => currentWindow?.toggleMaximize());
};

const minimize = () => {
  ensureAppWindow().then((currentWindow) => currentWindow?.minimize());
};
const toggleMaximize = async () => {
  const currentWindow = await ensureAppWindow();
  if (!currentWindow) return;
  await currentWindow.toggleMaximize();
  await checkMaximized();
};
const toggleAlwaysOnTop = async () => {
  const currentWindow = await ensureAppWindow();
  if (!currentWindow) return;
  isAlwaysOnTop.value = !isAlwaysOnTop.value;
  await currentWindow.setAlwaysOnTop(isAlwaysOnTop.value);
};
const close = () => {
  ensureAppWindow().then((currentWindow) => currentWindow?.close());
};
</script>

<template>
  <div 
    class="custom-titlebar" 
    data-tauri-drag-region
    @dblclick="handleDoubleClick"
  >
    <div class="drag-spacer" data-tauri-drag-region></div>

    <div
      v-if="asrBusy"
      class="asr-status-pill"
      :title="asrLabel + '，点击查看'"
      @mousedown.stop
      @dblclick.stop
      @click.stop="openAsrSettings"
    >
      <span class="asr-status-spinner"></span>
      <span class="asr-status-text">{{ asrLabel }}</span>
      <span class="asr-status-track">
        <span class="asr-status-fill" :style="{ width: `${asrPercent}%` }"></span>
      </span>
    </div>

    <div class="window-controls" @mousedown.stop @dblclick.stop>
      <div 
        class="win-btn pin-btn" 
        :class="{ active: isAlwaysOnTop }" 
        :title="isAlwaysOnTop ? '取消置顶' : '置顶'" 
        @click="toggleAlwaysOnTop"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="17" x2="12" y2="22"></line>
          <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
        </svg>
      </div>

      <div class="win-btn" title="最小化" @click="minimize">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 5H10" stroke="currentColor" stroke-width="1"/>
        </svg>
      </div>
      
      <div class="win-btn" :title="isMaximized ? '还原' : '最大化'" @click="toggleMaximize">
        <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10">
          <path d="M1 1H9V9H1V1Z" stroke="currentColor" fill="none" stroke-width="1"/>
        </svg>
        <svg v-else width="10" height="10" viewBox="0 0 10 10">
          <path d="M3 1H9V7" stroke="currentColor" fill="none" stroke-width="1"/>
          <path d="M1 3H7V9H1V3Z" stroke="currentColor" fill="none" stroke-width="1"/>
        </svg>
      </div>
      
      <div class="win-btn close-btn" title="关闭" @click="close">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1"/>
        </svg>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-titlebar {
  height: var(--titlebar-height, 28px);
  background-color: var(--bg-nav-rail, var(--bg-sidebar));
  display: flex;
  align-items: center;
  justify-content: flex-end;
  user-select: none;
  cursor: default;
  flex-shrink: 0;
  position: relative;
  z-index: 1300;
}

.drag-spacer {
  flex: 1;
}

.asr-status-pill {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background-color: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s, color 0.2s;
}

.asr-status-pill:hover {
  color: var(--text-primary);
  background-color: var(--bg-input);
}

.asr-status-spinner {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--color-primary);
  border-top-color: transparent;
  animation: asr-status-spin 0.9s linear infinite;
  flex-shrink: 0;
}

.asr-status-text {
  white-space: nowrap;
}

.asr-status-track {
  width: 38px;
  height: 3px;
  border-radius: 2px;
  background-color: var(--border-color);
  overflow: hidden;
  flex-shrink: 0;
}

.asr-status-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background-color: var(--color-primary);
  transition: width 0.4s ease;
}

@keyframes asr-status-spin {
  to {
    transform: rotate(360deg);
  }
}

.window-controls {
  display: flex;
  height: 100%;
}

.win-btn {
  width: 44px;
  height: var(--titlebar-height, 28px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  transition: all 0.2s;
}

.win-btn:hover {
  background-color: var(--bg-titlebar-button-hover, var(--bg-hover));
  color: var(--text-primary);
}

.pin-btn.active {
  color: var(--color-primary);
}

.pin-btn.active svg {
  fill: var(--color-primary-light-4);
}

.close-btn:hover {
  background-color: #e81123 !important;
  color: white !important;
}
</style>
