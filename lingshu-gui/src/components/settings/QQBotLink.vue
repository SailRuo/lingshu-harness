<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import IconCheckCircle from '@arco-design/web-vue/es/icon/icon-check-circle';
import IconDelete from '@arco-design/web-vue/es/icon/icon-delete';
import IconPlus from '@arco-design/web-vue/es/icon/icon-plus';
import IconQq from '@arco-design/web-vue/es/icon/icon-qq';
import IconRefresh from '@arco-design/web-vue/es/icon/icon-refresh';
import { getFullUrl } from '../../utils/apiConfig';

type Agent = { id: number; displayName: string; avatar?: string | null };
type QQBotBinding = {
  id: number;
  status: string;
  bound: boolean;
  running: boolean;
  connectionState: string;
  agentId: number | null;
  appId?: string | null;
  replyWithVoice?: boolean;
  enabledPrivate?: boolean;
  enabledGroup?: boolean;
};

type CredentialCache = Record<string, { clientSecret: string }>;

const props = defineProps<{ expanded: boolean; active?: boolean }>();
const emit = defineEmits<{ toggle: [] }>();

const CACHE_KEY = 'lingshu_qqbot_credentials';
const QQBOT_CREATE_URL = 'https://q.qq.com/qqbot/openclaw/';

const agents = ref<Agent[]>([]);
const bindings = ref<QQBotBinding[]>([]);
const loading = ref(true);
const busyId = ref<number | null>(null);
const applyingId = ref<number | null>(null);
const showAddForm = ref(false);

const newAppId = ref('');
const newClientSecret = ref('');
const newAgentId = ref<number | null>(null);
const newReplyWithVoice = ref(false);
const newEnabledPrivate = ref(true);
const newEnabledGroup = ref(false);
/** 手动填写凭据（App ID / Secret）默认折叠，扫码授权覆盖绝大多数场景。 */
const showManualCreds = ref(false);

