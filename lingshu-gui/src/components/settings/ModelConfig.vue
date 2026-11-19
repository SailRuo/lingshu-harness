<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Message } from '@arco-design/web-vue';
import { useSettingsStore } from '../../stores/settings';
import { getFullUrl } from '../../utils/apiConfig';
import {
  buildModelOptions,
  SENSENOVA_IMAGE_GEN_MODELS,
  VOLCENGINE_IMAGE_GEN_MODELS,
} from '../../utils/modelSourceCache';
import { THINKING_OPTIONS } from '../../utils/thinkingEffort';
import { CONTEXT_BUDGET_OPTIONS } from '../../utils/contextBudget';

const GENERATE_IMAGE_TOOL = 'generate_image';

const store = useSettingsStore();
const imageGenToolEnabled = ref(false);
const imageGenToolLoading = ref(false);
const activeTab = ref('llm');
const testing = ref(false);

// 生图走的是另一套接口，不做对话连通测试。
const canTestConnectivity = computed(() => activeTab.value !== 'imageGen');

const providerPlaceholder = '请先在服务商管理中添加服务商';

// 测试目标跟随当前标签页；记忆/识图留空时按运行时规则回退到对话模型。
function testTarget() {
  if (activeTab.value === 'memory') {
    return {
      providerId: store.memoryModel.providerId || store.llm.providerId,
      model: store.memoryModel.model || store.llm.model,
      temperature: store.llm.temperature,
      reasoningEffort: store.memoryModel.reasoningEffort,
    };
  }
  if (activeTab.value === 'vision') {
    return {
      providerId: store.visionModel.providerId || store.llm.providerId,
      model: store.visionModel.model || store.llm.model,
      temperature: store.llm.temperature,
      reasoningEffort: store.visionModel.reasoningEffort,
    };
  }
  return {
    providerId: store.llm.providerId,
    model: store.llm.model,
    temperature: store.llm.temperature,
    reasoningEffort: store.llm.reasoningEffort,
  };
}

async function testConnectivity() {
  if (!canTestConnectivity.value) return;
  const target = testTarget();
  if (!target.providerId) {
    Message.warning('请先选择服务商');
    return;
  }
  if (!target.model) {
    Message.warning('请先选择模型');
    return;
  }
  testing.value = true;
  try {
    const response = await fetch(getFullUrl('/api/settings/providers/test-chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      model?: string;
      latencyMs?: number;
      reply?: string;
      detail?: string;
    } | null;
    if (!response.ok || !body?.ok) {
      Message.error({
        content: body?.detail || `测试失败（HTTP ${response.status}）`,
        duration: 6000,
      });
      return;
    }
    const latency = typeof body.latencyMs === 'number' ? ` · ${body.latencyMs}ms` : '';
    const reply = body.reply ? ` · 返回「${body.reply}」` : ' · 返回为空';
    Message.success({ content: `连通成功${latency}${reply}`, duration: 5000 });
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '测试失败');
  } finally {
    testing.value = false;
  }
}

function handleProviderChange(kind: 'chat' | 'memory' | 'vision' | 'image') {
  store.syncProviderConnection(kind);
  store.refreshAllModelOptions();
  const provider = store.providerFor(kind);
  const enabled = provider?.enabledModels || [];
  if (kind === 'chat') {
    if (!provider) {
      store.llm.model = '';
    } else if (enabled.length && !enabled.includes(store.llm.model)) {
      store.llm.model = enabled[0];
    }
    return;
  }
  if (kind === 'memory') {
    if (!provider) {
      store.memoryModel.model = '';
    } else if (enabled.length && !enabled.includes(store.memoryModel.model)) {
      store.memoryModel.model = enabled[0];
    }
    return;
  }
  if (kind === 'vision') {
    if (!provider) {
      store.visionModel.model = '';
    } else if (enabled.length && !enabled.includes(store.visionModel.model)) {
      store.visionModel.model = enabled[0];
    }
    return;
  }
  if (kind === 'image') {
    if (enabled.length && !enabled.includes(store.imageGeneration.model)) {
      store.imageGeneration.model = enabled[0];
    }
  }
}

const imageGenModelOptions = computed(() => {
  const provider = store.providerFor('image');
  const models = provider?.enabledModels?.length
    ? provider.enabledModels
    : store.imageGeneration.source === 'sensenova'
      ? [...SENSENOVA_IMAGE_GEN_MODELS]
      : [...VOLCENGINE_IMAGE_GEN_MODELS];
  return buildModelOptions(models, store.imageGeneration.model);
});

async function fetchImageGenToolEnabled() {
  imageGenToolLoading.value = true;
  try {
    const response = await fetch(getFullUrl('/api/v1/tools/native'));
    if (!response.ok) return;
    const tools = await response.json() as Array<{ name: string; enabled: boolean }>;
    const tool = tools.find((item) => item.name === GENERATE_IMAGE_TOOL);
    imageGenToolEnabled.value = Boolean(tool?.enabled);
  } catch {
    // ignore — 开关保持当前值
  } finally {
    imageGenToolLoading.value = false;
  }
}

