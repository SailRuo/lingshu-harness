<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { Message, Modal } from '@arco-design/web-vue';
import IconPlus from '@arco-design/web-vue/es/icon/icon-plus';
import IconMinus from '@arco-design/web-vue/es/icon/icon-minus';
import IconDelete from '@arco-design/web-vue/es/icon/icon-delete';
import IconEdit from '@arco-design/web-vue/es/icon/icon-edit';
import IconCode from '@arco-design/web-vue/es/icon/icon-code';
import IconList from '@arco-design/web-vue/es/icon/icon-list';
import IconQuestionCircle from '@arco-design/web-vue/es/icon/icon-question-circle';
import { getFullUrl } from '../../utils/apiConfig';
import MijiaPluginCard from './MijiaPluginCard.vue';

interface McpServer {
  id?: number;
  name: string;
  description?: string;
  transport_type: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  is_active: boolean;
}

interface NativeTool {
  name: string;
  description?: string;
  enabled: boolean;
  always_enabled?: boolean;
  group?: string | null;
}


const servers = ref<McpServer[]>([]);
const nativeTools = ref<NativeTool[]>([]);
const loading = ref(false);
const nativeToolsLoading = ref(false);
const modalVisible = ref(false);
const importModalVisible = ref(false);
const jsonImportRaw = ref('');
const editingServer = ref<McpServer | null>(null);
const activeTab = ref('native');

/** 生图、通话收尾等运行期内部能力不在插件页展示 */
const HIDDEN_NATIVE_TOOLS = new Set(['generate_image', 'end_voice_call']);

/**
 * 插件页只展示业务名；技术名留在运行时。
 * help 文案用一句话讲清“这会让智能体能做什么”，不暴露参数/调用细节。
 */
const NATIVE_TOOL_META: Record<string, { title: string; help: string }> = {
  get_weather: {
    title: '天气查询',
    help: '让智能体查询指定城市的当前天气，方便聊今天的穿衣、出行或日常安排。',
  },
  file_read_text: {
    title: '查看本地文件',
    help: '在你允许后，让智能体查看工作区里的文本文件，用来帮你分析或整理资料。',
  },
  file_write_text: {
    title: '保存本地文件',
    help: '在你允许后，让智能体把整理好的文本保存成工作区里的文件。',
  },
  run_terminal_command: {
    title: '本地操作',
    help: '在你允许后，让智能体在工作区里执行一条操作，用来完成查找、整理或处理任务；执行结果会回传给它。',
  },
  skills_list: {
    title: '技能目录',
    help: '让智能体查看这台设备上当前可用的技能。',
  },
  skills_activate: {
    title: '启用技能',
    help: '让智能体在当前对话里启用某个技能，后续聊天可以继续使用。',
  },
  skills_deactivate: {
    title: '停用技能',
    help: '让智能体在当前对话里停用某个技能。',
  },
  skills_active: {
    title: '当前启用技能',
    help: '让智能体查看当前对话里已经启用的技能。',
  },
  save_memory: {
    title: '主动记忆',
    help: '把你在对话里明确说过、值得长期记住的事实、偏好和习惯写进记忆，之后聊天会用到。',
  },
  search_memory: {
    title: '回忆检索',
    help: '想不起你说过的事时，让智能体从记忆里检索相关片段，帮它回忆起之前聊过的细节。',
  },
  manage_alarm: {
    title: '提醒管理',
    help: '按你说定的未来日程建提醒：能定钟点就按钟点，只有日期就按日期，也支持重复提醒。',
  },
};

function nativeToolTitle(tool: NativeTool): string {
  return NATIVE_TOOL_META[tool.name]?.title || '内置能力';
}

function nativeToolHelp(tool: NativeTool): string {
  return NATIVE_TOOL_META[tool.name]?.help || '这是智能体可以使用的一项内置能力。';
}
const visibleNativeTools = computed(() =>
  nativeTools.value.filter(
    (tool) => !HIDDEN_NATIVE_TOOLS.has(tool.name) && tool.group !== 'mijia',
  ),
);

// --- 工具列表状态 ---
const toolsModalVisible = ref(false);
const currentServerTools = ref<any[]>([]);
const toolsLoading = ref(false);
const selectedServerName = ref('');

const formModel = ref<McpServer>({
  name: '',
  description: '',
  transport_type: 'stdio',
  command: '',
  args: [''],
  env: {},
  url: '',
  is_active: true
});