const secretDrafts = ref<Record<string, string>>({});
const STATUS_POLL_MS = 2000;
let statusPollTimer: ReturnType<typeof setInterval> | null = null;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // 无 body 的动作型 POST 不带 JSON content-type，避免后端对空 body 抛 400。
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init?.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(getFullUrl(path), {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string>) || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `请求失败 (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function readCredentialCache(): CredentialCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return {};
    if (data.appId && data.clientSecret) {
      return { [String(data.appId)]: { clientSecret: String(data.clientSecret) } };
    }
    const next: CredentialCache = {};
    for (const [appId, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'clientSecret' in value) {
        const secret = String((value as { clientSecret?: unknown }).clientSecret || '');
        if (secret) next[appId] = { clientSecret: secret };
      }
    }
    return next;
  } catch {
    return {};
  }
}

function writeCredentialCache(cache: CredentialCache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function cacheCredential(appId: string, clientSecret: string) {
  const normalizedAppId = appId.trim();
  const normalizedSecret = clientSecret.trim();
  if (!normalizedAppId || !normalizedSecret) return;
  const cache = readCredentialCache();
  cache[normalizedAppId] = { clientSecret: normalizedSecret };
  writeCredentialCache(cache);
}

function cachedSecretFor(appId: string | null | undefined): string {
  if (!appId) return '';
  return readCredentialCache()[appId]?.clientSecret || '';
}

const boundCount = computed(() => bindings.value.filter((item) => item.bound).length);

const boundAgentIds = computed(() => {
  const ids = new Set<number>();
  for (const binding of bindings.value) {
    if (binding.agentId != null) ids.add(binding.agentId);
  }
  return ids;
});

const availableAgentsForNew = computed(() =>
  agents.value.filter((agent) => !boundAgentIds.value.has(agent.id)),
);

const headerConnectionText = computed(() => {
  if (boundCount.value === 0) return '未绑定';
  const connected = bindings.value.filter(
    (item) => item.bound && item.running && item.connectionState === 'connected',
  ).length;
  if (connected === boundCount.value) return `已连接 ${connected} 个`;
  if (connected > 0) return `${connected}/${boundCount.value} 已连接`;
  return `已绑定 ${boundCount.value} 个`;
});

function connectionText(binding: QQBotBinding): string {
  if (!binding.bound) return '未绑定';
  if (binding.running && binding.connectionState === 'connected') return '已连接';
  if (binding.connectionState === 'connecting') return '连接中';
  if (binding.running) return '后台运行中';
  return '未连接';
}

function isAgentDisabled(agentId: number, binding: QQBotBinding): boolean {
  return bindings.value.some(
    (item) => item.id !== binding.id && item.agentId === agentId,
  );
}

async function loadAgents() {
  const list = await api<Agent[]>('/api/v1/agents/simple');
  agents.value = list;
  if (newAgentId.value == null) {
    const first = list.find((agent) => !boundAgentIds.value.has(agent.id));
    if (first) newAgentId.value = first.id;
  }
}

async function refreshBindings() {
  bindings.value = await api<QQBotBinding[]>('/api/v1/qqbot/bindings');
  for (const binding of bindings.value) {
    const appId = binding.appId || '';
    if (!appId) continue;
    if (!String(secretDrafts.value[appId] || '').trim()) {
      secretDrafts.value[appId] = cachedSecretFor(appId);
    }
  }
}

function needsStatusPolling(): boolean {
  return bindings.value.some(
    (binding) => binding.bound && binding.running && binding.connectionState !== 'connected',
  );
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function startStatusPolling() {
  if (statusPollTimer) return;
  statusPollTimer = setInterval(() => {
    if (!props.expanded) {
      stopStatusPolling();
      return;
    }
    if (needsStatusPolling()) {
      refreshBindings().catch(() => undefined);
    } else {
      stopStatusPolling();
    }
  }, STATUS_POLL_MS);
}

function syncStatusPolling() {
  if (props.expanded && needsStatusPolling()) {
    startStatusPolling();
    return;
  }
  stopStatusPolling();
}

async function createBinding(): Promise<boolean> {
  const appId = newAppId.value.trim();
  const secret = newClientSecret.value.trim() || cachedSecretFor(appId);
  if (!appId) {
    Message.warning('先填写 App ID');
    return false;
  }
  if (!secret) {
    Message.warning('先填写 Client Secret');
    return false;
  }
  if (newAgentId.value == null) {
    Message.warning('先选择要绑定的智能体');
    return false;
  }
  busyId.value = -1;
  try {
    await api<QQBotBinding>('/api/v1/qqbot/bindings', {
      method: 'POST',
      body: JSON.stringify({
        appId,
        clientSecret: secret,
        agentId: newAgentId.value,
        replyWithVoice: newReplyWithVoice.value,
        enabledPrivate: newEnabledPrivate.value,
        enabledGroup: newEnabledGroup.value,
      }),
    });
    cacheCredential(appId, secret);
    newAppId.value = '';
    newClientSecret.value = '';
    showAddForm.value = false;
    await refreshBindings();
    const first = availableAgentsForNew.value[0];
    newAgentId.value = first?.id ?? null;
    Message.success(`QQ Bot ${appId} 已绑定`);
    return true;
  } catch (e) {
    Message.error(e instanceof Error ? e.message : 'QQBot 绑定失败');
    return false;
  } finally {
    busyId.value = null;
  }
}

async function updateBinding(
  binding: QQBotBinding,
  patch: {
    agentId?: number;
    replyWithVoice?: boolean;
    enabledPrivate?: boolean;
    enabledGroup?: boolean;
    clientSecret?: string;
  },
  showToast = false,
) {
  if (binding.agentId == null && patch.agentId == null) return;
  applyingId.value = binding.id;
  try {
    const appId = binding.appId || '';
    const secret = patch.clientSecret
      || secretDrafts.value[appId]
      || cachedSecretFor(appId)
      || undefined;
    await api<QQBotBinding>(`/api/v1/qqbot/bindings/${binding.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        agentId: patch.agentId ?? binding.agentId,
        replyWithVoice: patch.replyWithVoice ?? binding.replyWithVoice ?? false,
        enabledPrivate: patch.enabledPrivate ?? binding.enabledPrivate ?? true,
        enabledGroup: patch.enabledGroup ?? binding.enabledGroup ?? false,
        clientSecret: secret,
      }),
    });
    if (secret && appId) cacheCredential(appId, secret);
    if (secret) secretDrafts.value[appId] = '';
    await refreshBindings();
    if (showToast) Message.success(`App ID ${binding.appId} 配置已更新`);
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '配置更新失败');
    await refreshBindings().catch(() => undefined);
  } finally {
    applyingId.value = null;
  }
}

