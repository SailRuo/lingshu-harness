<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Message } from '@arco-design/web-vue';
import { useUIStore } from '../stores/ui';
import { useSettingsStore } from '../stores/settings';
import { getApiBaseUrl, setApiBaseUrl, testBackendConnection } from '../utils/apiConfig';
import { selectFolderPath } from '../utils/selectFolderPath';
import IconUser from '@arco-design/web-vue/es/icon/icon-user';
import IconSettings from '@arco-design/web-vue/es/icon/icon-settings';
import IconApps from '@arco-design/web-vue/es/icon/icon-apps';
import IconInfoCircle from '@arco-design/web-vue/es/icon/icon-info-circle';
import IconRobot from '@arco-design/web-vue/es/icon/icon-robot';
import IconCode from '@arco-design/web-vue/es/icon/icon-code';
import IconCloud from '@arco-design/web-vue/es/icon/icon-cloud';
import IconSound from '@arco-design/web-vue/es/icon/icon-sound';
import IconVoice from '@arco-design/web-vue/es/icon/icon-voice';
import IconQrcode from '@arco-design/web-vue/es/icon/icon-qrcode';
import IconBarChart from '@arco-design/web-vue/es/icon/icon-bar-chart';
import AgentManager from '../components/settings/AgentManager.vue';
import ModelConfig from '../components/settings/ModelConfig.vue';
import ProviderManager from '../components/settings/ProviderManager.vue';
import TtsConfig from '../components/settings/TtsConfig.vue';
import AsrConfig from '../components/settings/AsrConfig.vue';
import UsageStatsPanel from '../components/settings/UsageStatsPanel.vue';
import PluginConfig from '../components/settings/PluginConfig.vue';
import WeChatLink from '../components/settings/WeChatLink.vue';
import QQBotLink from '../components/settings/QQBotLink.vue';
import AboutProductPanel from '../components/settings/AboutProductPanel.vue';
import AboutCapabilityGrid from '../components/settings/AboutCapabilityGrid.vue';
import AboutPrivacyPanel from '../components/settings/AboutPrivacyPanel.vue';
import UserProfilePanel from '../components/settings/UserProfilePanel.vue';


const VALID_TABS = ['profile', 'account', 'general', 'agents', 'providers', 'models', 'tts', 'asr', 'usage', 'plugins', 'about'] as const;

const uiStore = useUIStore();
const settingsStore = useSettingsStore();
const route = useRoute();
// 桌面壳自带后端，地址固定为 127.0.0.1:8600，无需用户配置。
const isDesktopRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const storedTab = localStorage.getItem('lingshu_settings_active_tab') || 'general';
const queryTab = typeof route.query.tab === 'string' ? route.query.tab : '';
const activeKey = ref(
  (VALID_TABS as readonly string[]).includes(queryTab)
    ? queryTab
    : (VALID_TABS as readonly string[]).includes(storedTab)
      ? storedTab
      : 'general',
);
const backendUrl = ref(getApiBaseUrl());
const backendUrlPlaceholder = ref(getApiBaseUrl() || 'http://127.0.0.1:8600');
const backendTesting = ref(false);
const backendSaving = ref(false);
const dataPath = ref('');
const defaultDataPath = ref('');
const runtimePath = ref('');
const dataPathLoading = ref(false);
const dataPathSaving = ref(false);
const dataPathChoosing = ref(false);
const activeAccountChannel = ref<'wechat' | 'qqbot' | null>(null);
const mobileConfigModalVisible = ref(false);
const mobileConfigUrl = ref('');
const mobileConfigQrSrc = ref('');
const mobileConfigQrError = ref(false);

// 监听 tab 切换并保存到本地存储
watch(activeKey, (newVal) => {
  localStorage.setItem('lingshu_settings_active_tab', newVal);
});

// 标题栏的下载状态胶囊会带 ?tab=asr 跳转过来
watch(
  () => route.query.tab,
  (tab) => {
    if (typeof tab === 'string' && (VALID_TABS as readonly string[]).includes(tab) && activeKey.value !== tab) {
      activeKey.value = tab;
    }
  },
);