const envList = ref<{ key: string; value: string }[]>([]);

const JSON_TEMPLATE = {
  "mcpServers": {
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "./data.db"]
    }
  }
};

const fillTemplate = () => {
  jsonImportRaw.value = JSON.stringify(JSON_TEMPLATE, null, 2);
};

// --- 数据清洗工具 ---
const ensureStringArray = (arr: any): string[] => {
  if (!Array.isArray(arr)) return [''];
  const cleaned = arr.map(item => (item && typeof item === 'object') ? '' : String(item));
  return cleaned.length > 0 ? cleaned.filter(i => i !== null) : [''];
};

// --- 参数操作 ---
const addArg = (index: number) => {
  formModel.value.args.splice(index + 1, 0, '');
};

const removeArg = (index: number) => {
  if (formModel.value.args.length > 1) {
    formModel.value.args.splice(index, 1);
  } else {
    formModel.value.args[0] = '';
  }
};

// --- 环境变量操作 ---
const addEnv = (index: number) => {
  envList.value.splice(index + 1, 0, { key: '', value: '' });
};

const removeEnv = (index: number) => {
  if (envList.value.length > 1) {
    envList.value.splice(index, 1);
  } else {
    envList.value[0] = { key: '', value: '' };
  }
};

const fetchServers = async () => {
  loading.value = true;
  try {
    const response = await fetch(getFullUrl('/api/v1/tools/mcp'));
    if (!response.ok) {
      Message.error(`获取插件列表失败 (${response.status})`);
      return;
    }
    servers.value = await response.json();
  } catch (error) {
    Message.error('获取插件列表失败，请检查后端地址与 HTTPS 配置');
  } finally {
    loading.value = false;
  }
};

const fetchNativeTools = async () => {
  nativeToolsLoading.value = true;
  try {
    const response = await fetch(getFullUrl('/api/v1/tools/native'));
    if (!response.ok) {
      Message.error(`获取内置工具失败 (${response.status})`);
      return;
    }
    nativeTools.value = await response.json();
  } catch (error) {
    Message.error('获取内置工具失败，请检查后端地址与 HTTPS 配置');
  } finally {
    nativeToolsLoading.value = false;
  }
};

const mijiaCardRef = ref<{ refreshStatus: () => Promise<void> } | null>(null);

const refreshNativeTab = async () => {
  await Promise.all([fetchNativeTools(), mijiaCardRef.value?.refreshStatus()]);
};

const openAddModal = () => {
  editingServer.value = null;
  formModel.value = {
    name: '',
    description: '',
    transport_type: 'stdio',
    command: '',
    args: [''],
    env: {},
    url: '',
    is_active: true
  };
  envList.value = [{ key: '', value: '' }];
  modalVisible.value = true;
};

const openEditModal = (server: McpServer) => {
  editingServer.value = server;
  formModel.value = { 
    ...server,
    args: ensureStringArray(server.args)
  };
  
  const entries = Object.entries(server.env || {});
  envList.value = entries.length > 0 
    ? entries.map(([key, value]) => ({ key, value: String(value) }))
    : [{ key: '', value: '' }];
    
  modalVisible.value = true;
};

const handleSaveServer = async () => {
  const cleanedArgs = formModel.value.args.filter(a => a && a.trim());
  const env: Record<string, string> = {};
  envList.value.forEach(item => {
    if (item.key.trim()) env[item.key.trim()] = item.value;
  });

  const payload: any = {
    ...formModel.value,
    args: cleanedArgs,
    env: env
  };

  if (formModel.value.transport_type !== 'stdio') {
    payload.url = formModel.value.url;
    payload.command = null;
    payload.args = [];
  }

  try {
    const url = editingServer.value 
      ? getFullUrl(`/api/v1/tools/mcp/${editingServer.value.id}`)
      : getFullUrl('/api/v1/tools/mcp');
    const method = editingServer.value ? 'PUT' : 'POST';

    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      Message.success(editingServer.value ? '更新成功' : '创建成功');
      modalVisible.value = false;
      fetchServers();
    }
  } catch (error) {
    Message.error('保存失败');
  }
};

