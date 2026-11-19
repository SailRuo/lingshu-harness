<script setup lang="ts">
import { computed, ref, onUnmounted, watch } from 'vue';
import { useUIStore } from '../../stores/ui';
import type { Conversation } from '../../types/conversation';
import IconLayout from '@arco-design/web-vue/es/icon/icon-layout';
import IconPhone from '@arco-design/web-vue/es/icon/icon-phone';
import IconMute from '@arco-design/web-vue/es/icon/icon-mute';
import IconSound from '@arco-design/web-vue/es/icon/icon-sound';
import IconDesktop from '@arco-design/web-vue/es/icon/icon-desktop';

const props = defineProps<{
  conversation: Conversation | null;
  callActive?: boolean;
  isConnecting?: boolean;
  inputLevel?: number;
  assistantSpeaking?: boolean;
  connectionHint?: string;
  speechActive?: boolean;
  isMuted?: boolean;
  isScreenSharing?: boolean;
  isFocused?: boolean;
}>();

const uiStore = useUIStore();
const emit = defineEmits<{
  'toggle-call': [];
  'toggle-mute': [];
  'toggle-screen-share': [];
  'interrupt': [];
}>();

const isUserSpeaking = computed(() => {
  return props.speechActive || props.connectionHint === '正在聆听你说话' || props.connectionHint === '检测到人声';
});

const barHeights = ref([0.35, 0.55, 0.8, 0.45, 0.65, 0.35, 0.25]);
let animFrameId: number | null = null;

