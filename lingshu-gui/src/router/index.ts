import { createRouter, createWebHashHistory, type RouteLocationGeneric } from 'vue-router';
import MainLayout from '../components/layout/MainLayout.vue';

const routes = [
  {
    path: '/voice-call',
    name: 'voice-call-window',
    component: () => import('../views/VoiceCallWindowView.vue'),
  },
  {
    path: '/',
    component: MainLayout,
    children: [
      {
        path: '',
        name: 'chat',
        component: () => import('../views/ChatView.vue'),
      },
      {
        path: 'contacts',
        name: 'contacts',
        component: () => import('../views/ContactsView.vue'),
      },
      {
        // 旧群聊独立页已并入对话页；保留重定向兼容历史深链 / 记忆中的链接
        path: 'groups/:groupId?',
        name: 'groups-redirect',
        redirect: (to: RouteLocationGeneric) => {
          const groupId = String(to.params.groupId || '');
          return groupId
            ? { path: '/', query: { group: groupId } }
            : { path: '/' };
        },
      },
      {
        path: 'folder',
        name: 'folder',
        component: () => import('../views/FolderView.vue'),
      },
      {
        path: 'starred',
        name: 'starred',
        component: () => import('../views/StarredView.vue'),
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('../views/SettingsView.vue'),
      },
      {
        path: 'voice-lab',
        name: 'voice-lab',
        component: () => import('../views/VoiceLabView.vue'),
      },
      {
        path: 'memory-overview',
        name: 'memory-overview',
        component: () => import('../views/MemoryOverviewView.vue'),
      },
      {
        path: 'memory-streams',
        name: 'memory-streams',
        component: () => import('../views/MemoryStreamsView.vue'),
      },
      {
        path: 'memory-seeds',
        name: 'memory-seeds',
        component: () => import('../views/MemorySeedsView.vue'),
      },
      {
        path: 'memory-self-portrait',
        name: 'memory-self-portrait',
        component: () => import('../views/MemorySelfPortraitView.vue'),
      },
      {
        path: 'memory-boundaries',
        name: 'memory-boundaries',
        component: () => import('../views/MemoryBoundariesView.vue'),
      },
      {
        path: 'memory-graph',
        name: 'memory-graph',
        component: () => import('../views/MemoryGraphView.vue'),
      },
      {
        path: 'memory-audit',
        name: 'memory-audit',
        component: () => import('../views/MemoryAuditView.vue'),
      },
      {
        path: 'retrospect',
        name: 'retrospect',
        component: () => import('../views/RetrospectView.vue'),
      },
      {
        path: 'proactive-console',
        name: 'proactive-console',
        component: () => import('../views/ProactiveConsoleView.vue'),
      },
      {
        path: 'debug/task-preview',
        name: 'debug-task-preview',
        component: () => import('../views/DebugTaskPreviewView.vue'),
      },
      {
        path: 'debug/message-lab',
        name: 'debug-message-lab',
        component: () => import('../views/DebugMessageLabView.vue'),
      },
      { path: 'debug/vrm', name: 'debug-vrm', component: () => import('../views/VrmTestView.vue') },
      {
        path: 'debug/flash-head',
        name: 'debug-flash-head',
        component: () => import('../views/FlashHeadLabView.vue'),
      },
    ],
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