const handleToggleActive = async (server: McpServer) => {
  try {
    const response = await fetch(getFullUrl(`/api/v1/tools/mcp/${server.id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...server, is_active: !server.is_active })
    });
    if (response.ok) {
      server.is_active = !server.is_active;
      Message.success(server.is_active ? '已启用' : '已禁用');
    }
  } catch (error) {
    Message.error('操作失败');
  }
};

const handleToggleNativeTool = async (tool: NativeTool, enabled: boolean | string | number) => {
  if (tool.always_enabled) return;
  const nextEnabled = Boolean(enabled);
  const previous = tool.enabled;
  tool.enabled = nextEnabled;
  try {
    const response = await fetch(getFullUrl(`/api/v1/tools/native/${encodeURIComponent(tool.name)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextEnabled })
    });
    if (!response.ok) {
      tool.enabled = previous;
      Message.error(`更新内置工具失败 (${response.status})`);
      return;
    }
    Message.success(nextEnabled ? '已启用内置工具' : '已禁用内置工具');
  } catch (error) {
    tool.enabled = previous;
    Message.error('操作失败');
  }
};

const handleDeleteServer = async (id: number) => {
  Modal.confirm({
    title: '确认删除',
    content: '确定要删除这个 MCP 服务器吗？',
    onOk: async () => {
      try {
        const response = await fetch(getFullUrl(`/api/v1/tools/mcp/${id}`), { method: 'DELETE' });
        if (response.ok) {
          Message.success('已删除');
          fetchServers();
        }
      } catch (error) {
        Message.error('删除失败');
      }
    }
  });
};

const handleImportJson = async () => {
  try {
    const parsed = JSON.parse(jsonImportRaw.value);
    const response = await fetch(getFullUrl('/api/v1/tools/mcp/import'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    });
    const result = await response.json();
    Message.success(`成功导入 ${result.imported} 个服务器`);
    importModalVisible.value = false;
    fetchServers();
  } catch (error: any) {
    Message.error('导入失败: ' + error.message);
  }
};

const handleViewTools = async (serverName: string) => {
  selectedServerName.value = serverName;
  toolsLoading.value = true;
  toolsModalVisible.value = true;
  currentServerTools.value = [];
  
  try {
    const response = await fetch(getFullUrl(`/api/v1/tools/mcp/${serverName}/tools`));
    if (response.ok) {
      currentServerTools.value = await response.json();
    } else {
      Message.error('获取工具列表失败');
    }
  } catch (error) {
    Message.error('网络错误');
  } finally {
    toolsLoading.value = false;
  }
};

onMounted(() => {
  fetchServers();
  fetchNativeTools();
});
</script>

