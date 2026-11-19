import { getDb } from "../db/sqlite.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const defaultsJson = JSON.parse(
  fs.readFileSync(new URL("../data/settings-defaults.json", import.meta.url), "utf-8"),
) as any;

const MODELS_KEYS = new Set([
  "source","chatModel","baseUrl","apiKey","enableThinking","chatReasoningEffort","chatTemperature","chatContextBudgetK",
  "chatProviderId","memoryProviderId","visionProviderId","imageGenProviderId",
  "memoryModelSource","memoryModel","memoryModelBaseUrl","memoryModelApiKey","memoryModelMaxOutputTokens",
  "memoryReasoningEffort",
  "visionModelSource","visionModel","visionModelBaseUrl","visionModelApiKey","visionModelEnableThinking","visionModelReasoningEffort",
  "imageGenSource","imageGenModel","imageGenBaseUrl","imageGenApiKey","imageGenDailyLimit",
  "imageGenEnableCooldown","imageGenCooldownSeconds","imageGenEnableSoftIntercept",
]);

const MODEL_PROVIDERS_ROW = "MODEL_PROVIDERS";

// Speech recognition is a provider choice of its own (local model / Xiaomi MiMo /
// Aliyun). Its keys get their own row so they don't mix into the TTS blob.
const ASR_KEYS = new Set([
  "asrProvider",
  "asrLanguage",
  "asrXiaomiBaseUrl",
  "asrXiaomiApiKey",
  "asrXiaomiModel",
  "asrXiaomiLanguage",
  "asrAliyunHttpBaseUrl",
  "asrAliyunWsUrl",
  "asrAliyunApiKey",
  "asrAliyunModel",
  "asrAliyunLanguage",
]);


