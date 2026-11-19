import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import Message from '@arco-design/web-vue/es/message';
import { getFullUrl } from '../utils/apiConfig'
import { inferCosyvoiceModelFromVoice } from '../utils/cosyvoiceModel'
import {
  buildModelOptions,
  DEFAULT_VOLCENGINE_IMAGE_GEN_MODEL,
  getSavedModels,
  purgeVolcengineSavedModelCache,
  rememberSavedModel,
  sourceHasModelListApi,
  type ModelOption,
} from '../utils/modelSourceCache';
import {
  persistTtsProviderSnapshot,
  restoreTtsProviderSnapshot,
  syncAllTtsProvidersToCache,
  hydrateVolcengineCloneSpeakerIds,
  rememberVolcengineCloneSpeakerIds,
  type TtsProviderId,
} from '../utils/ttsProviderCache';
import {
  normalizeEffortWithLegacy,
  normalizeThinkingEffort,
  thinkingEffortIsActive,
  type ThinkingEffort,
} from '../utils/thinkingEffort';
import { normalizeContextBudgetK, type ContextBudgetK } from '../utils/contextBudget';

export interface ModelProvider {
  id: string
  name: string
  protocol: string
  baseUrl: string
  apiKey: string
  models: string[]
  enabledModels: string[]
  modelsConfigured?: boolean
  preset?: string
  createdAt?: string
  updatedAt?: string
}

export interface LlmConfig {
  providerId: string
  source: string
  model: string
  baseUrl: string
  apiKey: string
  reasoningEffort: ThinkingEffort
  temperature: number
  contextBudgetK: ContextBudgetK
}

export interface MemoryModelConfig {
  providerId: string
  source: string
  model: string
  baseUrl: string
  apiKey: string
  reasoningEffort: ThinkingEffort
  maxOutputTokens: number
}

export interface VisionModelConfig {
  providerId: string
  source: string
  model: string
  baseUrl: string
  apiKey: string
  reasoningEffort: ThinkingEffort
}

export interface ImageGenerationConfig {
  providerId: string
  source: string
  model: string
  baseUrl: string
  apiKey: string
  dailyLimit: number
  enableCooldown: boolean
  cooldownSeconds: number
  enableSoftIntercept: boolean
}

export interface TtsConfig {
  enabled: boolean
  autoRead: boolean
  activeProvider: 'openai_compat' | 'aliyun_cosyvoice' | 'volcengine' | 'xiaomo_mimo' | 'fish_audio'
  baseUrl: string
  apiKey: string
  model: string
  defaultVoice: string
  defaultSpeed: number
  defaultFormat: string
  defaultSeed: number
  defaultCfg: number
  defaultTimesteps: number
  aliyunWsUrl: string
  aliyunApiKey: string
  aliyunModel: string
  aliyunVoice: string
  aliyunFormat: string
  aliyunSampleRate: number
  aliyunRate: number
  aliyunPitch: number
  aliyunVolume: number
  aliyunInstruction: string
  volcengineWsUrl: string
  volcengineApiKey: string
  volcengineResourceId: string
  volcengineSpeakerId: string
  volcengineModel: string
  volcengineFormat: string
  volcengineSampleRate: number
  volcengineUseTagParser: boolean | null
  volcengineContextTexts: string
  volcengineAllowDirectorTags: boolean
  volcengineVoiceMode: string
  volcengineRefVoicePath: string
  volcengineCloneSpeakerSlot: string
  volcengineCloneReferenceText: string
  volcengineCloneLanguage: number
  volcengineCloneDemoText: string
  volcengineCloneEnableDenoise: boolean
  volcengineCloneDisableVolumeNorm: boolean
  volcengineCloneStatus: number
  volcengineCloneModelType: number
  volcengineTrainedSpeakerId: string
  // Xiaomi MiMo fields
  xiaomoMimoBaseUrl: string
  xiaomoMimoApiKey: string
  xiaomoMimoModel: string
  xiaomoMimoMode: string
  xiaomoMimoRefVoicePath: string
  xiaomoMimoPresetVoiceName: string
  xiaomoMimoDirectorPrompt: string
  xiaomoMimoDesignPrompt: string
  xiaomoMimoAllowDirectorTags: boolean
  xiaomoMimoEmotionMode: boolean
  fishAudioBaseUrl: string
  fishAudioApiKey: string
  fishAudioModel: string
  fishAudioReferenceId: string
  fishAudioFormat: string
  fishAudioLatency: string
  fishAudioEmotionMode: boolean
}