async function selectAgent(binding: QQBotBinding, agentId: number) {
  if (binding.agentId === agentId || isAgentDisabled(agentId, binding)) return;
  await updateBinding(binding, { agentId });
}

async function reconnect(binding: QQBotBinding) {
  busyId.value = binding.id;
  try {
    await api<QQBotBinding>(`/api/v1/qqbot/bindings/${binding.id}/reconnect`, { method: 'POST' });
    await refreshBindings();
    Message.success(`App ID ${binding.appId} 已重连`);
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '重连失败');
  } finally {
    busyId.value = null;
  }
}

async function removeBinding(binding: QQBotBinding) {
  busyId.value = binding.id;
  try {
    await api(`/api/v1/qqbot/bindings/${binding.id}`, { method: 'DELETE' });
    await refreshBindings();
    Message.success(`已解绑 App ID ${binding.appId}`);
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '解绑失败');
  } finally {
    busyId.value = null;
  }
}

function avatarUrl(avatar?: string | null): string {
  if (!avatar) return '/lingshu.png';
  if (avatar.startsWith('http') || avatar.startsWith('data:')) return avatar;
  return avatar.startsWith('/api/') ? getFullUrl(avatar) : avatar;
}

function handleAvatarError(event: Event) {
  const img = event.target as HTMLImageElement;
  if (!img.src.endsWith('/lingshu.png')) {
    img.src = '/lingshu.png';
  }
}

async function openCreateQqBotPortal() {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(QQBOT_CREATE_URL);
  } catch {
    window.open(QQBOT_CREATE_URL, '_blank', 'noopener,noreferrer');
  }
}

