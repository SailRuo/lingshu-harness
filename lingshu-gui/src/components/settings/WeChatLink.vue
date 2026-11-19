<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import IconWechat from '@arco-design/web-vue/es/icon/icon-wechat';
import IconCheckCircle from '@arco-design/web-vue/es/icon/icon-check-circle';
import IconRefresh from '@arco-design/web-vue/es/icon/icon-refresh';
import { getFullUrl } from '../../utils/apiConfig';

type Agent = { id: number; displayName: string; avatar?: string | null };
type WeChatStatus = { status: string; bound: boolean; running: boolean; agentId: number | null };
type Phase = 'loading' | 'unbound' | 'qr' | 'selecting' | 'bound';

const props = defineProps<{ expanded: boolean; active?: boolean }>();
const emit = defineEmits<{ toggle: [] }>();

const phase = ref<Phase>('loading');
const qrSvg = ref('');
const agents = ref<Agent[]>([]);
const selectedAgentId = ref<number | null>(null);
const boundAgentId = ref<number | null>(null);
const boundAgentName = ref('');
const fromScan = ref(false);
const busy = ref(false);
/** 扫码后的状态提示（scaned = 已扫码待确认；need_verifycode = 需要配对码）。 */
const scanHint = ref('');
/** 微信登录设备配对码（need_verifycode 时才显示输入框）。 */
const verifyCode = ref('');
const verifyCodeRequired = ref(false);
const verifyCodeBlocked = ref(false);
let pollTimer: number | null = null;

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
  return res.json() as Promise<T>;
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function loadAgents(): Promise<Agent[]> {
  const list = await api<Agent[]>('/api/v1/agents/simple');
  agents.value = list;
  if (list.length > 0 && selectedAgentId.value == null) selectedAgentId.value = list[0].id;
  return list;
}

async function refreshStatus() {
  try {
    const status = await api<WeChatStatus>('/api/v1/wechat/status');
    if (status.bound) {
      const list = await api<Agent[]>('/api/v1/agents/simple').catch(() => [] as Agent[]);
      const matched = list.find((agent) => agent.id === status.agentId);
      agents.value = list;
      boundAgentId.value = status.agentId;
      boundAgentName.value = matched?.displayName ?? `智能体 #${status.agentId}`;
      phase.value = 'bound';
    } else {
      phase.value = 'unbound';
    }
  } catch {
    phase.value = 'unbound';
  }
}

async function startQrFlow() {
  busy.value = true;
  scanHint.value = '';
  verifyCode.value = '';
  verifyCodeRequired.value = false;
  verifyCodeBlocked.value = false;
  try {
    const data = await api<{ qrcodeSvg: string }>('/api/v1/wechat/qrcode', { method: 'POST' });
    qrSvg.value = data.qrcodeSvg;
    phase.value = 'qr';
    stopPolling();
    pollTimer = window.setInterval(async () => {
      try {
        const s = await api<{
          status: string;
          confirmed: boolean;
          scanned?: boolean;
          needVerifyCode?: boolean;
          verifyCodeBlocked?: boolean;
        }>('/api/v1/wechat/qrcode/status');
        if (s.confirmed) {
          stopPolling();
          scanHint.value = '';
          verifyCodeRequired.value = false;
          await loadAgents();
          fromScan.value = true;
          phase.value = 'selecting';
        } else if (s.status === 'scaned') {
          scanHint.value = '已扫码，请在手机上确认登录…';
        } else if (s.needVerifyCode) {
          // 登录设备需要配对码：填入微信给出的验证码后继续轮询。
          stopPolling();
          verifyCodeRequired.value = true;
          scanHint.value = '微信要求输入设备配对码，请查看微信里的验证码提示';
        } else if (s.verifyCodeBlocked) {
          stopPolling();
          verifyCodeBlocked.value = true;
          scanHint.value = '配对码验证失败次数过多，请稍后再试或重新扫码';
        } else if (s.status === 'expired') {
          stopPolling();
          Message.warning('二维码已过期，请重新获取');
          phase.value = 'unbound';
        }
      } catch {
        /* polling can transiently fail */
      }
    }, 2000);
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '获取二维码失败');
    phase.value = 'unbound';
  } finally {
    busy.value = false;
  }
}

