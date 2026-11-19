import { inferCosyvoiceModelFromVoice } from './cosyvoiceModel'

export type TtsProviderId = 'openai_compat' | 'aliyun_cosyvoice' | 'volcengine' | 'xiaomo_mimo' | 'fish_audio'

/** Minimal TTS shape used for provider-local caching (avoids store import cycle). */
export interface TtsProviderCacheSource {
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
  fishAudioBaseUrl: string; fishAudioApiKey: string; fishAudioModel: string; fishAudioReferenceId: string; fishAudioFormat: string; fishAudioLatency: string; fishAudioEmotionMode: boolean
}

export type FishAudioTtsSnapshot = Pick<TtsProviderCacheSource, 'fishAudioBaseUrl' | 'fishAudioApiKey' | 'fishAudioModel' | 'fishAudioReferenceId' | 'fishAudioFormat' | 'fishAudioLatency' | 'fishAudioEmotionMode'>

const CACHE_KEY = 'lingshu_tts_provider_cache'

export interface OpenAiCompatTtsSnapshot {
  baseUrl: string
  apiKey: string
  model: string
  defaultVoice: string
  defaultSpeed: number
  defaultFormat: string
  defaultSeed: number
  defaultCfg: number
  defaultTimesteps: number
}

export interface AliyunCosyvoiceTtsSnapshot {
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
}

export interface VolcengineTtsSnapshot {
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
  volcengineCloneSpeakerHistory?: string[]
}

const MAX_VOLCENGINE_CLONE_SPEAKER_HISTORY = 32

function normalizeVolcengineCloneSpeakerId(id: string): string {
  return (id || '').trim()
}

function isVolcengineCloneSpeakerId(id: string): boolean {
  return normalizeVolcengineCloneSpeakerId(id).startsWith('S_')
}

export function readVolcengineCloneSpeakerHistory(): string[] {
  const cache = readCache()
  const snapshot = cache.volcengine as VolcengineTtsSnapshot | undefined
  const history = snapshot?.volcengineCloneSpeakerHistory
  if (!Array.isArray(history)) return []
  return history
    .filter((id): id is string => typeof id === 'string' && isVolcengineCloneSpeakerId(id))
    .map(normalizeVolcengineCloneSpeakerId)
}

export function rememberVolcengineCloneSpeakerIds(...ids: string[]): string[] {
  const incoming = ids.map(normalizeVolcengineCloneSpeakerId).filter(isVolcengineCloneSpeakerId)
  const previous = readVolcengineCloneSpeakerHistory()
  if (incoming.length === 0) return previous

  const merged: string[] = []
  for (const id of [...incoming, ...previous]) {
    if (!merged.includes(id)) merged.push(id)
  }
  const next = merged.slice(0, MAX_VOLCENGINE_CLONE_SPEAKER_HISTORY)

  const cache = readCache()
  const existing = (cache.volcengine as VolcengineTtsSnapshot | undefined) || ({} as VolcengineTtsSnapshot)
  cache.volcengine = {
    ...existing,
    volcengineCloneSpeakerHistory: next,
  }
  writeCache(cache)
  return next
}

export function buildVolcengineCloneSpeakerOptions(...extraIds: string[]) {
  const history = readVolcengineCloneSpeakerHistory()
  const merged: string[] = []
  for (const raw of extraIds) {
    const id = normalizeVolcengineCloneSpeakerId(raw)
    if (isVolcengineCloneSpeakerId(id) && !merged.includes(id)) merged.push(id)
  }
  for (const id of history) {
    if (!merged.includes(id)) merged.push(id)
  }
  return merged.map((id) => ({ value: id, label: id }))
}

export interface XiaomiMimoTtsSnapshot {
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
}

type TtsProviderCache = Partial<Record<TtsProviderId, OpenAiCompatTtsSnapshot | AliyunCosyvoiceTtsSnapshot | VolcengineTtsSnapshot | XiaomiMimoTtsSnapshot | FishAudioTtsSnapshot>>

function readCache(): TtsProviderCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as TtsProviderCache
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeCache(cache: TtsProviderCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch (error) {
    console.error('Failed to write TTS provider cache', error)
  }
}

export function snapshotOpenAiCompatTts(tts: TtsProviderCacheSource): OpenAiCompatTtsSnapshot {
  return {
    baseUrl: tts.baseUrl || '',
    apiKey: tts.apiKey || '',
    model: tts.model || '',
    defaultVoice: tts.defaultVoice || '',
    defaultSpeed: tts.defaultSpeed ?? 1.0,
    defaultFormat: tts.defaultFormat || 'mp3',
    defaultSeed: tts.defaultSeed ?? -1,
    defaultCfg: tts.defaultCfg ?? 1.0,
    defaultTimesteps: tts.defaultTimesteps ?? 10,
  }
}

