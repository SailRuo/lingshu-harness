import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import {
  clearModelProviderReferences,
  getModelProviderById,
  getModelProviders,
  presetKeyFor,
  saveModelProviders,
  type ModelProviderRecord,
} from "../services/settingsService.js";
import {
  fetchProviderModels,
} from "../services/modelCatalogService.js";
import { normalizeOpenAIBaseUrl } from "../services/llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback, normalizeThinkingEffort } from "../services/thinkingEffort.js";

const TEST_TIMEOUT_MS = 30_000;

function describeTestError(error: unknown): string {
  const anyError = error as any;
  const status = Number(anyError?.status || 0);
  const detail = String(anyError?.error?.message || anyError?.message || "").trim();
  if (/timeout|aborted|ETIMEDOUT/i.test(detail)) {
    return status ? `HTTP ${status}：请求超时` : "请求超时";
  }
  if (!detail) return status ? `接口返回 HTTP ${status}` : "连接失败";
  if (!status) return detail;
  return detail.startsWith("HTTP ") ? detail : `HTTP ${status}：${detail}`;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
}

function toProvider(input: any, existing?: ModelProviderRecord | null): ModelProviderRecord {
  const now = new Date().toISOString();
  const models = uniqueStrings(input.models);
  const enabledModels = uniqueStrings(input.enabledModels);
  return {
    id: existing?.id || String(input.id || `provider-${randomUUID()}`),
    name: String(input.name || existing?.name || "服务商").trim() || "服务商",
    protocol: String(input.protocol || existing?.protocol || "openai").trim() || "openai",
    baseUrl: String(input.baseUrl ?? existing?.baseUrl ?? "").trim(),
    apiKey: String(input.apiKey ?? existing?.apiKey ?? ""),
    models: models.length ? models : (existing?.models || []),
    enabledModels: enabledModels.length ? enabledModels : (existing?.enabledModels || []),
    modelsConfigured: existing?.modelsConfigured ?? Boolean(input.modelsConfigured),
    preset: existing?.preset || String(input.preset || ""),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function providerResponse(provider: ModelProviderRecord) {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    models: provider.models,
    enabledModels: provider.enabledModels,
    modelsConfigured: provider.modelsConfigured,
    preset: provider.preset || "",
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export async function registerModelProviderRoutes(app: FastifyInstance) {
  app.get("/api/settings/providers", async () => getModelProviders().map(providerResponse));

  app.post("/api/settings/providers", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!String(body.name || "").trim()) {
      reply.code(400).send({ detail: "服务商名称不能为空" });
      return;
    }
    const provider = toProvider(body);
    const providers = getModelProviders();
    providers.push(provider);
    saveModelProviders(providers);
    return providerResponse(provider);
  });

  app.put("/api/settings/providers/:id", async (req, reply) => {
    const id = String((req.params as any).id || "");
    const existing = getModelProviderById(id);
    if (!existing) {
      reply.code(404).send({ detail: "服务商不存在" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = toProvider(body, existing);
    const providers = getModelProviders().map((provider) =>
      provider.id === id ? updated : provider,
    );
    saveModelProviders(providers);
    return providerResponse(updated);
  });

  app.delete("/api/settings/providers/:id", async (req, reply) => {
    const id = String((req.params as any).id || "");
    const providers = getModelProviders();
    if (!providers.some((provider) => provider.id === id)) {
      reply.code(404).send({ detail: "服务商不存在" });
      return;
    }
    saveModelProviders(providers.filter((provider) => provider.id !== id));
    clearModelProviderReferences(id);
    return { status: "success" };
  });

  app.post("/api/settings/providers/test", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const baseUrl = String(body.baseUrl || "").trim();
    if (!baseUrl) {
      reply.code(400).send({ detail: "请填写服务地址" });
      return;
    }
    const result = await fetchProviderModels({
      protocol: String(body.protocol || "openai"),
      baseUrl,
      apiKey: String(body.apiKey || ""),
    });
    return {
      ok: result.ok,
      modelCount: result.models.length,
      models: result.models,
      status: result.status,
      detail: result.detail,
    };
  });

  // 真实发一次对话请求，验证「服务商 + 模型」当前就能跑通（不走缓存、不重试）。
  app.post("/api/settings/providers/test-chat", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const providerId = String(body.providerId || "").trim();
    const provider = providerId ? getModelProviderById(providerId) : null;
    if (!provider) {
      reply.code(400).send({ ok: false, detail: "请先选择服务商" });
      return;
    }
    if (!provider.baseUrl.trim()) {
      reply.code(400).send({ ok: false, detail: "该服务商还没有填写服务地址" });
      return;
    }
    const model =
      String(body.model || "").trim() ||
      provider.enabledModels[0] ||
      provider.models[0] ||
      "";
    if (!model) {
      reply.code(400).send({ ok: false, detail: "请先选择模型" });
      return;
    }

    const rawTemperature = Number(body.temperature);
    const temperature = Number.isFinite(rawTemperature)
      ? Math.min(2, Math.max(0, rawTemperature))
      : 0;
    // The connectivity test validates the thinking level too: a rejected disable
    // param surfaces here (with the strip-retry) before it can hit real chats.
    const thinkingCfg = {
      reasoningEffort: normalizeThinkingEffort(body.reasoningEffort),
      baseUrl: provider.baseUrl,
      model,
      providerPreset: presetKeyFor(provider),
    };
    const startedAt = Date.now();

    try {
      const client = new OpenAI({
        baseURL: normalizeOpenAIBaseUrl(provider.baseUrl),
        apiKey: provider.apiKey || "dummy",
        timeout: TEST_TIMEOUT_MS,
        maxRetries: 0,
      });
      const result = await createCompletionWithThinkingFallback(
        client,
        {
          model,
          messages: [{ role: "user", content: "连通测试：请只回复 OK" }],
          temperature,
          ...buildThinkingParams(thinkingCfg),
        },
        thinkingCfg,
      );
      const text = (result.choices?.[0]?.message?.content || "").trim();
      return {
        ok: true,
        model,
        latencyMs: Date.now() - startedAt,
        reply: text.slice(0, 80),
      };
    } catch (error) {
      return {
        ok: false,
        model,
        latencyMs: Date.now() - startedAt,
        detail: describeTestError(error),
      };
    }
  });

  app.post("/api/settings/providers/:id/models/refresh", async (req, reply) => {
    const id = String((req.params as any).id || "");
    const provider = getModelProviderById(id);
    if (!provider) {
      reply.code(404).send({ detail: "服务商不存在" });
      return;
    }
    const fetchResult = await fetchProviderModels({
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    });
    const fetched = fetchResult.models;
    const models = [...new Set([...provider.models, ...fetched])];
    const updated: ModelProviderRecord = {
      ...provider,
      models,
      enabledModels: provider.modelsConfigured
        ? provider.enabledModels.filter((model) => models.includes(model))
        : models,
      updatedAt: new Date().toISOString(),
    };
    saveModelProviders(
      getModelProviders().map((item) => (item.id === id ? updated : item)),
    );
    return {
      provider: providerResponse(updated),
      fetched,
      fetchOk: fetchResult.ok,
      fetchDetail: fetchResult.detail || "",
      models,
      enabledModels: updated.enabledModels,
    };
  });

  app.put("/api/settings/providers/:id/models", async (req, reply) => {
    const id = String((req.params as any).id || "");
    const provider = getModelProviderById(id);
    if (!provider) {
      reply.code(404).send({ detail: "服务商不存在" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const replacementModels = Array.isArray(body.models) ? uniqueStrings(body.models) : null;
    const models = replacementModels
      ? replacementModels
      : [...new Set([...provider.models, ...uniqueStrings(body.models)])];
    const requestedEnabled = Array.isArray(body.enabledModels)
      ? uniqueStrings(body.enabledModels)
      : provider.enabledModels;
    for (const model of requestedEnabled) {
      if (!models.includes(model)) models.push(model);
    }
    const enabledModels = requestedEnabled.filter((model) => models.includes(model));
    const updated: ModelProviderRecord = {
      ...provider,
      models,
      enabledModels,
      modelsConfigured: true,
      updatedAt: new Date().toISOString(),
    };
    saveModelProviders(
      getModelProviders().map((item) => (item.id === id ? updated : item)),
    );
    return providerResponse(updated);
  });
}
