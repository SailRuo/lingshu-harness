<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { Message, Modal } from '@arco-design/web-vue';
import { invoke } from '@tauri-apps/api/core';
import IconCopy from '@arco-design/web-vue/es/icon/icon-copy';
import IconDownload from '@arco-design/web-vue/es/icon/icon-download';
import IconUpload from '@arco-design/web-vue/es/icon/icon-upload';
import IconDelete from '@arco-design/web-vue/es/icon/icon-delete';
import {
  cancelAsrModelDownload,
  deleteAsrModel,
  formatBytes,
  importAsrModelZip,
  startAsrModelDownload,
} from '../../services/asrModelApi';
import {
  applyAsrModelStatus,
  asrDownloadSpeed,
  asrModelState,
  isAsrModelBusy,
  refreshAsrModelStatus,
} from '../../services/asrModelWatcher';
import type { AppleSpeechStatus } from '../../composables/useVoiceAsrStatus';
import { prewarmVoiceCapture, useVoiceChat } from '../../composables/useVoiceChat';
import { VOICE_HINT } from '../../composables/voiceConnectionCopy';
import type { VoiceDiagnostics } from '../../composables/useVoiceChat';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();

const status = asrModelState;
const loading = ref(true);
const busy = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const upload = reactive({ active: false, loaded: 0, total: 0 });

const isMac = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent);

/**
 * 服务商选择卡片：名称 + 一句话门槛说明 + 实时状态点。
 * 让用户在点选之前就知道每个选项需要什么、现在是否可用。
 */
type ProviderCard = {
  value: 'local' | 'xiaomi' | 'aliyun' | 'apple';
  label: string;
  requirement: string;
  status: string;
  statusLevel: 'ok' | 'warn' | 'idle';
};

const localReady = computed(() => Boolean(installed.value && status.value?.runtimeReady));

const providerCards = computed<ProviderCard[]>(() => {
  const cards: ProviderCard[] = [
    {
      value: 'local',
      label: '本地模型',
      requirement: '完全离线 · 首次需下载约 208MB',
      status: localReady ? '已安装' : '未安装',
      statusLevel: localReady ? 'ok' : 'warn',
    },
    {
      value: 'xiaomi',
      label: '小米 MiMo',
      requirement: '云端转写 · 填 API Key 即用',
      status: settings.asr.xiaomi.apiKey ? '密钥已配置' : '未配置密钥',
      statusLevel: settings.asr.xiaomi.apiKey ? 'ok' : 'warn',
    },
    {
      value: 'aliyun',
      label: '阿里云',
      requirement: '云端转写 · 填 API Key 即用',
      status: settings.asr.aliyun.apiKey ? '密钥已配置' : '未配置密钥',
      statusLevel: settings.asr.aliyun.apiKey ? 'ok' : 'warn',
    },
  ];
  if (isMac) {
    cards.push({
      value: 'apple',
      label: 'macOS 系统识别',
      requirement: '系统自带 · 免费 · 不占磁盘',
      status: appleReady.value ? '已授权可用' : (appleDenied.value ? '权限被拒绝' : '待授权'),
      statusLevel: appleReady.value ? 'ok' : 'warn',
    });
  }
  return cards;
});

const appleStatus = ref<AppleSpeechStatus | null>(null);
const appleLoading = ref(false);

async function refreshAppleStatus() {
  appleLoading.value = true;
  try {
    appleStatus.value = await invoke<AppleSpeechStatus>('apple_speech_status', {
      language: settings.asr.language,
    });
  } catch {
    appleStatus.value = null;
  } finally {
    appleLoading.value = false;
  }
}

