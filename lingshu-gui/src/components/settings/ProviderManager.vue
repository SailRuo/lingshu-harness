<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Message, Modal } from '@arco-design/web-vue';
import { useSettingsStore, type ModelProvider } from '../../stores/settings';
import { getFullUrl } from '../../utils/apiConfig';

const store = useSettingsStore();

const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const refreshingId = ref('');
const savingModels = ref(false);
const editorVisible = ref(false);
const editing = ref<ModelProvider | null>(null);
const modelProviderId = ref<string | null>(null);
const modelsVisible = ref(false);
const selections = ref<Record<string, boolean>>({});
const customModel = ref('');
const extraModels = ref<string[]>([]);
const removedModels = ref<string[]>([]);

const providers = computed(() => store.modelProviders);
const activeProvider = computed(
  () => store.modelProviders.find((provider) => provider.id === modelProviderId.value) || null,
);
const allModels = computed(() => [
  ...new Set([...(activeProvider.value?.models || []), ...extraModels.value]),
].filter((model) => !removedModels.value.includes(model)));
const enabledCount = computed(
  () => Object.values(selections.value).filter(Boolean).length,
);

function openCreate() {
  editing.value = {
    id: '',
    name: '',
    protocol: 'openai',
    baseUrl: '',
    apiKey: '',
    models: [],
    enabledModels: [],
  };
  editorVisible.value = true;
}

function openEdit(provider: ModelProvider) {
  editing.value = { ...provider, models: [...provider.models], enabledModels: [...provider.enabledModels] };
  editorVisible.value = true;
}

async function testConnection() {
  if (!editing.value) return;
  const baseUrl = editing.value.baseUrl.trim();
  if (!baseUrl) {
    Message.warning('请填写服务地址');
    return;
  }
  testing.value = true;
  try {
    const res = await fetch(getFullUrl('/api/settings/providers/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 'openai',
        baseUrl,
        apiKey: editing.value.apiKey,
      }),
    });
    const body = await res.json().catch(() => null) as {
      ok?: boolean;
      modelCount?: number;
      detail?: string;
    } | null;
    if (!res.ok || !body?.ok) {
      Message.error(body?.detail || `连接失败（HTTP ${res.status}）`);
      return;
    }
    Message.success(
      body.modelCount
        ? `连接成功，发现 ${body.modelCount} 个模型`
        : '连接成功，但接口未返回模型',
    );
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '连接失败');
  } finally {
    testing.value = false;
  }
}

async function saveProvider() {
  if (!editing.value) return;
  if (!editing.value.name.trim()) {
    Message.warning('请填写服务商名称');
    return;
  }
  editing.value.protocol = 'openai';
  saving.value = true;
  try {
    await store.saveModelProvider(editing.value);
    editorVisible.value = false;
    Message.success('服务商已保存');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '保存服务商失败');
  } finally {
    saving.value = false;
  }
}

function removeProvider(provider: ModelProvider) {
  Modal.confirm({
    title: '删除服务商',
    content: `确定删除「${provider.name}」吗？已选择该服务商的模型配置会回退为空。`,
    okText: '删除',
    cancelText: '取消',
    onOk: async () => {
      try {
        await store.deleteModelProvider(provider.id);
        Message.success('服务商已删除');
      } catch (error) {
        Message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
  });
}

function syncSelections(provider: ModelProvider | null) {
  selections.value = Object.fromEntries(
    (provider?.enabledModels || []).map((model) => [model, true]),
  );
}

async function openModels(provider: ModelProvider) {
  modelProviderId.value = provider.id;
  modelsVisible.value = true;
  extraModels.value = [];
  removedModels.value = [];
  customModel.value = '';
  syncSelections(provider);
  await refreshModels();
}

function closeModels() {
  modelsVisible.value = false;
  modelProviderId.value = null;
}

async function refreshModels() {
  if (!activeProvider.value) return;
  refreshingId.value = activeProvider.value.id;
  try {
    const result = (await store.refreshModelProviderModels(activeProvider.value.id)) as {
      fetched?: string[];
      fetchOk?: boolean;
      fetchDetail?: string;
    } | null;
    const refreshed = store.modelProviders.find((item) => item.id === modelProviderId.value);
    syncSelections(refreshed || activeProvider.value);
    if (result?.fetchOk === false) {
      Message.warning({
        content: `没有从服务商拉到模型：${result.fetchDetail || '请检查地址和密钥'}。可修正配置后重试，或手动添加模型 ID。`,
        duration: 6000,
      });
    } else if (!refreshed?.models.length) {
      Message.warning('没有拉取到模型，请检查地址和密钥，或手动添加模型 ID');
    }
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '拉取模型失败');
  } finally {
    refreshingId.value = '';
  }
}

function addCustomModel() {
  const model = customModel.value.trim();
  if (!model) return;
  if (!allModels.value.includes(model)) extraModels.value.push(model);
  selections.value = { ...selections.value, [model]: true };
  customModel.value = '';
}

function toggleModel(model: string, checked: boolean) {
  selections.value = { ...selections.value, [model]: checked };
}

function removeModel(model: string) {
  if (!removedModels.value.includes(model)) {
    removedModels.value = [...removedModels.value, model];
  }
  const next = { ...selections.value };
  delete next[model];
  selections.value = next;
  extraModels.value = extraModels.value.filter((item) => item !== model);
  customModel.value = '';
}

async function saveModels() {
  if (!activeProvider.value) return;
  savingModels.value = true;
  try {
    const enabled = allModels.value.filter((model) => selections.value[model]);
    await store.saveModelProviderModels(activeProvider.value.id, enabled, allModels.value);
    closeModels();
    Message.success('可选模型已保存');
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '保存模型列表失败');
  } finally {
    savingModels.value = false;
  }
}