/** 带配对码继续轮询（need_verifycode 分支的续接）。 */
async function submitVerifyCode() {
  const code = verifyCode.value.trim();
  if (!code) return;
  busy.value = true;
  try {
    const s = await api<{
      status: string;
      confirmed: boolean;
      verifyCodeBlocked?: boolean;
    }>(`/api/v1/wechat/qrcode/status?verify_code=${encodeURIComponent(code)}`);
    if (s.confirmed) {
      scanHint.value = '';
      verifyCodeRequired.value = false;
      await loadAgents();
      fromScan.value = true;
      phase.value = 'selecting';
    } else if (s.verifyCodeBlocked) {
      verifyCodeBlocked.value = true;
      scanHint.value = '配对码验证失败次数过多，请稍后再试或重新扫码';
    } else {
      scanHint.value = '配对码已提交，等待微信确认…';
      verifyCodeRequired.value = false;
      resumeQrPolling();
    }
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '提交配对码失败');
  } finally {
    busy.value = false;
  }
}

function resumeQrPolling() {
  stopPolling();
  pollTimer = window.setInterval(async () => {
    try {
      const s = await api<{ status: string; confirmed: boolean }>('/api/v1/wechat/qrcode/status');
      if (s.confirmed) {
        stopPolling();
        scanHint.value = '';
        await loadAgents();
        fromScan.value = true;
        phase.value = 'selecting';
      } else if (s.status === 'expired') {
        stopPolling();
        Message.warning('二维码已过期，请重新获取');
        phase.value = 'unbound';
      }
    } catch {
      /* polling can transiently fail */
    }
  }, 2000);
}

async function changeAgent() {
  busy.value = true;
  try {
    await loadAgents();
    selectedAgentId.value = boundAgentId.value;
    fromScan.value = false;
    phase.value = 'selecting';
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '加载智能体失败');
  } finally {
    busy.value = false;
  }
}

function cancelSelecting() {
  stopPolling();
  refreshStatus();
}

async function completeBind() {
  if (selectedAgentId.value == null) return;
  busy.value = true;
  try {
    await api('/api/v1/wechat/bind', {
      method: 'POST',
      body: JSON.stringify({ agentId: selectedAgentId.value }),
    });
    Message.success('绑定成功');
    await refreshStatus();
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '绑定失败');
  } finally {
    busy.value = false;
  }
}