const appleReady = computed(() => Boolean(appleStatus.value?.available && appleStatus.value?.authorized));
const appleStatusText = computed(() => {
  const current = appleStatus.value;
  if (!current) return '正在读取系统语音识别状态…';
  if (!current.available) return current.message || '此系统不支持所选语言的系统语音识别';
  if (!current.authorized) return '点击「授权」允许灵枢使用系统语音识别';
  if (current.authorization === 'denied' || current.authorization === 'restricted') {
    return current.message || '系统语音识别权限被拒绝，请到 系统设置 → 隐私与安全性 → 语音识别 中允许灵枢';
  }
  return '系统语音识别可用，语音功能应立即可用';
});
const appleDenied = computed(() => {
  const current = appleStatus.value;
  return Boolean(current && !current.authorized
    && (current.authorization === 'denied' || current.authorization === 'restricted'));
});
const appleOnDeviceText = computed(() => {
  const current = appleStatus.value;
  if (!current) return '';
  return current.onDevice
    ? '系统已装设备端语音包，可完全离线识别'
    : '未检测到设备端语音包，将走 Apple 服务器识别（需联网）';
});

async function requestAppleAuthorization() {
  appleLoading.value = true;
  try {
    const next = await invoke<AppleSpeechStatus>('apple_speech_request_authorization');
    if (next.authorized) {
      appleStatus.value = await invoke<AppleSpeechStatus>('apple_speech_status', {
        language: settings.asr.language,
      });
      Message.success('系统语音识别已授权');
    } else {
      appleStatus.value = next;
      Message.warning(next.message || '未能获得系统语音识别授权');
    }
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '发起授权失败');
  } finally {
    appleLoading.value = false;
  }
}

// —— 语音识别测试：点击开始 → 开麦采集（JS VAD 门控）→ 检测到停顿自动断句，
// 收到第一句 final 即结束并显示结果；识别结果只留在本页，不会发给智能体。
// 所有服务商通用：apple 走 Rust Speech 框架（实时流式），其余走后端 WS。
const voice = useVoiceChat();
const testRunning = ref(false);
const testResult = ref('');
const testAudioUrl = ref<string | null>(null);
const testAudioSeconds = ref(0);
const testDiag = ref<VoiceDiagnostics | null>(null);
let testDiagTimer: number | null = null;
let testStopping = false;

function pollVoiceDiagnostics(): void {
  testDiag.value = voice.getVoiceDiagnostics();
}

/** 说话过程中的流式中间文本（partial 实时回传）；聆听占位文案视为空 */
const testLiveText = computed(() => {
  const text = (voice.liveTranscript.value || '').trim();
  return text && text !== VOICE_HINT.liveListening ? text : '';
});

async function startVoiceTest() {
  if (testRunning.value) return;
  testRunning.value = true;
  testResult.value = '';
  if (testAudioUrl.value) {
    URL.revokeObjectURL(testAudioUrl.value);
    testAudioUrl.value = null;
  }
  testAudioSeconds.value = 0;
  // 显式测试：旁路上传门禁（每帧直送 ASR），并记录实际送出的 PCM 供回放诊断
  voice.setAsrGateBypass(true);
  voice.startAsrCapture();
  pollVoiceDiagnostics();
  if (testDiagTimer !== null) window.clearInterval(testDiagTimer);
  testDiagTimer = window.setInterval(pollVoiceDiagnostics, 400);
  voice.setTranscriptHandler((text) => {
    const clean = text.trim();
    if (!clean) return;
    // 停顿断句出的每一句都累计，不结束测试；点「停止测试」才收尾
    testResult.value = testResult.value ? `${testResult.value}${clean}` : clean;
  });
  try {
    await voice.startPushToTalk();
    if (!voice.micReady.value) {
      throw new Error(voice.lastError.value || '麦克风不可用');
    }
  } catch (error) {
    voice.setTranscriptHandler(null);
    voice.setAsrGateBypass(false);
    voice.stopAsrCapture();
    pollVoiceDiagnostics();
    testRunning.value = false;
    Message.error(error instanceof Error ? error.message : '启动语音测试失败');
  } finally {
    if (testDiagTimer !== null) {
      window.clearInterval(testDiagTimer);
      testDiagTimer = null;
    }
  }
}