/** 语音合成（TTS）设置 → 后端 /api/settings 与 /api/tts/test 共用的字段映射。 */
export function buildTtsSettingsPayload(config: TtsConfig): Record<string, any> {
  return {
    ttsEnabled: config.enabled,
    ttsAutoRead: config.autoRead,
    ttsActiveProvider: config.activeProvider,
    ttsBaseUrl: config.baseUrl,
    ttsApiKey: config.apiKey,
    ttsModel: config.model,
    ttsDefaultVoice: config.defaultVoice,
    ttsDefaultSpeed: config.defaultSpeed,
    ttsDefaultFormat: config.defaultFormat,
    ttsDefaultSeed: config.defaultSeed,
    ttsDefaultCfg: config.defaultCfg,
    ttsDefaultTimesteps: config.defaultTimesteps,
    ttsOpenaiCompatBaseUrl: config.baseUrl,
    ttsOpenaiCompatApiKey: config.apiKey,
    ttsOpenaiCompatModel: config.model,
    ttsOpenaiCompatDefaultVoice: config.defaultVoice,
    ttsOpenaiCompatDefaultSpeed: config.defaultSpeed,
    ttsOpenaiCompatDefaultFormat: config.defaultFormat,
    ttsOpenaiCompatDefaultSeed: config.defaultSeed,
    ttsOpenaiCompatDefaultCfg: config.defaultCfg,
    ttsOpenaiCompatDefaultTimesteps: config.defaultTimesteps,
    ttsAliyunWsUrl: config.aliyunWsUrl,
    ttsAliyunApiKey: config.aliyunApiKey,
    ttsAliyunModel: config.aliyunModel,
    ttsAliyunVoice: config.aliyunVoice,
    ttsAliyunFormat: config.aliyunFormat,
    ttsAliyunSampleRate: config.aliyunSampleRate,
    ttsAliyunRate: config.aliyunRate,
    ttsAliyunPitch: config.aliyunPitch,
    ttsAliyunVolume: config.aliyunVolume,
    ttsAliyunInstruction: config.aliyunInstruction,
    ttsVolcengineWsUrl: config.volcengineWsUrl,
    ttsVolcengineApiKey: config.volcengineApiKey,
    ttsVolcengineResourceId: config.volcengineResourceId,
    ttsVolcengineSpeakerId: config.volcengineSpeakerId,
    ttsVolcengineModel: config.volcengineModel,
    ttsVolcengineFormat: config.volcengineFormat,
    ttsVolcengineSampleRate: config.volcengineSampleRate,
    ttsVolcengineUseTagParser: config.volcengineUseTagParser,
    ttsVolcengineContextTexts: config.volcengineContextTexts,
    ttsVolcengineAllowDirectorTags: config.volcengineAllowDirectorTags,
    ttsVolcengineVoiceMode: config.volcengineVoiceMode,
    ttsVolcengineRefVoicePath: config.volcengineRefVoicePath,
    ttsVolcengineCloneSpeakerSlot: config.volcengineCloneSpeakerSlot,
    ttsVolcengineCloneReferenceText: config.volcengineCloneReferenceText,
    ttsVolcengineCloneLanguage: config.volcengineCloneLanguage,
    ttsVolcengineCloneDemoText: config.volcengineCloneDemoText,
    ttsVolcengineCloneEnableDenoise: config.volcengineCloneEnableDenoise,
    ttsVolcengineCloneDisableVolumeNorm: config.volcengineCloneDisableVolumeNorm,
    ttsVolcengineCloneStatus: config.volcengineCloneStatus,
    ttsVolcengineCloneModelType: config.volcengineCloneModelType,
    ttsVolcengineTrainedSpeakerId: config.volcengineTrainedSpeakerId,
    ttsXiaomoMimoBaseUrl: config.xiaomoMimoBaseUrl,
    ttsXiaomoMimoApiKey: config.xiaomoMimoApiKey,
    ttsXiaomoMimoModel: config.xiaomoMimoModel,
    ttsXiaomoMimoMode: config.xiaomoMimoMode,
    ttsXiaomoMimoRefVoicePath: config.xiaomoMimoRefVoicePath,
    ttsXiaomoMimoPresetVoiceName: config.xiaomoMimoPresetVoiceName,
    ttsXiaomoMimoDirectorPrompt: config.xiaomoMimoDirectorPrompt,
    ttsXiaomoMimoDesignPrompt: config.xiaomoMimoDesignPrompt,
    ttsXiaomoMimoAllowDirectorTags: config.xiaomoMimoAllowDirectorTags,
    ttsXiaomoMimoEmotionMode: config.xiaomoMimoEmotionMode,
    ttsFishAudioBaseUrl: config.fishAudioBaseUrl,
    ttsFishAudioApiKey: config.fishAudioApiKey,
    ttsFishAudioModel: config.fishAudioModel,
    ttsFishAudioReferenceId: config.fishAudioReferenceId,
    ttsFishAudioFormat: config.fishAudioFormat,
    ttsFishAudioLatency: config.fishAudioLatency,
    ttsFishAudioEmotionMode: config.fishAudioEmotionMode,
  }
}

export interface AsrConfig {
  /** 识别方式：本地模型 / 小米 MiMo / 阿里云 / macOS 系统识别（仅 Mac） */
  provider: 'local' | 'xiaomi' | 'aliyun' | 'apple'
  language: 'auto' | 'zh' | 'en'
  xiaomi: {
    baseUrl: string
    apiKey: string
    model: string
    language: 'auto' | 'zh' | 'en'
  }
  aliyun: {
    httpBaseUrl: string
    wsUrl: string
    apiKey: string
    model: string
    language: 'auto' | 'zh' | 'en'
  }
}

/** 语音识别设置 → 后端 /api/settings 共用的字段映射。 */
export function buildAsrSettingsPayload(config: AsrConfig): Record<string, any> {
  return {
    asrProvider: config.provider,
    asrLanguage: config.language,
    asrXiaomiBaseUrl: config.xiaomi.baseUrl,
    asrXiaomiApiKey: config.xiaomi.apiKey,
    asrXiaomiModel: config.xiaomi.model,
    asrXiaomiLanguage: config.xiaomi.language,
    asrAliyunHttpBaseUrl: config.aliyun.httpBaseUrl,
    asrAliyunWsUrl: config.aliyun.wsUrl,
    asrAliyunApiKey: config.aliyun.apiKey,
    asrAliyunModel: config.aliyun.model,
    asrAliyunLanguage: config.aliyun.language,
  }
}

function normalizeAsrLanguage(
  value: unknown,
  fallback: 'auto' | 'zh' | 'en' = 'auto',
): 'auto' | 'zh' | 'en' {
  return value === 'zh' || value === 'en' || value === 'auto' ? value : fallback
}

export interface SecurityConfig {
  enforceGitRollback: boolean
  readRoots: string[]
  writeRoots: string[]
  trustedCommands: string[]
  fullAccessEnabled: boolean
}

function normalizeSecurityConfig(config: SecurityConfig): SecurityConfig {
  return {
    enforceGitRollback: !!config.enforceGitRollback,
    readRoots: Array.isArray(config.readRoots) ? config.readRoots.map((item) => String(item).trim()).filter(Boolean) : ['.'],
    writeRoots: Array.isArray(config.writeRoots) ? config.writeRoots.map((item) => String(item).trim()).filter(Boolean) : ['.'],
    trustedCommands: Array.isArray(config.trustedCommands) ? config.trustedCommands.map((item) => String(item).trim()).filter(Boolean) : ['python', 'pip', 'npm'],
    fullAccessEnabled: !!config.fullAccessEnabled
  }
}

function securityConfigSignature(config: SecurityConfig): string {
  return JSON.stringify(normalizeSecurityConfig(config))
}