function startAnimation() {
  if (animFrameId !== null) return;
  const update = () => {
    if (!props.callActive && !props.isConnecting) {
      animFrameId = null;
      return;
    }
    const t = Date.now() / 1000;
    let heights = [0.35, 0.55, 0.8, 0.45, 0.65, 0.35, 0.25];
    
    if (props.isMuted) {
      heights = [0.35, 0.55, 0.8, 0.45, 0.65, 0.35, 0.25];
    } else if (props.isConnecting && !props.callActive) {
      // Connecting scan animation
      heights = [
        0.2 + Math.max(0, Math.sin(t * 10 - 0) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 1) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 2) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 3) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 4) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 5) * 0.5),
        0.2 + Math.max(0, Math.sin(t * 10 - 6) * 0.5),
      ];
    } else if (props.assistantSpeaking) {
      // AI speaking visualizer
      const env = Math.max(0.15, Math.sin(t * 7.5) * 0.45 + Math.cos(t * 3.3) * 0.45 + 0.4);
      heights = [
        0.25 + env * 0.45 * (0.6 + Math.sin(t * 24) * 0.4),
        0.25 + env * 0.65 * (0.8 + Math.cos(t * 20) * 0.2),
        0.25 + env * 0.85 * (0.6 + Math.sin(t * 28) * 0.4),
        0.25 + env * 0.95 * (0.8 + Math.cos(t * 21) * 0.2),
        0.25 + env * 0.85 * (0.6 + Math.sin(t * 25) * 0.4),
        0.25 + env * 0.65 * (0.8 + Math.cos(t * 23) * 0.2),
        0.25 + env * 0.45 * (0.6 + Math.sin(t * 22) * 0.4),
      ];
    } else if (isUserSpeaking.value && props.inputLevel && props.inputLevel > 0.01) {
      // User speaking visualizer (VAD guarded)
      const level = Math.min(1.0, props.inputLevel * 1.8);
      heights = [
        0.25 + level * 0.45 * (0.6 + Math.sin(t * 32) * 0.4),
        0.25 + level * 0.65 * (0.8 + Math.cos(t * 26) * 0.2),
        0.25 + level * 0.85 * (0.6 + Math.sin(t * 38) * 0.4),
        0.25 + level * 0.95 * (0.8 + Math.cos(t * 29) * 0.2),
        0.25 + level * 0.85 * (0.6 + Math.sin(t * 33) * 0.4),
        0.25 + level * 0.65 * (0.8 + Math.cos(t * 31) * 0.2),
        0.25 + level * 0.45 * (0.6 + Math.sin(t * 34) * 0.4),
      ];
    } else {
      // Completely static wave lines when quiet
      heights = [0.35, 0.55, 0.8, 0.45, 0.65, 0.35, 0.25];
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
  () => props.callActive || props.isConnecting,
  (active) => {
    if (active) {
      startAnimation();
    } else {
      stopAnimation();
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  stopAnimation();
});
</script>

<template>
  <header v-if="conversation" class="chat-header" data-tauri-drag-region>
    <div class="header-left">
      <div class="header-title">
        <span class="name">{{ conversation.name }}</span>
      </div>
    </div>

    <div v-if="callActive || isConnecting" class="header-center">
      <div 
        class="calling-island"
        :class="{
          'is-ai-speaking': assistantSpeaking,
          'is-user-speaking': !assistantSpeaking && isUserSpeaking
        }"
      >
        <div 
          class="voice-wave" 
          :class="{ 
            'is-ai-speaking': assistantSpeaking, 
            'is-user-speaking': !assistantSpeaking && isUserSpeaking,
            'is-idle': !assistantSpeaking && !isUserSpeaking,
            'is-muted': isMuted,
            'is-interruptable': assistantSpeaking
          }"
          :title="assistantSpeaking ? '点击打断' : undefined"
          @click.stop="assistantSpeaking && emit('interrupt')"
        >
          <span class="bar" :style="{ transform: `scaleY(${barHeights[0]})` }"></span>
          <span class="bar" :style="{ transform: `scaleY(${barHeights[1]})` }"></span>
          <span class="bar" :style="{ transform: `scaleY(${barHeights[2]})` }"></span>
          <span class="bar" :style="{ transform: `scaleY(${barHeights[3]})` }"></span>
          <span class="bar" :style="{ transform: `scaleY(${barHeights[4]})` }"></span>
          <span class="bar" :style="{ transform: `scaleY(${barHeights[5]})` }"></span>
          <span class="bar" :style="{ transform: `scaleY(${barHeights[6]})` }"></span>
        </div>
        
        <div class="island-divider"></div>
        
        <div class="island-actions">
          <button
            class="island-btn mute-btn"
            :class="{ 'is-muted': isMuted }"
            type="button"
            :title="isMuted ? '取消静音' : '静音'"
            @click="emit('toggle-mute')"
          >
            <IconMute v-if="isMuted" class="btn-icon" />
            <IconSound v-else class="btn-icon" />
          </button>
          
          <button
            class="island-btn screen-share-btn"
            :class="{ 'is-active': isScreenSharing }"
            type="button"
            :title="isScreenSharing ? '关闭屏幕共享' : '开启屏幕共享'"
            @click="emit('toggle-screen-share')"
          >
            <IconDesktop class="btn-icon" />
          </button>

          <button
            class="island-btn hangup-btn"
            type="button"
            title="挂断通话"
            @click="emit('toggle-call')"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" class="hangup-icon" style="transform: rotate(135deg);">
              <path d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div class="header-right">
      <button
        class="action-btn"
        :class="{ 'is-active': callActive }"
        :title="callActive ? '正在通话' : '发起通话'"
        id="header-call-btn"
        @click="emit('toggle-call')"
      >
        <IconPhone :size="18" />
      </button>

      <button
        class="action-btn"
        :class="{ 'is-active': uiStore.showMemoryPanel }"
        title="记忆召回"
        id="header-toggle-panel-btn"
        @click="uiStore.toggleMemoryPanel"
      >
        <IconLayout :size="18" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.chat-header {
  height: 44px;
  background-color: transparent;
  border-bottom: 1px solid var(--header-border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
  position: relative;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-selector {
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.2s;
}

.agent-selector:hover {
  background-color: var(--bg-hover);
}

.current-agent {
  display: flex;
  align-items: center;
  gap: 8px;
}

.caret {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-left: -2px;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.name {
  font-size: var(--font-size-md);
  color: var(--text-primary);
  font-weight: 600;
  line-height: 1.3;
}

.stage-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 8px 2px 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--primary-color, #165dff) 12%, transparent);
  color: var(--primary-color, #165dff);
  font-size: 10px;
  line-height: 1;
  user-select: none;
}

.stage-heart {
  width: 10px;
  height: 10px;
  opacity: 0.75;
  flex-shrink: 0;
}

.stage-label {
  font-weight: 400;
}

.ai-badge {
  background-color: var(--text-placeholder);
  color: #fff;
  font-size: 10px;
  padding: 0px 4px;
  border-radius: 2px;
  transform: scale(0.9);
  line-height: 1.4;
}

.header-right {
  display: flex;
  align-items: center;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 4px;
  transition: all 0.2s;
}

.action-btn:hover {
  background-color: var(--bg-hover);
  color: var(--text-primary);
}

.action-btn.is-active,
.action-btn.is-active:hover {
  color: var(--primary-color);
  background: none;
}

/* 灵动岛呼叫中心样式 */
.header-center {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  pointer-events: auto;
}

.calling-island {
  display: flex;
  align-items: center;
  background: rgba(24, 24, 28, 0.88);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  padding: 4px 14px;
  border-radius: 99px;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.25),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  height: 36px;
  box-sizing: border-box;
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
  cursor: pointer;
  animation: island-appear 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.calling-island.is-ai-speaking {
  border-color: rgba(0, 180, 42, 0.45);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.25),
    0 0 12px rgba(0, 180, 42, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.calling-island.is-user-speaking {
  border-color: rgba(0, 180, 42, 0.45);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.25),
    0 0 12px rgba(0, 180, 42, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.calling-island:hover {
  padding: 4px 8px 4px 14px;
}

@keyframes island-appear {
  0% {
    transform: scale(0.8) translateY(-10px);
    opacity: 0;
    filter: blur(4px);
  }
  100% {
    transform: scale(1) translateY(0);
    opacity: 1;
    filter: blur(0);
  }
}

.voice-wave {
  display: flex;
  align-items: center;
  gap: 3.5px;
  height: 24px;
  width: 44px;
  justify-content: center;
  box-sizing: border-box;
  flex-shrink: 0;
}

.voice-wave .bar {
  width: 3px;
  height: 20px;
  border-radius: 1.5px;
  transform-origin: center;
  transition: transform 0.08s ease, background-color 0.3s ease;
  will-change: transform;
  background-color: var(--color-success, #00b42a);
}

.voice-wave.is-ai-speaking .bar {
  background-color: var(--color-success, #00b42a);
}

.voice-wave.is-user-speaking .bar {
  background-color: var(--color-success, #00b42a);
}

.voice-wave.is-idle .bar {
  background-color: rgba(0, 180, 42, 0.6);
}

.voice-wave.is-muted .bar {
  background-color: var(--text-placeholder, #86909c);
}

.voice-wave.is-interruptable {
  cursor: pointer;
}

.voice-wave.is-interruptable:hover .bar {
  background-color: var(--color-warning, #ff7d00) !important;
  transition: background-color 0.15s ease, transform 0.08s ease;
}

.island-divider {
  width: 0;
  height: 16px;
  background-color: rgba(255, 255, 255, 0.18);
  margin: 0;
  flex-shrink: 0;
  opacity: 0;
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.calling-island:hover .island-divider {
  width: 1px;
  margin: 0 10px;
  opacity: 1;
}

.island-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  max-width: 0;
  opacity: 0;
  transform: scale(0.8) translateX(-5px);
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
}

.calling-island:hover .island-actions {
  max-width: 120px;
  opacity: 1;
  transform: scale(1) translateX(0);
  pointer-events: auto;
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
  background-color: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
  transition: all 0.2s ease;
  padding: 0;
}

.island-btn:hover {
  background-color: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

.island-btn:active {
  transform: scale(0.9);
}

.btn-icon,
.hangup-icon {
  width: 14px !important;
  height: 14px !important;
  font-size: 14px !important;
  display: inline-block !important;
}

.screen-share-btn.is-active {
  background-color: rgba(22, 93, 255, 0.3);
  color: #4080ff;
}

.screen-share-btn.is-active:hover {
  background-color: rgba(22, 93, 255, 0.45);
  color: #689fff;
}

.mute-btn.is-muted {
  background-color: rgba(255, 125, 0, 0.2);
  color: #ff7d00;
}

.mute-btn.is-muted:hover {
  background-color: rgba(255, 125, 0, 0.35);
  color: #ff8e24;
}

.hangup-btn {
  background-color: var(--color-error, #f53f3f);
  color: #ffffff;
}

.hangup-btn:hover {
  background-color: #ff5757;
}
</style>