<template>
  <div class="plugin-config">
    <div class="config-header">
      <div class="header-info">
        <div class="header-text">
          <h3 class="title">插件管理</h3>
          <p class="subtitle">管理智能体可用的内置能力和外部扩展。</p>
        </div>
      </div>
      <div class="header-actions">
        <template v-if="activeTab === 'native'">
          <a-button :loading="nativeToolsLoading" @click="refreshNativeTab">
            <template #icon><IconList /></template>
            刷新
          </a-button>
        </template>
        <template v-else-if="activeTab === 'mcp'">
          <a-button @click="importModalVisible = true">
            <template #icon><IconCode /></template>
            JSON 导入
          </a-button>
          <a-button type="primary" @click="openAddModal">
            <template #icon><IconPlus /></template>
            添加服务器
          </a-button>
        </template>
      </div>
    </div>

    <a-tabs v-model:active-key="activeTab" type="line" class="plugin-tabs">
      <a-tab-pane key="native" title="内置能力">
        <div class="tab-content">
          <MijiaPluginCard ref="mijiaCardRef" @changed="fetchNativeTools" />

          <a-spin :loading="nativeToolsLoading" style="width: 100%">
            <a-empty v-if="visibleNativeTools.length === 0 && !nativeToolsLoading" description="暂无可配置的内置能力" />
            <div v-else class="native-tool-list">
              <div v-for="tool in visibleNativeTools" :key="tool.name" class="native-tool-row">
                <div class="tool-main">
                  <div class="tool-icon-mini"><IconCode /></div>
                  <div class="tool-copy">
                    <span class="tool-name">{{ nativeToolTitle(tool) }}</span>
                  </div>
                </div>
                <div class="tool-actions">
                  <a-popover
                    trigger="click"
                    position="rt"
                    content-class="tool-help-pop"
                  >
                    <button
                      class="tool-help-btn"
                      type="button"
                      title="这是什么"
                      @click.stop
                    >
                      <IconQuestionCircle :size="14" style="width: 14px; height: 14px;" />
                    </button>
                    <template #content>
                      <p class="tool-help-title">{{ nativeToolTitle(tool) }}</p>
                      <p class="tool-help-text">{{ nativeToolHelp(tool) }}</p>
                    </template>
                  </a-popover>
                  <a-switch
                    :model-value="tool.enabled"
                    :disabled="tool.always_enabled"
                    size="small"
                    @change="(value) => handleToggleNativeTool(tool, value)"
                  />
                </div>
              </div>
            </div>
          </a-spin>
        </div>
      </a-tab-pane>

      <a-tab-pane key="mcp" title="扩展插件">
        <div class="tab-content">
          <p class="section-subtitle tab-desc">添加、导入或停用外部扩展。</p>
          <a-spin :loading="loading" style="width: 100%">
            <div class="server-list">
              <a-empty v-if="servers.length === 0 && !loading" description="暂无配置的插件" />
              
              <div v-for="server in servers" :key="server.id" class="server-card">
                <div class="card-content">
                  <div class="server-main">
                    <div class="status-dot" :class="{ active: server.is_active }"></div>
                    <div class="server-details">
                      <span class="server-name">{{ server.name }}</span>
                      <div class="server-meta">
                        <a-tag size="small">{{ server.transport_type }}</a-tag>
                        <code v-if="server.command">{{ server.command }}</code>
                      </div>
                    </div>
                  </div>
                  <div class="server-actions">
                    <a-switch :model-value="server.is_active" @change="handleToggleActive(server)" size="small" />
                    <a-button type="text" size="small" @click="openEditModal(server)">
                      <template #icon><IconEdit /></template>
                    </a-button>
                    <a-button type="text" size="small" @click="handleViewTools(server.name)" title="查看工具">
                      <template #icon><IconList /></template>
                    </a-button>
                    <a-button type="text" status="danger" size="small" @click="handleDeleteServer(server.id!)">
                      <template #icon><IconDelete /></template>
                    </a-button>
                  </div>
                </div>
              </div>
            </div>
          </a-spin>
        </div>
      </a-tab-pane>
    </a-tabs>

    <!-- Add/Edit Modal -->
    <a-modal 
      v-model:visible="modalVisible" 
      :title="editingServer ? '编辑 MCP 服务器' : '添加 MCP 服务器'" 
      @ok="handleSaveServer" 
      width="600px"
      :body-style="{ maxHeight: '75vh', overflowY: 'auto', paddingRight: '12px' }"
    >
      <a-form :model="formModel" layout="vertical">
        <a-form-item label="名称 (唯一)" field="name" required>
          <a-input v-model="formModel.name" placeholder="例如: mysql-client" />
        </a-form-item>
        <a-form-item label="传输通道 (Transport)" field="transport_type" required>
          <a-select v-model="formModel.transport_type">
            <a-option value="stdio">标准输入 / 输出 (stdio)</a-option>
            <a-option value="sse">服务器发送事件 (sse)</a-option>
            <a-option value="streamableHttp">可流式传输的 HTTP (streamableHttp)</a-option>
          </a-select>
        </a-form-item>
        
        <!-- 只有 stdio 模式显示启动指令和参数 -->
        <template v-if="formModel.transport_type === 'stdio'">
          <a-form-item label="启动指令 (Command)" field="command" required>
            <a-input v-model="formModel.command" placeholder="例如: npx, python, docker..." />
          </a-form-item>
          
          <a-form-item label="启动参数 (Arguments)">
            <div class="dynamic-container">
              <div v-for="(_, index) in formModel.args" :key="index" class="dynamic-row">
                <a-input v-model="formModel.args[index]" placeholder="参数内容" class="row-input" />
                <a-button-group class="row-actions">
                  <a-button @click="removeArg(index)" type="secondary" size="small">
                    <template #icon><IconMinus /></template>
                  </a-button>
                  <a-button @click="addArg(index)" type="secondary" size="small">
                    <template #icon><IconPlus /></template>
                  </a-button>
                </a-button-group>
              </div>
            </div>
          </a-form-item>
        </template>

        <!-- SSE 或 StreamableHTTP 模式通常需要一个 URL 字段，虽然目前后端可能还没完全处理，先加上 UI -->
        <template v-else>
          <a-form-item label="服务器地址 (URL)" field="url" required>
            <a-input v-model="formModel.url" placeholder="例如: http://localhost:8080/mcp" />
          </a-form-item>
        </template>

        <a-form-item label="环境变量 (Environment Variables)">
          <div class="dynamic-container">
            <div v-for="(_, index) in envList" :key="index" class="dynamic-row">
              <a-input v-model="envList[index].key" placeholder="Key" style="width: 140px" />
              <a-input v-model="envList[index].value" placeholder="Value" class="row-input" />
              <a-button-group class="row-actions">
                <a-button @click="removeEnv(index)" type="secondary" size="small">
                  <template #icon><IconMinus /></template>
                </a-button>
                <a-button @click="addEnv(index)" type="secondary" size="small">
                  <template #icon><IconPlus /></template>
                </a-button>
              </a-button-group>
            </div>
          </div>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- JSON Import Modal -->
    <a-modal v-model:visible="importModalVisible" title="从 JSON 导入配置" @ok="handleImportJson">
      <div class="modal-header-actions">
        <p class="import-tip">支持 Claude Desktop 格式的 mcpServers JSON 配置。</p>
        <a-button size="mini" @click="fillTemplate">填充示例</a-button>
      </div>
      <a-textarea
        v-model="jsonImportRaw"
        placeholder='{ "mcpServers": { ... } }'
        :auto-size="{ minRows: 10, maxRows: 20 }"
        class="code-textarea"
      />
    </a-modal>

    <!-- View Tools Modal -->
    <a-modal 
      v-model:visible="toolsModalVisible" 
      :title="`${selectedServerName} - 工具列表`" 
      :footer="false"
      width="500px"
    >
      <a-spin :loading="toolsLoading" style="width: 100%">
        <a-list :max-height="400">
          <a-list-item v-for="tool in currentServerTools" :key="tool.name">
            <a-list-item-meta
              :title="tool.name"
              :description="tool.description || '暂无描述'"
            >
              <template #avatar>
                <div class="tool-icon-mini"><IconCode /></div>
              </template>
            </a-list-item-meta>
          </a-list-item>
          <template #empty v-if="!toolsLoading">
            <a-empty description="该服务当前没有可用的工具" />
          </template>
        </a-list>
      </a-spin>
    </a-modal>
  </div>