async function stopVoiceTest() {
  if (!testRunning.value || testStopping) return;
  testStopping = true;
  try {
    await voice.stopPushToTalk();
    // 等尾部的 final 事件送达（closeAsrStream 内部已等 350ms）
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  } finally {
    voice.setTranscriptHandler(null);
    voice.setAsrGateBypass(false);
    const capture = voice.stopAsrCapture();
    testAudioUrl.value = capture.wavUrl;
    testAudioSeconds.value = capture.seconds;
    pollVoiceDiagnostics();
    testRunning.value = false;
    testStopping = false;
    if (testDiagTimer !== null) {
      window.clearInterval(testDiagTimer);
      testDiagTimer = null;
    }
  }
}

async function copyTestResult() {
  try {
    await navigator.clipboard.writeText(testResult.value);
    Message.success('已复制');
  } catch {
    Message.error('复制失败');
  }
}

const languageOptions = [
  { value: 'auto', label: '自动' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
];

const CLOUD_CONSOLES = {
  xiaomi: 'https://platform.xiaomimimo.com/console/api-keys',
  aliyun: 'https://bailian.console.aliyun.com/',
} as const;

const installed = computed(() => Boolean(status.value?.installed));
const resumableBytes = computed(() => status.value?.resumableBytes || 0);
const canResume = computed(() => !installed.value && !active.value && resumableBytes.value > 0);
const downloadLabel = computed(() => {
  if (installed.value) return '重新下载';
  return canResume.value ? '继续下载' : '下载模型';
});
const downloadHint = computed(() => {
  if (canResume.value) {
    return `上次下载中断，已保留 ${formatBytes(resumableBytes.value)}，点击继续`;
  }
  return '从官方地址下载并自动安装，下载期间可取消';
});
const serverActive = computed(() => isAsrModelBusy(status.value));
const active = computed(() => upload.active || serverActive.value);
const downloadUrl = computed(() => status.value?.downloadUrl || '');
const modelSizeText = computed(() => (status.value?.sizeBytes ? formatBytes(status.value.sizeBytes) : ''));
const provider = computed(() => settings.asr.provider);

const percent = computed(() => {
  if (upload.active) {
    return upload.total > 0 ? Math.min(100, Math.round((upload.loaded / upload.total) * 100)) : 0;
  }
  const current = status.value;
  if (!current) return 0;
  if (current.phase === 'downloading') {
    return current.totalBytes > 0
      ? Math.min(100, Math.round((current.downloadedBytes / current.totalBytes) * 100))
      : 0;
  }
  if (current.phase === 'installing') return 100;
  return current.phase === 'done' ? 100 : 0;
});

const phaseLabel = computed(() => {
  if (upload.active) return '正在上传模型包…';
  const phase = status.value?.phase;
  if (phase === 'downloading') return '正在下载模型…';
  if (phase === 'installing') return '正在安装模型…';
  return '';
});

const progressText = computed(() => {
  if (upload.active) {
    return `${formatBytes(upload.loaded)} / ${formatBytes(upload.total)}`;
  }
  const current = status.value;
  if (!current) return '';
  if (current.phase === 'downloading') {
    const speed = asrDownloadSpeed.value;
    const speedText = speed > 0 ? ` · ${formatBytes(speed)}/s` : '';
    return `${formatBytes(current.downloadedBytes)} / ${formatBytes(current.totalBytes)}（${percent.value}%）${speedText}`;
  }
  if (current.phase === 'installing') return '解压与校验中，请稍候…';
  return '';
});

async function saveConfig() {
  try {
    await settings.saveSettings();
    Message.success('语音识别配置已保存');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '保存失败');
  }
}

