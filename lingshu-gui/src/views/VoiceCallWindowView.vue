<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import VoiceCallPanel from '../components/chat/VoiceCallPanel.vue';

onMounted(() => {
  document.documentElement.classList.add('is-voice-call-window');
  document.body.classList.add('is-voice-call-window');
});

onUnmounted(() => {
  document.documentElement.classList.remove('is-voice-call-window');
  document.body.classList.remove('is-voice-call-window');
});
</script>

<template>
  <div class="voice-call-view" >
    <VoiceCallPanel />
  </div>
</template>

<style>
/* 全局穿透：悬浮窗视图下强制 html、body、#app 全部透明，无滚动条与边框 */
html.is-voice-call-window,
body.is-voice-call-window,
html.is-voice-call-window #app,
body.is-voice-call-window #app {
  background: transparent !important;
  background-color: transparent !important;
  overflow: hidden !important;
  user-select: none;
}
</style>

<style scoped>
.voice-call-view {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: transparent !important;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>