const menuItems = [
  { key: 'profile', title: '我的', icon: IconUser },
  { key: 'account', title: '微信/QQ机器人', icon: IconApps },
  { key: 'general', title: '系统设置', icon: IconSettings },
  { key: 'agents', title: '智能体管理', icon: IconRobot },
  { key: 'providers', title: '服务商管理', icon: IconCloud },
  { key: 'models', title: '模型配置', icon: IconCode },
  { key: 'tts', title: '语音合成', icon: IconSound },
  { key: 'asr', title: '语音识别', icon: IconVoice },
  { key: 'usage', title: '用量统计', icon: IconBarChart },
  { key: 'plugins', title: '插件', icon: IconApps },
  { key: 'about', title: '关于灵枢', icon: IconInfoCircle },
];



const appearanceOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

onMounted(() => {
  backendUrl.value = getApiBaseUrl();
  backendUrlPlaceholder.value = getApiBaseUrl() || 'http://127.0.0.1:8600';
  if (!settingsStore.isLoaded) {
    settingsStore.fetchSettings();
  } else {
    settingsStore.fetchGeneralSettings();
  }
  void loadDataPath();
});

async function loadDataPath() {
  dataPathLoading.value = true;
  try {
    const res = await fetch(new URL('/api/system/data-path', getApiBaseUrl()).toString(), {
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String(data?.detail || '读取数据路径失败'));
    }
    dataPath.value = String(data.dataPath || '');
    defaultDataPath.value = String(data.defaultDataPath || '');
    runtimePath.value = String(data.runtimePath || '');
  } catch (err) {
    Message.warning(err instanceof Error ? err.message : '读取数据路径失败');
  } finally {
    dataPathLoading.value = false;
  }
}

async function handleSaveDataPath() {
  const target = dataPath.value.trim();
  if (!target) {
    Message.warning('请填写数据路径');
    return;
  }
  dataPathSaving.value = true;
  try {
    const res = await fetch(new URL('/api/system/data-path', getApiBaseUrl()).toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dataPath: target }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String(data?.detail || data?.message || '保存数据路径失败'));
    }
    dataPath.value = String(data.dataPath || target);
    defaultDataPath.value = String(data.defaultDataPath || defaultDataPath.value);
    runtimePath.value = String(data.runtimePath || runtimePath.value);
    Message.success(String(data.message || '数据路径已更新'));
  } catch (err) {
    Message.error(err instanceof Error ? err.message : '保存数据路径失败');
  } finally {
    dataPathSaving.value = false;
  }
}

function resetDataPathToDefault() {
  if (defaultDataPath.value) {
    dataPath.value = defaultDataPath.value;
  }
}

async function handleChooseDataPath() {
  dataPathChoosing.value = true;
  try {
    const selected = await selectFolderPath({
      title: '选择灵枢数据目录',
      defaultPath: dataPath.value || defaultDataPath.value,
    });
    if (selected) {
      dataPath.value = selected;
    }
  } catch (err) {
    Message.error(err instanceof Error ? err.message : '打开文件夹选择器失败');
  } finally {
    dataPathChoosing.value = false;
  }
}

async function handleTestBackendConnection() {
  backendTesting.value = true;
  try {
    const result = await testBackendConnection(backendUrl.value);
    if (result.ok) {
      Message.success(result.message);
    } else {
      Message.error(result.message);
    }
  } finally {
    backendTesting.value = false;
  }
}

async function handleSaveBackendUrl() {
  backendSaving.value = true;
  try {
    const previous = getApiBaseUrl();
    setApiBaseUrl(backendUrl.value);
    backendUrl.value = getApiBaseUrl();
    const result = await testBackendConnection(backendUrl.value);
    if (result.ok) {
      Message.success(backendUrl.value !== previous ? '后端地址已保存' : '后端连接正常');
    } else {
      Message.warning(result.message);
    }
  } catch (err) {
    Message.error(err instanceof Error ? err.message : '保存失败');
  } finally {
    backendSaving.value = false;
  }
}

function resolveMobileConfigOrigin(): string {
  const raw = (backendUrl.value || getApiBaseUrl()).trim();
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

function openMobileConfigModal() {
  const origin = resolveMobileConfigOrigin();
  if (!origin) {
    Message.warning('请先填写后端服务地址');
    return;
  }
  mobileConfigUrl.value = origin;
  mobileConfigQrError.value = false;
  mobileConfigQrSrc.value = `${origin}/api/system/mobile-config.svg?t=${Date.now()}`;
  mobileConfigModalVisible.value = true;
}

function closeMobileConfigModal() {
  mobileConfigModalVisible.value = false;
}

async function copyMobileConfigUrl() {
  const text = mobileConfigUrl.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    Message.success('已复制后端地址');
  } catch {
    Message.error('复制失败，请手动选择地址复制');
  }
}

