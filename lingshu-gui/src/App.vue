<script setup lang="ts">
import { onMounted } from 'vue';
import { useSettingsStore } from './stores/settings';
import { useUIStore } from './stores/ui';

const uiStore = useUIStore();
const settingsStore = useSettingsStore();

onMounted(() => {
  uiStore.setTheme(uiStore.theme);
  uiStore.setFontSize(uiStore.fontSize);
  if (!settingsStore.isLoaded) {
    void settingsStore.fetchSettings();
  }
});
</script>

<template>
  <router-view />
</template>

<style>
/* 全屏基础设置 */
html, body, #app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
}

.app-boot {
  width: 100%;
  height: 100%;
  background: var(--bg-chat-window);
}
</style>