export const useSettingsStore = defineStore('settings', () => {
  const modelProviders = ref<ModelProvider[]>([])

  const llm = ref<LlmConfig>({
    providerId: '',
    source: 'ollama',
    model: '',
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    reasoningEffort: 'default',
    temperature: 0.65,
    contextBudgetK: 128
  })

  const memoryModel = ref<MemoryModelConfig>({
    providerId: '',
    source: '',
    model: '',
    baseUrl: '',
    apiKey: '',
    reasoningEffort: 'default',
    maxOutputTokens: 131072
  })

  const visionModel = ref<VisionModelConfig>({
    providerId: '',
    source: '',
    model: '',
    baseUrl: '',
    apiKey: '',
    reasoningEffort: 'default'
  })

  const imageGeneration = ref<ImageGenerationConfig>({
    providerId: '',
    source: 'volcengine',
    model: DEFAULT_VOLCENGINE_IMAGE_GEN_MODEL,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: '',
    dailyLimit: 20,
    enableCooldown: true,
    cooldownSeconds: 180,
    enableSoftIntercept: true,
  })

  const tts = ref<TtsConfig>({
    enabled: false,
    autoRead: false,
    activeProvider: 'openai_compat',
    baseUrl: 'http://localhost:5050',
    apiKey: '',
    model: 'voxcpm-2',
    defaultVoice: 'alloy',
    defaultSpeed: 1.0,
    defaultFormat: 'mp3',
    defaultSeed: -1,
    defaultCfg: 1.0,
    defaultTimesteps: 10,
    aliyunWsUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    aliyunApiKey: '',
    aliyunModel: 'cosyvoice-v3-flash',
    aliyunVoice: 'longanyang',
    aliyunFormat: 'pcm',
    aliyunSampleRate: 22050,
    aliyunRate: 1.0,
    aliyunPitch: 1.0,
    aliyunVolume: 50,
    aliyunInstruction: '',
    volcengineWsUrl: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
    volcengineApiKey: '',
    volcengineResourceId: 'seed-icl-2.0',
    volcengineSpeakerId: '',
    volcengineModel: 'seed-tts-2.0-expressive',
    volcengineFormat: 'pcm',
    volcengineSampleRate: 24000,
    volcengineUseTagParser: null,
    volcengineContextTexts: '',
    volcengineAllowDirectorTags: false,
    volcengineVoiceMode: 'preset',
    volcengineRefVoicePath: '',
    volcengineCloneSpeakerSlot: '',
    volcengineCloneReferenceText: '',
    volcengineCloneLanguage: 0,
    volcengineCloneDemoText: '',
    volcengineCloneEnableDenoise: false,
    volcengineCloneDisableVolumeNorm: false,
    volcengineCloneStatus: -1,
    volcengineCloneModelType: 0,
    volcengineTrainedSpeakerId: '',
    // Xiaomi MiMo default values:
    xiaomoMimoBaseUrl: 'https://api.xiaomimimo.com/v1',
    xiaomoMimoApiKey: '',
    xiaomoMimoModel: 'mimo-v2.5-tts-voiceclone',
    xiaomoMimoMode: 'voice_clone',
    xiaomoMimoRefVoicePath: '',
    xiaomoMimoPresetVoiceName: '冰糖',
    xiaomoMimoDirectorPrompt: '',
    xiaomoMimoDesignPrompt: '',
    xiaomoMimoAllowDirectorTags: false,
    xiaomoMimoEmotionMode: true,
    fishAudioBaseUrl: 'https://api.fish.audio/v1', fishAudioApiKey: '', fishAudioModel: 's2.1-pro-free', fishAudioReferenceId: '', fishAudioFormat: 'pcm', fishAudioLatency: 'balanced', fishAudioEmotionMode: true
  })

  const asr = ref<AsrConfig>({
    provider: 'local',
    language: 'auto',
    xiaomi: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: '',
      model: 'mimo-v2.5-asr',
      language: 'zh',
    },
    aliyun: {
      httpBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      wsUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
      apiKey: '',
      model: 'qwen3-asr-flash-realtime',
      language: 'zh',
    },
  })

  const security = ref<SecurityConfig>({
    enforceGitRollback: true,
    readRoots: ['.'],
    writeRoots: ['.'],
    trustedCommands: ['python', 'pip', 'npm'],
    fullAccessEnabled: false
  })

  const isLoaded = ref(false)
  const volcengineCloneSpeakerHistoryVersion = ref(0)

  function syncVolcengineCloneSpeakerHistory() {
    rememberVolcengineCloneSpeakerIds(
      tts.value.volcengineSpeakerId,
      tts.value.volcengineCloneSpeakerSlot,
      tts.value.volcengineTrainedSpeakerId,
    )
    volcengineCloneSpeakerHistoryVersion.value += 1
  }
  const saving = ref(false)
  const generalSaving = ref(false)
  const securitySaving = ref(false)
  const securityLastSavedSignature = ref(securityConfigSignature(security.value))

  const chatModelOptions = ref<ModelOption[]>([])
  const memoryModelOptions = ref<ModelOption[]>([])
  const visionModelOptions = ref<ModelOption[]>([])
  const loadingChatModels = ref(false)
  const loadingMemoryModels = ref(false)
  const loadingVisionModels = ref(false)

  type ProviderKind = 'chat' | 'memory' | 'vision' | 'image'

  function providerIdFor(kind: ProviderKind): string {
    if (kind === 'memory') return memoryModel.value.providerId || llm.value.providerId
    if (kind === 'vision') return visionModel.value.providerId || llm.value.providerId
    if (kind === 'image') return imageGeneration.value.providerId
    return llm.value.providerId
  }

  function effectiveMemorySource(): string {
    const provider = providerFor('memory')
    return (provider?.protocol || memoryModel.value.source || llm.value.source || '').trim().toLowerCase()
  }

  function effectiveVisionSource(): string {
    const provider = providerFor('vision')
    return (provider?.protocol || visionModel.value.source || llm.value.source || '').trim().toLowerCase()
  }

  function providerFor(kind: ProviderKind): ModelProvider | null {
    const id = providerIdFor(kind)
    if (!id) return null
    return modelProviders.value.find((provider) => provider.id === id) || null
  }

  function syncProviderConnection(kind: ProviderKind) {
    const provider = providerFor(kind)
    if (kind === 'chat') {
      if (provider) {
        llm.value.source = provider.protocol
        llm.value.baseUrl = provider.baseUrl
        llm.value.apiKey = provider.apiKey
      }
      return
    }
    if (kind === 'memory') {
      memoryModel.value.source = provider?.protocol || ''
      memoryModel.value.baseUrl = provider?.baseUrl || ''
      memoryModel.value.apiKey = provider?.apiKey || ''
      return
    }
    if (kind === 'vision') {
      visionModel.value.source = provider?.protocol || ''
      visionModel.value.baseUrl = provider?.baseUrl || ''
      visionModel.value.apiKey = provider?.apiKey || ''
      return
    }
    if (kind === 'image') {
      if (!provider) return
      imageGeneration.value.source = provider.protocol
      imageGeneration.value.baseUrl = provider.baseUrl
      imageGeneration.value.apiKey = provider.apiKey
    }
  }

  function refreshChatModelOptions() {
    const provider = providerFor('chat')
    chatModelOptions.value = buildModelOptions(provider?.enabledModels || [], llm.value.model)
  }

  function refreshMemoryModelOptions() {
    const provider = providerFor('memory')
    memoryModelOptions.value = buildModelOptions(provider?.enabledModels || [], memoryModel.value.model)
  }

  function refreshVisionModelOptions() {
    const provider = providerFor('vision')
    visionModelOptions.value = buildModelOptions(provider?.enabledModels || [], visionModel.value.model)
  }

  function refreshAllModelOptions() {
    refreshChatModelOptions()
    refreshMemoryModelOptions()
    refreshVisionModelOptions()
  }

  function syncSavedModelHistory() {
    const chatProvider = providerFor('chat')
    if (chatProvider && llm.value.model) {
      rememberSavedModel(chatProvider.protocol, 'chat', llm.value.model)
    }
    const memoryProvider = providerFor('memory')
    if (memoryProvider && memoryModel.value.model) {
      rememberSavedModel(memoryProvider.protocol, 'memory', memoryModel.value.model)
    }
    const visionProvider = providerFor('vision')
    if (visionProvider && visionModel.value.model) {
      rememberSavedModel(visionProvider.protocol, 'vision', visionModel.value.model)
    }
  }

  // 没有密钥的服务商调不通模型，放进选择器只会让人选了才发现失败；
  // 管理页（providerFor / modelProviders）仍然拿全量列表，方便去补配置。
  const providerOptions = computed(() =>
    modelProviders.value
      .filter((provider) => String(provider.apiKey || '').trim().length > 0)
      .map((provider) => ({ value: provider.id, label: provider.name })),
  )

  async function fetchModelProviders() {
    const res = await fetch(getFullUrl('/api/settings/providers'))
    if (!res.ok) throw new Error('Failed to fetch model providers')
    modelProviders.value = await res.json()
    refreshAllModelOptions()
    return modelProviders.value
  }

  async function saveModelProvider(provider: ModelProvider) {
    const res = await fetch(
      getFullUrl(provider.id ? `/api/settings/providers/${encodeURIComponent(provider.id)}` : '/api/settings/providers'),
      {
        method: provider.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(provider),
      },
    )
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(String(data?.detail || '保存服务商失败'))
    }
    await fetchModelProviders()
    return await res.json()
  }

  async function deleteModelProvider(id: string) {
    const res = await fetch(getFullUrl(`/api/settings/providers/${encodeURIComponent(id)}`), {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error('删除服务商失败')
    if (llm.value.providerId === id) llm.value.providerId = ''
    if (memoryModel.value.providerId === id) memoryModel.value.providerId = ''
    if (visionModel.value.providerId === id) visionModel.value.providerId = ''
    if (imageGeneration.value.providerId === id) imageGeneration.value.providerId = ''
    await fetchModelProviders()
  }

  async function refreshModelProviderModels(id: string) {
    const res = await fetch(
      getFullUrl(`/api/settings/providers/${encodeURIComponent(id)}/models/refresh`),
      { method: 'POST' },
    )
    if (!res.ok) throw new Error('拉取模型列表失败')
    await fetchModelProviders()
    return await res.json()
  }

  async function saveModelProviderModels(id: string, enabledModels: string[], models?: string[]) {
    const res = await fetch(
      getFullUrl(`/api/settings/providers/${encodeURIComponent(id)}/models`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledModels, models }),
      },
    )
    if (!res.ok) throw new Error('保存模型列表失败')
    await fetchModelProviders()
    return await res.json()
  }

  function syncAliyunModelWithVoice() {
    const inferred = inferCosyvoiceModelFromVoice(tts.value.aliyunVoice, tts.value.aliyunModel)
    if (inferred !== tts.value.aliyunModel) {
      tts.value.aliyunModel = inferred
    }
  }

  function switchTtsProvider(next: TtsProviderId) {
    const prev = tts.value.activeProvider
    if (prev === next) return
    // Persist all current states to cache first to keep any unsaved input edits
    persistTtsProviderSnapshot('openai_compat', tts.value)
    persistTtsProviderSnapshot('aliyun_cosyvoice', tts.value)
    persistTtsProviderSnapshot('volcengine', tts.value)
    persistTtsProviderSnapshot('xiaomo_mimo', tts.value)
    
    tts.value.activeProvider = next
    restoreTtsProviderSnapshot(next, tts.value)
    if (next === 'aliyun_cosyvoice') {
      syncAliyunModelWithVoice()
    }
  }

  async function fetchSettings() {
    try {
      purgeVolcengineSavedModelCache()
      const res = await fetch(getFullUrl('/api/settings'))
      if (!res.ok) throw new Error('Failed to fetch settings')
      const data = await res.json()

      modelProviders.value = Array.isArray(data.modelProviders) ? data.modelProviders : []

      llm.value = {
        providerId: data.chatProviderId || '',
        source: data.source || 'ollama',
        model: data.chatModel || '',
        baseUrl: data.baseUrl || 'http://localhost:11434',
        apiKey: data.apiKey || '',
        reasoningEffort: normalizeEffortWithLegacy(data.chatReasoningEffort, data.enableThinking),
        temperature: data.chatTemperature ?? 0.65,
        contextBudgetK: normalizeContextBudgetK(data.chatContextBudgetK)
      }

      memoryModel.value = {
        providerId: data.memoryProviderId || '',
        source: data.memoryModelSource || '',
        model: data.memoryModel || '',
        baseUrl: data.memoryModelBaseUrl || '',
        apiKey: data.memoryModelApiKey || '',
        reasoningEffort: normalizeThinkingEffort(data.memoryReasoningEffort),
        maxOutputTokens: data.memoryModelMaxOutputTokens ?? 131072
      }

      visionModel.value = {
        providerId: data.visionProviderId || '',
        source: data.visionModelSource || '',
        model: data.visionModel || '',
        baseUrl: data.visionModelBaseUrl || '',
        apiKey: data.visionModelApiKey || '',
        reasoningEffort: normalizeEffortWithLegacy(data.visionModelReasoningEffort, data.visionModelEnableThinking),
      }

      const dailyLimitRaw = Number(data.imageGenDailyLimit ?? 20)
      const cooldownSecondsRaw = Number(data.imageGenCooldownSeconds ?? 180)
      imageGeneration.value = {
        providerId: data.imageGenProviderId || '',
        source: data.imageGenSource || 'volcengine',
        model: data.imageGenModel || DEFAULT_VOLCENGINE_IMAGE_GEN_MODEL,
        baseUrl: data.imageGenBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: data.imageGenApiKey || '',
        dailyLimit: Number.isFinite(dailyLimitRaw)
          ? Math.max(0, Math.min(Math.round(dailyLimitRaw), 10000))
          : 20,
        enableCooldown: data.imageGenEnableCooldown !== undefined ? Boolean(data.imageGenEnableCooldown) : true,
        cooldownSeconds: Number.isFinite(cooldownSecondsRaw)
          ? Math.max(0, Math.min(Math.round(cooldownSecondsRaw), 86400))
          : 180,
        enableSoftIntercept: data.imageGenEnableSoftIntercept !== undefined ? Boolean(data.imageGenEnableSoftIntercept) : true,
      }

      tts.value = {
        enabled: data.ttsEnabled ?? false,
        autoRead: (data.ttsEnabled ?? false) ? (data.ttsAutoRead ?? false) : false,
        activeProvider: (data.ttsActiveProvider || 'openai_compat') as TtsConfig['activeProvider'],
        baseUrl: data.ttsOpenaiCompatBaseUrl || data.ttsBaseUrl || 'http://localhost:5050',
        apiKey: data.ttsOpenaiCompatApiKey || data.ttsApiKey || '',
        model: data.ttsOpenaiCompatModel || data.ttsModel || 'voxcpm-2',
        defaultVoice: data.ttsOpenaiCompatDefaultVoice || data.ttsDefaultVoice || 'alloy',
        defaultSpeed: data.ttsOpenaiCompatDefaultSpeed ?? data.ttsDefaultSpeed ?? 1.0,
        defaultFormat: data.ttsOpenaiCompatDefaultFormat || data.ttsDefaultFormat || 'mp3',
        defaultSeed: data.ttsOpenaiCompatDefaultSeed ?? data.ttsDefaultSeed ?? -1,
        defaultCfg: data.ttsOpenaiCompatDefaultCfg ?? data.ttsDefaultCfg ?? 1.0,
        defaultTimesteps: data.ttsOpenaiCompatDefaultTimesteps ?? data.ttsDefaultTimesteps ?? 10,
        aliyunWsUrl: data.ttsAliyunWsUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
        aliyunApiKey: data.ttsAliyunApiKey || '',
        aliyunModel: data.ttsAliyunModel || 'cosyvoice-v3-flash',
        aliyunVoice: data.ttsAliyunVoice || 'longanyang',
        aliyunFormat: 'pcm',
        aliyunSampleRate: data.ttsAliyunSampleRate ?? 22050,
        aliyunRate: data.ttsAliyunRate ?? 1.0,
        aliyunPitch: data.ttsAliyunPitch ?? 1.0,
        aliyunVolume: data.ttsAliyunVolume ?? 50,
        aliyunInstruction: data.ttsAliyunInstruction || '',
        volcengineWsUrl: data.ttsVolcengineWsUrl || 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
        volcengineApiKey: data.ttsVolcengineApiKey || '',
        volcengineResourceId: data.ttsVolcengineResourceId || 'seed-icl-2.0',
        volcengineSpeakerId: data.ttsVolcengineSpeakerId || '',
        volcengineModel: data.ttsVolcengineModel || 'seed-tts-2.0-expressive',
        volcengineFormat: 'pcm',
        volcengineSampleRate: data.ttsVolcengineSampleRate ?? 24000,
        volcengineUseTagParser: data.ttsVolcengineUseTagParser ?? null,
        volcengineContextTexts: data.ttsVolcengineContextTexts || '',
        volcengineAllowDirectorTags: data.ttsVolcengineAllowDirectorTags ?? false,
        volcengineVoiceMode: data.ttsVolcengineVoiceMode || 'preset',
        volcengineRefVoicePath: data.ttsVolcengineRefVoicePath || '',
        volcengineCloneSpeakerSlot: data.ttsVolcengineCloneSpeakerSlot || '',
        volcengineCloneReferenceText: data.ttsVolcengineCloneReferenceText || '',
        volcengineCloneLanguage: data.ttsVolcengineCloneLanguage ?? 0,
        volcengineCloneDemoText: data.ttsVolcengineCloneDemoText || '',
        volcengineCloneEnableDenoise: data.ttsVolcengineCloneEnableDenoise ?? false,
        volcengineCloneDisableVolumeNorm: data.ttsVolcengineCloneDisableVolumeNorm ?? false,
        volcengineCloneStatus: data.ttsVolcengineCloneStatus ?? -1,
        volcengineCloneModelType: data.ttsVolcengineCloneModelType ?? 0,
        volcengineTrainedSpeakerId: data.ttsVolcengineTrainedSpeakerId || '',
        xiaomoMimoBaseUrl: data.ttsXiaomoMimoBaseUrl || 'https://api.xiaomimimo.com/v1',
        xiaomoMimoApiKey: data.ttsXiaomoMimoApiKey || '',
        xiaomoMimoModel: data.ttsXiaomoMimoModel || 'mimo-v2.5-tts-voiceclone',
        xiaomoMimoMode: data.ttsXiaomoMimoMode || 'voice_clone',
        xiaomoMimoRefVoicePath: data.ttsXiaomoMimoRefVoicePath || '',
        xiaomoMimoPresetVoiceName: data.ttsXiaomoMimoPresetVoiceName || '冰糖',
        xiaomoMimoDirectorPrompt: data.ttsXiaomoMimoDirectorPrompt || '',
        xiaomoMimoDesignPrompt: data.ttsXiaomoMimoDesignPrompt || '',
        xiaomoMimoAllowDirectorTags: data.ttsXiaomoMimoAllowDirectorTags ?? false,
        xiaomoMimoEmotionMode: data.ttsXiaomoMimoEmotionMode ?? true,
        fishAudioBaseUrl: data.ttsFishAudioBaseUrl || 'https://api.fish.audio/v1',
        fishAudioApiKey: data.ttsFishAudioApiKey || '',
        fishAudioModel: data.ttsFishAudioModel || 's2.1-pro-free',
        fishAudioReferenceId: data.ttsFishAudioReferenceId || '',
        fishAudioFormat: (data.ttsFishAudioFormat === 'mp3' || !data.ttsFishAudioFormat) ? 'pcm' : data.ttsFishAudioFormat,
        fishAudioLatency: data.ttsFishAudioLatency || 'balanced',
        fishAudioEmotionMode: data.ttsFishAudioEmotionMode ?? true,
      }
      // Server is source of truth on load. Do NOT overlay localStorage provider cache here —
      // that made refresh show stale drafts (e.g. old voice/URL) while backend still used DB.
      // Cache is only for switchTtsProvider() unsaved drafts; rebuild it from server payload.
      hydrateVolcengineCloneSpeakerIds(tts.value)
      tts.value.volcengineVoiceMode = 'preset'
      syncVolcengineCloneSpeakerHistory()

      syncAliyunModelWithVoice()
      syncAllTtsProvidersToCache(tts.value)
      asr.value = {
        provider: (data.asrProvider === 'xiaomi' || data.asrProvider === 'aliyun' || data.asrProvider === 'apple') ? data.asrProvider : 'local',
        language: normalizeAsrLanguage(data.asrLanguage),
        xiaomi: {
          baseUrl: data.asrXiaomiBaseUrl || 'https://api.xiaomimimo.com/v1',
          apiKey: data.asrXiaomiApiKey || '',
          model: data.asrXiaomiModel || 'mimo-v2.5-asr',
          language: normalizeAsrLanguage(data.asrXiaomiLanguage, 'zh'),
        },
        aliyun: {
          httpBaseUrl: data.asrAliyunHttpBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          wsUrl: data.asrAliyunWsUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
          apiKey: data.asrAliyunApiKey || '',
          model: data.asrAliyunModel || 'qwen3-asr-flash-realtime',
          language: normalizeAsrLanguage(data.asrAliyunLanguage, 'zh'),
        },
      }
      security.value = {
        enforceGitRollback: data.enforceGitRollback ?? true,
        readRoots: Array.isArray(data.toolReadRoots) && data.toolReadRoots.length > 0 ? data.toolReadRoots : ['.'],
        writeRoots: Array.isArray(data.toolWriteRoots) && data.toolWriteRoots.length > 0 ? data.toolWriteRoots : ['.'],
        trustedCommands: Array.isArray(data.trustedCommands) && data.trustedCommands.length > 0 ? data.trustedCommands : ['python', 'pip', 'npm'],
        fullAccessEnabled: data.fullAccessEnabled ?? data.langsmithTracingEnabled ?? false
      }
      securityLastSavedSignature.value = securityConfigSignature(security.value)

      // Sync settings to browser cache (localStorage) for each source
      try {
        const cacheStr = localStorage.getItem('lingshu_model_source_cache') || '{}';
        const cache = JSON.parse(cacheStr);
        let changed = false;

        if (llm.value.source) {
          if (!cache[llm.value.source]) cache[llm.value.source] = {};
          if (!cache[llm.value.source].llm) cache[llm.value.source].llm = {};
          if (
            cache[llm.value.source].llm.apiKey !== llm.value.apiKey ||
            cache[llm.value.source].llm.model !== llm.value.model ||
            cache[llm.value.source].llm.baseUrl !== llm.value.baseUrl ||
            cache[llm.value.source].llm.reasoningEffort !== llm.value.reasoningEffort ||
            cache[llm.value.source].llm.temperature !== llm.value.temperature ||
            cache[llm.value.source].llm.contextBudgetK !== llm.value.contextBudgetK
          ) {
            cache[llm.value.source].llm.apiKey = llm.value.apiKey || '';
            cache[llm.value.source].llm.model = llm.value.model || '';
            cache[llm.value.source].llm.baseUrl = llm.value.baseUrl || '';
            cache[llm.value.source].llm.reasoningEffort = llm.value.reasoningEffort;
            cache[llm.value.source].llm.temperature = llm.value.temperature;
            cache[llm.value.source].llm.contextBudgetK = llm.value.contextBudgetK;
            changed = true;
          }
        }

        const memorySource = effectiveMemorySource();
        if (memorySource) {
          if (!cache[memorySource]) cache[memorySource] = {};
          if (!cache[memorySource].memoryModel) cache[memorySource].memoryModel = {};
          if (
            cache[memorySource].memoryModel.apiKey !== memoryModel.value.apiKey ||
            cache[memorySource].memoryModel.model !== memoryModel.value.model ||
            cache[memorySource].memoryModel.baseUrl !== memoryModel.value.baseUrl ||
            cache[memorySource].memoryModel.reasoningEffort !== memoryModel.value.reasoningEffort ||
            cache[memorySource].memoryModel.maxOutputTokens !== memoryModel.value.maxOutputTokens
          ) {
            cache[memorySource].memoryModel.apiKey = memoryModel.value.apiKey || '';
            cache[memorySource].memoryModel.model = memoryModel.value.model || '';
            cache[memorySource].memoryModel.baseUrl = memoryModel.value.baseUrl || '';
            cache[memorySource].memoryModel.reasoningEffort = memoryModel.value.reasoningEffort;
            cache[memorySource].memoryModel.maxOutputTokens = memoryModel.value.maxOutputTokens || 131072;
            changed = true;
          }
        }

        const visionSource = effectiveVisionSource();
        if (visionSource) {
          if (!cache[visionSource]) cache[visionSource] = {};
          if (!cache[visionSource].visionModel) cache[visionSource].visionModel = {};
          if (
            cache[visionSource].visionModel.apiKey !== visionModel.value.apiKey ||
            cache[visionSource].visionModel.model !== visionModel.value.model ||
            cache[visionSource].visionModel.baseUrl !== visionModel.value.baseUrl ||
            cache[visionSource].visionModel.reasoningEffort !== visionModel.value.reasoningEffort
          ) {
            cache[visionSource].visionModel.apiKey = visionModel.value.apiKey || '';
            cache[visionSource].visionModel.model = visionModel.value.model || '';
            cache[visionSource].visionModel.baseUrl = visionModel.value.baseUrl || '';
            cache[visionSource].visionModel.reasoningEffort = visionModel.value.reasoningEffort;
            changed = true;
          }
        }

        if (imageGeneration.value.source) {
          const imgSource = imageGeneration.value.source;
          if (!cache[imgSource]) cache[imgSource] = {};
          if (!cache[imgSource].imageGeneration) cache[imgSource].imageGeneration = {};
          if (
            cache[imgSource].imageGeneration.apiKey !== imageGeneration.value.apiKey ||
            cache[imgSource].imageGeneration.model !== imageGeneration.value.model ||
            cache[imgSource].imageGeneration.baseUrl !== imageGeneration.value.baseUrl
          ) {
            cache[imgSource].imageGeneration.apiKey = imageGeneration.value.apiKey || '';
            cache[imgSource].imageGeneration.model = imageGeneration.value.model || '';
            cache[imgSource].imageGeneration.baseUrl = imageGeneration.value.baseUrl || '';
            changed = true;
          }
        }

        if (changed) {
          localStorage.setItem('lingshu_model_source_cache', JSON.stringify(cache));
        }
        syncSavedModelHistory();
      } catch (e) {
        console.error('Failed to sync cache on fetchSettings', e);
      }

      refreshAllModelOptions();
      isLoaded.value = true
    } catch (err) {
      console.error('Failed to fetch settings', err)
    }
  }

  async function fetchGeneralSettings() {
    try {
      const res = await fetch(getFullUrl('/api/settings/general'))
      if (!res.ok) throw new Error('Failed to fetch general settings')
      await res.json()
    } catch (err) {
      console.error('Failed to fetch general settings', err)
    }
  }

  async function fetchSecuritySettings() {
    try {
      const res = await fetch(getFullUrl('/api/settings/security'))
      if (!res.ok) throw new Error('Failed to fetch security settings')
      const data = await res.json()

      security.value = {
        enforceGitRollback: data.enforceGitRollback ?? true,
        readRoots: Array.isArray(data.toolReadRoots) && data.toolReadRoots.length > 0 ? data.toolReadRoots : ['.'],
        writeRoots: Array.isArray(data.toolWriteRoots) && data.toolWriteRoots.length > 0 ? data.toolWriteRoots : ['.'],
        trustedCommands: Array.isArray(data.trustedCommands) && data.trustedCommands.length > 0 ? data.trustedCommands : ['python', 'pip', 'npm'],
        fullAccessEnabled: data.fullAccessEnabled ?? data.langsmithTracingEnabled ?? false
      }
      securityLastSavedSignature.value = securityConfigSignature(security.value)
    } catch (err) {
      console.error('Failed to fetch security settings', err)
    }
  }

  async function saveSettings() {
    saving.value = true
    try {
      syncAliyunModelWithVoice()
      tts.value.volcengineVoiceMode = 'preset'
      
      // Ensure all current values in the store are persisted to the provider cache
      persistTtsProviderSnapshot('openai_compat', tts.value)
      persistTtsProviderSnapshot('aliyun_cosyvoice', tts.value)
      persistTtsProviderSnapshot('volcengine', tts.value)
    persistTtsProviderSnapshot('xiaomo_mimo', tts.value)
    persistTtsProviderSnapshot('fish_audio', tts.value)

      syncProviderConnection('chat')
      syncProviderConnection('memory')
      syncProviderConnection('vision')
      syncProviderConnection('image')
      
      const res = await fetch(getFullUrl('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatProviderId: llm.value.providerId,
          memoryProviderId: memoryModel.value.providerId,
          visionProviderId: visionModel.value.providerId,
          imageGenProviderId: imageGeneration.value.providerId,
          source: llm.value.source,
          chatModel: llm.value.model,
          baseUrl: llm.value.baseUrl,
          apiKey: llm.value.apiKey,
          // 新 5 档 key + 遗留布尔镜像双写（镜像给旧版后端/排查用），语义同 App writeConfig。
          chatReasoningEffort: llm.value.reasoningEffort,
          enableThinking: thinkingEffortIsActive(llm.value.reasoningEffort),
          chatTemperature: llm.value.temperature,
          chatContextBudgetK: llm.value.contextBudgetK,
          memoryModelSource: memoryModel.value.source,
          memoryModel: memoryModel.value.model,
          memoryModelBaseUrl: memoryModel.value.baseUrl,
          memoryModelApiKey: memoryModel.value.apiKey,
          memoryReasoningEffort: memoryModel.value.reasoningEffort,
          memoryModelMaxOutputTokens: memoryModel.value.maxOutputTokens,
          visionModelSource: visionModel.value.source,
          visionModel: visionModel.value.model,
          visionModelBaseUrl: visionModel.value.baseUrl,
          visionModelApiKey: visionModel.value.apiKey,
          visionModelReasoningEffort: visionModel.value.reasoningEffort,
          visionModelEnableThinking: thinkingEffortIsActive(visionModel.value.reasoningEffort),
          imageGenSource: imageGeneration.value.source,
          imageGenModel: imageGeneration.value.model,
          imageGenBaseUrl: imageGeneration.value.baseUrl,
          imageGenApiKey: imageGeneration.value.apiKey,
          imageGenDailyLimit: imageGeneration.value.dailyLimit,
          imageGenEnableCooldown: imageGeneration.value.enableCooldown,
          imageGenCooldownSeconds: imageGeneration.value.cooldownSeconds,
          imageGenEnableSoftIntercept: imageGeneration.value.enableSoftIntercept,
          ...buildTtsSettingsPayload(tts.value),
          ...buildAsrSettingsPayload(asr.value),
          enforceGitRollback: security.value.enforceGitRollback,
          toolReadRoots: security.value.readRoots,
          toolWriteRoots: security.value.writeRoots,
          trustedCommands: security.value.trustedCommands,
          fullAccessEnabled: security.value.fullAccessEnabled
        })
      })
      if (!res.ok) throw new Error('Failed to save settings')

      syncVolcengineCloneSpeakerHistory()
      syncAllTtsProvidersToCache(tts.value)

      // Save to browser cache (localStorage) for each source on save
      try {
        const cacheStr = localStorage.getItem('lingshu_model_source_cache') || '{}';
        const cache = JSON.parse(cacheStr);

        if (llm.value.source) {
          if (!cache[llm.value.source]) cache[llm.value.source] = {};
          if (!cache[llm.value.source].llm) cache[llm.value.source].llm = {};
          cache[llm.value.source].llm.apiKey = llm.value.apiKey || '';
          cache[llm.value.source].llm.model = llm.value.model || '';
          cache[llm.value.source].llm.baseUrl = llm.value.baseUrl || '';
          cache[llm.value.source].llm.reasoningEffort = llm.value.reasoningEffort;
          cache[llm.value.source].llm.temperature = llm.value.temperature;
          cache[llm.value.source].llm.contextBudgetK = llm.value.contextBudgetK;
        }

        const memorySource = effectiveMemorySource();
        if (memorySource) {
          if (!cache[memorySource]) cache[memorySource] = {};
          if (!cache[memorySource].memoryModel) cache[memorySource].memoryModel = {};
          cache[memorySource].memoryModel.apiKey = memoryModel.value.apiKey || '';
          cache[memorySource].memoryModel.model = memoryModel.value.model || '';
          cache[memorySource].memoryModel.baseUrl = memoryModel.value.baseUrl || '';
          cache[memorySource].memoryModel.reasoningEffort = memoryModel.value.reasoningEffort;
          cache[memorySource].memoryModel.maxOutputTokens = memoryModel.value.maxOutputTokens || 131072;
        }

        const visionSource = effectiveVisionSource();
        if (visionSource) {
          if (!cache[visionSource]) cache[visionSource] = {};
          if (!cache[visionSource].visionModel) cache[visionSource].visionModel = {};
          cache[visionSource].visionModel.apiKey = visionModel.value.apiKey || '';
          cache[visionSource].visionModel.model = visionModel.value.model || '';
          cache[visionSource].visionModel.baseUrl = visionModel.value.baseUrl || '';
          cache[visionSource].visionModel.reasoningEffort = visionModel.value.reasoningEffort;
        }

        if (imageGeneration.value.source) {
          const imgSource = imageGeneration.value.source;
          if (!cache[imgSource]) cache[imgSource] = {};
          if (!cache[imgSource].imageGeneration) cache[imgSource].imageGeneration = {};
          cache[imgSource].imageGeneration.apiKey = imageGeneration.value.apiKey || '';
          cache[imgSource].imageGeneration.model = imageGeneration.value.model || '';
          cache[imgSource].imageGeneration.baseUrl = imageGeneration.value.baseUrl || '';
        }

        localStorage.setItem('lingshu_model_source_cache', JSON.stringify(cache));
        syncSavedModelHistory();
        refreshAllModelOptions();
      } catch (e) {
        console.error('Failed to save settings cache to localStorage', e);
      }

      Message.success('模型配置已保存')
    } catch (err) {
      console.error('Failed to save settings', err)
      Message.error('保存配置失败')
    } finally {
      saving.value = false
    }
  }

  async function saveSecuritySettings(options?: { showSuccess?: boolean; force?: boolean }) {
    const normalized = normalizeSecurityConfig(security.value)
    const nextSignature = securityConfigSignature(normalized)
    if (!options?.force && nextSignature === securityLastSavedSignature.value) {
      return true
    }

    securitySaving.value = true
    try {
      security.value = normalized
      const res = await fetch(getFullUrl('/api/settings/security'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enforceGitRollback: normalized.enforceGitRollback,
          toolReadRoots: normalized.readRoots,
          toolWriteRoots: normalized.writeRoots,
          trustedCommands: normalized.trustedCommands,
          fullAccessEnabled: normalized.fullAccessEnabled
        })
      })
      if (!res.ok) throw new Error('Failed to save security settings')

      securityLastSavedSignature.value = nextSignature
      if (options?.showSuccess ?? true) {
        Message.success('安全配置已保存')
      }
      return true
    } catch (err) {
      console.error('Failed to save security settings', err)
      Message.error('保存安全配置失败')
      return false
    } finally {
      securitySaving.value = false
    }
  }

  async function fetchChatModels(silent = false) {
    const baseUrl = llm.value.baseUrl
    const source = (llm.value.source || '').trim().toLowerCase()
    if (!baseUrl || !source) return

    loadingChatModels.value = true
    try {
      let apiModels: string[] = []
      if (sourceHasModelListApi(source)) {
        const params = new URLSearchParams({
          source,
          baseUrl,
          apiKey: llm.value.apiKey
        })
        const res = await fetch(getFullUrl(`/api/chat/models?${params.toString()}`))
        if (!res.ok) throw new Error('Failed to fetch chat models')
        apiModels = await res.json()
      }

      const cachedModels = getSavedModels(source, 'chat')
      chatModelOptions.value = buildModelOptions(
        [...apiModels, ...cachedModels],
        llm.value.model,
      )

      if (
        sourceHasModelListApi(source)
        && chatModelOptions.value.length > 0
        && !chatModelOptions.value.find((option) => option.value === llm.value.model)
      ) {
        llm.value.model = chatModelOptions.value[0].value
      }
      if (!silent && sourceHasModelListApi(source)) Message.success('对话模型列表已更新')
    } catch (err) {
      if (!silent && sourceHasModelListApi(source)) Message.error('无法连接到对话模型服务')
      chatModelOptions.value = buildModelOptions(
        [...getSavedModels(source, 'chat')],
        llm.value.model,
      )
    } finally {
      loadingChatModels.value = false
    }
  }

  async function fetchMemoryModels(silent = false) {
    const baseUrl = memoryModel.value.baseUrl || llm.value.baseUrl
    const source = effectiveMemorySource()
    if (!baseUrl || !source) return

    loadingMemoryModels.value = true
    try {
      let apiModels: string[] = []
      if (sourceHasModelListApi(source)) {
        const params = new URLSearchParams({
          source,
          baseUrl,
          apiKey: memoryModel.value.apiKey || llm.value.apiKey
        })
        const res = await fetch(getFullUrl(`/api/chat/models?${params.toString()}`))
        if (!res.ok) throw new Error('Failed to fetch memory models')
        apiModels = await res.json()
      }

      const cachedModels = getSavedModels(source, 'memory')
      memoryModelOptions.value = buildModelOptions(
        [...apiModels, ...cachedModels],
        memoryModel.value.model,
      )

      if (
        sourceHasModelListApi(source)
        && memoryModelOptions.value.length > 0
        && !memoryModelOptions.value.find((option) => option.value === memoryModel.value.model)
      ) {
        memoryModel.value.model = memoryModelOptions.value[0].value
      }
      if (!silent && sourceHasModelListApi(source)) Message.success('记忆模型列表已更新')
    } catch (err) {
      if (!silent && sourceHasModelListApi(source)) Message.error('无法连接到记忆模型服务')
      memoryModelOptions.value = buildModelOptions(
        [...getSavedModels(source, 'memory')],
        memoryModel.value.model,
      )
    } finally {
      loadingMemoryModels.value = false
    }
  }

  async function fetchVisionModels(silent = false) {
    const baseUrl = visionModel.value.baseUrl || llm.value.baseUrl
    const source = effectiveVisionSource()
    if (!baseUrl || !source) return

    loadingVisionModels.value = true
    try {
      let apiModels: string[] = []
      if (sourceHasModelListApi(source)) {
        const params = new URLSearchParams({
          source,
          baseUrl,
          apiKey: visionModel.value.apiKey || llm.value.apiKey
        })
        const res = await fetch(getFullUrl(`/api/chat/models?${params.toString()}`))
        if (!res.ok) throw new Error('Failed to fetch vision models')
        apiModels = await res.json()
      }

      const cachedModels = getSavedModels(source, 'vision')
      visionModelOptions.value = buildModelOptions(
        [...apiModels, ...cachedModels],
        visionModel.value.model,
      )

      if (
        sourceHasModelListApi(source)
        && visionModelOptions.value.length > 0
        && !visionModelOptions.value.find((option) => option.value === visionModel.value.model)
      ) {
        visionModel.value.model = visionModelOptions.value[0].value
      }
      if (!silent && sourceHasModelListApi(source)) Message.success('识图模型列表已更新')
    } catch (err) {
      if (!silent && sourceHasModelListApi(source)) Message.error('无法连接到识图模型服务')
      visionModelOptions.value = buildModelOptions(
        [...getSavedModels(source, 'vision')],
        visionModel.value.model,
      )
    } finally {
      loadingVisionModels.value = false
    }
  }

  return {
    llm,
    memoryModel,
    visionModel,
    imageGeneration,
    tts,
    asr,
    security,
    isLoaded,
    volcengineCloneSpeakerHistoryVersion,
    saving,
    generalSaving,
    securitySaving,
    securityLastSavedSignature,
    modelProviders,
    providerOptions,
    providerFor,
    syncProviderConnection,
    fetchModelProviders,
    saveModelProvider,
    deleteModelProvider,
    refreshModelProviderModels,
    saveModelProviderModels,
    refreshAllModelOptions,
    chatModelOptions,
    memoryModelOptions,
    visionModelOptions,
    loadingChatModels,
    loadingMemoryModels,
    loadingVisionModels,
    fetchSettings,
    fetchGeneralSettings,
    fetchSecuritySettings,
    saveSettings,
    saveSecuritySettings,
    fetchChatModels,
    fetchMemoryModels,
    fetchVisionModels,
    refreshChatModelOptions,
    refreshMemoryModelOptions,
    refreshVisionModelOptions,
    switchTtsProvider,
    syncVolcengineCloneSpeakerHistory,
  }
})