async function onDownload() {
  if (busy.value || active.value) return;
  busy.value = true;
  try {
    applyAsrModelStatus(await startAsrModelDownload());
    Message.info('已开始下载，可以离开此页面');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '启动下载失败');
  } finally {
    busy.value = false;
  }
}

async function onCancel() {
  try {
    applyAsrModelStatus(await cancelAsrModelDownload());
    Message.info('已取消下载');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '取消失败');
  }
}

function pickFile() {
  if (busy.value) return;
  fileInput.value?.click();
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.zip')) {
    Message.warning('请选择官方发布的 .zip 模型包');
    return;
  }
  upload.active = true;
  upload.loaded = 0;
  upload.total = file.size;
  try {
    const next = await importAsrModelZip(file, (loaded, total) => {
      upload.loaded = loaded;
      upload.total = total;
    });
    applyAsrModelStatus(next);
    Message.success('模型导入完成，已生效');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '导入失败');
  } finally {
    upload.active = false;
  }
}

function confirmDelete() {
  Modal.confirm({
    title: '删除语音识别模型',
    content: '删除后语音识别将不可用，需要重新下载或导入。确定删除吗？',
    okText: '删除',
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try {
        applyAsrModelStatus(await deleteAsrModel());
        Message.success('模型已删除');
      } catch (error) {
        Message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
  });
}

async function copyText(text: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    Message.success('已复制');
  } catch {
    Message.error('复制失败，请手动选择文本复制');
  }
}