async function handleImageGenToolToggle(enabled: boolean | string | number) {
  const nextEnabled = Boolean(enabled);
  const imageProvider = store.providerFor('image');
  if (nextEnabled && !String(imageProvider?.apiKey || store.imageGeneration.apiKey || '').trim()) {
    Message.warning('请先在服务商管理中配置生图服务商密钥，再开启对话生图');
    return;
  }
  const previous = imageGenToolEnabled.value;
  imageGenToolEnabled.value = nextEnabled;
  imageGenToolLoading.value = true;
  try {
    const response = await fetch(
      getFullUrl(`/api/v1/tools/native/${encodeURIComponent(GENERATE_IMAGE_TOOL)}`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      },
    );
    if (!response.ok) {
      imageGenToolEnabled.value = previous;
      let detail = `更新失败 (${response.status})`;
      try {
        const body = await response.json();
        if (body?.detail) detail = String(body.detail);
      } catch {
        // keep status message
      }
      Message.error(detail);
      return;
    }
    const body = await response.json().catch(() => null);
    if (body && typeof body.enabled === 'boolean') {
      imageGenToolEnabled.value = body.enabled;
    }
    Message.success(nextEnabled ? '已开启对话生图' : '已关闭对话生图');
  } catch {
    imageGenToolEnabled.value = previous;
    Message.error('操作失败');
  } finally {
    imageGenToolLoading.value = false;
  }
}

onMounted(() => {
  store.fetchSettings();
  void fetchImageGenToolEnabled();
});
</script>

