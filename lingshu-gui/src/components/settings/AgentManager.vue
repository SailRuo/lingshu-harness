<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import IconPlus from '@arco-design/web-vue/es/icon/icon-plus';
import IconCheck from '@arco-design/web-vue/es/icon/icon-check';
import IconUpload from '@arco-design/web-vue/es/icon/icon-upload';
import IconRefresh from '@arco-design/web-vue/es/icon/icon-refresh';


import { useAgentsStore, type AgentConfig } from '../../stores/agents';
import { useChatStore } from '../../stores/chat';
import {
  DEFAULT_ROLE_SETTING,
  DEFAULT_LINGYU_ROLE_SETTING,
} from '../../services/agentDefaults';
import {
  PERSONA_FACETS,
  PERSONA_AVOID_OPTIONS,
  findPersonaOption,
  type PersonaFacet,
} from '../../constants/personaFacets';
import Message from '@arco-design/web-vue/es/message';
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import { getFullUrl } from '../../utils/apiConfig';
import ChatHistoryImport from './ChatHistoryImport.vue';

const agentsStore = useAgentsStore();
const chatStore = useChatStore();

// 智能体管理相关状态
const editingAgent = ref<AgentConfig | null>(null);
const isEditing = ref(false);
const isGeneratingRole = ref(false);
const isRoleWizardVisible = ref(false);
const isTransferModalVisible = ref(false);
const isCreatingTransfer = ref(false);
const transferQrSvg = ref('');
const transferExpiresAt = ref<number | null>(null);
const isImportModalVisible = ref(false);
const importTargetAgentId = ref<number | undefined>();

const openImportModal = (agent?: AgentConfig) => {
  importTargetAgentId.value = agent?.id;
  isImportModalVisible.value = true;
};
const roleWizard = ref({
  rawIdea: '',
  companionTarget: '他',
  picks: {} as Record<string, string[]>,
  notes: {} as Record<string, string>,
  avoidPicks: [] as string[],
  avoidNote: '',
});

const toggleFacetPick = (facet: PersonaFacet, optionId: string) => {
  const current = roleWizard.value.picks[facet.key] || [];
  if (current.includes(optionId)) {
    roleWizard.value.picks[facet.key] = current.filter((id) => id !== optionId);
    return;
  }
  if (facet.max === 1) {
    roleWizard.value.picks[facet.key] = [optionId];
    return;
  }
  const next = current.length >= facet.max ? [...current.slice(1), optionId] : [...current, optionId];
  roleWizard.value.picks[facet.key] = next;
};

const toggleAvoidPick = (optionId: string) => {
  const current = roleWizard.value.avoidPicks;
  roleWizard.value.avoidPicks = current.includes(optionId)
    ? current.filter((id) => id !== optionId)
    : [...current, optionId];
};

const facetOptionBrief = (facet: PersonaFacet, id: string) =>
  findPersonaOption(facet.options, id)?.brief || findPersonaOption(facet.options, id)?.label || id;

// 头像选择弹窗状态
const isAvatarModalVisible = ref(false);
const avatarModalTarget = ref<AgentConfig | null>(null);
const tempSelectedAvatar = ref('');
const isCropModalVisible = ref(false);
const cropSourceDataUrl = ref('');
const cropImageEl = ref<HTMLImageElement | null>(null);
let cropper: Cropper | null = null;
let cropInitTimer: number | null = null;
let cropInitDone = false;

const AVATAR_SIZE = 512;

const avatarPresets = [
  '/lingshu.png',
  '/lingyu.png',
  '/linger2.png',
  '/ziling.png',
];

function handleAvatarError(event: Event) {
  const img = event.target as HTMLImageElement;
  if (!img.src.endsWith('/lingshu.png')) {
    img.src = '/lingshu.png';
  }
}