async function unbind() {
  busy.value = true;
  try {
    await api('/api/v1/wechat/unbind', { method: 'POST' });
    qrSvg.value = '';
    phase.value = 'unbound';
    Message.success('已解绑');
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '解绑失败');
  } finally {
    busy.value = false;
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

onMounted(() => {
  void refreshStatus();
});

watch(
  () => props.expanded,
  (expanded) => {
    if (!expanded) return;
    void refreshStatus();
  },
);

watch(
  () => props.active,
  (active) => {
    if (!active) return;
    void refreshStatus();
  },
);

onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="wechat-link" :class="{ 'channel-card--expanded': expanded }">
    <button type="button" class="channel-row" @click="emit('toggle')">
      <div class="row-label">
        <span class="main-text">
          <IconWechat class="wechat-icon" />
          微信对话
        </span>
        <span class="sub-text">
          扫码绑定微信后，选一个智能体；之后你在微信里发消息，就是在和这个智能体聊天。
        </span>
      </div>
      <div class="row-action">
        <a-tag v-if="phase === 'bound'" color="green" size="small" borderless>已绑定</a-tag>
        <a-tag v-else-if="phase === 'qr' || phase === 'selecting'" color="arcoblue" size="small" borderless>绑定中</a-tag>
        <a-tag v-else color="gray" size="small" borderless>未绑定</a-tag>
        <span class="chevron" :class="{ expanded }" />
      </div>
    </button>

    <div v-if="expanded" class="channel-body">
      <div v-if="phase === 'loading'" class="state-block">
        <a-spin />
      </div>

      <div v-else-if="phase === 'unbound'" class="state-block unbound-block">
        <p class="hint">微信使用扫码授权。扫码确认后，再选择一个智能体完成绑定。</p>
        <a-button type="primary" size="small" :loading="busy" @click="startQrFlow">接入微信</a-button>
      </div>

      <div v-else-if="phase === 'qr'" class="state-block qr-block">
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="qr-canvas" v-html="qrSvg" />
        <p class="hint">{{ scanHint || '请用微信扫码并确认登录…' }}</p>
        <div v-if="verifyCodeRequired && !verifyCodeBlocked" class="verify-row">
          <a-input
            v-model="verifyCode"
            size="small"
            placeholder="输入微信里的设备配对码"
            allow-clear
            @press-enter="submitVerifyCode"
          />
          <a-button type="primary" size="small" :loading="busy" @click="submitVerifyCode">提交</a-button>
        </div>
        <a-button type="text" size="small" :loading="busy" @click="startQrFlow">
          <template #icon><IconRefresh /></template>
          刷新二维码
        </a-button>
      </div>

      <div v-else-if="phase === 'selecting'" class="state-block selecting-block">
        <p class="hint">{{ fromScan ? '扫码成功，选择一个智能体完成绑定：' : '选择要绑定的智能体：' }}</p>
        <div class="agent-list">
          <div
            v-for="agent in agents"
            :key="agent.id"
            class="agent-item"
            :class="{ selected: selectedAgentId === agent.id }"
            @click="selectedAgentId = agent.id"
          >
            <img :src="avatarUrl(agent.avatar)" class="agent-avatar" alt="" @error="handleAvatarError" />
            <span class="agent-name">{{ agent.displayName }}</span>
            <IconCheckCircle v-if="selectedAgentId === agent.id" class="check-icon" />
          </div>
        </div>
        <div class="selecting-actions">
          <a-button type="primary" :loading="busy" :disabled="selectedAgentId == null" @click="completeBind">
            {{ fromScan ? '完成绑定' : '确认更换' }}
          </a-button>
          <a-button v-if="!fromScan" :disabled="busy" @click="cancelSelecting">取消</a-button>
        </div>
      </div>

      <div v-else-if="phase === 'bound'" class="state-block bound-block">
        <div class="bound-info">
          <IconCheckCircle class="bound-icon" />
          <span>已绑定 · 当前智能体：<strong>{{ boundAgentName }}</strong></span>
        </div>
        <div class="bound-actions">
          <a-button size="small" :loading="busy" @click="changeAgent">更换智能体</a-button>
          <a-button size="small" :loading="busy" status="danger" @click="unbind">解绑微信</a-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wechat-link {
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
  border-radius: 0;
  background-color: transparent;
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

.wechat-icon {
  color: #07c160;
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

.channel-body {
  border-top: 1px solid var(--border-color);
  background: transparent;
}

.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 22px 24px;
}

.unbound-block {
  align-items: flex-start;
}

.qr-canvas {
  background: #fff;
  padding: 16px;
  border-radius: 12px;
}

.qr-canvas :deep(svg) {
  width: 200px;
  height: 200px;
  display: block;
}

.verify-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 320px;
}

.hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

.selecting-block {
  width: 100%;
  align-items: stretch;
}

.agent-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}

.agent-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background-color: var(--bg-input);
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s;
}

.agent-item:hover {
  background-color: var(--bg-hover);
}

.agent-item.selected {
  border-color: #07c160;
  background-color: rgba(7, 193, 96, 0.08);
}

.agent-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}

.agent-avatar.placeholder {
  background-color: var(--bg-hover);
}

.agent-name {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
}

.check-icon {
  color: #07c160;
  font-size: 18px;
}

.bound-block {
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  color: var(--text-primary);
}

.bound-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.selecting-actions,
.bound-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.bound-icon {
  color: #07c160;
  font-size: 20px;
}
</style>