<template>
  <div class="model-config">
    <a-spin :loading="!store.isLoaded" tip="正在加载模型配置...">
      <a-alert
        v-if="store.isLoaded && store.modelProviders.length === 0"
        type="warning"
        show-icon
        style="margin-bottom: 12px"
      >
        还没有服务商。请先在「服务商管理」中添加服务商、拉取模型并勾选可用模型。
      </a-alert>
      <a-tabs v-model:active-key="activeTab" default-active-key="llm" type="line" class="model-tabs">
        <!-- 对话模型 (LLM) -->
        <a-tab-pane key="llm" title="对话模型">
          <div class="settings-group">
            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">服务商</span>
                <span class="sub-text">在「服务商管理」中维护地址、密钥和可用模型；这里只选择由哪个服务商提供对话模型</span>
              </div>
              <div class="row-action">
                <a-select
                  v-model="store.llm.providerId"
                  :options="store.providerOptions"
                  :style="{ width: '220px' }"
                  size="small"
                  :placeholder="providerPlaceholder"
                  @change="handleProviderChange('chat')"
                />
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">模型</span>
                <span class="sub-text">选择对话使用的语言模型</span>
              </div>
              <div class="row-action model-select-action">
                <a-select
                  v-model="store.llm.model"
                  :options="store.chatModelOptions"
                  :loading="store.loadingChatModels"
                  :placeholder="'选择服务商已启用的模型'"
                  :style="{ width: '320px' }"
                  size="small"
                  allow-search
                />
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">温度</span>
                <span class="sub-text">控制对话与「我是谁」生成的发散程度，越高越有延展，越低越稳定</span>
              </div>
              <div class="row-action temperature-action">
                <a-slider
                  v-model="store.llm.temperature"
                  :min="0"
                  :max="2"
                  :step="0.05"
                  :style="{ width: '220px' }"
                />
                <a-input-number
                  v-model="store.llm.temperature"
                  :min="0"
                  :max="2"
                  :step="0.05"
                  :precision="2"
                  size="small"
                  :style="{ width: '80px' }"
                />
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">思考程度</span>
                <span class="sub-text">默认=不向服务商发送思考参数，由模型自行决定；关=明确要求关闭思考；低/中/高=要求开启思考并按强度下发。各服务商支持程度不同，不支持的字段通常被忽略</span>
              </div>
              <div class="row-action thinking-action">
                <a-radio-group v-model="store.llm.reasoningEffort" type="button" size="small">
                  <a-radio v-for="opt in THINKING_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</a-radio>
                </a-radio-group>
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">上下文大小</span>
                <span class="sub-text">这是大模型请求携带的对话数据上限，默认 128K 就行，不影响长期记忆。设置 512K 等于对话接近 50 万 token 时才会进行摘要，单次对话产生的费用会更多</span>
              </div>
              <div class="row-action thinking-action">
                <a-radio-group v-model="store.llm.contextBudgetK" type="button" size="small">
                  <a-radio v-for="opt in CONTEXT_BUDGET_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</a-radio>
                </a-radio-group>
              </div>
            </div>
          </div>
        </a-tab-pane>

        <!-- 记忆模型 (Memory Model) -->
        <a-tab-pane key="memory" title="记忆模型">
          <div class="settings-group">
            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">服务商</span>
                <span class="sub-text">用于长期记忆处理的模型；留空则默认使用对话模型的服务商与模型</span>
              </div>
              <div class="row-action">
                <a-select v-model="store.memoryModel.providerId" :options="store.providerOptions" :style="{ width: '220px' }" size="small" allow-clear placeholder="默认使用对话模型" @change="handleProviderChange('memory')" />
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">模型</span>
                <span class="sub-text">用于记忆提取和关联分析的模型</span>
              </div>
              <div class="row-action model-select-action">
                <a-select
                  v-model="store.memoryModel.model"
                  :options="store.memoryModelOptions"
                  :loading="store.loadingMemoryModels"
                  :placeholder="'默认使用对话模型'"
                  :style="{ width: '320px' }"
                  size="small"
                  allow-clear
                  allow-search
                />
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">思考程度</span>
                <span class="sub-text">记忆提取走结构化输出，通常「默认」即可；各服务商支持程度不同，不支持的字段通常被忽略</span>
              </div>
              <div class="row-action thinking-action">
                <a-radio-group v-model="store.memoryModel.reasoningEffort" type="button" size="small">
                  <a-radio v-for="opt in THINKING_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</a-radio>
                </a-radio-group>
              </div>
            </div>
          </div>
        </a-tab-pane>

        <!-- 识图模型 (Vision Model) -->
        <a-tab-pane key="vision" title="识图模型">
          <div class="settings-group">
            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">服务商</span>
                <span class="sub-text">用于识图的视觉模型；留空则默认使用对话模型的服务商与模型</span>
              </div>
              <div class="row-action">
                <a-select
                  v-model="store.visionModel.providerId"
                  :options="store.providerOptions"
                  :style="{ width: '220px' }"
                  size="small"
                  allow-clear
                  placeholder="默认使用对话模型"
                  @change="handleProviderChange('vision')"
                />
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">模型</span>
                <span class="sub-text">选择服务商已启用的多模态视觉模型</span>
              </div>
              <div class="row-action model-select-action">
                <a-select
                  v-model="store.visionModel.model"
                  :options="store.visionModelOptions"
                  :loading="store.loadingVisionModels"
                  :placeholder="'默认使用对话模型'"
                  :style="{ width: '320px' }"
                  size="small"
                  allow-clear
                  allow-search
                />
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">思考程度</span>
                <span class="sub-text">默认=不向服务商发送思考参数，由模型自行决定；关=明确要求关闭思考；低/中/高=要求开启思考并按强度下发</span>
              </div>
              <div class="row-action thinking-action">
                <a-radio-group v-model="store.visionModel.reasoningEffort" type="button" size="small">
                  <a-radio v-for="opt in THINKING_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</a-radio>
                </a-radio-group>
              </div>
            </div>
          </div>
        </a-tab-pane>

        <!-- 生图模型 (Image Generation) -->
        <a-tab-pane key="imageGen" title="生图模型">
          <div class="settings-group">
            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">开启对话生图</span>
                <span class="sub-text">用户明确要求看图/自拍/画画时，允许模型调用生图工具。需先在服务商管理中配置生图服务商</span>
              </div>
              <div class="row-action">
                <a-switch
                  :model-value="imageGenToolEnabled"
                  :loading="imageGenToolLoading"
                  size="small"
                  @change="handleImageGenToolToggle"
                />
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">服务商</span>
                <span class="sub-text">选择在「服务商管理」中配置的生图服务商（如火山引擎 Seedream、商汤日日新）</span>
              </div>
              <div class="row-action">
                <a-select
                  v-model="store.imageGeneration.providerId"
                  :options="store.providerOptions"
                  :style="{ width: '220px' }"
                  size="small"
                  :placeholder="providerPlaceholder"
                  @change="handleProviderChange('image')"
                />
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">模型</span>
                <span class="sub-text">生图模型；从服务商已启用模型中选择</span>
              </div>
              <div class="row-action model-select-action">
                <a-select
                  v-model="store.imageGeneration.model"
                  :options="imageGenModelOptions"
                  :placeholder="'选择服务商已启用的模型'"
                  :style="{ width: '320px' }"
                  size="small"
                  allow-search
                />
              </div>
            </div>
          </div>
        </a-tab-pane>
      </a-tabs>

      <!-- 保存按钮 -->
      <div class="save-area">
        <a-button
          v-if="canTestConnectivity"
          :loading="testing"
          :disabled="store.saving"
          @click="testConnectivity"
        >
          测试连通
        </a-button>
        <a-button type="primary" :loading="store.saving" @click="store.saveSettings">保存配置</a-button>
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.model-config {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.model-tabs {
  flex: 1;
}

:deep(.arco-tabs-content) {
  padding-top: 16px;
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
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color);
}

.setting-row:last-child {
  border-bottom: none;
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 55%;
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

.row-action {
  display: flex;
  align-items: center;
}

.model-select-action {
  display: flex;
  align-items: center;
  gap: 4px;
}

.temperature-action {
  display: flex;
  align-items: center;
  gap: 12px;
}

.thinking-action {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.token-value {
  min-width: 44px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: right;
}

.save-area {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
  margin-top: auto;
}
</style>
