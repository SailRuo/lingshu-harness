import { getDb } from "../db/sqlite.js";

function localDay(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}

/**
 * Normalised provider usage.
 *
 * Every provider names its cache counters differently, so the raw `usage`
 * object is normalised into one shape here:
 *
 * - OpenAI / DeepSeek / most proxies: `prompt_tokens_details.cached_tokens`
 * - DashScope (Qwen):             `prompt_cache_hit_tokens`
 * - Anthropic-style gateways:     `cache_read_input_tokens` / `cache_creation_input_tokens`
 * - Volcengine (Doubao):          `prompt_tokens_details.cached_tokens`
 *
 * `cachedOutputTokens` stays `null` when the provider reports no output-cache
 * counter at all — the UI must show "not reported" instead of a fake 0 %.
 */
export interface ParsedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedPromptTokens: number;
  /** Input tokens written into the provider's prompt cache by this call. */
  cacheCreationTokens: number;
  /** Output tokens served from an output cache; null = provider does not report it. */
  cachedOutputTokens: number | null;
  reasoningTokens: number;
  /** True when the provider returned a real usage object (not our estimate). */
  reported: boolean;
}

function num(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pick(source: any, keys: string[]): number | null {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    const value = source[key];
    if (value === null || value === undefined) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Read the provider `usage` object into the normalised shape.
 * Returns null when there is nothing usable at all.
 */
export function parseProviderUsage(raw: any): ParsedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const promptTokens = pick(raw, ["prompt_tokens", "promptTokens", "input_tokens"]) ?? 0;
  const completionTokens = pick(raw, ["completion_tokens", "completionTokens", "output_tokens"]) ?? 0;
  const totalTokens =
    pick(raw, ["total_tokens", "totalTokens"]) ?? promptTokens + completionTokens;

  const promptDetails = raw.prompt_tokens_details || raw.promptTokensDetails || null;
  const completionDetails = raw.completion_tokens_details || raw.completionTokensDetails || null;

  const cachedPromptTokens =
    pick(promptDetails, ["cached_tokens", "cachedTokens"]) ??
    pick(raw, [
      "prompt_cache_hit_tokens",
      "cache_read_input_tokens",
      "input_cached_tokens",
      "cached_tokens",
    ]) ??
    0;

  const cacheCreationTokens =
    pick(raw, [
      "cache_creation_input_tokens",
      "prompt_cache_creation_tokens",
      "cache_creation_tokens",
    ]) ?? 0;

  // Output caching is rare; only claim a rate when the provider says so.
  const cachedOutputTokens =
    pick(completionDetails, ["cached_tokens", "cachedTokens"]) ??
    pick(raw, ["output_cached_tokens", "cached_output_tokens", "output_cache_hit_tokens"]);

  const reasoningTokens =
    pick(completionDetails, ["reasoning_tokens", "reasoningTokens"]) ??
    pick(raw, ["reasoning_tokens"]) ??
    0;

  const reported =
    promptTokens > 0 || completionTokens > 0 || totalTokens > 0 || cachedPromptTokens > 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens: Math.min(cachedPromptTokens, promptTokens || cachedPromptTokens),
    cacheCreationTokens,
    cachedOutputTokens,
    reasoningTokens,
    reported,
  };
}

/** Input cache hit rate (0..1). null when the call had no input tokens. */
export function inputCacheHitRate(usage: ParsedUsage | null | undefined): number | null {
  if (!usage || !usage.reported) return null;
  if (usage.promptTokens <= 0) return null;
  return Math.max(0, Math.min(1, usage.cachedPromptTokens / usage.promptTokens));
}

/** Output cache hit rate (0..1). null when the provider does not report it. */
export function outputCacheHitRate(usage: ParsedUsage | null | undefined): number | null {
  if (!usage || !usage.reported) return null;
  if (usage.cachedOutputTokens === null) return null;
  if (usage.completionTokens <= 0) return usage.cachedOutputTokens > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, usage.cachedOutputTokens / usage.completionTokens));
}

export type LlmUsageDimension = "chat" | "memory";