</template>

<style scoped>
.plugin-config {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.plugin-tabs {
  width: 100%;
}

:deep(.arco-tabs-content) {
  padding-top: 16px;
}

.tab-desc {
  margin-top: 0;
  margin-bottom: 16px;
}

.config-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.header-info {
  display: flex;
  gap: 16px;
  align-items: center;
}

.header-icon {
  font-size: 32px;
  color: var(--color-primary);
  background: var(--color-primary-light-1);
  padding: 12px;
  border-radius: 12px;
}

.title { margin: 0; font-size: 18px; font-weight: 600; color: var(--text-primary); }
.subtitle { margin: 4px 0 0; font-size: 13px; color: var(--text-tertiary); }

.header-actions {
  display: flex;
  gap: 12px;
}

.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.native-tools-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.native-tool-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.native-tool-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  min-height: 64px;
  padding: 14px 18px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 12px;
}

.tool-main {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.tool-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.tool-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.tool-help-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-color);
  border-radius: 50%;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}

.tool-help-btn:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--color-primary-light-1);
}

:global(.tool-help-pop) {
  max-width: 300px;
}

:global(.tool-help-pop .tool-help-title) {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

:global(.tool-help-pop .tool-help-text) {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.tool-name {
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-word;
}

.tool-description {
  max-width: 680px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-tertiary);
}

.server-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.server-card {
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px 20px;
  transition: all 0.2s;
}

.server-card:hover {
  border-color: var(--color-primary-light-3);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.card-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.server-main {
  display: flex;
  align-items: center;
  gap: 16px;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: var(--color-neutral-4);
}

.status-dot.active {
  background-color: var(--color-success);
  box-shadow: 0 0 8px var(--color-success-light-3);
}

.server-name {
  font-weight: 600;
  color: var(--text-primary);
}

.server-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.server-meta code {
  font-size: 11px;
  background: rgba(0, 0, 0, 0.05);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
}

.server-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dynamic-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 12px;
}

.dynamic-row {
  display: flex;
  width: 100%;
  gap: 12px;
  align-items: center;
}

.row-input {
  flex: 1;
}

.row-actions {
  flex-shrink: 0;
}

.modal-header-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.code-textarea {
  font-family: 'Fira Code', 'Monaco', 'Menlo', monospace;
  font-size: 12px;
}

.tool-icon-mini {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background-color: var(--color-primary-light-1);
  color: var(--color-primary);
  border-radius: 6px;
}
</style>