function onMobileConfigQrError() {
  mobileConfigQrError.value = true;
}
</script>

<template>
  <div class="settings-container">
    <!-- Left Sidebar Menu -->
    <div class="settings-sidebar">
      <div 
        v-for="item in menuItems" 
        :key="item.key"
        class="menu-item"
        :class="{ active: activeKey === item.key }"
        @click="activeKey = item.key"
      >
        <component :is="item.icon" class="item-icon" />
        <span class="item-title">{{ item.title }}</span>
      </div>
    </div>

    <!-- Right Settings Content -->
    <div class="settings-content">
      <div v-show="activeKey === 'profile'" class="settings-scroll-area">
        <UserProfilePanel />
      </div>

      <div v-show="activeKey === 'account'" class="settings-scroll-area">
        <WeChatLink
          :expanded="activeAccountChannel === 'wechat'"
          :active="activeKey === 'account'"
          @toggle="activeAccountChannel = activeAccountChannel === 'wechat' ? null : 'wechat'"
        />
        <QQBotLink
          :expanded="activeAccountChannel === 'qqbot'"
          :active="activeKey === 'account'"
          @toggle="activeAccountChannel = activeAccountChannel === 'qqbot' ? null : 'qqbot'"
        />
      </div>

      <div v-show="activeKey === 'general'" class="settings-scroll-area">
        <div class="settings-group">
          <div v-if="!isDesktopRuntime" class="setting-row">
            <div class="row-label">
              <span class="main-text">后端服务地址</span>
              <span class="sub-text">自动读取本机 IP，需服务端运行在当前设备上；不一致，请手动配置服务端所在设备 IP</span>
            </div>
            <div class="row-action backend-url-actions">
              <a-input
                v-model="backendUrl"
                :placeholder="backendUrlPlaceholder"
                :style="{ width: '320px' }"
                size="small"
              />
              <a-button size="small" :loading="backendTesting" @click="handleTestBackendConnection">
                测试连接
              </a-button>
              <a-button type="primary" size="small" :loading="backendSaving" @click="handleSaveBackendUrl">
                保存
              </a-button>
            </div>
          </div>
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">数据路径</span>
              <span class="sub-text">
                灵枢本地数据根目录，默认位于用户目录。
              </span>
              <span v-if="runtimePath" class="sub-text runtime-hint">runtime：{{ runtimePath }}</span>
            </div>
            <div class="row-action backend-url-actions">
              <a-input
                v-model="dataPath"
                :placeholder="defaultDataPath || 'C:\\Users\\你\\.lingshu'"
                class="path-input"
                size="small"
                :disabled="dataPathLoading"
              >
                <template #suffix>
                  <a-button
                    type="text"
                    size="mini"
                    style="padding: 0 4px; height: auto;"
                    :loading="dataPathChoosing"
                    :disabled="dataPathLoading"
                    @click="handleChooseDataPath"
                  >
                    浏览
                  </a-button>
                </template>
              </a-input>
              <a-button size="small" :disabled="dataPathLoading || !defaultDataPath" @click="resetDataPathToDefault">
                重置
              </a-button>
              <a-button
                type="primary"
                size="small"
                :loading="dataPathSaving"
                :disabled="dataPathLoading"
                @click="handleSaveDataPath"
              >
                保存
              </a-button>
            </div>
          </div>
          <div v-if="!isDesktopRuntime" class="setting-row">
            <div class="row-label">
              <span class="main-text">移动端 APP 配置</span>
              <span class="sub-text">生成与当前后端地址一致的二维码，供手机 App「设置 → 扫码配置连接」扫描写入</span>
            </div>
            <div class="row-action">
              <a-button size="small" type="primary" @click="openMobileConfigModal">
                <template #icon><IconQrcode /></template>
                显示二维码
              </a-button>
            </div>
          </div>
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">外观</span>
              <span class="sub-text">切换应用主题，系统模式会跟随操作系统的深浅色偏好</span>
            </div>
            <div class="row-action">
              <a-select 
                v-model="uiStore.theme"
                :options="appearanceOptions" 
                :style="{ width: '120px' }" 
                size="small" 
              />
            </div>
          </div>
        </div>
      </div>

      <div v-show="activeKey === 'agents'" class="settings-scroll-area">
        <AgentManager />
      </div>

      <div v-show="activeKey === 'providers'" class="settings-scroll-area">
        <ProviderManager />
      </div>

      <div v-show="activeKey === 'models'" class="settings-scroll-area">
        <ModelConfig />
      </div>

      <div v-show="activeKey === 'tts'" class="settings-scroll-area">
        <TtsConfig />
      </div>

      <div v-show="activeKey === 'asr'" class="settings-scroll-area">
        <AsrConfig />
      </div>

      <div v-show="activeKey === 'usage'" class="settings-scroll-area">
        <UsageStatsPanel />
      </div>

      <div v-show="activeKey === 'plugins'" class="settings-scroll-area">
        <PluginConfig />
      </div>

      <div v-show="activeKey === 'about'" class="settings-scroll-area">
        <div class="about-content-inner about-console">
          <div class="about-top-grid">
            <AboutProductPanel version="Version 0.1.0 (Alpha Build)" />
          </div>
          <AboutCapabilityGrid />
          <AboutPrivacyPanel />
          <div class="about-footer">
            <p>© 2026 LingShu AI Project. 本地优先的个人数字生命港湾。</p>
            <div class="footer-actions">
              <a-button type="text" size="mini" disabled>检查更新</a-button>
              <a-button type="text" size="mini" disabled>GitHub 仓库</a-button>
            </div>
          </div>
        </div>
      </div>


      <div v-show="!['profile', 'account', 'general', 'agents', 'providers', 'models', 'tts', 'asr', 'usage', 'plugins', 'about'].includes(activeKey)" class="empty-detail">
        <p>该功能正在开发中...</p>
      </div>

    </div>

    <!-- 移动端 APP 扫码配置（对齐后端授权页「进入灵枢」弹窗） -->
    <a-modal
      v-model:visible="mobileConfigModalVisible"
      :footer="false"
      :width="400"
      unmount-on-close
      @cancel="closeMobileConfigModal"
    >
      <template #title>
        <span class="mobile-config-title">扫码连接灵枢</span>
      </template>
      <div class="mobile-config-modal">
        <p class="mobile-config-hint">
          打开手机 App 的「设置」→「扫码配置连接」，扫描下方二维码即可自动写入当前后端地址。
        </p>
        <div class="mobile-config-qr-frame">
          <img
            v-if="mobileConfigQrSrc && !mobileConfigQrError"
            :src="mobileConfigQrSrc"
            alt="灵枢服务端配置二维码"
            @error="onMobileConfigQrError"
          />
          <div v-else class="mobile-config-qr-fallback">
            二维码加载失败，请确认后端可访问后重试
          </div>
        </div>
        <code class="mobile-config-url">{{ mobileConfigUrl }}</code>
        <div class="mobile-config-actions">
          <a-button style="flex: 1" @click="copyMobileConfigUrl">复制地址</a-button>
          <a-button type="primary" style="flex: 1" @click="closeMobileConfigModal">完成</a-button>
        </div>
      </div>
    </a-modal>

  </div>