async function openUrlExternally(url: string) {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/* ------------------------------ 一键绑定（弹窗扫码：点按钮 → 弹二维码 → 手机 QQ 扫码 → 弹窗内完成绑定） ------------------------------ */

type QuickConnectSession = { taskId: string; connectUrl: string; connectUrlQrSvg?: string };
type QuickConnectPoll = {
  status: 'pending' | 'completed' | 'expired' | 'unknown';
  appId?: string;
  clientSecret?: string;
  userOpenid?: string;
};

const quickConnectModalVisible = ref(false);
const quickConnectStage = ref<'idle' | 'creating' | 'waiting' | 'binding'>('idle');
const quickConnectUrl = ref('');
const quickConnectQrSvg = ref('');
let quickConnectTaskId = '';
let quickConnectTimer: ReturnType<typeof setInterval> | null = null;

function stopQuickConnectPolling() {
  if (quickConnectTimer) {
    clearInterval(quickConnectTimer);
    quickConnectTimer = null;
  }
}

function resetQuickConnect() {
  stopQuickConnectPolling();
  quickConnectTaskId = '';
  quickConnectUrl.value = '';
  quickConnectQrSvg.value = '';
  quickConnectStage.value = 'idle';
}

function closeQuickConnectModal() {
  quickConnectModalVisible.value = false;
  resetQuickConnect();
}

/** 点「一键绑定」：直接弹窗并出码。 */
async function openQuickConnectModal() {
  quickConnectModalVisible.value = true;
  await startQuickConnect();
}

async function startQuickConnect() {
  quickConnectStage.value = 'creating';
  try {
    const session = await api<QuickConnectSession>('/api/v1/qqbot/quick-connect', { method: 'POST' });
    quickConnectTaskId = session.taskId;
    quickConnectUrl.value = session.connectUrl;
    quickConnectQrSvg.value = session.connectUrlQrSvg || '';
    quickConnectStage.value = 'waiting';
    stopQuickConnectPolling();
    quickConnectTimer = setInterval(() => {
      void pollQuickConnectOnce();
    }, 2500);
  } catch (e) {
    quickConnectStage.value = 'idle';
    quickConnectModalVisible.value = false;
    Message.error(e instanceof Error ? e.message : '发起一键绑定失败');
  }
}

async function pollQuickConnectOnce() {
  if (!quickConnectTaskId) return;
  try {
    const result = await api<QuickConnectPoll>(
      `/api/v1/qqbot/quick-connect/${encodeURIComponent(quickConnectTaskId)}`,
    );
    if (result.status === 'completed' && result.appId && result.clientSecret) {
      stopQuickConnectPolling();
      quickConnectTaskId = '';
      // secret 只在后端解密后一次性回传：写入本机缓存后直接用面板里选好的智能体自动绑定。
      cacheCredential(result.appId, result.clientSecret);
      newAppId.value = result.appId;
      newClientSecret.value = '';
      quickConnectStage.value = 'binding';
      const ok = await createBinding();
      if (ok) {
        closeQuickConnectModal();
        return;
      }
      // 自动绑定失败（如该 App ID 已被绑定）：回落到手动填写凭据。
      closeQuickConnectModal();
      showAddForm.value = true;
      showManualCreds.value = true;
    } else if (result.status === 'expired') {
      Message.warning('快捷绑定任务已过期，弹窗已关闭，请重新发起');
      closeQuickConnectModal();
    }
  } catch {
    /* transient poll failure */
  }
}

function copyQuickConnectUrl() {
  const url = quickConnectUrl.value;
  if (!url) return;
  try {
    void navigator.clipboard
      .writeText(url)
      .then(() => Message.success('授权链接已复制，可在手机 QQ 里打开'))
      .catch(() => undefined);
  } catch {
    // Tauri webview 可能未授权剪贴板；用户可以手动复制可见链接。
  }
}

onMounted(async () => {
  loading.value = true;
  try {
    await Promise.all([loadAgents(), refreshBindings()]);
    syncStatusPolling();
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '加载 QQBot 配置失败');
  } finally {
    loading.value = false;
  }
});

watch(
  () => props.expanded,
  (expanded) => {
    if (!expanded) {
      stopStatusPolling();
      return;
    }
    void Promise.all([loadAgents(), refreshBindings()])
      .then(() => syncStatusPolling())
      .catch(() => undefined);
  },
);

watch(
  () => props.active,
  (active) => {
    if (!active) return;
    void Promise.all([loadAgents(), refreshBindings()])
      .then(() => {
        if (props.expanded) syncStatusPolling();
      })
      .catch(() => undefined);
  },
);

watch(
  () => bindings.value.map((binding) => `${binding.id}:${binding.connectionState}:${binding.running}`).join('|'),
  () => {
    syncStatusPolling();
  },
);

onUnmounted(() => {
  stopStatusPolling();
  stopQuickConnectPolling();
});
</script>