async function openExternal(url: string) {
  if (!url) return;
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  try {
    if (isTauri) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch {
    Message.error('打开链接失败，可复制后在浏览器中打开');
  }
}

function openDownloadUrl() {
  void openExternal(downloadUrl.value);
}

function openConsole() {
  if (provider.value === 'xiaomi') void openExternal(CLOUD_CONSOLES.xiaomi);
  else if (provider.value === 'aliyun') void openExternal(CLOUD_CONSOLES.aliyun);
}

onMounted(async () => {
  if (!settings.isLoaded) {
    try {
      await settings.fetchSettings();
    } catch {
      // 状态行会提示读取失败，不阻塞本地模型面板
    }
  }
  await refreshAsrModelStatus(true);
  if (isMac) void refreshAppleStatus();
  // 预热音频图（AudioWorklet 模块），降低首次「测试识别」的建链延迟
  prewarmVoiceCapture();
  loading.value = false;
});

// 切到 macOS 系统识别时刷新一次系统状态（语言可能已变化）
watch(
  () => settings.asr.provider,
  (next) => {
    if (isMac && next === 'apple') void refreshAppleStatus();
  },
);
</script>

<template>
  <div class="asr-config">
    <div class="asr-header">
      <div class="asr-title">语音识别</div>
      <div class="asr-desc">
        本地模型完全离线运行，首次使用需要下载约 208MB 模型包；小米 MiMo 与阿里云走云端，只需填写 API Key，不再占用磁盘；macOS 用户还可选用系统自带语音识别。
      </div>
    </div>

    <div class="settings-group provider-group">
      <div
        class="provider-grid"
        role="radiogroup"
        aria-label="识别方式"
      >
        <button
          v-for="item in providerCards"
          :key="item.value"
          type="button"
          class="provider-chip"
          :class="{ selected: provider === item.value }"
          role="radio"
          :aria-checked="provider === item.value"
          :title="item.requirement"
          @click="settings.asr.provider = item.value"
        >
          <span class="status-dot" :class="item.statusLevel" aria-hidden="true"></span>
          {{ item.label }}
        </button>
      </div>
    </div>

    <template v-if="provider === 'apple'">
      <a-spin :loading="appleLoading" tip="正在读取系统识别状态...">
        <div class="settings-group">
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">系统识别状态</span>
              <span class="sub-text">{{ appleStatusText }}</span>
            </div>
            <div class="row-action">
              <span class="status-pill" :data-level="appleReady ? 'ok' : 'warn'">
                <span class="status-dot"></span>
                {{ appleReady ? '可用' : (appleDenied ? '已拒绝' : '待授权') }}
              </span>
              <a-button
                v-if="!appleReady"
                type="primary"
                size="small"
                :loading="appleLoading"
                :disabled="appleDenied"
                @click="requestAppleAuthorization"
              >
                授权
              </a-button>
              <a-button size="small" :loading="appleLoading" @click="refreshAppleStatus">刷新</a-button>
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">设备端识别</span>
              <span class="sub-text">{{ appleOnDeviceText }}</span>
            </div>
            <div class="row-action">
              <span class="status-pill" :data-level="appleStatus?.onDevice ? 'ok' : 'idle'">
                <span class="status-dot"></span>
                {{ appleStatus?.onDevice ? '可离线' : '需联网' }}
              </span>
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">识别语言</span>
              <span class="sub-text">自动按中文处理，英文用户可选英文</span>
            </div>
            <div class="row-action">
              <a-select
                v-model="settings.asr.language"
                size="small"
                style="width: 160px"
                @change="refreshAppleStatus"
              >
                <a-option v-for="item in languageOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </a-option>
              </a-select>
            </div>
          </div>

        </div>

      </a-spin>
    </template>

    <template v-else-if="provider === 'local'">
      <a-spin :loading="loading" tip="正在读取模型状态...">
        <div class="settings-group">
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">模型状态</span>
              <span class="sub-text">
                {{ installed ? (status?.runtimeReady ? '已安装并可用' : '已安装，识别器尚未就绪') : '尚未安装，语音识别不可用' }}
              </span>
            </div>
            <div class="row-action">
              <span class="status-pill" :data-level="installed ? (status?.runtimeReady ? 'ok' : 'warn') : 'idle'">
                <span class="status-dot"></span>
                {{ installed ? (status?.runtimeReady ? '可用' : '待加载') : '未安装' }}
              </span>
              <span v-if="installed && status?.model" class="meta-text">
                {{ status.model }}<template v-if="modelSizeText"> · {{ modelSizeText }}</template>
              </span>
            </div>
          </div>

          <div v-if="installed && !localReady && status?.installDir" class="setting-row">
            <div class="row-label">
              <span class="main-text">安装位置</span>
              <span class="sub-text mono-text">{{ status.installDir }}</span>
            </div>
            <div class="row-action">
              <a-button size="small" @click="copyText(status?.installDir || '')">
                <template #icon><IconCopy /></template>
                复制路径
              </a-button>
            </div>
          </div>

          <div v-if="active" class="setting-row progress-row">
            <div class="row-label">
              <span class="main-text">{{ phaseLabel }}</span>
              <span class="sub-text">{{ progressText }}</span>
            </div>
            <div class="row-action">
              <a-button v-if="serverActive && status?.phase === 'downloading'" size="small" @click="onCancel">
                取消
              </a-button>
            </div>
          </div>
          <div v-if="active" class="progress-wrap">
            <div class="progress-track">
              <div class="progress-fill" :style="{ width: `${percent}%` }"></div>
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">一键下载</span>
              <span class="sub-text">{{ downloadHint }}</span>
            </div>
            <div class="row-action">
              <a-button type="primary" :loading="busy" :disabled="active" @click="onDownload">
                <template #icon><IconDownload /></template>
                {{ downloadLabel }}
              </a-button>
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">本地导入</span>
              <span class="sub-text">选择官方发布的 .zip 模型包，支持离线安装</span>
            </div>
            <div class="row-action">
              <input
                ref="fileInput"
                class="hidden-input"
                type="file"
                accept=".zip,application/zip"
                @change="onFileChange"
              />
              <a-button :disabled="active" @click="pickFile">
                <template #icon><IconUpload /></template>
                选择 ZIP
              </a-button>
            </div>
          </div>

          <div v-if="!localReady" class="setting-row">
            <div class="row-label">
              <span class="main-text">下载链接</span>
              <span class="sub-text break-text">{{ downloadUrl }}</span>
            </div>
            <div class="row-action">
              <a-button size="small" @click="copyText(downloadUrl)">复制链接</a-button>
              <a-button size="small" @click="openDownloadUrl">浏览器打开</a-button>
            </div>
          </div>

          <div v-if="installed" class="setting-row">
            <div class="row-label">
              <span class="main-text">删除模型</span>
              <span class="sub-text">删除已安装的模型文件，释放磁盘空间</span>
            </div>
            <div class="row-action">
              <a-button size="small" status="danger" :disabled="active" @click="confirmDelete">
                <template #icon><IconDelete /></template>
                删除
              </a-button>
            </div>
          </div>

        </div>

        <a-alert v-if="status?.phase === 'failed' && status.error" type="error" show-icon class="asr-alert">
          {{ status.error }}
        </a-alert>
        <a-alert
          v-else-if="installed && !status?.runtimeReady && status?.runtimeMessage"
          type="warning"
          show-icon
          class="asr-alert"
        >
          {{ status.runtimeMessage }}
        </a-alert>
      </a-spin>
    </template>

    <template v-else>
      <div class="settings-group">
        <div class="setting-row">
          <div class="row-label">
            <span class="main-text">API Key</span>
            <span class="sub-text">保存在本机设置中，仅用于语音识别请求</span>
          </div>
          <div class="row-action">
            <a-input-password
              v-if="provider === 'xiaomi'"
              v-model="settings.asr.xiaomi.apiKey"
              placeholder="填写小米 MiMo API Key"
              size="small"
              style="width: 320px"
              allow-clear
            />
            <a-input-password
              v-else
              v-model="settings.asr.aliyun.apiKey"
              placeholder="sk-..."
              size="small"
              style="width: 320px"
              allow-clear
            />
            <a-button size="small" @click="openConsole">申请 API Key</a-button>
          </div>
        </div>

        <div class="setting-row">
          <div class="row-label">
            <span class="main-text">模型</span>
            <span class="sub-text">
              {{ provider === 'aliyun'
                ? '以 qwen3-asr-flash-realtime 开头时走实时 WebSocket，其余走 HTTP 兼容模式'
                : '小米 MiMo 语音识别模型' }}
            </span>
          </div>
          <div class="row-action">
            <a-input
              v-if="provider === 'xiaomi'"
              v-model="settings.asr.xiaomi.model"
              size="small"
              style="width: 260px"
            />
            <a-input
              v-else
              v-model="settings.asr.aliyun.model"
              size="small"
              style="width: 260px"
            />
          </div>
        </div>

        <div class="setting-row">
          <div class="row-label">
            <span class="main-text">接口地址</span>
            <span class="sub-text">OpenAI 兼容的 base URL，保留默认即可</span>
          </div>
          <div class="row-action">
            <a-input
              v-if="provider === 'xiaomi'"
              v-model="settings.asr.xiaomi.baseUrl"
              size="small"
              style="width: 320px"
            />
            <a-input
              v-else
              v-model="settings.asr.aliyun.httpBaseUrl"
              size="small"
              style="width: 320px"
            />
          </div>
        </div>

        <div v-if="provider === 'aliyun'" class="setting-row">
          <div class="row-label">
            <span class="main-text">实时接口地址</span>
            <span class="sub-text">仅 qwen3-asr-flash-realtime 使用</span>
          </div>
          <div class="row-action">
            <a-input
              v-model="settings.asr.aliyun.wsUrl"
              size="small"
              style="width: 320px"
            />
          </div>
        </div>

        <div class="setting-row">
          <div class="row-label">
            <span class="main-text">识别语言</span>
            <span class="sub-text">自动会交给服务商判断</span>
          </div>
          <div class="row-action">
            <a-select
              v-model="settings.asr.language"
              :options="languageOptions"
              size="small"
              style="width: 120px"
            />
          </div>
        </div>
      </div>
    </template>

    <div class="page-footer">
      <div class="page-actions">
        <a-button
          size="small"
          :type="testRunning ? 'outline' : 'secondary'"
          @click="testRunning ? stopVoiceTest() : startVoiceTest()"
        >
          {{ testRunning ? '停止测试' : '测试识别' }}
        </a-button>
        <a-button type="primary" size="small" :loading="settings.saving" @click="saveConfig">
          保存配置
        </a-button>
      </div>
      <div v-if="testRunning || testResult" class="test-console">
        <span v-if="testDiag" class="test-diag">
          帧收 {{ testDiag.framesReceived }} · 首帧 {{ testDiag.firstFrameLatencyMs ?? '-' }}ms · 转发 {{ testDiag.framesForwarded }} · 缓冲 {{ testDiag.framesBuffered }} · 会话就绪 {{ testDiag.sessionReadyAtMs ?? '-' }}ms
        </span>
        <span v-if="testRunning && testLiveText" class="test-live">{{ testLiveText }}</span>
        <span v-else-if="testRunning" class="test-status">
          正在听…（停顿会断句并累计，说完点「停止测试」）
        </span>
        <span v-else class="test-status">测试完成</span>
        <template v-if="!testRunning && testResult">
          <span class="test-result-text">{{ testResult }}</span>
          <a-button size="mini" @click="copyTestResult">复制</a-button>
          <a-button size="mini" @click="testResult = ''">清除</a-button>
        </template>
      </div>
      <div v-if="!testRunning && testAudioUrl" class="test-replay">
        <span class="test-status">实际送入识别的录音（{{ testAudioSeconds.toFixed(1) }}s），可回放比对：</span>
        <audio controls :src="testAudioUrl" class="test-audio"></audio>
      </div>
    </div>
  </div>
</template>

<style scoped>
.asr-config {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.asr-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.asr-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.asr-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-tertiary);
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
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color);
}

