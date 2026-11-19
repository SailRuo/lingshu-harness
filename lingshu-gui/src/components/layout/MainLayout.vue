<script setup lang="ts">
import SidebarNav from './SidebarNav.vue';
import TitleBar from './TitleBar.vue';
import { initAsrModelWatcher } from '../../services/asrModelWatcher';

// 全局轮询语音识别模型下载状态：离开设置页也能继续更新标题栏进度并弹完成提示。
initAsrModelWatcher();
</script>

<template>
  <div class="main-layout">
    <SidebarNav />
    
    <div class="main-container">
      <!-- 重新放回头部的固定流 -->
      <TitleBar />
      <div class="content-area">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <keep-alive include="ChatView">
              <component :is="Component" />
            </keep-alive>
          </transition>
        </router-view>
      </div>
    </div>
  </div>
</template>

<style scoped>
.main-layout {
  --titlebar-height: 28px;
  display: flex;
  width: 100%;
  height: 100vh;
  overflow: hidden;
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
}

.main-container {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column; /* 恢复垂直排列 */
  height: 100%;
  overflow: hidden;
  background-color: var(--bg-chat-window);
}

.content-area {
  flex: 1;
  min-height: 0; /* 允许在标题栏下方收缩，子页面才能出现纵向滚动 */
  width: 100%;
  overflow: hidden;
  position: relative;
}

/* router-view / 页面根节点必须吃满 content-area，否则 height:100% 失效、滚动区会跟着内容撑开 */
.content-area > * {
  height: 100%;
  min-height: 0;
  max-height: 100%;
  box-sizing: border-box;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
