import type OpenAI from "openai";
import { getRow, saveRow } from "./settingsService.js";

/**
 * Reasoning-effort levels for the thinking control (思考程度).
 *
 * - `default`: send no thinking params, let the upstream decide.
 * - `off`: explicitly ask the upstream to disable thinking.
 * - `low` / `medium` / `high`: ask the upstream to enable thinking at that strength.
 *
 * Whether a provider honors these fields is up to the user; unknown fields are
 * silently ignored by most OpenAI-compatible endpoints. Per-provider quirks are
 * adapted here as they surface.
 */
export type ThinkingEffort = "default" | "off" | "low" | "medium" | "high";

export function normalizeThinkingEffort(raw: unknown): ThinkingEffort {
  const norm = String(raw ?? "").trim().toLowerCase();
  if (norm === "off" || norm === "low" || norm === "medium" || norm === "high") return norm;
  return "default";
}

/** Whether the level asks the upstream to enable thinking (only low/medium/high do). */
export function thinkingEffortIsActive(effort: ThinkingEffort): boolean {
  return effort === "low" || effort === "medium" || effort === "high";
}

/**
 * Legacy desktop `enableThinking` boolean migration. Unlike the mobile app, the
 * desktop boolean was never wired into requests (no UI, never sent upstream), so
 * `false` was a dormant default rather than an explicit "off" — map it to
 * `default` to keep current behavior, and `true` to `medium` as a best guess.
 */
export function effortFromLegacyThinking(legacy: unknown): ThinkingEffort {
  return legacy === true || legacy === "true" ? "medium" : "default";
}

/**
 * Resolve the effort from a settings row: trust the new 5-level key whenever it
 * holds an explicit non-default level; `default` may also mean "key missing, fell
 * back to defaults" on pre-upgrade installs, in which case consult the legacy boolean.
 */
export function resolveReasoningEffort(effortRaw: unknown, legacyEnableThinking: unknown): ThinkingEffort {
  const effort = normalizeThinkingEffort(effortRaw);
  if (effort !== "default") return effort;
  return effortFromLegacyThinking(legacyEnableThinking);
}

export interface ThinkingParamsConfig {
  reasoningEffort?: ThinkingEffort | null;
  baseUrl: string;
  model: string;
  /** Provider preset key; empty/undefined means a user-added gateway endpoint. */
  providerPreset?: string | null;
}

/** DashScope models that reject enable_thinking=false (must be true). */
function dashScopeRequiresThinking(modelId: string): boolean {
  const m = modelId.toLowerCase();
  return m.includes("qwen3.7-max") || m.includes("qwen3_7-max") || m.includes("qwen3.7.max");
}

function supportsThinkingControl(baseUrl: string): boolean {
  return !baseUrl.toLowerCase().includes("googleapis.com");
}

/**
 * Build the thinking-related fields to spread into a chat.completions body.
 * Returns `{}` for the `default` level and for upstreams known to reject disable
 * params, so those requests stay byte-identical to before. The Node OpenAI SDK
 * sends unknown top-level fields verbatim, so no extra_body indirection is needed.
 */
export function buildThinkingParams(cfg: ThinkingParamsConfig): Record<string, unknown> {
  const effort = normalizeThinkingEffort(cfg.reasoningEffort);
  if (effort === "default") return {};
  const active = thinkingEffortIsActive(effort);
  // The "off" level first consults the learned cache: endpoints that reject
  // disable-thinking params with a 400 (forced-thinking gateways such as nex-n2)
  // skip the params entirely and behave like the default level.
  if (!active && disableThinkingUnsupported(cfg.baseUrl, cfg.model)) return {};
  if (!supportsThinkingControl(cfg.baseUrl)) return {};

  const lowerUrl = cfg.baseUrl.toLowerCase();
  if (lowerUrl.includes("dashscope.aliyuncs.com") || lowerUrl.includes(".maas.aliyuncs.com")) {
    // DashScope toggles hybrid thinking via enable_thinking; its DeepSeek does not
    // accept reasoning_effort=none, so "off" only sends enable_thinking=false.
    // qwen3.7-max only accepts true (forced false would 400) — in that corner we
    // still send enable_thinking=true but leave the effort unset for upstream default.
    const effectiveThinking = active || dashScopeRequiresThinking(cfg.model);
    const params: Record<string, unknown> = { enable_thinking: effectiveThinking };
    if (active) params.reasoning_effort = effort;
    return params;
  }
  if (lowerUrl.includes("bigmodel.cn")) {
    // Zhipu GLM: the 5.3 series forces thinking (no disabled allowed); only 5.2+
    // support reasoning_effort, and 5.3 only accepts low/high/max. Dashed ids such
    // as glm-5-2-260617 count as the dotted series.
    const m = cfg.model.toLowerCase().replace(/-/g, ".");
    if (!active) {
      return m.includes("5.3") ? {} : { thinking: { type: "disabled" } };
    }
    const params: Record<string, unknown> = { thinking: { type: "enabled" } };
    if (m.includes("5.3")) {
      params.reasoning_effort = effort === "high" ? "max" : effort === "medium" ? "high" : "low";
    } else if (m.includes("5.2")) {
      params.reasoning_effort = effort;
    }
    return params;
  }
  if (!cfg.providerPreset) {
    // User-added providers / gateways: send the unified reasoning_effort only and
    // let the gateway translate per channel; extra fields make strict upstreams
    // report unknown-field errors.
    return { reasoning_effort: active ? effort : "none" };
  }
  // Known preset providers (volcengine/sensenova/deepseek/openai/...): send both
  // the thinking toggle and the effort.
  return {
    thinking: { type: active ? "enabled" : "disabled" },
    reasoning_effort: active ? effort : "none",
  };
}

