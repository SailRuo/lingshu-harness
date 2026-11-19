<script setup lang="ts">
import { useRouter, useRoute } from 'vue-router';
import { computed, ref } from 'vue';
import IconMessage from '@arco-design/web-vue/es/icon/icon-message';
import { useUIStore } from '../../stores/ui';

const router = useRouter();
const route = useRoute();
const uiStore = useUIStore();

const mainNavItems = [
  { id: 'chat', icon: IconMessage, label: '对话', path: '/' },
  { id: 'memory', icon: 'psychology', label: '记忆', path: '/memory-overview' },
  { id: 'impressions', icon: 'psychiatry', label: '自我演化', path: '/memory-seeds' },
  { id: 'retrospect', icon: 'schedule', label: '时光回溯', path: '/retrospect' },
];

const devNavItems = [
  { id: 'voice-lab', icon: 'mic', label: '通话模拟', path: '/voice-lab' },
  { id: 'flash-head', icon: 'face', label: '数字人测试', path: '/debug/flash-head' },
  { id: 'console', icon: 'tune', label: '控制台', path: '/proactive-console' },
];

const bottomNavItems = [
  { id: 'settings', icon: 'Menu', label: '设置', path: '/settings' },
];

const visibleMainNavItems = computed(() => (
  uiStore.consoleNavUnlocked ? [...mainNavItems, ...devNavItems] : mainNavItems
));

const logoClickCount = ref(0);
let logoClickTimer: number | null = null;

const activeNavId = computed(() => {
  const currentPath = route.path;
  if (currentPath.startsWith('/proactive-console')) {
    return 'console';
  }
  if (currentPath.startsWith('/voice-lab')) {
    return 'voice-lab';
  }
  if (currentPath.startsWith('/debug/flash-head')) {
    return 'flash-head';
  }
  if (currentPath.startsWith('/memory-seeds')) {
    return 'impressions';
  }
  if (currentPath.startsWith('/memory-')) {
    return 'memory';
  }
  if (currentPath.startsWith('/retrospect')) {
    return 'retrospect';
  }
  const matchedItem = [...visibleMainNavItems.value, ...bottomNavItems].find((item) => item.path === currentPath);
  return matchedItem ? matchedItem.id : 'chat';
});

function handleSelect(item: any) {
  router.push(item.path);
}

function handleLogoClick() {
  if (logoClickTimer !== null) {
    window.clearTimeout(logoClickTimer);
  }
  logoClickCount.value += 1;
  if (logoClickCount.value >= 3) {
    logoClickCount.value = 0;
    const wasUnlocked = uiStore.consoleNavUnlocked;
    uiStore.toggleConsoleNav();
    if (
      wasUnlocked &&
      (route.path.startsWith('/proactive-console') ||
        route.path.startsWith('/voice-lab') ||
        route.path.startsWith('/debug/flash-head'))
    ) {
      router.push('/');
    }
    return;
  }
  logoClickTimer = window.setTimeout(() => {
    logoClickCount.value = 0;
    logoClickTimer = null;
  }, 1200);
}

async function startWindowDragging() {
  if (!(window as typeof window & { __TAURI__?: unknown }).__TAURI__) return;
  const tauriWindow = await import('@tauri-apps/api/window');
  await tauriWindow.getCurrentWindow().startDragging();
}
</script>

<template>
  <aside class="sidebar-nav">
    <!-- Top: User Avatar (Also a drag region) -->
    <div 
      class="user-area" 
      data-tauri-drag-region
      @mousedown="startWindowDragging"
    >
      <div class="user-avatar" title="个人设置" @click.stop="handleLogoClick">
        <img src="/logo.png" alt="avatar" />
      </div>
    </div>

    <!-- Middle: Main Navigation -->
    <nav class="nav-list main-nav">
      <div
        v-for="item in visibleMainNavItems"
        :key="item.id"
        class="nav-item"
        :class="{ active: activeNavId === item.id }"
        :title="item.label"
        @click="handleSelect(item)"
      >
        <component :is="item.icon" v-if="typeof item.icon !== 'string'" class="item-icon-component" />
        <span v-else class="material-symbols-outlined">{{ item.icon }}</span>
      </div>
    </nav>

    <!-- Bottom: Secondary Navigation -->
    <nav class="nav-list bottom-nav">
      <div
        v-for="item in bottomNavItems"
        :key="item.id"
        class="nav-item"
        :class="{ active: activeNavId === item.id }"
        :title="item.label"
        @click="handleSelect(item)"
      >
        <span class="material-symbols-outlined">{{ item.icon }}</span>
      </div>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar-nav {
  width: var(--sidebar-width);
  height: 100%;
  background-color: var(--bg-nav-rail, var(--bg-sidebar));
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 15px 0;
  flex-shrink: 0;
  position: relative;
  z-index: 1300;
}

.user-area {
  margin-bottom: 18px;
  display: flex;
  justify-content: center;
  width: 100%;
}

.user-avatar {
  width: 38px;
  height: 38px;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  transition: transform var(--transition-fast);
}

.user-avatar:hover {
  transform: scale(1.05);
}

.user-avatar:active {
  transform: scale(0.95);
}

.user-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.nav-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  align-items: center;
}

.main-nav {
  flex: 1;
}

.nav-item {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
  color: var(--text-secondary);
}

.nav-item:active {
  transform: scale(0.92);
}

.material-symbols-outlined {
  font-size: 26px;
  display: inline-block;
  width: 26px;
  height: 26px;
  overflow: hidden;
  white-space: nowrap;
  font-variation-settings:
    'FILL' 0,
    'wght' 300,
    'GRAD' 0,
    'opsz' 24;
  transition: font-variation-settings 0.2s;
}

.item-icon-component {
  font-size: 26px;
  width: 26px;
  height: 26px;
}

.nav-item:hover {
  color: var(--text-primary);
}

.nav-item.active {
  color: var(--color-primary);
}

.nav-item.active .material-symbols-outlined {
  font-variation-settings:
    'FILL' 1,
    'wght' 300,
    'GRAD' 0,
    'opsz' 24;
}

.bottom-nav {
  margin-top: auto;
  padding-bottom: 10px;
}
</style>