export function snapshotAliyunCosyvoiceTts(tts: TtsProviderCacheSource): AliyunCosyvoiceTtsSnapshot {
  return {
    aliyunWsUrl: tts.aliyunWsUrl || '',
    aliyunApiKey: tts.aliyunApiKey || '',
    aliyunModel: tts.aliyunModel || '',
    aliyunVoice: tts.aliyunVoice || '',
    aliyunFormat: tts.aliyunFormat || 'pcm',
    aliyunSampleRate: tts.aliyunSampleRate ?? 22050,
    aliyunRate: tts.aliyunRate ?? 1.0,
    aliyunPitch: tts.aliyunPitch ?? 1.0,
    aliyunVolume: tts.aliyunVolume ?? 50,
    aliyunInstruction: tts.aliyunInstruction || '',
  }
}

export function snapshotVolcengineTts(tts: TtsProviderCacheSource): VolcengineTtsSnapshot {
  return {
    volcengineWsUrl: tts.volcengineWsUrl || '',
    volcengineApiKey: tts.volcengineApiKey || '',
    volcengineResourceId: tts.volcengineResourceId || 'seed-icl-2.0',
    volcengineSpeakerId: tts.volcengineSpeakerId || '',
    volcengineModel: tts.volcengineModel || 'seed-tts-2.0-expressive',
    volcengineFormat: tts.volcengineFormat || 'pcm',
    volcengineSampleRate: tts.volcengineSampleRate ?? 24000,
    volcengineUseTagParser: tts.volcengineUseTagParser ?? null,
    volcengineContextTexts: tts.volcengineContextTexts || '',
    volcengineAllowDirectorTags: tts.volcengineAllowDirectorTags ?? false,
    volcengineVoiceMode: tts.volcengineVoiceMode || 'preset',
    volcengineRefVoicePath: tts.volcengineRefVoicePath || '',
    volcengineCloneSpeakerSlot: tts.volcengineCloneSpeakerSlot || '',
    volcengineCloneReferenceText: tts.volcengineCloneReferenceText || '',
    volcengineCloneLanguage: tts.volcengineCloneLanguage ?? 0,
    volcengineCloneDemoText: tts.volcengineCloneDemoText || '',
    volcengineCloneEnableDenoise: tts.volcengineCloneEnableDenoise ?? false,
    volcengineCloneDisableVolumeNorm: tts.volcengineCloneDisableVolumeNorm ?? false,
    volcengineCloneStatus: tts.volcengineCloneStatus ?? -1,
    volcengineCloneModelType: tts.volcengineCloneModelType ?? 0,
    volcengineTrainedSpeakerId: tts.volcengineTrainedSpeakerId || '',
    volcengineCloneSpeakerHistory: readVolcengineCloneSpeakerHistory(),
  }
}

export function snapshotXiaomiMimoTts(tts: TtsProviderCacheSource): XiaomiMimoTtsSnapshot {
  return {
    xiaomoMimoBaseUrl: tts.xiaomoMimoBaseUrl || '',
    xiaomoMimoApiKey: tts.xiaomoMimoApiKey || '',
    xiaomoMimoModel: tts.xiaomoMimoModel || '',
    xiaomoMimoMode: tts.xiaomoMimoMode || 'voice_clone',
    xiaomoMimoRefVoicePath: tts.xiaomoMimoRefVoicePath || '',
    xiaomoMimoPresetVoiceName: tts.xiaomoMimoPresetVoiceName || '冰糖',
    xiaomoMimoDirectorPrompt: tts.xiaomoMimoDirectorPrompt || '',
    xiaomoMimoDesignPrompt: tts.xiaomoMimoDesignPrompt || '',
    xiaomoMimoAllowDirectorTags: tts.xiaomoMimoAllowDirectorTags ?? false,
    xiaomoMimoEmotionMode: tts.xiaomoMimoEmotionMode ?? true,
  }
}

export function snapshotFishAudioTts(tts: TtsProviderCacheSource): FishAudioTtsSnapshot {
  return {
    fishAudioBaseUrl: tts.fishAudioBaseUrl || '',
    fishAudioApiKey: tts.fishAudioApiKey || '',
    fishAudioModel: tts.fishAudioModel || '',
    fishAudioReferenceId: tts.fishAudioReferenceId || '',
    fishAudioFormat: tts.fishAudioFormat || 'pcm',
    fishAudioLatency: tts.fishAudioLatency || 'normal',
    fishAudioEmotionMode: tts.fishAudioEmotionMode ?? true,
  }
}