function stripMarkdownText(text: string): string {
  if (!text) return '';

  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => {
    let cleaned = line.trim();
    cleaned = cleaned.replace(/^#{1,6}\s+/, '');
    cleaned = cleaned.replace(/^>\s?/, '');
    cleaned = cleaned.replace(/^[-*+]\s+/, '');
    cleaned = cleaned.replace(/^\d+\.\s+/, '');
    return cleaned;
  });

  let result = lines.join('\n');
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');
  result = result.replace(/`([^`]+)`/g, '$1');
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeRoleSetting(agent: AgentConfig): AgentConfig {
  const defaultSetting = agent.name === 'lingyu' ? DEFAULT_LINGYU_ROLE_SETTING : DEFAULT_ROLE_SETTING;
  return {
    ...agent,
    roleSetting: agent.roleSetting?.trim() || defaultSetting,
    selfEvolutionEnabled: agent.selfEvolutionEnabled !== false,
    timeMirrorEnabled: agent.timeMirrorEnabled !== false,
    proactiveEnabled: agent.proactiveEnabled !== false,
  };
}

function payloadForSave(agent: AgentConfig): AgentConfig {
  const cleanedRole = stripMarkdownText(agent.roleSetting || '');
  return {
    ...agent,
    roleSetting: cleanedRole || undefined,
  };
}

const handleEditAgent = (agent: AgentConfig) => {
  editingAgent.value = normalizeRoleSetting(agent);
  isEditing.value = true;
};

const resetRoleSetting = () => {
  if (editingAgent.value) {
    if (editingAgent.value.name === 'lingyu') {
      editingAgent.value.roleSetting = DEFAULT_LINGYU_ROLE_SETTING;
    } else {
      editingAgent.value.roleSetting = DEFAULT_ROLE_SETTING;
    }
  }
};

const openRoleWizard = () => {
  if (!editingAgent.value) return;
  roleWizard.value = {
    rawIdea: (editingAgent.value.roleSetting || '').trim(),
    companionTarget: '他',
    picks: {},
    notes: {},
    avoidPicks: [],
    avoidNote: '',
  };
  isRoleWizardVisible.value = true;
};

const openTransferModal = async (agent: AgentConfig) => {
  if (!agent.id) return;
  isCreatingTransfer.value = true;
  transferQrSvg.value = '';
  transferExpiresAt.value = null;
  try {
    const response = await fetch(getFullUrl(`/api/v1/agent-transfer/${agent.id}/session`), { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json() as { qrSvg?: string; expiresAt?: number };
    if (!payload.qrSvg) throw new Error('二维码生成失败');
    transferQrSvg.value = payload.qrSvg;
    transferExpiresAt.value = Number(payload.expiresAt || 0) || null;
    isTransferModalVisible.value = true;
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '迁移二维码生成失败');
  } finally {
    isCreatingTransfer.value = false;
  }
};

const buildRoleWizardDraft = () => {
  const answers = roleWizard.value;
  const facetBriefLine = (facet: PersonaFacet) => {
    const briefs = (answers.picks[facet.key] || []).map((id) => facetOptionBrief(facet, id));
    const note = (answers.notes[facet.key] || '').trim();
    const parts = [...briefs];
    if (note) parts.push(note);
    return parts.length ? parts.join('；') : '（用户未填写，请从其他答案推断）';
  };

  const avoidBriefs = answers.avoidPicks.map(
    (id) => findPersonaOption(PERSONA_AVOID_OPTIONS, id)?.brief
      || findPersonaOption(PERSONA_AVOID_OPTIONS, id)?.label
      || id,
  );
  const avoidNote = answers.avoidNote.trim();
  const avoidParts = [...avoidBriefs];
  if (avoidNote) avoidParts.push(avoidNote);

  const lines = [
    `已有想法：${answers.rawIdea.trim() || '（没有完整文本，请根据下面答案推断和补全）'}`,
    `被陪伴的人称呼：${answers.companionTarget}`,
    ...PERSONA_FACETS.map((facet) => `${facet.briefLabel}：${facetBriefLine(facet)}`),
    `用户不希望她像什么：${avoidParts.length ? avoidParts.join('；') : '（用户未填写）'}`,
  ];
  return [
    '这是一份「我是谁」生成 brief。用户多半不会写人设，除了「已有想法」外的答案大多是勾选的预设短语。请推断短语背后的关系需求和审美偏好，再完整化成稳定身份背景。不要逐项复述，不要只是拼装原句。',
    lines.join('\n'),
  ].join('\n\n');
};

const generateRoleSettingFromWizard = async () => {
  if (!editingAgent.value) return;
  const answers = roleWizard.value;
  const hasAnyAnswer = answers.rawIdea.trim().length > 0
    || Object.values(answers.picks).some((picked) => (picked || []).length > 0)
    || Object.values(answers.notes).some((note) => String(note || '').trim().length > 0)
    || answers.avoidPicks.length > 0
    || answers.avoidNote.trim().length > 0;
  if (!hasAnyAnswer) {
    Message.warning('选几个贴近的词，或先写一点想法，哪怕只是一句话也行');
    return;
  }
  const draft = buildRoleWizardDraft();
  isGeneratingRole.value = true;
  try {
    const result = await agentsStore.generateRoleSetting(
      draft,
      editingAgent.value.displayName || editingAgent.value.name,
    );
    const generated = String(result?.roleSetting || '').trim();
    if (!generated) throw new Error('生成结果为空');
    editingAgent.value.roleSetting = generated;
    const generatedStyle = String(result?.speakingStyle || '').trim();
    if (generatedStyle) editingAgent.value.speakingStyle = generatedStyle;
    isRoleWizardVisible.value = false;
    Message.success('已根据你的答案生成，可继续调整');
  } catch (e) {
    Message.error(e instanceof Error ? e.message : 'AI 生成失败');
  } finally {
    isGeneratingRole.value = false;
  }
};

const handleCreateAgent = async () => {
  const defaults = await agentsStore.getAgentDefaults();
  // 移除 id 以确保是新建流程，避免继承默认智能体的 ID 和关键属性
  const { id, name, displayName, isDefault, ...rest } = defaults || {};
  
  const { roleSetting, speakingStyle, innateSeeds, ...restWithoutRole } = rest;
  editingAgent.value = normalizeRoleSetting({
    name: `agent_${Date.now()}`,
    displayName: '新智能体',
    roleSetting: DEFAULT_ROLE_SETTING,
    isDefault: false,
    isActive: true,
    ...restWithoutRole,
  });
  isEditing.value = true;
};

const openAvatarModal = (agent: AgentConfig) => {
  avatarModalTarget.value = agent;
  tempSelectedAvatar.value = agent.avatar || '';
  isAvatarModalVisible.value = true;
};

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('图片读取失败'));
  });

const loadImageSize = (src: string): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = src;
  });

const destroyCropper = () => {
  if (cropInitTimer != null) {
    window.clearTimeout(cropInitTimer);
    cropInitTimer = null;
  }
  cropInitDone = false;
  if (!cropper) return;
  cropper.destroy();
  cropper = null;
};

const initCropper = async () => {
  await nextTick();
  if (!isCropModalVisible.value) return;
  const imageEl = cropImageEl.value;
  if (!imageEl) return;
  if (!imageEl.complete || imageEl.naturalWidth <= 0 || imageEl.naturalHeight <= 0) {
    console.warn('[avatar-crop] init skipped: image not ready', {
      complete: imageEl.complete,
      naturalWidth: imageEl.naturalWidth,
      naturalHeight: imageEl.naturalHeight,
    });
    return;
  }
  const rect = imageEl.getBoundingClientRect();
  console.info('[avatar-crop] init cropper', {
    complete: imageEl.complete,
    naturalWidth: imageEl.naturalWidth,
    naturalHeight: imageEl.naturalHeight,
    rectWidth: rect.width,
    rectHeight: rect.height,
    hasCropper: Boolean(cropper),
  });
  destroyCropper();
  cropper = new Cropper(imageEl, {
    aspectRatio: 1,
    viewMode: 1,
    dragMode: 'move',
    autoCropArea: 1,
    background: false,
    guides: false,
    center: false,
    highlight: false,
    movable: true,
    zoomable: true,
    scalable: false,
    rotatable: false,
    cropBoxMovable: false,
    cropBoxResizable: false,
    toggleDragModeOnDblclick: false,
    wheelZoomRatio: 0.1,
    ready() {
      if (!cropper) return;
      const container = cropper.getContainerData();
      cropper.setCropBoxData({
        left: 0,
        top: 0,
        width: container.width,
        height: container.height,
      });
      const imageData = cropper.getImageData();
      const coverRatio = Math.max(
        container.width / imageData.naturalWidth,
        container.height / imageData.naturalHeight,
      );

      // 首次打开按“覆盖模式”铺满裁剪框，避免出现四周空黑边。
      cropper.zoomTo(coverRatio);

      // 缩放后再把裁剪框贴合当前可视画布，避免出现内缩蓝框。
      const canvasData = cropper.getCanvasData();
      cropper.setCropBoxData({
        left: canvasData.left,
        top: canvasData.top,
        width: canvasData.width,
        height: canvasData.height,
      });
    },
  });
};

const scheduleCropperInit = (attempt = 0) => {
  if (!isCropModalVisible.value) return;
  if (cropInitDone) return;
  const imageEl = cropImageEl.value;
  if (!imageEl) return;

  const rect = imageEl.getBoundingClientRect();
  const ready =
    imageEl.complete
    && imageEl.naturalWidth > 0
    && imageEl.naturalHeight > 0
    && rect.width > 10
    && rect.height > 10;

  console.debug('[avatar-crop] schedule check', {
    attempt,
    complete: imageEl.complete,
    naturalWidth: imageEl.naturalWidth,
    naturalHeight: imageEl.naturalHeight,
    rectWidth: rect.width,
    rectHeight: rect.height,
    ready,
  });

  if (ready) {
    if (cropInitTimer != null) {
      window.clearTimeout(cropInitTimer);
      cropInitTimer = null;
    }
    cropInitDone = true;
    void initCropper();
    return;
  }

  if (attempt >= 20) return;
  cropInitTimer = window.setTimeout(() => {
    scheduleCropperInit(attempt + 1);
  }, 50);
};

const resetCropState = () => {
  destroyCropper();
  isCropModalVisible.value = false;
  cropSourceDataUrl.value = '';
};

const openCropModal = (dataUrl: string) => {
  cropSourceDataUrl.value = dataUrl;
  cropInitDone = false;
  isCropModalVisible.value = true;
};

const getCroppedAvatar = async (): Promise<string> => {
  if (!cropper) throw new Error('裁剪器未初始化');
  const canvas = cropper.getCroppedCanvas({
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    fillColor: '#ffffff',
  });
  if (!canvas) throw new Error('裁剪失败');
  return canvas.toDataURL('image/jpeg', 0.92);
};

const applyAvatar = async (avatar: string) => {
  tempSelectedAvatar.value = avatar;
  if (avatarModalTarget.value?.id) {
    await syncAvatarToBackend(avatarModalTarget.value.id, avatar);
  }
};

// 头像上传转Base64
const handleBase64Upload = async (fileList: any) => {
  // Arco Design 的 @change 返回的是文件列表
  const fileItem = fileList[fileList.length - 1];
  const file = fileItem.file as File | undefined;
  if (!file) return;
  
  const isImage = file.type.startsWith('image/');
  if (!isImage) {
    Message.error('只能上传图片文件');
    return;
  }
  
  const maxSize = 5 * 1024 * 1024; // 5MB
  if (file.size > maxSize) {
    Message.error('图片大小不能超过 5MB!');
    return;
  }

  try {
    const base64 = await readFileAsDataUrl(file);
    const { width, height } = await loadImageSize(base64);
    if (width > AVATAR_SIZE || height > AVATAR_SIZE) {
      openCropModal(base64);
      return;
    }
    await applyAvatar(base64);
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '头像上传失败');
  }
};

const selectPresetAvatar = async (url: string) => {
  await applyAvatar(url);
};

const confirmCropAvatar = async () => {
  try {
    const cropped = await getCroppedAvatar();
    await applyAvatar(cropped);
    resetCropState();
    Message.success('头像已裁剪为 512x512');
  } catch (e) {
    Message.error(e instanceof Error ? e.message : '裁剪失败');
  }
};

const syncAvatarToBackend = async (id: number, avatar: string) => {
  try {
    const agent = agentsStore.agents.find(a => a.id === id);
    if (agent) {
      const updated = { ...agent, avatar };
      await agentsStore.updateAgent(id, updated);
      if (editingAgent.value && editingAgent.value.id === id) {
        editingAgent.value.avatar = avatar;
      }
      await chatStore.loadConversations();
      Message.success('头像已同步更新');
    }
  } catch (e) {
    Message.error('头像同步失败');
  }
};

const confirmAvatarSelection = () => {
  if (avatarModalTarget.value) {
    avatarModalTarget.value.avatar = tempSelectedAvatar.value;
  }
  isAvatarModalVisible.value = false;
};

const handleSaveAgent = async () => {
  if (!editingAgent.value) return;
  
  if (!editingAgent.value.avatar) {
    editingAgent.value.avatar = '/lingshu.png';
  }
  
  const payload = payloadForSave(editingAgent.value);
  editingAgent.value.roleSetting = payload.roleSetting ?? '';
  editingAgent.value.speakingStyle = payload.speakingStyle ?? '';
  if (editingAgent.value.id) {
    await agentsStore.updateAgent(editingAgent.value.id, payload);
  } else {
    await agentsStore.createAgent(payload);
  }
  await chatStore.loadConversations();
  isEditing.value = false;
  editingAgent.value = null;
};

const handleCancelEdit = () => {
  isEditing.value = false;
  editingAgent.value = null;
};

onMounted(async () => {
  await agentsStore.fetchAgents();
});

watch(isCropModalVisible, (visible) => {
  if (!visible) {
    destroyCropper();
    return;
  }
  void nextTick(() => {
    scheduleCropperInit(0);
  });
});

onBeforeUnmount(() => {
  destroyCropper();
});
</script>

<template>
  <div class="agent-manager">
    <div v-if="!isEditing" class="agent-list-view">
      <div class="section-header">
        <h3 class="section-title">智能体列表</h3>
        <a-button type="primary" size="small" @click="handleCreateAgent">新增智能体</a-button>
      </div>
          
      <div class="agent-list">
        <div v-for="agent in agentsStore.agents" :key="agent.id" class="agent-card">
          <div class="agent-info">
            <a-avatar 
              :size="40" 
              class="clickable-avatar agent-square-avatar"
              :style="{ backgroundColor: agent.color || 'var(--primary-color)' }"
              @click="openAvatarModal(agent)"
            >
              <img :src="agent.avatar || '/lingshu.png'" :alt="agent.displayName" @error="handleAvatarError" />
              <div class="avatar-hover-mask"><IconPlus /></div>
            </a-avatar>
            <div class="agent-meta">
              <div class="agent-name">
                {{ agent.displayName }}
              </div>
              <div class="agent-id">ID: {{ agent.name }}</div>
            </div>
          </div>
          <div class="agent-actions">
            <a-button type="text" size="small" @click="openImportModal(agent)">导入</a-button>
            <a-button type="text" size="small" :loading="isCreatingTransfer" @click="openTransferModal(agent)">迁移</a-button>
            <a-button type="text" size="small" @click="handleEditAgent(agent)">编辑</a-button>
            <a-button type="text" status="danger" size="small" @click="async () => { await agentsStore.deleteAgent(agent.id!); await chatStore.loadConversations(); }">删除</a-button>
          </div>
        </div>
        <div v-if="agentsStore.agents.length === 0" class="empty-state">
          暂无智能体配置
        </div>
      </div>
    </div>

    <!-- 编辑界面 -->
    <div v-else class="agent-edit-form">
      <div class="section-header">
        <h3 class="section-title">{{ editingAgent?.id ? '编辑智能体' : '新增智能体' }}</h3>
        <div class="header-actions">
          <a-button size="small" @click="handleCancelEdit">取消</a-button>
          <a-button type="primary" size="small" @click="handleSaveAgent">保存</a-button>
        </div>
      </div>

      <a-form :model="editingAgent || {}" layout="vertical">
        <!-- 基础配置卡片 -->
        <div class="agent-edit-card">
          <div class="card-section-title">基础配置</div>
          
          <div class="form-row" style="align-items: center; margin-bottom: 20px; gap: 24px;">
            <div class="avatar-uploader" @click="openAvatarModal(editingAgent!)" style="margin-right: 0;">
              <a-avatar :size="64" class="agent-square-avatar" :style="{ backgroundColor: editingAgent!.color || 'var(--primary-color)' }">
                <img :src="editingAgent?.avatar || '/lingshu.png'" :alt="editingAgent?.displayName || '智能体'" @error="handleAvatarError" />
                <div class="avatar-hover-mask"><IconPlus /></div>
              </a-avatar>
              <div class="upload-tip">点击修改头像</div>
            </div>

            <div style="flex: 1; display: flex; flex-direction: column; gap: 16px;">
              <a-form-item label="显示名称" required style="margin-bottom: 0;">
                <a-input v-model="editingAgent!.displayName" placeholder="例如：生活助手" />
              </a-form-item>

              <div class="status-pill">
                <span class="status-pill-label">启用智能体</span>
                <a-switch v-model="editingAgent!.isActive" size="small" />
              </div>
            </div>
          </div>

          <div class="form-row" style="margin-bottom: 20px;">
            <a-form-item label="TTS 音色" style="margin-bottom: 0; flex: 1;">
              <a-input
                v-model="editingAgent!.voice"
                placeholder="留空则使用默认音色"
              />
            </a-form-item>
          </div>

          <div class="form-row advanced-toggle-row" style="width: 100%;">
            <a-form-item label="高级功能" style="margin-bottom: 0; flex: 1; width: 100%;">
              <div class="toggle-row">
                <div class="toggle-setting-card">
                  <a-switch v-model="editingAgent!.selfEvolutionEnabled" />
                  <div class="toggle-copy">
                    <div class="toggle-title">自我演化</div>
                    <div class="toggle-desc">开启后段末会写入/强化人格种子；关闭后仍可在对话里唤醒已有种子。</div>
                  </div>
                </div>
                <div class="toggle-setting-card">
                  <a-switch v-model="editingAgent!.timeMirrorEnabled" />
                  <div class="toggle-copy">
                    <div class="toggle-title">时光回溯</div>
                    <div class="toggle-desc">开启后生成时间画像、用户画像与回望弧；关闭后不再调用见证侧 LLM。</div>
                  </div>
                </div>
                <div class="toggle-setting-card">
                  <a-switch v-model="editingAgent!.proactiveEnabled" />
                  <div class="toggle-copy">
                    <div class="toggle-title">主动问候</div>
                    <div class="toggle-desc">开启后会在合适的时候惦记你、主动发消息；约定到点提醒不受此开关影响。</div>
                  </div>
                </div>
              </div>
            </a-form-item>
          </div>
        </div>

        <!-- 人格配置 -->
        <div class="agent-edit-card">
          <div class="card-section-title">我是谁</div>
          <p class="innate-seeds-lead">写她是什么样的存在、为什么留下来、想怎样长期陪着这个人。拿不准可以留空点「AI 生成」，再按自己的感觉改。</p>
          <a-textarea
            v-if="editingAgent"
            v-model="editingAgent.roleSetting"
            placeholder="例如：我是一个会在长期相处里慢慢认识他的陪伴者……"
            :auto-size="{ minRows: 5, maxRows: 12 }"
          />
          <a-form-item label="表达方式" class="speaking-style-field">
            <a-textarea
              v-if="editingAgent"
              v-model="editingAgent.speakingStyle"
              placeholder="她说话的语气和节奏，例如：简短自然，少用书面语；留空则使用默认表达方式"
              :auto-size="{ minRows: 2, maxRows: 4 }"
            />
          </a-form-item>
          <div class="innate-seeds-edit-actions">
            <a-button
              type="outline"
              size="small"
              :loading="isGeneratingRole"
              @click="openRoleWizard"
            >
              AI 生成
            </a-button>
            <a-button type="text" size="small" @click="resetRoleSetting">
              <template #icon><IconRefresh /></template>
              恢复默认
            </a-button>
          </div>
        </div>
      </a-form>
    </div>

    <a-modal
      v-model:visible="isRoleWizardVisible"
      title="生成「我是谁」"
      width="720px"
      :footer="false"
    >
      <div class="role-wizard">
        <p class="role-wizard-lead">不会写也没关系——选几个贴近的词，剩下的交给 AI。每一项都可以跳过。</p>
        <a-form :model="roleWizard" layout="vertical">
          <a-form-item label="你已经想到的部分">
            <a-textarea
              v-model="roleWizard.rawIdea"
              placeholder="可以很乱，比如：她不是客服，更像一个会慢慢认识我的长期陪伴者……"
              :auto-size="{ minRows: 3, maxRows: 6 }"
            />
          </a-form-item>

          <a-form-item label="被陪伴的人怎么称呼">
            <a-radio-group v-model="roleWizard.companionTarget" type="button">
              <a-radio value="他">他</a-radio>
              <a-radio value="她">她</a-radio>
              <a-radio value="ta">ta</a-radio>
            </a-radio-group>
          </a-form-item>

          <a-form-item v-for="facet in PERSONA_FACETS" :key="facet.key">
            <template #label>
              <span class="facet-label">{{ facet.label }}</span>
              <span class="facet-hint">{{ facet.hint }}</span>
            </template>
            <div class="facet-chips">
              <button
                v-for="option in facet.options"
                :key="option.id"
                type="button"
                class="facet-chip"
                :class="{ selected: (roleWizard.picks[facet.key] || []).includes(option.id) }"
                @click="toggleFacetPick(facet, option.id)"
              >
                {{ option.label }}
              </button>
            </div>
            <a-input
              v-model="roleWizard.notes[facet.key]"
              class="facet-note"
              placeholder="想自己补一句也行（可不填）"
              allow-clear
            />
          </a-form-item>

          <a-form-item>
            <template #label>
              <span class="facet-label">你不希望她像什么</span>
              <span class="facet-hint">可多选</span>
            </template>
            <div class="facet-chips">
              <button
                v-for="option in PERSONA_AVOID_OPTIONS"
                :key="option.id"
                type="button"
                class="facet-chip avoid"
                :class="{ selected: roleWizard.avoidPicks.includes(option.id) }"
                @click="toggleAvoidPick(option.id)"
              >
                {{ option.label }}
              </button>
            </div>
            <a-input
              v-model="roleWizard.avoidNote"
              class="facet-note"
              placeholder="想自己补一句也行（可不填）"
              allow-clear
            />
          </a-form-item>
        </a-form>
        <div class="role-wizard-actions">
          <a-button :disabled="isGeneratingRole" @click="isRoleWizardVisible = false">取消</a-button>
          <a-button type="primary" :loading="isGeneratingRole" @click="generateRoleSettingFromWizard">生成</a-button>
        </div>
      </div>
    </a-modal>

    <a-modal
      v-model:visible="isTransferModalVisible"
      title="迁移到灵枢 App Local"
      :footer="false"
      width="420px"
      @close="transferQrSvg = ''"
    >
      <div class="transfer-modal">
        <p>请在 App Local 的「数据与安全」中选择“从灵枢 PC 导入智能体”，再扫描此二维码。</p>
        <div v-if="transferQrSvg" class="transfer-qr" v-html="transferQrSvg" />
        <p class="transfer-hint">会迁移该智能体的聊天、记忆、事实图、约定和画像；二维码仅能使用一次。</p>
        <p v-if="transferExpiresAt" class="transfer-expiry">有效至 {{ new Date(transferExpiresAt * 1000).toLocaleTimeString() }}</p>
      </div>
    </a-modal>

    <!-- 头像选择弹窗 -->
    <a-modal
      v-model:visible="isAvatarModalVisible"
      title="选择智能体头像"
      @ok="confirmAvatarSelection"
      width="400px"
    >
      <div class="avatar-selector-grid">
        <div 
          v-for="url in avatarPresets" 
          :key="url" 
          class="preset-item"
          :class="{ selected: tempSelectedAvatar === url }"
          @click="selectPresetAvatar(url)"
        >
          <img :src="url" />
          <div v-if="tempSelectedAvatar === url" class="selected-badge">
            <IconCheck />
          </div>
        </div>
        
        <!-- 上传选项 -->
        <a-upload
          action="/"
          :auto-upload="false"
          :show-file-list="false"
          @change="handleBase64Upload"
          accept="image/*"
        >
          <template #upload-button>
            <div
              class="preset-item upload-box"
              :class="{
                selected: tempSelectedAvatar.startsWith('data:image'),
                'upload-box--has-image': tempSelectedAvatar.startsWith('data:image'),
              }"
            >
              <img v-if="tempSelectedAvatar.startsWith('data:image')" :src="tempSelectedAvatar" />
              <IconUpload v-else style="font-size: 24px;" />
              <div v-if="!tempSelectedAvatar.startsWith('data:image')" class="upload-text">点击上传</div>
            </div>
          </template>
        </a-upload>
      </div>
    </a-modal>

    <a-modal
      v-model:visible="isCropModalVisible"
      title="裁剪头像（512 × 512）"
      width="460px"
      @ok="confirmCropAvatar"
      @cancel="resetCropState"
      ok-text="应用裁剪"
    >
      <div class="crop-panel">
        <div class="crop-preview-shell">
          <div class="crop-preview">
            <img
              ref="cropImageEl"
              class="cropper-source-image"
              :src="cropSourceDataUrl"
            />
          </div>
        </div>
        <div class="crop-hint">在裁剪框内拖动调整位置，滚轮缩放，确认后输出 512 × 512 PNG。</div>
      </div>
    </a-modal>

    <!-- 聊天记录导入弹窗 -->
    <a-modal
      v-model:visible="isImportModalVisible"
      title="聊天记录导入"
      :footer="false"
      width="780px"
      unmount-on-close
    >
      <ChatHistoryImport :initial-agent-id="importTargetAgentId" />
    </a-modal>
  </div>
</template>

<style scoped>
.agent-manager {
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

.agent-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.agent-card {
  background-color: var(--bg-input);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 1px solid var(--border-color);
  transition: all 0.2s;
}

.agent-card:hover {
  border-color: var(--primary-color);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.agent-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

.clickable-avatar {
  cursor: pointer;
  position: relative;
}

.agent-square-avatar {
  border-radius: 10px;
  overflow: hidden;
}

.agent-square-avatar:deep(.arco-avatar) {
  border-radius: 10px !important;
  overflow: hidden;
}

.agent-square-avatar:deep(.arco-avatar-image),
.agent-square-avatar:deep(.arco-avatar-text),
.agent-square-avatar:deep(.arco-avatar > img),
.agent-square-avatar:deep(.arco-avatar img),
.agent-square-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 10px !important;
}

.avatar-hover-mask {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s;
  color: white;
  border-radius: 10px;
}

.clickable-avatar:hover .avatar-hover-mask,
.avatar-uploader:hover .avatar-hover-mask {
  opacity: 1;
}

.agent-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agent-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-id {
  font-size: 12px;
  color: var(--text-tertiary);
}

.agent-innate-preview {
  margin: 8px 0 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.agent-innate-preview li {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.agent-actions {
  display: flex;
  gap: 8px;
}

.agent-edit-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.form-row {
  display: flex;
  gap: 16px;
}

.form-row > * {
  flex: 1;
}

.status-pill {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-sidebar, rgba(0, 0, 0, 0.08));
  border: 1px solid var(--border-color);
  padding: 6px 14px;
  border-radius: 8px;
  width: max-content;
}

.status-pill-label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}

.advanced-toggle-row {
  margin-top: 18px;
}

.toggle-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  width: 100%;
}

.toggle-setting-card {
  flex: 1;
  min-width: 250px;
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 12px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 14px;
  transition: all 0.2s ease;
}

.toggle-setting-card:hover {
  border-color: var(--color-primary-light-3, var(--primary-color));
  background: transparent;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.toggle-setting-card :deep(.arco-switch) {
  margin-top: 0;
}

.toggle-copy {
  min-width: 0;
}

.toggle-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--text-primary);
}

.toggle-desc {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.avatar-uploader {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  margin-right: 16px;
}

.avatar-uploader:hover .upload-tip {
  color: var(--primary-color);
}

.upload-tip {
  font-size: 12px;
  color: var(--text-tertiary);
  transition: color 0.2s;
}

.empty-state {
  padding: 40px;
  text-align: center;
  color: var(--text-tertiary);
  background-color: var(--bg-input);
  border-radius: 12px;
  border: 1px dashed var(--border-color);
}

/* Modal Grid */
.avatar-selector-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  max-height: 400px;
  overflow-y: auto;
  padding: 8px;
}

.preset-item {
  position: relative;
  aspect-ratio: 1;
  border-radius: 12px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.2s;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background-color: var(--bg-sidebar);
}

.preset-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preset-item:hover {
  border-color: var(--color-primary-light-3);
  transform: scale(1.05);
}

.preset-item.selected {
  border-color: var(--primary-color);
  background-color: var(--color-primary-light-1);
}

.selected-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  background: var(--primary-color);
  color: white;
  border-radius: 50%;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
}

.upload-box {
  border: 2px dashed var(--border-color);
  color: var(--text-tertiary);
}

.upload-box--has-image {
  display: block;
}

.upload-text {
  font-size: 12px;
  margin-top: 4px;
}

.crop-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.crop-preview-shell {
  display: flex;
  justify-content: center;
  padding: 8px;
}

.crop-preview {
  width: 240px;
  height: 240px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  position: relative;
}

.cropper-source-image {
  display: block;
  max-width: 100%;
  user-select: none;
}

.crop-hint {
  font-size: 12px;
  color: var(--text-tertiary);
}

.v3-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
}

.v3-inner-collapse {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.v3-collapse-block {
  background-color: var(--bg-sidebar, rgba(0, 0, 0, 0.15));
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  transition: all 0.2s ease;
}

.v3-collapse-block:hover {
  border-color: var(--color-primary-light-3, var(--primary-color));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.v3-collapse-block--open {
  border-color: var(--primary-color);
}

.v3-collapse-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 20px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: inherit;
  box-sizing: border-box;
}

.v3-collapse-trigger:hover {
  background: rgba(255, 255, 255, 0.02);
}

.v3-collapse-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.title-text {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
}

.title-extra {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: normal;
}

.v3-collapse-action {
  font-size: 14px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  transition: all 0.2s;
}

.v3-collapse-trigger:hover .v3-collapse-action {
  color: var(--primary-color);
  border-color: var(--primary-color);
}

.v3-collapse-body {
  padding: 0 20px 20px;
  box-sizing: border-box;
  border-top: 1px dashed var(--border-color);
  padding-top: 16px;
}

.v3-collapse-body :deep(.arco-form-item) {
  margin-bottom: 16px;
}

.v3-collapse-body :deep(.arco-form-item:last-child) {
  margin-bottom: 0;
}

.form-field-stack {
  width: 100%;
}

.advanced-field-hint {
  margin-top: 6px;
}

.advanced-field-hint--warn {
  color: var(--color-warning-light-4, #ffb400);
}

.advanced-warning {
  margin-bottom: 16px;
}

.v3-section-label {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
}

.field-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

/* 新智能体编辑卡片配置 */
.agent-edit-card {
  margin-bottom: 20px;
  padding: 20px 24px;
  border-radius: 12px;
  background: var(--bg-secondary, #FFFFFF);
  border: 1px solid var(--border-color, #E5E5E5);
  box-sizing: border-box;
}

.card-section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #1A1A1A);
  margin-bottom: 16px;
}

/* 美化卡片内部输入组件的背景与边框，确保与浅/深主题完美咬合 */
.agent-edit-card :deep(.arco-input-wrapper),
.agent-edit-card :deep(.arco-textarea) {
  background-color: var(--bg-input, #FFFFFF) !important;
  border: 1px solid var(--border-color, #E5E5E5) !important;
  border-radius: 6px !important;
  transition: all 0.2s ease;
}

.agent-edit-card :deep(.arco-input-wrapper:hover),
.agent-edit-card :deep(.arco-textarea:hover) {
  border-color: var(--color-primary-hover) !important;
}

.agent-edit-card :deep(.arco-input-wrapper-focus),
.agent-edit-card :deep(.arco-textarea-focus),
.agent-edit-card :deep(.arco-textarea:focus) {
  border-color: var(--color-primary) !important;
  box-shadow: 0 0 0 2px var(--slider-shadow-color) !important;
  background-color: var(--bg-input, #FFFFFF) !important;
}

.innate-seeds-lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary, #575757);
}

.innate-seeds-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.innate-seeds-list li {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-primary, #1A1A1A);
}

.innate-seeds-foot {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary, #999999);
}

.innate-seeds-edit-container {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.seed-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.seed-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 12px;
  background: var(--bg-sidebar, rgba(0, 0, 0, 0.08));
}

.seed-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.seed-name-input {
  flex: 1;
  max-width: 180px;
}

.seed-trigger-row {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.seed-trigger-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.innate-seeds-edit-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
}

.transfer-modal {
  text-align: center;
}

.transfer-modal > p {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.transfer-qr {
  width: 248px;
  margin: 18px auto;
  padding: 12px;
  border-radius: 12px;
  background: #fff;
}

.transfer-qr :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}

.transfer-hint,
.transfer-expiry {
  color: var(--text-tertiary) !important;
  font-size: 12px !important;
}

.role-wizard {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.role-wizard :deep(.arco-form-item) {
  margin-bottom: 14px;
}

.role-wizard :deep(.arco-form-item-label) {
  font-size: 13px;
  color: var(--text-secondary);
}

.role-wizard :deep(.arco-input-wrapper),
.role-wizard :deep(.arco-textarea) {
  background-color: var(--bg-input, #FFFFFF) !important;
  border: 1px solid var(--border-color, #E5E5E5) !important;
  border-radius: 6px !important;
}

.role-wizard-lead {
  margin: 0 0 4px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.facet-label {
  font-size: 13px;
  color: var(--text-secondary);
}

.facet-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.facet-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.facet-chip {
  padding: 4px 12px;
  font-size: 13px;
  line-height: 1.5;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background-color: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.facet-chip:hover {
  border-color: var(--color-primary-light-3);
  color: var(--primary-color);
}

.facet-chip.selected {
  border-color: var(--primary-color);
  background-color: rgba(var(--primary-color-rgb), 0.12);
  color: var(--primary-color);
}

.facet-chip.avoid.selected {
  border-color: rgba(248, 90, 90, 0.6);
  background-color: rgba(248, 90, 90, 0.12);
  color: #f56a6a;
}

.facet-note {
  margin-top: 8px;
}

.speaking-style-field {
  margin-top: 12px;
}

.role-wizard-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
  padding-top: 14px;
  border-top: 1px solid var(--border-color);
}
</style>
