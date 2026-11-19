<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Message, Modal } from '@arco-design/web-vue';
import IconApps from '@arco-design/web-vue/es/icon/icon-apps';
import { getFullUrl } from '../../utils/apiConfig';

interface MijiaStatus {
  authenticated: boolean;
  enabled: boolean;
  expiresAt: number | null;
  verify?: 'valid' | 'invalid' | 'unverified' | null;
}

const emit = defineEmits<{ (event: 'changed'): void }>();

const status = ref<MijiaStatus | null>(null);
const loginLoading = ref(false);
const modalVisible = ref(false);
const qrDataUrl = ref('');
const loginId = ref('');
const loginError = ref('');
let pollTimer: number | null = null;

const statusLabel = computed(() => {
  if (!status.value) return '读取中…';
  if (!status.value.authenticated) return '未登录';
  if (status.value.verify === 'unverified') return '已登录 · 暂无法验证';
  return '已登录';
});

const expiresLabel = computed(() => {
  const expiresAt = status.value?.expiresAt;
  if (!expiresAt) return '';
  return new Date(expiresAt).toLocaleDateString('zh-CN');
});

const fetchStatus = async () => {
  try {
    const response = await fetch(getFullUrl('/api/v1/plugins/mijia/status?verify=1'));
    if (!response.ok) return;
    status.value = await response.json();
  } catch {
    // 状态读取失败时保持未登录展示，不影响其它插件操作
  }
};

const stopPolling = () => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
};

const pollLogin = () => {
  stopPolling();
  pollTimer = window.setInterval(() => {
    void (async () => {
      if (!loginId.value) return;
      try {
        const response = await fetch(
          getFullUrl(`/api/v1/plugins/mijia/login/${encodeURIComponent(loginId.value)}`),
        );
        if (!response.ok) return;
        const data = await response.json();
        if (data.status === 'authenticated') {
          stopPolling();
          modalVisible.value = false;
          qrDataUrl.value = '';
          loginId.value = '';
          Message.success('米家账号登录成功');
          await fetchStatus();
          emit('changed');
        } else if (data.status === 'error') {
          stopPolling();
          loginError.value = String(data.detail || '登录失败或超时，请重新获取二维码');
        }
      } catch {
        // 网络抖动不终止登录轮询
      }
    })();
  }, 2000);
};

const startLogin = async () => {
  loginLoading.value = true;
  loginError.value = '';
  stopPolling();
  try {
    const response = await fetch(getFullUrl('/api/v1/plugins/mijia/login'), {
      method: 'POST',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(data?.detail || `获取二维码失败 (${response.status})`));
    }
    if (data.status === 'authenticated') {
      modalVisible.value = false;
      Message.success('米家账号已登录');
      await fetchStatus();
      emit('changed');
      return;
    }
    qrDataUrl.value = String(data.qrDataUrl || '');
    loginId.value = String(data.loginId || '');
    modalVisible.value = true;
    pollLogin();
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取米家登录二维码失败';
    if (modalVisible.value) loginError.value = message;
    Message.error(message);
  } finally {
    loginLoading.value = false;
  }
};

const handleToggle = async (enabled: boolean | string | number) => {
  if (!status.value) return;
  const nextEnabled = Boolean(enabled);
  const previous = status.value.enabled;
  status.value = { ...status.value, enabled: nextEnabled };
  try {
    const response = await fetch(getFullUrl('/api/v1/plugins/mijia/enabled'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextEnabled }),
    });
    if (!response.ok) throw new Error(String(response.status));
    Message.success(nextEnabled ? '已启用米家工具' : '已停用米家工具');
    emit('changed');
  } catch {
    if (status.value) status.value = { ...status.value, enabled: previous };
    Message.error('更新米家工具开关失败');
  }
};