<template>
  <div class="qqbot-link" :class="{ 'channel-card--expanded': expanded }">
    <button type="button" class="channel-row" @click="emit('toggle')">
      <div class="row-label">
        <span class="main-text">
          <IconQq class="qqbot-icon" />
          QQBot 对话
        </span>
        <span class="sub-text">
          支持多个 QQ Bot，每个 Bot 用 App ID 区分，且必须绑定不同智能体。
        </span>
      </div>
      <div class="row-action">
        <a-tag v-if="boundCount > 0" color="green" size="small" borderless>{{ headerConnectionText }}</a-tag>
        <a-tag v-else color="gray" size="small" borderless>未绑定</a-tag>
        <span class="chevron" :class="{ expanded }" />
      </div>
    </button>

    <template v-if="expanded">
      <div v-if="loading" class="state-block loading-block">
        <a-spin />
      </div>

      <div v-else class="qqbot-panel">
        <section v-if="bindings.length > 0" class="panel-section bindings-section">
          <div class="section-title-row">
            <div>
              <h4>已绑定 Bot</h4>
              <p>每个 App ID 对应一个独立网关连接，智能体不可重复绑定。</p>
            </div>
          </div>

          <div class="binding-list">
            <article v-for="binding in bindings" :key="binding.id" class="binding-card">
              <div class="binding-card-header">
                <div>
                  <h5>App ID：{{ binding.appId }}</h5>
                </div>
                <a-tag
                  :color="binding.running && binding.connectionState === 'connected' ? 'green' : 'gray'"
                  size="small"
                  borderless
                >
                  {{ connectionText(binding) }}
                </a-tag>
              </div>

              <div class="binding-grid">
                <div class="agent-pane">
                  <span class="col-label">智能体</span>
                  <div class="agent-list">
                    <button
                      v-for="agent in agents"
                      :key="agent.id"
                      type="button"
                      class="agent-item"
                      :class="{ selected: binding.agentId === agent.id, disabled: isAgentDisabled(agent.id, binding) }"
                      :disabled="applyingId === binding.id || isAgentDisabled(agent.id, binding)"
                      @click="selectAgent(binding, agent.id)"
                    >
                      <img :src="avatarUrl(agent.avatar)" class="agent-avatar" alt="" @error="handleAvatarError" />
                      <span class="agent-name">{{ agent.displayName }}</span>
                      <IconCheckCircle v-if="binding.agentId === agent.id" class="check-icon" />
                    </button>
                  </div>
                </div>

                <div class="binding-side">
                  <label class="field-block">
                    <span class="col-label">Client Secret</span>
                    <a-input-password
                      v-model="secretDrafts[binding.appId || '']"
                      :placeholder="cachedSecretFor(binding.appId) ? '本机已缓存，可点右侧眼睛查看' : '填写密钥'"
                      allow-clear
                    />
                    <span v-if="cachedSecretFor(binding.appId)" class="field-hint">
                      密钥仅缓存在本机浏览器，后端不回传明文。
                    </span>
                  </label>

                  <div class="option-list compact">
                    <label class="option-item">
                      <span><strong>接收私聊</strong></span>
                      <a-switch
                        :model-value="binding.enabledPrivate ?? true"
                        :disabled="applyingId === binding.id"
                        @change="(val) => updateBinding(binding, { enabledPrivate: !!val })"
                      />
                    </label>
                    <label class="option-item">
                      <span><strong>接收群聊</strong></span>
                      <a-switch
                        :model-value="binding.enabledGroup ?? false"
                        :disabled="applyingId === binding.id"
                        @change="(val) => updateBinding(binding, { enabledGroup: !!val })"
                      />
                    </label>
                    <label class="option-item">
                      <span><strong>语音回复</strong></span>
                      <a-switch
                        :model-value="binding.replyWithVoice ?? false"
                        :disabled="applyingId === binding.id"
                        @change="(val) => updateBinding(binding, { replyWithVoice: !!val })"
                      />
                    </label>
                  </div>

                  <div class="binding-actions">
                    <a-button
                      size="small"
                      :loading="applyingId === binding.id"
                      @click="updateBinding(binding, {}, true)"
                    >
                      保存凭据
                    </a-button>
                    <a-button size="small" :loading="busyId === binding.id" @click="reconnect(binding)">
                      <template #icon><IconRefresh /></template>
                      重连
                    </a-button>
                    <a-button
                      size="small"
                      status="danger"
                      :loading="busyId === binding.id"
                      @click="removeBinding(binding)"
                    >
                      <template #icon><IconDelete /></template>
                      解绑
                    </a-button>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section class="panel-section add-section">
          <div class="section-title-row">
            <div>
              <h4>绑定 QQ Bot</h4>
              <p>选一个智能体，点「绑定」后用手机 QQ 扫码授权即可；凭据自动获取并加密保存。</p>
            </div>
            <div class="section-title-actions">
              <a-button type="outline" size="small" @click="openCreateQqBotPortal">
                创建 QQBot
              </a-button>
              <a-button v-if="!showAddForm" type="outline" size="small" @click="showAddForm = true">
                <template #icon><IconPlus /></template>
                添加 Bot
              </a-button>
            </div>
          </div>

          <div v-if="showAddForm || bindings.length === 0" class="add-form">
            <div class="add-grid">
              <div class="agent-list">
                <button
                  v-for="agent in availableAgentsForNew"
                  :key="agent.id"
                  type="button"
                  class="agent-item"
                  :class="{ selected: newAgentId === agent.id }"
                  @click="newAgentId = agent.id"
                >
                  <img :src="avatarUrl(agent.avatar)" class="agent-avatar" alt="" @error="handleAvatarError" />
                  <span class="agent-name">{{ agent.displayName }}</span>
                  <IconCheckCircle v-if="newAgentId === agent.id" class="check-icon" />
                </button>
                <p v-if="availableAgentsForNew.length === 0" class="empty-hint">
                  所有智能体都已绑定其他 QQ Bot，请先解绑或新建智能体。
                </p>
              </div>

              <div class="option-list compact">
                <label class="option-item">
                  <span><strong>接收私聊</strong></span>
                  <a-switch v-model="newEnabledPrivate" />
                </label>
                <label class="option-item">
                  <span><strong>接收群聊</strong></span>
                  <a-switch v-model="newEnabledGroup" />
                </label>
                <label class="option-item">
                  <span><strong>语音回复</strong></span>
                  <a-switch v-model="newReplyWithVoice" />
                </label>
              </div>
            </div>

            <div class="manual-toggle-row">
              <a-button type="text" size="mini" @click="showManualCreds = !showManualCreds">
                {{ showManualCreds ? '收起手动填写' : '手动填写凭据' }}
              </a-button>
            </div>
            <div v-if="showManualCreds" class="credential-grid">
              <label class="field-block">
                <span>App ID</span>
                <a-input v-model="newAppId" placeholder="例如：1904118605" allow-clear />
              </label>
              <label class="field-block">
                <span>Client Secret</span>
                <a-input-password
                  v-model="newClientSecret"
                  :placeholder="cachedSecretFor(newAppId) ? '留空则使用本机缓存' : '首次填写后会保存在本机缓存'"
                  allow-clear
                />
              </label>
            </div>

            <div class="add-actions">
              <a-button v-if="bindings.length > 0" @click="showAddForm = false">取消</a-button>
              <a-button
                type="primary"
                :loading="busyId === -1 || quickConnectStage === 'creating' || quickConnectStage === 'waiting'"
                :disabled="availableAgentsForNew.length === 0 || newAgentId == null"
                @click="openQuickConnectModal"
              >
                绑定
              </a-button>
            </div>
          </div>
        </section>
      </div>
    </template>

    <!-- 扫码绑定弹窗：点「绑定」→ 弹二维码 → 手机 QQ 扫码授权 → 自动完成绑定 -->
    <a-modal
      :visible="quickConnectModalVisible"
      :footer="false"
      :width="400"
      unmount-on-close
      :mask-closable="false"
      @cancel="closeQuickConnectModal"
    >
      <template #title>
        {{ quickConnectStage === 'binding' ? '正在完成绑定…' : '扫码绑定 QQ Bot' }}
      </template>

      <div v-if="quickConnectStage === 'creating'" class="qc-center">
        <a-spin tip="正在创建授权任务…" />
      </div>

      <div v-else-if="quickConnectStage === 'waiting'" class="qc-center">
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="quick-qr" v-html="quickConnectQrSvg" />
        <p class="quick-hint">用手机 QQ 扫码，并在 QQ 里确认授权…</p>
        <p class="quick-links">
          <a @click.prevent="openUrlExternally(quickConnectUrl)">在浏览器打开</a>
          <a @click.prevent="copyQuickConnectUrl">复制链接</a>
        </p>
        <a-button size="small" @click="closeQuickConnectModal">取消</a-button>
      </div>

      <div v-else-if="quickConnectStage === 'binding'" class="qc-center">
        <a-spin tip="授权成功，正在绑定…" />
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.qqbot-link {
  display: flex;
  flex-direction: column;
  overflow: visible;
  border-radius: 12px;
  background-color: var(--bg-input);
  border: 1px solid transparent;
}