</template>

<style scoped>
.settings-container {
  position: absolute;
  inset: 0;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
  background-color: var(--bg-nav-rail, var(--bg-sidebar));
}

/* Sidebar Styling */
.settings-sidebar {
  width: 240px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
  background-color: var(--bg-conversation-list, var(--bg-nav-rail, var(--bg-sidebar)));
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
}


.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  color: var(--text-primary);
}

.menu-item:hover {
  background-color: var(--bg-hover);
}

.menu-item.active {
  background-color: var(--bg-selected);
}

.item-icon {
  width: 18px;
  height: 18px;
  font-size: 18px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.item-title {
  font-size: 14px;
}

/* Content Styling */
.settings-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  background-color: var(--bg-chat-window);
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}

.settings-scroll-area {
  flex: 1 1 auto;
  min-height: 0;
  height: 0; /* flex 列里强制可收缩，内容溢出才走本层滚动 */
  overflow-x: hidden;
  overflow-y: auto;
  display: block; /* 不要用 flex 列包内容，避免子项把滚动容器撑开 */
  padding: 24px 32px;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.settings-scroll-area > * + * {
  margin-top: 16px;
}

/* Custom Scrollbar — 展开 QQ/微信配置后内容变长，需可见可滚 */
.settings-scroll-area::-webkit-scrollbar {
  width: 8px;
}

.settings-scroll-area::-webkit-scrollbar-track {
  background: transparent;
}

.settings-scroll-area::-webkit-scrollbar-thumb {
  background: rgba(var(--primary-color-rgb, 0, 0, 0), 0.22);
  border-radius: 10px;
  transition: background 0.3s;
}

.settings-scroll-area:hover::-webkit-scrollbar-thumb {
  background: rgba(var(--primary-color-rgb, 0, 0, 0), 0.38);
}

.settings-group {
  background-color: var(--bg-input);
  border-radius: 12px;
  padding: 4px 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.setting-row:last-child {
  border-bottom: none;
}

.setting-row.multi-line {
  align-items: flex-start;
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
  max-width: 58%;
}

.main-text {
  font-size: 14px;
  color: var(--text-primary);
}

.sub-text {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.sub-text.runtime-hint {
  word-break: break-all;
}

.row-action {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.backend-url-actions {
  gap: 8px;
  flex-wrap: nowrap;
  justify-content: flex-end;
}

.path-input {
  width: 280px;
  flex-shrink: 1;
  min-width: 160px;
}

.slider-container {
  padding-top: 10px;
  min-width: 200px;
}

.empty-detail {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-tertiary);
}

/* About Page Styling */
.about-content-inner {
  display: flex;
  flex-direction: column;
  gap: 36px;
  max-width: 760px;
  margin: auto;
  padding: 30px 24px 60px;
}

.about-hero {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.about-logo {
  width: 80px;
  height: 80px;
  border-radius: 20px;
  box-shadow: 0 8px 24px rgba(7, 193, 96, 0.15);
  margin-bottom: 8px;
}

.app-name {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.app-version {
  font-size: 13px;
  color: var(--text-tertiary);
  margin: 0;
}

.manifesto-lead {
  max-width: 600px;
  margin-top: 16px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
  text-align: center;
}

.manifesto-lead p {
  margin: 8px 0;
}

.manifesto-lead .highlight {
  color: var(--color-primary);
  font-weight: 500;
  font-size: 15px;
}

.about-manifesto-sections {
  display: flex;
  flex-direction: column;
  gap: 20px;
  margin-top: 10px;
}

.manifesto-card {
  display: flex;
  gap: 20px;
  background-color: var(--bg-input);
  padding: 24px;
  border-radius: 16px;
  border: 1px solid var(--border-color);
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.01);
}

.manifesto-card:hover {
  border-color: var(--color-primary-light-3);
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(7, 193, 96, 0.05);
}

.card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  background-color: var(--color-primary-light-1);
  color: var(--color-primary);
  border-radius: 12px;
  flex-shrink: 0;
}

.card-icon .material-symbols-outlined {
  font-size: 22px;
}

.card-body h4 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.card-body p {
  font-size: 13.5px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.6;
}

.about-manifesto-footer {
  display: flex;
  flex-direction: column;
  gap: 28px;
  margin-top: 16px;
  text-align: center;
}

.philosophy-quote {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-tertiary);
  font-style: italic;
  padding: 16px;
  background-color: var(--bg-hover);
  border-radius: 12px;
  border-left: 3px solid var(--color-primary);
  text-align: left;
  max-width: 680px;
  margin: 0 auto;
}

.about-footer {
  padding-top: 24px;
  border-top: 1px solid var(--border-color);
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: center;
}

.footer-actions {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-top: 12px;
}

.footer-actions :deep(.arco-btn) {
  color: var(--text-secondary) !important;
  transition: color var(--transition-fast) !important;
}

.footer-actions :deep(.arco-btn:not(.arco-btn-disabled):hover) {
  color: var(--color-primary) !important;
}

.footer-actions :deep(.arco-btn-disabled) {
  color: var(--text-placeholder) !important;
  opacity: 0.5;
  cursor: not-allowed !important;
}

.about-content-inner.about-console {
  max-width: 980px;
  gap: 16px;
  padding: 0 0 32px;
}

.about-top-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
}

@media (max-width: 980px) {
  .about-top-grid {
    grid-template-columns: 1fr;
  }
}

.mobile-config-title {
  font-size: 16px;
  font-weight: 600;
}

.mobile-config-modal {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  text-align: center;
  padding: 4px 4px 8px;
}

.mobile-config-hint {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 1.55;
  text-align: left;
}

.mobile-config-qr-frame {
  width: 224px;
  height: 224px;
  margin: 20px auto 14px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: #fff;
  box-sizing: border-box;
}

.mobile-config-qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
}

.mobile-config-qr-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 16px;
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
}

.mobile-config-url {
  display: block;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-hover);
  color: var(--text-primary);
  font-size: 12px;
  word-break: break-all;
  text-align: left;
}

.mobile-config-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

</style>