export function applyOpenAiCompatSnapshot(tts: TtsProviderCacheSource, snapshot: OpenAiCompatTtsSnapshot): void {
  tts.baseUrl = snapshot.baseUrl
  tts.apiKey = snapshot.apiKey
  tts.model = snapshot.model
  tts.defaultVoice = snapshot.defaultVoice
  tts.defaultSpeed = snapshot.defaultSpeed
  tts.defaultFormat = snapshot.defaultFormat
  tts.defaultSeed = snapshot.defaultSeed
  tts.defaultCfg = snapshot.defaultCfg
  tts.defaultTimesteps = snapshot.defaultTimesteps
}

export function applyAliyunCosyvoiceSnapshot(tts: TtsProviderCacheSource, snapshot: AliyunCosyvoiceTtsSnapshot): void {
  tts.aliyunWsUrl = snapshot.aliyunWsUrl
  tts.aliyunApiKey = snapshot.aliyunApiKey
  tts.aliyunModel = snapshot.aliyunModel
  tts.aliyunVoice = snapshot.aliyunVoice
  tts.aliyunFormat = snapshot.aliyunFormat
  tts.aliyunSampleRate = snapshot.aliyunSampleRate
  tts.aliyunRate = snapshot.aliyunRate
  tts.aliyunPitch = snapshot.aliyunPitch
  tts.aliyunVolume = snapshot.aliyunVolume
  tts.aliyunInstruction = snapshot.aliyunInstruction
  tts.aliyunModel = inferCosyvoiceModelFromVoice(tts.aliyunVoice, tts.aliyunModel)
}

export function applyVolcengineSnapshot(tts: TtsProviderCacheSource, snapshot: VolcengineTtsSnapshot): void {
  tts.volcengineWsUrl = snapshot.volcengineWsUrl
  tts.volcengineApiKey = snapshot.volcengineApiKey
  tts.volcengineResourceId = snapshot.volcengineResourceId
  tts.volcengineSpeakerId = snapshot.volcengineSpeakerId || tts.volcengineSpeakerId
  tts.volcengineModel = snapshot.volcengineModel
  tts.volcengineFormat = snapshot.volcengineFormat
  tts.volcengineSampleRate = snapshot.volcengineSampleRate
  tts.volcengineUseTagParser = snapshot.volcengineUseTagParser
  tts.volcengineContextTexts = snapshot.volcengineContextTexts
  tts.volcengineAllowDirectorTags = snapshot.volcengineAllowDirectorTags ?? false
  tts.volcengineVoiceMode = snapshot.volcengineVoiceMode || 'preset'
  tts.volcengineRefVoicePath = snapshot.volcengineRefVoicePath || ''
  tts.volcengineCloneSpeakerSlot = snapshot.volcengineCloneSpeakerSlot || tts.volcengineCloneSpeakerSlot
  tts.volcengineCloneReferenceText = snapshot.volcengineCloneReferenceText || ''
  tts.volcengineCloneLanguage = snapshot.volcengineCloneLanguage ?? 0
  tts.volcengineCloneDemoText = snapshot.volcengineCloneDemoText || ''
  tts.volcengineCloneEnableDenoise = snapshot.volcengineCloneEnableDenoise ?? false
  tts.volcengineCloneDisableVolumeNorm = snapshot.volcengineCloneDisableVolumeNorm ?? false
  tts.volcengineCloneStatus = snapshot.volcengineCloneStatus ?? -1
  tts.volcengineCloneModelType = snapshot.volcengineCloneModelType ?? 0
  tts.volcengineTrainedSpeakerId = snapshot.volcengineTrainedSpeakerId || tts.volcengineTrainedSpeakerId
}

/** Fill preset speaker from trained/slot when server saved clone id but UI field was cleared. */
export function hydrateVolcengineCloneSpeakerIds(tts: TtsProviderCacheSource): void {
  const resourceId = (tts.volcengineResourceId || '').trim()
  if (!resourceId.startsWith('seed-icl')) return

  const pickCloneSpeaker = (...values: string[]) => {
    for (const value of values) {
      const trimmed = (value || '').trim()
      if (trimmed.startsWith('S_')) return trimmed
    }
    return ''
  }

  const speaker = (tts.volcengineSpeakerId || '').trim()
  const trained = (tts.volcengineTrainedSpeakerId || '').trim()
  const slot = (tts.volcengineCloneSpeakerSlot || '').trim()

  if (speaker.startsWith('S_')) return

  const fallback = pickCloneSpeaker(trained, slot)
  if (fallback) {
    tts.volcengineSpeakerId = fallback
    return
  }

  if (speaker && !speaker.startsWith('S_')) {
    tts.volcengineSpeakerId = ''
  }
}