.channel-card--expanded {
  border-color: var(--border-color);
}

.channel-row {
  width: 100%;
  min-height: 82px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  border: 0;
  background-color: transparent;
  border-radius: 0;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.2s;
}

.channel-row:hover {
  background-color: var(--bg-hover);
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.main-text {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-primary);
}

.qqbot-icon {
  color: #12b7f5;
  font-size: 18px;
}

.sub-text {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.row-action {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.chevron {
  width: 8px;
  height: 8px;
  border-right: 1.5px solid var(--text-tertiary);
  border-bottom: 1.5px solid var(--text-tertiary);
  transform: rotate(45deg);
  transition: transform 0.2s;
}

.chevron.expanded {
  transform: rotate(225deg);
}

.loading-block {
  align-items: center;
  padding: 24px;
  border-top: 1px solid var(--border-color);
}

.qqbot-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px 20px;
  background: transparent;
  border-top: 1px solid var(--border-color);
}

.panel-section {
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-chat-window);
}

.section-title-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 14px;
}

.section-title-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.section-title-row h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-title-row p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-tertiary);
}

.binding-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.binding-card {
  padding: 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-input);
}

.binding-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.binding-card-header h5 {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary);
}

.binding-card-header p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.binding-grid,
.add-grid {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 1.2fr);
  gap: 14px;
  align-items: stretch;
}

