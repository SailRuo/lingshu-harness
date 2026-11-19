import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { applyThemeToDocument } from '../utils/theme.js';

export type ThemeMode = 'light' | 'dark' | 'system';

export const useUIStore = defineStore('ui', () => {
  const theme = ref<ThemeMode>((localStorage.getItem('lingshu-theme') as ThemeMode) || 'light');
  const fontSize = ref(Number(localStorage.getItem('lingshu-font-size')) || 2); // 1: 小, 2: 标准, 3: 中, 4: 大, 5: 特大
  const conversationListWidth = ref(Number(localStorage.getItem('lingshu-sidebar-width')) || 280);
  const showMemoryPanel = ref(localStorage.getItem('lingshu-show-memory-panel') !== 'false');
  // 控制台入口仅本会话有效：每次启动默认隐藏，logo 连点三次切换
  const consoleNavUnlocked = ref(false);
  localStorage.removeItem('lingshu-console-nav-unlocked');

  // 监听变化并持久化
  watch(theme, (val) => {
    localStorage.setItem('lingshu-theme', val);
    applyThemeToDocument(document, val);
  }, { immediate: true });
  watch(fontSize, (val) => localStorage.setItem('lingshu-font-size', val.toString()));
  watch(conversationListWidth, (val) => localStorage.setItem('lingshu-sidebar-width', val.toString()));
  watch(showMemoryPanel, (val) => localStorage.setItem('lingshu-show-memory-panel', val.toString()));

  function toggleConsoleNav() {
    consoleNavUnlocked.value = !consoleNavUnlocked.value;
  }
  
  function toggleTheme() {
    const newMode = theme.value === 'light' ? 'dark' : 'light';
    setTheme(newMode);
  }

  function setTheme(mode: ThemeMode) {
    theme.value = mode;
  }

  function setFontSize(size: number) {
    fontSize.value = size;
    document.documentElement.style.setProperty('--font-scale', (0.8 + size * 0.1).toString());
  }

  function setConversationListWidth(width: number) {
    conversationListWidth.value = Math.min(400, Math.max(280, width));
  }

  function toggleMemoryPanel() {
    showMemoryPanel.value = !showMemoryPanel.value;
  }

  return {
    theme,
    fontSize,
    conversationListWidth,
    showMemoryPanel,
    consoleNavUnlocked,
    toggleConsoleNav,
    toggleTheme,
    setTheme,
    setFontSize,
    setConversationListWidth,
    toggleMemoryPanel,
  };
});