export function recordLlmUsage(
  model: string,
  usage: TokenUsage | ParsedUsage | null | undefined,
  dimension: LlmUsageDimension = "chat",
) {
  if (!usage) return;
  const db = getDb();
  const day = localDay();
  const prompt = Number(usage.promptTokens || 0);
  const rawCached =
    "cachedPromptTokens" in usage
      ? usage.cachedPromptTokens
      : "cachedTokens" in usage
        ? usage.cachedTokens
        : 0;
  const cached = Math.min(Number(rawCached || 0), prompt);
  const uncached = Math.max(0, prompt - cached);
  const output = Number(usage.completionTokens || 0);
  const modelName = model || "unknown";
  db.prepare(
    `INSERT INTO llm_token_usage_daily (day, model, dimension, input_cached, input_uncached, output, calls)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(day, model, dimension) DO UPDATE SET
       input_cached = input_cached + excluded.input_cached,
       input_uncached = input_uncached + excluded.input_uncached,
       output = output + excluded.output,
       calls = calls + 1`,
  ).run(day, modelName, dimension, cached, uncached, output);
}

/**
 * Record one LLM call into the daily rollup, now carrying the cache counters.
 * `cache_creation` (input tokens written into the prompt cache) and
 * `output_cached` are tracked separately from the plain cached/uncached split.
 */
export function recordLlmUsageDetailed(
  model: string,
  usage: ParsedUsage | null | undefined,
  dimension: LlmUsageDimension = "chat",
) {
  if (!usage || !usage.reported) return;
  const db = getDb();
  const day = localDay();
  const cached = Math.min(usage.cachedPromptTokens, usage.promptTokens);
  const uncached = Math.max(0, usage.promptTokens - cached);
  const modelName = model || "unknown";
  db.prepare(
    `INSERT INTO llm_token_usage_daily
       (day, model, dimension, input_cached, input_uncached, output, calls, cache_creation, output_cached)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(day, model, dimension) DO UPDATE SET
       input_cached = input_cached + excluded.input_cached,
       input_uncached = input_uncached + excluded.input_uncached,
       output = output + excluded.output,
       calls = calls + 1,
       cache_creation = cache_creation + excluded.cache_creation,
       output_cached = output_cached + excluded.output_cached`,
  ).run(
    day,
    modelName,
    dimension,
    cached,
    uncached,
    usage.completionTokens,
    usage.cacheCreationTokens,
    usage.cachedOutputTokens || 0,
  );
}

/**
 * Record a non-streaming completion (used by memory pipelines, which do not go
 * through the chat stream). No-op when the provider did not return usage.
 */
export function recordCompletionUsage(
  model: string,
  completion: any,
  dimension: LlmUsageDimension = "memory",
) {
  const parsed = parseProviderUsage(completion?.usage);
  if (!parsed?.reported) return;
  recordLlmUsageDetailed(model, parsed, dimension);
}

export function recordTtsUsage(provider: string, chars: number) {
  if (!chars) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO tts_usage_daily (day, provider, chars, calls)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(day, provider) DO UPDATE SET chars = chars + excluded.chars, calls = calls + 1`,
  ).run(localDay(), provider || "unknown", chars);
}

export function getUsageStats(days = 30) {
  const db = getDb();
  const tokenRows = db
    .prepare(
      `SELECT day AS date, model,
              CASE WHEN dimension = 'memory' THEN 'memory' ELSE 'chat' END AS dimension,
              input_cached AS inputCached,
              input_uncached AS inputUncached, output,
              cache_creation AS cacheCreation, output_cached AS outputCached,
              (input_cached + input_uncached + output) AS total, calls
       FROM llm_token_usage_daily
       ORDER BY day ASC, model ASC`,
    )
    .all() as Record<string, unknown>[];
  const ttsRows = db
    .prepare(
      `SELECT day AS date, provider, chars, calls
       FROM tts_usage_daily
       ORDER BY day ASC, provider ASC`,
    )
    .all() as Record<string, unknown>[];
  const models = [...new Set(tokenRows.map((row) => String(row.model)))].sort();
  const ttsProviders = [...new Set(ttsRows.map((row) => String(row.provider)))].sort();
  return { tokenDaily: tokenRows, ttsDaily: ttsRows, models, ttsProviders, days };
}

export function resetUsage(clearToken = true, clearTts = true) {
  const db = getDb();
  if (clearToken) db.prepare("DELETE FROM llm_token_usage_daily").run();
  if (clearTts) db.prepare("DELETE FROM tts_usage_daily").run();
  return { message: "用量统计已成功重置", ok: true };
}