const handleLogout = () => {
  Modal.confirm({
    title: '退出米家账号',
    content: '退出后米家工具会立即从对话中解绑，重新使用需要再次扫码登录。',
    onOk: async () => {
      try {
        const response = await fetch(getFullUrl('/api/v1/plugins/mijia/logout'), {
          method: 'POST',
        });
        if (!response.ok) throw new Error(String(response.status));
        Message.success('已退出米家账号');
        await fetchStatus();
        emit('changed');
      } catch {
        Message.error('退出米家账号失败');
      }
    },
  });
};

const handleModalClose = () => {
  stopPolling();
  loginError.value = '';
  qrDataUrl.value = '';
  loginId.value = '';
  void fetchStatus();
};

onMounted(() => {
  void fetchStatus();
});

onBeforeUnmount(stopPolling);

defineExpose({ refreshStatus: fetchStatus });
</script>

<template>
  <div class="mijia-card">
    <div class="mijia-main">
      <div class="mijia-icon"><IconApps /></div>
      <div class="mijia-copy">
        <span class="mijia-name">米家智能家居</span>
        <span class="mijia-description">
          扫码登录米家账号后，可通过对话控制灯光、插座、空调、扫地机与手动场景（10 个内置工具）。
        </span>
        <span class="mijia-status-line">
          <a-tag size="small" :color="status?.authenticated ? 'green' : 'gray'">
            {{ statusLabel }}
          </a-tag>
          <span v-if="expiresLabel" class="mijia-expire">
            会话有效期至 {{ expiresLabel }}
          </span>
        </span>
      </div>
    </div>
    <div class="mijia-actions">
      <a-switch
        :model-value="Boolean(status?.enabled)"
        :disabled="!status?.authenticated"
        size="small"
        @change="handleToggle"
      />
      <a-button
        v-if="!status?.authenticated"
        type="primary"
        size="small"
        :loading="loginLoading"
        @click="startLogin"
      >
        扫码登录
      </a-button>
      <a-button v-else size="small" status="danger" @click="handleLogout">
        退出账号
      </a-button>
    </div>
  </div>

  <a-modal
    v-model:visible="modalVisible"
    title="米家账号扫码登录"
    :footer="false"
    :width="380"
    unmount-on-close
    @cancel="handleModalClose"
  >
    <div class="mijia-qr-panel">
      <div class="mijia-qr-frame">
        <img v-if="qrDataUrl" :src="qrDataUrl" alt="米家登录二维码" />
      </div>
      <p class="mijia-qr-hint">
        用另一台手机打开米家 App →「我的」右上角「扫一扫」。不要用「添加设备」、微信或系统相机扫描。
      </p>
      <div v-if="loginError" class="mijia-qr-error">
        <span>{{ loginError }}</span>
        <a-button size="mini" type="primary" :loading="loginLoading" @click="startLogin">
          重新获取二维码
        </a-button>
      </div>
      <div v-else class="mijia-qr-wait">
        <a-spin :size="14" />
        <span>等待扫码，扫码成功后会自动完成登录</span>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.mijia-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  min-height: 64px;
  margin-bottom: 16px;
  padding: 14px 18px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 12px;
}

.mijia-main {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.mijia-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background-color: var(--color-primary-light-1);
  color: var(--color-primary);
  border-radius: 6px;
  flex-shrink: 0;
}

.mijia-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mijia-name {
  font-weight: 600;
  color: var(--text-primary);
}

.mijia-description {
  max-width: 680px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-tertiary);
}

.mijia-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.mijia-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.mijia-expire {
  font-size: 12px;
  color: var(--text-tertiary);
}

.mijia-qr-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 4px 4px 8px;
}

.mijia-qr-frame {
  width: 224px;
  height: 224px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: #fff;
  box-sizing: border-box;
}

.mijia-qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
}

.mijia-qr-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-tertiary);
  text-align: left;
}

.mijia-qr-wait {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.mijia-qr-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--color-danger);
  text-align: center;
}
</style>