// ---- Learned cache for "disable-thinking rejected" endpoints ----

const LLM_THINKING_ROW = "LLM_THINKING";
const DISABLE_THINKING_UNSUPPORTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function disableThinkingCacheKey(baseUrl: string, modelId: string): string {
  const base = String(baseUrl || "").trim().toLowerCase();
  const model = String(modelId || "").trim().toLowerCase();
  if (!base || !model) return "";
  return `${base}|${model}`;
}

function readDisableThinkingUnsupportedMap(): Record<string, number> {
  const row = getRow(LLM_THINKING_ROW) as { disableThinkingUnsupported?: Record<string, number> } | null;
  const parsed = row?.disableThinkingUnsupported;
  if (!parsed || typeof parsed !== "object") return {};
  const now = Date.now();
  const fresh: Record<string, number> = {};
  for (const [key, learnedAt] of Object.entries(parsed)) {
    if (typeof learnedAt === "number" && now - learnedAt < DISABLE_THINKING_UNSUPPORTED_TTL_MS) {
      fresh[key] = learnedAt;
    }
  }
  return fresh;
}

function writeDisableThinkingUnsupportedMap(map: Record<string, number>): void {
  saveRow(LLM_THINKING_ROW, { disableThinkingUnsupported: map });
}

/**
 * Whether this base|model is known to reject disable-thinking params. Model ids
 * containing "nex" (forced-thinking gateway models such as nex-n2) are treated as
 * unsupported right away; the shortcut only affects the disable direction, so it
 * never harms the enable levels.
 */
export function disableThinkingUnsupported(baseUrl: string, modelId: string): boolean {
  if (String(modelId || "").toLowerCase().includes("nex")) return true;
  const key = disableThinkingCacheKey(baseUrl, modelId);
  return Boolean(key && readDisableThinkingUnsupportedMap()[key]);
}

/** Learn that this base|model rejects disable-thinking params (also prunes expired entries). */
export function learnDisableThinkingUnsupported(baseUrl: string, modelId: string): void {
  const key = disableThinkingCacheKey(baseUrl, modelId);
  if (!key) return;
  try {
    const map = readDisableThinkingUnsupportedMap();
    map[key] = Date.now();
    writeDisableThinkingUnsupportedMap(map);
  } catch {
    // A failed cache write must not break the main flow.
  }
}

/** Whether the request carries explicit disable-thinking fields (only the "off" level writes them). */
export function hasDisableThinkingParams(params: Record<string, unknown>): boolean {
  const thinking = params.thinking as { type?: unknown } | undefined;
  if (thinking?.type === "disabled") return true;
  if (params.reasoning_effort === "none") return true;
  if (params.enable_thinking === false) return true;
  return false;
}

/** Strip the disable-thinking fields, keeping every other param untouched. */
export function stripDisableThinkingParams(params: Record<string, unknown>): void {
  delete params.thinking;
  delete params.enable_thinking;
  delete params.reasoning_effort;
}

/** A non-rate-limit 4xx: the upstream explicitly rejected this request, worth retrying without disable params. */
export function isDisableThinkingHttp4xx(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return false;
  // 429 is throttling, not "disabling thinking unsupported" — never learn from it.
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * Non-streaming completion with disable-thinking tolerance: when the request
 * carried disable params and the upstream rejected it with a 4xx (e.g. forced
 * thinking models answering "does not support disabling thinking"), retry once
 * without them. On success the endpoint is written into the learned cache; if the
 * retry also fails the original error is rethrown so the upstream detail survives.
 *
 * The passed `params` object is mutated in place on the retry path to mirror what
 * was actually sent, so callers may trace it verbatim after the call.
 */
export async function createCompletionWithThinkingFallback(
  client: OpenAI,
  params: Record<string, unknown>,
  cfg: ThinkingParamsConfig,
  options: Record<string, unknown> = {},
): Promise<OpenAI.ChatCompletion> {
  const sentDisableThinking = hasDisableThinkingParams(params);
  try {
    return await client.chat.completions.create(
      params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      options,
    );
  } catch (requestError) {
    if (!sentDisableThinking || !isDisableThinkingHttp4xx(requestError)) throw requestError;
    stripDisableThinkingParams(params);
    try {
      const response = await client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
        options,
      );
      learnDisableThinkingUnsupported(cfg.baseUrl, cfg.model);
      return response;
    } catch {
      throw requestError;
    }
  }
}

/**
 * Streaming variant. The upstream rejects bad bodies before the first chunk, so a
 * single retry after stripping disable params is safe (nothing has been emitted yet).
 * Like the non-streaming helper, `params` is mutated on the retry path.
 */
export async function createChatStreamWithThinkingFallback(
  client: OpenAI,
  params: Record<string, unknown>,
  cfg: ThinkingParamsConfig,
  options: Record<string, unknown> = {},
): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>> {
  const sentDisableThinking = hasDisableThinkingParams(params);
  try {
    const stream = await client.chat.completions.create(
      params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      options,
    );
    return stream as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;
  } catch (requestError) {
    if (!sentDisableThinking || !isDisableThinkingHttp4xx(requestError)) throw requestError;
    stripDisableThinkingParams(params);
    try {
      const stream = await client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
        options,
      );
      learnDisableThinkingUnsupported(cfg.baseUrl, cfg.model);
      return stream as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;
    } catch {
      throw requestError;
    }
  }
}