export function applyXiaomiMimoSnapshot(tts: TtsProviderCacheSource, snapshot: XiaomiMimoTtsSnapshot): void {
  tts.xiaomoMimoBaseUrl = snapshot.xiaomoMimoBaseUrl
  tts.xiaomoMimoApiKey = snapshot.xiaomoMimoApiKey
  tts.xiaomoMimoModel = snapshot.xiaomoMimoModel
  tts.xiaomoMimoMode = snapshot.xiaomoMimoMode
  tts.xiaomoMimoRefVoicePath = snapshot.xiaomoMimoRefVoicePath
  tts.xiaomoMimoPresetVoiceName = snapshot.xiaomoMimoPresetVoiceName
  tts.xiaomoMimoDirectorPrompt = snapshot.xiaomoMimoDirectorPrompt
  tts.xiaomoMimoDesignPrompt = snapshot.xiaomoMimoDesignPrompt
  tts.xiaomoMimoAllowDirectorTags = snapshot.xiaomoMimoAllowDirectorTags ?? false
  tts.xiaomoMimoEmotionMode = snapshot.xiaomoMimoEmotionMode ?? true
}

export function applyFishAudioSnapshot(tts: TtsProviderCacheSource, snapshot: FishAudioTtsSnapshot): void {
  tts.fishAudioBaseUrl = snapshot.fishAudioBaseUrl
  tts.fishAudioApiKey = snapshot.fishAudioApiKey
  tts.fishAudioModel = snapshot.fishAudioModel
  tts.fishAudioReferenceId = snapshot.fishAudioReferenceId
  tts.fishAudioFormat = snapshot.fishAudioFormat
  tts.fishAudioLatency = snapshot.fishAudioLatency
  tts.fishAudioEmotionMode = snapshot.fishAudioEmotionMode ?? true
}

export function persistTtsProviderSnapshot(provider: TtsProviderId, tts: TtsProviderCacheSource): void {
  const cache = readCache()
  if (provider === 'openai_compat') {
    cache[provider] = snapshotOpenAiCompatTts(tts)
  } else if (provider === 'aliyun_cosyvoice') {
    cache[provider] = snapshotAliyunCosyvoiceTts(tts)
  } else if (provider === 'volcengine') {
    cache[provider] = snapshotVolcengineTts(tts)
  } else if (provider === 'xiaomo_mimo') {
    cache[provider] = snapshotXiaomiMimoTts(tts)
  } else if (provider === 'fish_audio') {
    cache[provider] = snapshotFishAudioTts(tts)
  }
  writeCache(cache)
}

export function restoreTtsProviderSnapshot(provider: TtsProviderId, tts: TtsProviderCacheSource): boolean {
  const cache = readCache()
  const snapshot = cache[provider]
  if (!snapshot) return false

  if (provider === 'openai_compat') {
    applyOpenAiCompatSnapshot(tts, snapshot as OpenAiCompatTtsSnapshot)
  } else if (provider === 'aliyun_cosyvoice') {
    applyAliyunCosyvoiceSnapshot(tts, snapshot as AliyunCosyvoiceTtsSnapshot)
  } else if (provider === 'volcengine') {
    applyVolcengineSnapshot(tts, snapshot as VolcengineTtsSnapshot)
  } else if (provider === 'xiaomo_mimo') {
    applyXiaomiMimoSnapshot(tts, snapshot as XiaomiMimoTtsSnapshot)
  } else if (provider === 'fish_audio') {
    applyFishAudioSnapshot(tts, snapshot as FishAudioTtsSnapshot)
  }
  return true
}

export function syncAllTtsProvidersToCache(tts: TtsProviderCacheSource): void {
  const cache: TtsProviderCache = {
    openai_compat: snapshotOpenAiCompatTts(tts),
    aliyun_cosyvoice: snapshotAliyunCosyvoiceTts(tts),
    volcengine: snapshotVolcengineTts(tts),
    xiaomo_mimo: snapshotXiaomiMimoTts(tts),
    fish_audio: snapshotFishAudioTts(tts),
  }
  writeCache(cache)
}