export interface ModelProviderRecord {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabledModels: string[];
  modelsConfigured: boolean;
  preset?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProviderPreset {
  key: string;
  name: string;
  baseUrl: string;
}

const MODEL_PROVIDER_PRESETS_ROW = "MODEL_PROVIDER_PRESETS";
const PROVIDER_PRESETS_VERSION = 4;

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "volcengine",
    name: "火山引擎",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    key: "sensenova",
    name: "商汤日日新",
    baseUrl: "https://token.sensenova.cn/v1",
  },
  {
    key: "zhipu",
    name: "智谱 AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  { key: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  {
    key: "aliyun",
    name: "阿里云",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  { key: "xiaomi", name: "小米 MiMo", baseUrl: "https://api.xiaomimimo.com/v1" },
  { key: "agents", name: "Agents", baseUrl: "https://api.agnes-ai.cn/v1" },
  { key: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { key: "ollama", name: "Ollama (本地)", baseUrl: "http://localhost:11434" },
  { key: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1" },
];

/**
 * 旧版本会把内置模型直接写进服务商记录。这里只用于升级时把这些历史内置项
 * 从已有数据库里清掉；新版本不再内置任何模型，模型必须由「刷新模型列表」或
 * 手动添加产生。
 */
const LEGACY_PRESET_MODELS: Record<string, string[]> = {
  volcengine: [
    "doubao-seed-2-1-turbo-260628",
    "doubao-seed-2-1-pro-260628",
    "doubao-seed-character-260628",
    "doubao-seed-2-0-pro-260215",
    "doubao-seed-2-0-mini-260215",
    "doubao-seed-2-0-lite-260428",
    "deepseek-v4-pro-ga-260813",
    "deepseek-v4-flash-ga-260731",
    "glm-5-2-260617",
  ],
  sensenova: ["sensenova-6.8-flash-lite", "deepseek-v4-flash", "glm-5.2"],
  zhipu: [
    "glm-5.3",
    "glm-5",
    "glm-4.7-flash",
    "glm-4.6v-flash",
    "glm-4-plus",
    "glm-4-air",
    "glm-4-flash",
    "glm-4-long",
    "glm-4v-plus",
    "glm-4v-flash",
    "glm-zero-preview",
  ],
};

const allDefaults = defaultsJson.models as Record<string, any>;
const defaultModels: Record<string, any> = {};
const defaultTts: Record<string, any> = {};
const defaultAsr: Record<string, any> = {};
for (const [k, v] of Object.entries(allDefaults)) {
  if (MODELS_KEYS.has(k)) defaultModels[k] = v;
  else if (ASR_KEYS.has(k)) defaultAsr[k] = v;
  else defaultTts[k] = v;
}
const defaultGeneral = defaultsJson.general as Record<string, any>;
const defaultSecurity = defaultsJson.security as Record<string, any>;

function getRow(id: string): Record<string, any> | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings_rows WHERE id = ?").get(id) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function saveRow(id: string, value: Record<string, any>) {
  const db = getDb();
  db.prepare("INSERT INTO settings_rows (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .run(id, JSON.stringify(value));
}

// Shared with other services that persist small JSON blobs (e.g. the thinking-effort
// learned cache in thinkingEffort.ts).
export { getRow, saveRow };

function normalizeProvider(raw: any): ModelProviderRecord {
  const now = new Date().toISOString();
  const models: string[] = Array.isArray(raw?.models)
    ? (raw.models.map((value: unknown) => String(value)).filter(Boolean) as string[])
    : [];
  const enabledModels: string[] = Array.isArray(raw?.enabledModels)
    ? (raw.enabledModels.map((value: unknown) => String(value)).filter(Boolean) as string[])
    : models;
  return {
    id: String(raw?.id || `provider-${randomUUID()}`),
    name: String(raw?.name || raw?.protocol || "服务商"),
    protocol: String(raw?.protocol || raw?.source || "openai"),
    baseUrl: String(raw?.baseUrl || ""),
    apiKey: String(raw?.apiKey || ""),
    models: [...new Set(models)],
    enabledModels: [...new Set(enabledModels)],
    modelsConfigured: Boolean(raw?.modelsConfigured),
    preset: String(raw?.preset || ""),
    createdAt: String(raw?.createdAt || now),
    updatedAt: String(raw?.updatedAt || now),
  };
}

function normalizeUrl(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(v1|v3|v4)$/i, "")
    .toLowerCase();
}

function providerPresetIdentity(provider: ModelProviderRecord): string {
  const url = normalizeUrl(provider.baseUrl);
  if (url) {
    const byUrl = PROVIDER_PRESETS.filter((preset) => normalizeUrl(preset.baseUrl) === url);
    if (byUrl.length === 1) return byUrl[0].key;
  }
  const name = String(provider.name || "").trim().toLowerCase();
  const byName = PROVIDER_PRESETS.find(
    (preset) => preset.name.toLowerCase() === name,
  );
  return byName?.key || "";
}

function presetKeyFor(provider: ModelProviderRecord): string {
  if (provider.preset && PROVIDER_PRESETS.some((preset) => preset.key === provider.preset)) {
    return provider.preset;
  }
  return providerPresetIdentity(provider);
}

export { presetKeyFor };

function createPresetProvider(
  preset: ProviderPreset,
  overrides: {
    baseUrl?: string;
    apiKey?: string;
    models?: string[];
  } = {},
): ModelProviderRecord {
  const now = new Date().toISOString();
  const models = [...new Set(overrides.models || [])];
  return {
    id: `provider-${randomUUID()}`,
    name: preset.name,
    protocol: "openai",
    baseUrl: String(overrides.baseUrl || preset.baseUrl).trim(),
    apiKey: String(overrides.apiKey || ""),
    models,
    enabledModels: models,
    modelsConfigured: false,
    preset: preset.key,
    createdAt: now,
    updatedAt: now,
  };
}

function seedModelProviders(): ModelProviderRecord[] {
  const mod = { ...defaultModels, ...(getRow("MODELS") || {}) };
  const legacySource = String(mod.source || "ollama").toLowerCase();
  const legacyModels = [mod.chatModel, mod.memoryModel, mod.visionModel]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  let chatProviderId = "";
  const providers = PROVIDER_PRESETS.map((preset) => {
    const isLegacySource = preset.key === legacySource;
    const provider = createPresetProvider(preset, isLegacySource
      ? {
          baseUrl: String(mod.baseUrl || "").trim() || preset.baseUrl,
          apiKey: String(mod.apiKey || ""),
          models: legacyModels,
        }
      : {});
    if (isLegacySource) chatProviderId = provider.id;
    return provider;
  });
  saveRow(MODEL_PROVIDERS_ROW, providers);
  saveRow(MODEL_PROVIDER_PRESETS_ROW, { seeded: true, version: PROVIDER_PRESETS_VERSION });
  const nextModels = { ...(getRow("MODELS") || {}) };
  if (!nextModels.chatProviderId) nextModels.chatProviderId = chatProviderId || providers[0]?.id || "";
  saveRow("MODELS", nextModels);
  return providers;
}

function ensureProviderPresets(raw: ModelProviderRecord[]): ModelProviderRecord[] {
  const marker = getRow(MODEL_PROVIDER_PRESETS_ROW) || {};
  const seeded = Boolean(marker.seeded);
  const version = Number(marker.version || (seeded ? 1 : 0));
  const needsRepair = seeded && version < 3;
  const needsModelCleanup = !seeded || version < PROVIDER_PRESETS_VERSION;
  let changed = false;
  let providers = raw.map((provider) => {
    let next = provider;
    if (needsRepair) {
      const identity = providerPresetIdentity(provider);
      if ((next.preset || "") !== identity) {
        changed = true;
        next = { ...next, preset: identity };
      }
    } else if (!next.preset) {
      const preset = presetKeyFor(next);
      if (preset) {
        changed = true;
        next = { ...next, preset };
      }
    }
    const cleanupPreset = next.preset || presetKeyFor(next);
    if (needsModelCleanup && cleanupPreset) {
      const legacyModels = LEGACY_PRESET_MODELS[cleanupPreset];
      if (legacyModels?.length) {
        const legacy = new Set(legacyModels);
        const models = next.models.filter((model) => !legacy.has(model));
        if (models.length !== next.models.length) {
          changed = true;
          next = {
            ...next,
            models,
            enabledModels: next.enabledModels.filter((model) => models.includes(model)),
          };
        }
      }
    }
    return next;
  });
  if (!seeded || needsRepair) {
    const existingKeys = new Set(providers.map((provider) => provider.preset).filter(Boolean));
    providers = [...providers];
    for (const preset of PROVIDER_PRESETS) {
      if (existingKeys.has(preset.key)) continue;
      providers.push(createPresetProvider(preset));
      changed = true;
    }
    saveRow(MODEL_PROVIDER_PRESETS_ROW, { seeded: true, version: PROVIDER_PRESETS_VERSION });
  } else if (needsModelCleanup || !marker.version) {
    saveRow(MODEL_PROVIDER_PRESETS_ROW, { seeded: true, version: PROVIDER_PRESETS_VERSION });
  }
  if (changed) saveModelProviders(providers);
  return providers;
}

export function getModelProviders(): ModelProviderRecord[] {
  const raw = getRow(MODEL_PROVIDERS_ROW);
  if (Array.isArray(raw) && raw.length) {
    return ensureProviderPresets(raw.map(normalizeProvider));
  }
  return seedModelProviders();
}

export function saveModelProviders(providers: ModelProviderRecord[]) {
  saveRow(MODEL_PROVIDERS_ROW, providers.map(normalizeProvider));
}

export function getModelProviderById(id: string): ModelProviderRecord | null {
  if (!id) return null;
  return getModelProviders().find((provider) => provider.id === id) || null;
}

export function clearModelProviderReferences(providerId: string) {
  const mod = { ...(getRow("MODELS") || {}) };
  let changed = false;
  for (const key of [
    "chatProviderId",
    "memoryProviderId",
    "visionProviderId",
    "imageGenProviderId",
  ]) {
    if (mod[key] === providerId) {
      mod[key] = "";
      changed = true;
    }
  }
  if (changed) saveRow("MODELS", mod);
}

export function getSettings() {
  const modelRow = getRow("MODELS");
  const ttsRow = getRow("TTS");
  const asrRow = getRow("ASR");
  const generalRow = getRow("GENERAL");
  const securityRow = getRow("SECURITY");
  const modelSettings = { ...(modelRow || {}) } as Record<string, any>;
  // Accept the APP/native spelling when an older row still uses it.
  if (
    modelSettings.chatContextBudgetK == null &&
    modelSettings.chat_context_budget_k != null
  ) {
    modelSettings.chatContextBudgetK = modelSettings.chat_context_budget_k;
  }
  const ttsSettings = ttsRow || {};
  const asrSettings = asrRow || {};
  const generalSettings = generalRow || {};
  const securitySettings = securityRow || {};
  const settings: Record<string, any> = {
    ...defaultModels,
    ...defaultTts,
    ...defaultAsr,
    ...defaultGeneral,
    ...defaultSecurity,
    ...modelSettings,
    ...ttsSettings,
    ...asrSettings,
    ...generalSettings,
    ...securitySettings,
    // APP/native spelling, kept in sync for callers that use the shared key.
    chat_context_budget_k: modelSettings.chatContextBudgetK ?? defaultModels.chatContextBudgetK ?? 128,
    modelProviders: getModelProviders(),
  };
  // 语音合成关闭时自动朗读没有意义，读取时也保持两者一致。
  if (!settings.ttsEnabled) settings.ttsAutoRead = false;
  return settings;
}

export function saveSettings(data: Record<string, any>) {
  // A few settings are also addressed by their APP/native snake_case names.
  // Accept both spellings and persist the canonical camelCase key.
  const aliases: Record<string, string> = {
    chat_context_budget_k: "chatContextBudgetK",
  };
  const allowed = new Set([...Object.keys(allDefaults), ...Object.keys(aliases)]);
  const payload: Record<string, any> = {};
  for (const [rawKey, value] of Object.entries(data)) {
    if (!allowed.has(rawKey)) continue;
    payload[aliases[rawKey] || rawKey] = value;
  }
  // 语音合成关闭时自动朗读没有意义，保持两者状态一致。
  if (payload.ttsEnabled === false) payload.ttsAutoRead = false;
  const modelPayload: Record<string, any> = {};
  const ttsPayload: Record<string, any> = {};
  const asrPayload: Record<string, any> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (MODELS_KEYS.has(k)) modelPayload[k] = v;
    else if (ASR_KEYS.has(k)) asrPayload[k] = v;
    else ttsPayload[k] = v;
  }
  // merge with existing
  const existingModel = getRow("MODELS") || {};
  const existingTts = getRow("TTS") || {};
  const existingAsr = getRow("ASR") || {};
  saveRow("MODELS", { ...existingModel, ...modelPayload });
  saveRow("TTS", { ...existingTts, ...ttsPayload });
  saveRow("ASR", { ...existingAsr, ...asrPayload });
  return { status: "success" };
}

export function getGeneralSettings() {
  const row = getRow("GENERAL");
  const base = row || {};
  // pick general defaults keys
  const result: Record<string, any> = { ...defaultGeneral };
  for (const k of Object.keys(defaultGeneral)) {
    if (base[k] !== undefined) result[k] = base[k];
  }
  return result;
}

export function saveGeneralSettings(data: Record<string, any>) {
  const allowed = new Set(Object.keys(defaultGeneral));
  const payload: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (allowed.has(k)) payload[k] = v;
  }
  const existing = getRow("GENERAL") || {};
  saveRow("GENERAL", { ...existing, ...payload });
  return { status: "success" };
}

export function getSecuritySettings() {
  const row = getRow("SECURITY");
  const base = row || {};
  const result: Record<string, any> = { ...defaultSecurity };
  for (const k of Object.keys(defaultSecurity)) {
    if (base[k] !== undefined) result[k] = base[k];
  }
  return result;
}

export function saveSecuritySettings(data: Record<string, any>) {
  const allowed = new Set(Object.keys(defaultSecurity));
  const payload: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (allowed.has(k)) payload[k] = v;
  }
  const existing = getRow("SECURITY") || {};
  saveRow("SECURITY", { ...existing, ...payload });
  return { status: "success" };
}