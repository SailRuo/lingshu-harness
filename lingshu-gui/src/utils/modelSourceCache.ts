export const MODEL_SOURCE_CACHE_KEY = 'lingshu_model_source_cache'

export type ModelListKind = 'chat' | 'voice' | 'memory' | 'vision'

export interface ModelOption {
  label: string
  value: string
}

interface SourceCacheEntry {
  llm?: Record<string, unknown>
  voiceModel?: Record<string, unknown>
  memoryModel?: Record<string, unknown>
  visionModel?: Record<string, unknown>
  savedChatModels?: string[]
  savedVoiceModels?: string[]
  savedMemoryModels?: string[]
  savedVisionModels?: string[]
}

type ModelSourceCache = Record<string, SourceCacheEntry>

const SOURCES_WITHOUT_MODEL_LIST_API = new Set(['volcengine'])

/** 火山引擎 Seedream 生图常用 Model ID */
export const VOLCENGINE_IMAGE_GEN_MODELS = [
  'doubao-seedream-5-0-260128',
  'doubao-seedream-4-5-251128',
] as const

/** 商汤日日新 SenseNova 生图常用 Model ID */
export const SENSENOVA_IMAGE_GEN_MODELS = [
  'sensenova-u1-fast',
] as const

export const DEFAULT_VOLCENGINE_IMAGE_GEN_MODEL = VOLCENGINE_IMAGE_GEN_MODELS[0]
export const DEFAULT_SENSENOVA_IMAGE_GEN_MODEL = SENSENOVA_IMAGE_GEN_MODELS[0]

export function sourceHasModelListApi(source: string): boolean {
  return !SOURCES_WITHOUT_MODEL_LIST_API.has(source.trim().toLowerCase())
}

function readCache(): ModelSourceCache {
  try {
    const raw = localStorage.getItem(MODEL_SOURCE_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeCache(cache: ModelSourceCache): void {
  localStorage.setItem(MODEL_SOURCE_CACHE_KEY, JSON.stringify(cache))
}

function savedModelsKey(kind: ModelListKind): 'savedChatModels' | 'savedVoiceModels' | 'savedMemoryModels' | 'savedVisionModels' {
  if (kind === 'chat') return 'savedChatModels'
  if (kind === 'voice') return 'savedVoiceModels'
  if (kind === 'memory') return 'savedMemoryModels'
  return 'savedVisionModels'
}

export function getSavedModels(source: string, kind: ModelListKind): string[] {
  const normalized = source.trim().toLowerCase()
  if (!normalized) return []
  // 火山引擎无模型列表 API，只用代码内预设；不再读本地 saved* 以免旧 Model ID 污染下拉
  if (normalized === 'volcengine') return []

  const cache = readCache()
  const entry = cache[normalized]
  const key = savedModelsKey(kind)
  const models = entry?.[key]
  if (!Array.isArray(models)) return []

  return models
    .map((item) => String(item).trim())
    .filter(Boolean)
}

export function rememberSavedModel(source: string, kind: ModelListKind, model: string): void {
  const normalizedSource = source.trim().toLowerCase()
  const normalizedModel = model.trim()
  if (!normalizedSource || !normalizedModel) return
  if (normalizedSource === 'volcengine') return

  const cache = readCache()
  if (!cache[normalizedSource]) cache[normalizedSource] = {}

  const key = savedModelsKey(kind)
  const existing = Array.isArray(cache[normalizedSource][key])
    ? cache[normalizedSource][key]!
    : []

  if (!existing.includes(normalizedModel)) {
    cache[normalizedSource][key] = [...existing, normalizedModel]
    writeCache(cache)
  }
}

/** Drop stale volcengine saved model lists from localStorage (one-shot cleanup). */
export function purgeVolcengineSavedModelCache(): void {
  const cache = readCache()
  const entry = cache.volcengine
  if (!entry) return
  if (!('savedChatModels' in entry) && !('savedVoiceModels' in entry) && !('savedMemoryModels' in entry) && !('savedVisionModels' in entry)) return
  delete entry.savedChatModels
  delete entry.savedVoiceModels
  delete entry.savedMemoryModels
  delete entry.savedVisionModels
  cache.volcengine = entry
  writeCache(cache)
}

export function buildModelOptions(models: string[], currentModel?: string): ModelOption[] {
  const merged = new Set<string>()

  for (const model of models) {
    const normalized = model.trim()
    if (normalized) merged.add(normalized)
  }

  const current = currentModel?.trim()
  if (current) merged.add(current)

  return Array.from(merged).map((value) => ({ label: value, value }))
}
