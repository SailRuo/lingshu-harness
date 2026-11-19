import OpenAI from "openai";
import { getSettings, presetKeyFor, type ModelProviderRecord } from "./settingsService.js";
import { resolveReasoningEffort, type ThinkingEffort } from "./thinkingEffort.js";

export interface LLMProviderConfig {
  source: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 5-level thinking effort (思考程度); wired into requests via thinkingEffort.buildThinkingParams. */
  reasoningEffort?: ThinkingEffort;
  /** Provider preset key; empty/undefined marks a user-added gateway endpoint. */
  providerPreset?: string;
  temperature?: number;
}

function findProvider(settings: any, providerId: string): ModelProviderRecord | null {
  if (!providerId) return null;
  const providers = Array.isArray(settings.modelProviders) ? settings.modelProviders : [];
  return providers.find((provider: ModelProviderRecord) => provider.id === providerId) || null;
}

function providerConfig(
  provider: ModelProviderRecord,
  model: string,
  temperature: number | undefined,
  reasoningEffort?: ThinkingEffort,
): LLMProviderConfig {
  return {
    source: provider.protocol || "openai",
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    reasoningEffort,
    providerPreset: presetKeyFor(provider),
    temperature,
  };
}

export function getLLMConfig(kind: "chat" | "memory" | "vision" = "chat"): LLMProviderConfig {
  const s = getSettings() as any;
  if (kind === "memory") {
    // Effort follows the memory scope even when credentials fall back to the chat provider.
    const memoryEffort = resolveReasoningEffort(s.memoryReasoningEffort, undefined);
    const explicit = findProvider(s, s.memoryProviderId);
    if (explicit) {
      return providerConfig(
        explicit,
        String(s.memoryModel || s.chatModel || "").trim(),
        s.chatTemperature,
        memoryEffort,
      );
    }
    if (s.memoryModel && (s.memoryModelBaseUrl || s.memoryModelApiKey)) {
      return {
        source: s.memoryModelSource || s.source,
        baseUrl: s.memoryModelBaseUrl || s.baseUrl,
        apiKey: s.memoryModelApiKey || s.apiKey,
        model: s.memoryModel,
        reasoningEffort: memoryEffort,
        temperature: s.chatTemperature,
      };
    }
    const chatProvider = findProvider(s, s.chatProviderId);
    if (chatProvider) {
      return providerConfig(
        chatProvider,
        String(s.memoryModel || s.chatModel || "").trim(),
        s.chatTemperature,
        memoryEffort,
      );
    }
  }
  if (kind === "vision") {
    // Legacy desktop installs only had the dormant visionModelEnableThinking boolean.
    const visionEffort = resolveReasoningEffort(s.visionModelReasoningEffort, s.visionModelEnableThinking);
    const explicit = findProvider(s, s.visionProviderId);
    if (explicit) {
      return providerConfig(
        explicit,
        String(s.visionModel || s.chatModel || "").trim(),
        s.chatTemperature,
        visionEffort,
      );
    }
    if (s.visionModel && (s.visionModelBaseUrl || s.visionModelApiKey)) {
      return {
        source: s.visionModelSource || s.source,
        baseUrl: s.visionModelBaseUrl || s.baseUrl,
        apiKey: s.visionModelApiKey || s.apiKey,
        model: s.visionModel,
        reasoningEffort: visionEffort,
        temperature: s.chatTemperature,
      };
    }
    const chatProvider = findProvider(s, s.chatProviderId);
    if (chatProvider) {
      return providerConfig(
        chatProvider,
        String(s.visionModel || s.chatModel || "").trim(),
        s.chatTemperature,
        visionEffort,
      );
    }
  }
  const chatEffort = resolveReasoningEffort(s.chatReasoningEffort, s.enableThinking);
  const chatProvider = findProvider(s, s.chatProviderId);
  if (chatProvider) {
    return providerConfig(chatProvider, String(s.chatModel || "").trim(), s.chatTemperature, chatEffort);
  }
  return {
    source: s.source,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    model: s.chatModel,
    reasoningEffort: chatEffort,
    temperature: s.chatTemperature,
  };
}

export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  const base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return base;
  try {
    const path = new URL(base).pathname.replace(/\/+$/, "");
    if (/(^|\/)(v1|v3|v4)$/.test(path)) return base;
    return `${base}/v1`;
  } catch {
    return base;
  }
}

export function createOpenAIClient(cfg: LLMProviderConfig): OpenAI {
  return new OpenAI({
    baseURL: normalizeOpenAIBaseUrl(cfg.baseUrl),
    apiKey: cfg.apiKey || "dummy",
  });
}

export async function chatComplete(
  messages: { role: string; content: string }[],
  kind: "chat" | "memory" | "vision" = "chat",
): Promise<string> {
  const cfg = getLLMConfig(kind);
  if (!cfg.model) throw new Error("model not configured");
  const client = createOpenAIClient(cfg);
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: messages as any,
    temperature: cfg.temperature,
  });
  return res.choices?.[0]?.message?.content ?? "";
}