.agent-pane {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  /* 行高由右侧决定；左侧贴合同高并在列表内滚动 */
  height: 0;
  min-height: 100%;
  overflow: hidden;
}

.binding-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.col-label {
  display: block;
  height: 18px;
  line-height: 18px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.field-hint {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-tertiary);
}

.quick-qr {
  background: #fff;
  padding: 12px;
  border-radius: 12px;
  flex-shrink: 0;
}

.quick-qr :deep(svg) {
  width: 200px;
  height: 200px;
  display: block;
}

.quick-links {
  margin: 0;
}

.quick-links a {
  margin: 0 6px;
  color: var(--color-primary, #4080ff);
  cursor: pointer;
  font-size: 12px;
}

.qc-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 8px 0 4px;
}

.manual-toggle-row {
  display: flex;
  justify-content: flex-end;
}

.quick-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.4;
  margin: 0;
}

.credential-grid {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 1.2fr);
  gap: 14px;
  margin-bottom: 14px;
}

.field-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.field-block > span:not(.col-label):not(.field-hint) {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.agent-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
  scrollbar-gutter: stable;
}

.agent-item {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background-color: var(--bg-chat-window);
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color 0.2s, background-color 0.2s, opacity 0.2s;
}

.agent-item:hover:not(:disabled) {
  background-color: var(--bg-hover);
}

.agent-item.selected {
  border-color: #12b7f5;
  background-color: rgba(18, 183, 245, 0.1);
}

.agent-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.agent-item:disabled {
  cursor: wait;
  opacity: 0.75;
}

.agent-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}

.agent-avatar.placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg-hover);
  color: var(--text-tertiary);
}

.agent-name {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check-icon {
  color: #12b7f5;
  font-size: 18px;
  flex-shrink: 0;
}

.option-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.option-list.compact .option-item {
  min-height: 48px;
  padding: 10px 12px;
}

.option-item {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 13px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-chat-window);
}

.option-item span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.option-item strong {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.binding-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.binding-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.add-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.45;
}

@media (max-width: 900px) {
  .credential-grid,
  .binding-grid,
  .add-grid {
    grid-template-columns: 1fr;
  }
}
</style>