onMounted(async () => {
  try {
    await store.fetchModelProviders();
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '加载服务商失败');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="provider-manager">
    <div class="section-header">
      <h3 class="section-title">服务商列表</h3>
      <a-button type="primary" size="small" @click="openCreate">新增服务商</a-button>
    </div>

    <a-spin :loading="loading">
      <div v-if="providers.length === 0" class="empty-state">
        暂无服务商，请先新增一个服务商并拉取模型。
      </div>
      <div v-else class="provider-list">
        <div v-for="provider in providers" :key="provider.id" class="provider-card">
          <div class="provider-main">
            <div class="provider-name-line">
              <span class="provider-name">{{ provider.name }}</span>
              <a-tag v-if="provider.preset" size="small" color="blue" borderless>预设</a-tag>
              <a-tag v-if="provider.apiKey" size="small" color="green" borderless>密钥已配置</a-tag>
              <a-tag v-else size="small" color="gray" borderless>未配置密钥</a-tag>
            </div>
            <div class="provider-models">
              可选模型 {{ provider.enabledModels.length }} / 共 {{ provider.models.length }} 个
            </div>
          </div>
          <div class="provider-actions">
            <a-button type="text" size="small" @click="openEdit(provider)">编辑</a-button>
            <a-button type="text" size="small" @click="openModels(provider)">模型管理</a-button>
            <a-button type="text" status="danger" size="small" @click="removeProvider(provider)">删除</a-button>
          </div>
        </div>
      </div>
    </a-spin>

    <a-modal
      v-model:visible="editorVisible"
      :title="editing?.id ? '编辑服务商' : '新增服务商'"
      :footer="false"
      width="520px"
    >
      <div v-if="editing" class="provider-form">
        <label class="form-field">
          <span>名称</span>
          <a-input v-model="editing.name" placeholder="例如：我的 OpenAI 代理" />
        </label>
        <label class="form-field">
          <span>服务地址</span>
          <a-input v-model="editing.baseUrl" placeholder="https://api.example.com/v1" />
        </label>
        <label class="form-field">
          <span>API 密钥</span>
          <a-input-password v-model="editing.apiKey" placeholder="sk-..." />
        </label>
        <div class="form-actions">
          <a-button
            class="test-connection"
            size="small"
            :loading="testing"
            :disabled="saving"
            @click="testConnection"
          >
            测试联通
          </a-button>
          <a-button size="small" @click="editorVisible = false">取消</a-button>
          <a-button type="primary" size="small" :loading="saving" @click="saveProvider">保存</a-button>
        </div>
      </div>
    </a-modal>

    <a-modal
      v-model:visible="modelsVisible"
      :title="`模型管理 · ${activeProvider?.name || ''}`"
      :footer="false"
      width="560px"
    >
      <div class="model-panel">
        <div class="model-toolbar">
          <a-button size="small" :loading="refreshingId === activeProvider?.id" @click="refreshModels">
            刷新模型列表
          </a-button>
          <span class="model-count">已选 {{ enabledCount }} 个</span>
        </div>
        <p class="model-hint">打开时会自动拉取最新模型；拉取失败时列表为空，可检查地址和密钥后重试，或手动添加模型 ID。首次默认全部勾选，保存后会记住你的选择。</p>
        <div class="custom-model-row">
          <a-input v-model="customModel" size="small" placeholder="手动添加模型 ID，例如 gpt-4o-mini" @press-enter="addCustomModel" />
          <a-button size="small" @click="addCustomModel">添加</a-button>
        </div>
        <div v-if="allModels.length === 0 && refreshingId === activeProvider?.id" class="empty-models">
          正在拉取最新模型...
        </div>
        <div v-else-if="allModels.length === 0" class="empty-models">
          还没有模型。请检查密钥后刷新，或手动添加模型 ID。
        </div>
        <div v-else class="model-checklist">
          <div
            v-for="model in allModels"
            :key="model"
            class="model-check-item"
            @click="toggleModel(model, !Boolean(selections[model]))"
          >
            <a-checkbox
              :model-value="Boolean(selections[model])"
              @click.stop
              @change="(checked) => toggleModel(model, Boolean(checked))"
            />
            <span class="model-check-name">{{ model }}</span>
            <button
              type="button"
              class="model-remove"
              title="从服务商移除该模型"
              @click.stop="removeModel(model)"
            >
              移除
            </button>
          </div>
        </div>
        <div class="form-actions">
          <a-button size="small" @click="closeModels">取消</a-button>
          <a-button type="primary" size="small" :loading="savingModels" @click="saveModels">
            保存模型选择
          </a-button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.provider-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding: 0 4px;
}

.section-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.provider-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-input);
}

.provider-main {
  min-width: 0;
}

.provider-name-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.provider-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.provider-models {
  margin-top: 6px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.provider-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 2px;
}

.empty-state {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.provider-form,
.model-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.test-connection {
  margin-right: auto;
}

.model-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.model-count {
  color: var(--text-tertiary);
  font-size: 12px;
}

.model-hint {
  margin: -4px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.5;
}

.custom-model-row {
  display: flex;
  gap: 8px;
}

.empty-models {
  padding: 24px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
}

.model-checklist {
  max-height: 320px;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 14px;
  padding: 4px;
}

.model-check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 3px 5px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}

.model-check-item:hover {
  background: var(--bg-hover);
}

.model-remove {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 11px;
  cursor: pointer;
  padding: 0 2px;
}

.model-remove:hover {
  color: var(--color-danger);
}

.model-check-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