.setting-row:last-child {
  border-bottom: none;
}

.progress-row {
  border-bottom: none;
  padding-bottom: 6px;
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 62%;
  min-width: 0;
}

.row-action {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
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

.meta-text {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-left: 8px;
}

.mono-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.break-text {
  word-break: break-all;
  user-select: text;
}

.hidden-input {
  display: none;
}

.progress-wrap {
  padding: 0 20px 16px;
}

.progress-track {
  height: 6px;
  border-radius: 999px;
  background: var(--border-color);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--color-primary), #65d6ad);
  box-shadow: 0 0 12px rgba(64, 158, 255, 0.35);
  transition: width 0.3s ease;
}

.asr-alert {
  margin-top: 12px;
}

/* —— 服务商选择 chip（紧凑，可无限横向换行扩展） —— */
.provider-group {
  padding: 12px 14px;
}

.provider-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.provider-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  font-size: 13px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-secondary);
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}

.provider-chip:hover {
  border-color: var(--border-color-dark);
  color: var(--text-primary);
}

.provider-chip:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.provider-chip.selected {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
  color: var(--text-primary);
  font-weight: 600;
}

/* —— 状态点 / 状态签（面板内统一的状态展示） —— */
.status-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-offline);
}

.status-dot.ok,
.status-pill[data-level='ok'] .status-dot {
  background: var(--color-success);
}

.status-dot.warn,
.status-pill[data-level='warn'] .status-dot {
  background: var(--color-warning);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* —— 试一试（按住说话测试） —— */
.page-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.page-footer {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.test-console {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-input);
}

.test-diag {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.test-status {
  font-size: 12px;
  color: var(--text-tertiary);
}

.test-live {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-all;
}

.test-console .test-status {
  margin-right: 4px;
}

.test-result-text {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-all;
}

.test-replay {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.test-audio {
  height: 32px;
}
</style>
