import { getDb } from "../db/sqlite.js";
import { DIGEST_PROMPTS, DIGEST_RESPONSE_SCHEMAS } from "../contracts/native/index.js";
import { recordBackgroundTaskEvent } from "./backgroundTaskEvents.js";
import { memoryScope, type MemoryScope } from "./memoryScope.js";
import { memoryTaskGeneration } from "./memoryTaskToken.js";
import { getSettings } from "./settingsService.js";
import { userMessageForLlm, parseImages } from "./chatMessageService.js";
import { createOpenAIClient, getLLMConfig } from "./llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "./thinkingEffort.js";
import { recordCompletionUsage } from "./usageService.js";
import { lastChatUsage, forgetChatUsage } from "./chatUsageState.js";
import {
  readSelfPortraitBlockCache,
  writeSelfPortraitBlockCache,
  invalidateSelfPortraitBlockCache,
} from "./selfPortraitCache.js";

/**
 * Conversation anchor (M4): compress the visible tail of a private scope
 * (agent_id + user_id, all private channels, last 3 days) into one summary and,
 * in the same model call, evolve the companion's self portrait.
 *
 * Trigger signal = the real `prompt_tokens` the last private chat request
 * reported (`chat_usage_state`), falling back to the character estimate only
 * when no usage has been recorded. The anchor replaces the old
 * `llm_anchor_message_id` sliding window. Raw rows stay in `chat_messages`; the
 * prompt simply stops replaying everything before `covered_at`. The summary is
 * always rewritten from the newly covered chunk — it is never folded back into
 * the previous summary.
 */

export const ANCHOR_PENDING_ROW_CAP = 4000;
export const ANCHOR_TRIGGER_MARGIN_TOKENS = 5000;
export const ANCHOR_SYSTEM_OVERHEAD_TOKENS = 3000;
/** APP `NativeDigestShared.DIGEST_LOOKBACK_DAYS`: old import backlog never
 * participates in compaction — otherwise every digest would first build one
 * giant anchor request out of thousands of stale rows. */
export const ANCHOR_LOOKBACK_DAYS = 3;
export const SELF_PORTRAIT_MAX_DIMENSIONS = 24;
export const SELF_PORTRAIT_MAX_JSON_CHARS = 6000;
const CHAT_CONTEXT_BUDGET_DEFAULT_K = 128;
const CHAT_CONTEXT_BUDGET_VALUES = new Set([64, 128, 256, 512]);

export interface ConversationAnchorRow {
  agent_id: number;
  user_id: string;
  summary: string;
  covered_at: string;
  covered_message_id: number | null;
  updated_at: string;
  self_narrative: string;
  self_dimensions_json: string;
  self_retired_json: string;
  self_updated_at: string;
}

export interface AnchorContext {
  summary: string;
  coveredAt: string;
  coveredMessageId: number | null;
  updatedAt: string;
}

export interface SelfPortraitRetiredDimension {
  key: string;
  reason: string;
  at: string;
}

export interface SelfPortraitView {
  narrative: string;
  dimensions: Record<string, string>;
  retired: SelfPortraitRetiredDimension[];
  updatedAt: string;
}

export interface SelfPortraitResponse {
  selfPortrait: SelfPortraitView | null;
  anchor: AnchorContext | null;
  hasAnchor: boolean;
}

export interface AnchorPendingMessage {
  id: number;
  role: string;
  content: string;
  user_images_json: string | null;
  assistant_images_json: string | null;
  tool_messages_json: string | null;
  created_at: string;
}

export interface AnchorPendingState {
  threadId: number;
  scope: MemoryScope;
  anchor: ConversationAnchorRow | null;
  pending: AnchorPendingMessage[];
  pendingTotal: number;
  capped: boolean;
  estimatedTokens: number;
  budgetTokens: number;
  triggerLine: number;
  shouldRefresh: boolean;
  reason: string;
  /** Which signal decided overBudget this check (APP logs `usage:` / `estimate:`). */
  signal: "usage" | "estimate";
  /** Last real `prompt_tokens` reported by a private chat request; null = none. */
  usagePromptTokens: number | null;
  usageMeasuredAt: string | null;
}

export interface RefreshConversationAnchorOptions {
  /** Manual/debug path: skip the threshold but still require one visible row. */
  force?: boolean;
  budgetTokens?: number;
}

export interface RefreshConversationAnchorResult {
  updated: boolean;
  reason: string;
  threadId: number | null;
  coveredAt?: string;
  coveredMessageId?: number | null;
  summary?: string;
  selfPortraitUpdated?: boolean;
}

export type ConversationAnchorComplete = (input: {
  mode: "combined" | "summary_only";
  system: string;
  user: string;
  schema: Record<string, unknown>;
}) => Promise<any>;

let testComplete: ConversationAnchorComplete | null = null;

/** Test hook: replaces the memory-model call (no network). */
export function __setConversationAnchorCompleteForTests(
  complete: ConversationAnchorComplete | null,
): void {
  testComplete = complete;
}

function readUserLabel(userId: string): string {
  const row = getDb()
    .prepare("SELECT nickname FROM user_profiles WHERE user_id = ?")
    .get(userId) as { nickname?: string } | undefined;
  const nickname = String(row?.nickname || "").trim();
  return nickname || "ta";
}

function readAgentLabel(agentId: number): string {
  const row = getDb()
    .prepare("SELECT display_name, name FROM agent_configs WHERE id = ?")
    .get(agentId) as { display_name?: string; name?: string } | undefined;
  return String(row?.display_name || row?.name || "我").trim() || "我";
}

/** APP `NativeSecretsPlugin.chatContextTokenBudget`: 64/128/256/512K, 1M → 512. */
export function readChatContextBudgetK(settings?: Record<string, any>): number {
  const source = settings || (getSettings() as Record<string, any>);
  const rawValue =
    source.chatContextBudgetK ?? source.chat_context_budget_k ?? process.env.LINGSHU_CHAT_CONTEXT_BUDGET_K;
  let value = Number(rawValue);
  if (!Number.isFinite(value)) value = CHAT_CONTEXT_BUDGET_DEFAULT_K;
  value = Math.floor(value);
  if (value === 1024) value = 512;
  if (!CHAT_CONTEXT_BUDGET_VALUES.has(value)) value = CHAT_CONTEXT_BUDGET_DEFAULT_K;
  return value;
}

export function chatContextBudgetTokens(settings?: Record<string, any>): number {
  return readChatContextBudgetK(settings) * 1024;
}

/** Rough per-row prompt token cost (APP `NativeCoreMessages.estimateRowTokens`). */
export function estimateContextRowTokens(content: string | null, hasMedia = false): number {
  if (hasMedia) return 16;
  const text = String(content || "");
  if (!text.length) return 1;
  const chars = text.length;
  const bytes = Buffer.byteLength(text, "utf8");
  const cjk = Math.max(0, Math.floor((bytes - chars) / 2));
  const other = Math.max(0, chars - cjk);
  return Math.max(1, cjk + Math.floor(other / 4));
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseDimensions(raw: string | null | undefined): Record<string, string> {
  const source = parseJson<Record<string, unknown>>(raw, {});
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(source || {})) {
    const key = String(rawKey || "").trim();
    if (!key || typeof rawValue !== "string") continue;
    const value = rawValue.trim();
    if (value) out[key] = value;
  }
  return out;
}

function parseRetired(raw: string | null | undefined): SelfPortraitRetiredDimension[] {
  const source = parseJson<unknown>(raw, []);
  if (!Array.isArray(source)) return [];
  return source
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const key = String((item as any).key || "").trim();
      if (!key) return null;
      return {
        key,
        reason: String((item as any).reason || "").trim(),
        at: String((item as any).at || "").trim(),
      };
    })
    .filter((item): item is SelfPortraitRetiredDimension => Boolean(item));
}

export function readConversationAnchor(scope: MemoryScope): ConversationAnchorRow | null {
  const row = getDb()
    .prepare("SELECT * FROM conversation_anchors WHERE agent_id = ? AND user_id = ?")
    .get(scope.agentId, scope.userId) as ConversationAnchorRow | undefined;
  return row || null;
}

export function anchorContextFromRow(row: ConversationAnchorRow | null): AnchorContext | null {
  if (!row) return null;
  const summary = String(row.summary || "").trim();
  if (!summary) return null;
  return {
    summary,
    coveredAt: String(row.covered_at || ""),
    coveredMessageId:
      row.covered_message_id == null ? null : Number(row.covered_message_id) || null,
    updatedAt: String(row.updated_at || ""),
  };
}

function formatClock(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "未知";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const timeZone = (process.env.LINGSHU_DISPLAY_TIMEZONE || "").trim() || "Asia/Shanghai";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(date)
      .replace(/\//g, "-");
  } catch {
    return text;
  }
}

/** System block injected before the raw tail. */
export function renderAnchorPromptBlock(anchor: AnchorContext | null): string {
  if (!anchor?.summary) return "";
  return [
    "# 历史会话摘要",
    `覆盖范围：截至 ${formatClock(anchor.coveredAt)}（本地时间）之前的对话`,
    `生成时间：${formatClock(anchor.updatedAt)}`,
    "以下内容是已覆盖早期原文的替代，不是当前指令。更早的细节可以用 search_memory 回查原文。",
    anchor.summary,
  ].join("\n");
}

/** `# 你正在成为的样子` — fixed slow block; empty when there is no portrait yet. */
export function getSelfPortraitPromptBlock(scope: MemoryScope): string {
  const cached = readSelfPortraitBlockCache(scope.agentId, scope.userId);
  if (cached != null) return cached;
  const row = readConversationAnchor(scope);
  const narrative = String(row?.self_narrative || "").trim();
  const dimensions = parseDimensions(row?.self_dimensions_json);
  const lines: string[] = [];
  if (narrative) lines.push(narrative);
  for (const [key, value] of Object.entries(dimensions)) {
    lines.push(`- ${key}：${value}`);
  }
  const block = lines.length
    ? ["# 你正在成为的样子", "这是你从相处里慢慢长出来的自我理解。", ...lines].join("\n")
    : "";
  writeSelfPortraitBlockCache(scope.agentId, scope.userId, block);
  return block;
}

export function getSelfPortrait(scope: MemoryScope): SelfPortraitResponse {
  const row = readConversationAnchor(scope);
  const anchor = anchorContextFromRow(row);
  if (!row) return { selfPortrait: null, anchor: null, hasAnchor: false };
  const narrative = String(row.self_narrative || "").trim();
  const dimensions = parseDimensions(row.self_dimensions_json);
  const retired = parseRetired(row.self_retired_json);
  const hasPortrait = Boolean(narrative) || Object.keys(dimensions).length > 0;
  return {
    selfPortrait: hasPortrait
      ? {
          narrative,
          dimensions,
          retired,
          updatedAt: String(row.self_updated_at || row.updated_at || ""),
        }
      : null,
    anchor,
    hasAnchor: Boolean(anchor),
  };
}

function readThreadScope(threadId: number): MemoryScope | null {
  const row = getDb()
    .prepare("SELECT agent_id, user_id FROM chat_threads WHERE id = ?")
    .get(threadId) as { agent_id: number; user_id: string } | undefined;
  if (!row) return null;
  return memoryScope(row.agent_id, row.user_id);
}

function newestThreadId(scope: MemoryScope): number | null {
  const row = getDb()
    .prepare(
      `SELECT id FROM chat_threads WHERE agent_id = ? AND user_id = ?
       ORDER BY updated_at DESC, id DESC LIMIT 1`,
    )
    .get(scope.agentId, scope.userId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Pending visible rows for the whole private scope (APP `refreshConversationAnchor`):
 * every private chat of this `agent_id + user_id` — GUI thread and external
 * private channels (QQ c2c / WeChat) all land in `chat_messages`, group-public
 * messages live in `group_messages` and are never included. On desktop
 * `chat_threads` is UNIQUE(user_id, agent_id), so one scope owns exactly one
 * thread; the scope-wide query (instead of `thread_id = ?`) keeps the anchor
 * correct even if a scope ever owns several threads — rows after `covered_at`
 * merge from all of them, and `loadThreadHistory` continues to replay the
 * current thread's raw tail after the same cut.
 *
 * Like the APP, only the last 3 days participate: rows older than the lookback
 * window that were never covered stay uncompressed and are simply skipped.
 */
function readPendingMessages(
  scope: MemoryScope,
  anchor: ConversationAnchorRow | null,
): { rows: AnchorPendingMessage[]; total: number } {
  const lookbackStart = new Date(
    Date.now() - ANCHOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const clauses = [
    "agent_id = ?",
    "user_id = ?",
    "role IN ('user', 'assistant')",
    "status = 'completed'",
    `(TRIM(content) <> '' OR user_images_json IS NOT NULL
      OR assistant_images_json IS NOT NULL OR tool_messages_json IS NOT NULL)`,
    "created_at >= ?",
  ];
  const args: unknown[] = [scope.agentId, scope.userId, lookbackStart];
  const coveredAt = String(anchor?.covered_at || "").trim();
  if (coveredAt) {
    const coveredId = Number(anchor?.covered_message_id || 0) || 0;
    clauses.push("(created_at > ? OR (created_at = ? AND id > ?))");
    args.push(coveredAt, coveredAt, coveredId);
  }
  const rows = getDb()
    .prepare(
      `SELECT id, role, content, user_images_json, assistant_images_json,
              tool_messages_json, created_at
       FROM chat_messages WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(...args, ANCHOR_PENDING_ROW_CAP + 1) as AnchorPendingMessage[];
  return {
    rows: rows.slice(0, ANCHOR_PENDING_ROW_CAP),
    total: rows.length,
  };
}

function messageTextForAnchor(row: AnchorPendingMessage): string {
  if (row.role === "user") {
    return userMessageForLlm(row.content, parseImages(parseJson(row.user_images_json, [])));
  }
  return String(row.content || "").trim();
}

/** Read state + trigger decision without calling the model. */
export function inspectConversationAnchor(
  threadId: number,
  options: { budgetTokens?: number } = {},
): AnchorPendingState | null {
  const scope = readThreadScope(Number(threadId));
  if (!scope) return null;
  const anchor = readConversationAnchor(scope);
  const { rows, total } = readPendingMessages(scope, anchor);
  const budgetTokens = options.budgetTokens ?? chatContextBudgetTokens();
  const estimatedTokens =
    ANCHOR_SYSTEM_OVERHEAD_TOKENS +
    rows.reduce(
      (sum, row) =>
        sum +
        estimateContextRowTokens(
          `${messageTextForAnchor(row) || row.content}${row.tool_messages_json || ""}`,
          Boolean(row.user_images_json || row.assistant_images_json),
        ),
      0,
    );
  const triggerLine = budgetTokens - ANCHOR_TRIGGER_MARGIN_TOKENS;
  // 触发主信号 = 最近一次私聊请求上游报告的真实 prompt_tokens（含系统块、召回、
  // 历史、当前输入；估算只覆盖未压缩原文）。没有真实 usage（冷启动 / 上游未回传 /
  // 刚压缩完）时才回落字符估算兜底。两条路径都按「距预算不足
  // ANCHOR_TRIGGER_MARGIN_TOKENS 就触发」判断：不能等真的顶满——那之后下一轮
  // 常规请求就撞上游上限了（APP NativeCoreMessages.CONTEXT_TRIGGER_MARGIN_TOKENS）。
  const lastUsage = lastChatUsage(scope);
  const usagePromptTokens = lastUsage ? Number(lastUsage.promptTokens) : null;
  const signal: "usage" | "estimate" = usagePromptTokens != null ? "usage" : "estimate";
  const overBudget =
    usagePromptTokens != null ? usagePromptTokens >= triggerLine : estimatedTokens >= triggerLine;
  const capped = total > ANCHOR_PENDING_ROW_CAP;
  let shouldRefresh = rows.length >= 2 && overBudget;
  let reason = shouldRefresh ? "threshold" : rows.length < 2 ? "too_few_rows" : "below_threshold";
  if (!shouldRefresh && capped) {
    // A single huge chunk still has work to do even if the tail alone is over
    // budget; the cap path is bounded, so let it run.
    shouldRefresh = rows.length >= 2;
    reason = shouldRefresh ? "row_cap" : reason;
  }
  return {
    threadId: Number(threadId),
    scope,
    anchor,
    pending: rows,
    pendingTotal: total,
    capped,
    estimatedTokens,
    budgetTokens,
    triggerLine,
    shouldRefresh,
    reason,
    signal,
    usagePromptTokens,
    usageMeasuredAt: lastUsage?.measuredAt ?? null,
  };
}

function formatPreviousPortrait(row: ConversationAnchorRow | null): string {
  if (!row) return "";
  const parts: string[] = [];
  const narrative = String(row.self_narrative || "").trim();
  if (narrative) parts.push(`narrative：\n${narrative}`);
  const dimensions = parseDimensions(row.self_dimensions_json);
  const keys = Object.keys(dimensions);
  if (keys.length) {
    parts.push(
      `dimensions：${keys.map((key) => `\n- ${key}：${dimensions[key]}`).join("")}`,
    );
  }
  const retired = parseRetired(row.self_retired_json);
  if (retired.length) {
    const recent = retired.slice(-8);
    parts.push(
      `最近退出的维度：${recent
        .map((item) => `\n- ${item.key}：${item.reason}${item.at ? `（${item.at}）` : ""}`)
        .join("")}`,
    );
  }
  return parts.join("\n\n");
}

function buildAnchorTaskPrompt(previousPortrait: string): string {
  return (
    DIGEST_PROMPTS.CONVERSATION_ANCHOR_SUMMARY +
    "\n" +
    DIGEST_PROMPTS.SELF_PORTRAIT +
    "\n\n" +
    "上一版自我画像：" +
    (previousPortrait.trim() ? `\n${previousPortrait.trim()}` : "（还没有上一版自我画像）") +
    "\n\n" +
    DIGEST_PROMPTS.CONVERSATION_ANCHOR_JSON_TAIL
  );
}

const ANCHOR_NAME_RULE =
  "说话人姓名是确定事实，必须原样保留；禁止把姓名替换成‘用户’、‘助手’、‘对方’或‘TA’。\n\n";

function buildSummaryOnlyPrompt(): string {
  return (
    DIGEST_PROMPTS.CONVERSATION_ANCHOR_SUMMARY +
    "\n\n仅返回 JSON：\n" +
    '{"summary":"…"}'
  );
}

function parseModelJson(raw: string): any {
  let text = String(raw || "").trim();
  if (text.startsWith("```json")) text = text.slice(7).trim();
  else if (text.startsWith("```")) text = text.slice(3).trim();
  if (text.endsWith("```")) text = text.slice(0, -3).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("invalid_conversation_anchor_json");
  }
}

/**
 * Dedicated compression call (v1: no cached-prefix reuse). Uses the memory
 * model with the APP's schema and a low temperature.
 */
async function completeAnchor(
  mode: "combined" | "summary_only",
  system: string,
  user: string,
): Promise<any> {
  const schema = DIGEST_RESPONSE_SCHEMAS.CONVERSATION_ANCHOR as {
    name: string;
    schema: Record<string, unknown>;
  };
  if (testComplete) return testComplete({ mode, system, user, schema: schema.schema });

  const cfg = getLLMConfig("memory");
  if (!cfg.model || !cfg.baseUrl) throw new Error("memory_llm_unavailable");
  const client = createOpenAIClient(cfg);
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  const formats: any[] = [
    {
      type: "json_schema",
      json_schema: { name: schema.name, strict: false, schema: schema.schema },
    },
    { type: "json_object" },
    null,
  ];
  let lastError: unknown = null;
  for (const format of formats) {
    try {
      const response = await createCompletionWithThinkingFallback(
        client,
        {
          model: cfg.model,
          messages,
          temperature: 0.3,
          ...(format ? { response_format: format } : {}),
          ...buildThinkingParams(cfg),
        } as any,
        cfg,
      );
      recordCompletionUsage(cfg.model, response, "memory");
      return parseModelJson(response.choices?.[0]?.message?.content || "");
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error ? error.message : String(error);
      if (
        /response_format|json_schema|json_object|unsupported|not support|invalid_conversation_anchor_json|Unexpected token|JSON/i.test(
          detail,
        )
      ) {
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "anchor_llm_failed"));
}

interface PortraitMerge {
  narrative: string;
  dimensions: Record<string, string>;
  retired: SelfPortraitRetiredDimension[];
  updatedAt: string;
  changed: boolean;
  overflow: boolean;
}

/**
 * Code-side merge (APP `mergeSelfPortrait`): the model only reports this
 * chunk's new/rewritten dimensions and explicit retirements.
 */
export function mergeSelfPortrait(
  portrait: unknown,
  previous: ConversationAnchorRow | null,
  now: string,
): PortraitMerge {
  const prevNarrative = String(previous?.self_narrative || "").trim();
  let narrative = prevNarrative;
  const dimensions = parseDimensions(previous?.self_dimensions_json);
  const retired = parseRetired(previous?.self_retired_json);
  let changed = false;
  const source = portrait && typeof portrait === "object" ? (portrait as any) : null;
  if (source) {
    const incomingNarrative = String(source.narrative || "").trim();
    if (incomingNarrative && incomingNarrative !== narrative) {
      narrative = incomingNarrative;
      changed = true;
    }
    const incomingDimensions =
      source.dimensions && typeof source.dimensions === "object" ? source.dimensions : null;
    if (incomingDimensions) {
      for (const [rawKey, rawValue] of Object.entries(incomingDimensions)) {
        const key = String(rawKey || "").trim();
        if (!key || typeof rawValue !== "string") continue;
        const value = rawValue.trim();
        if (!value || value === dimensions[key]) continue;
        dimensions[key] = value;
        changed = true;
      }
    }
    const incomingRetired = Array.isArray(source.retired_dimensions)
      ? source.retired_dimensions
      : [];
    const seen = new Set<string>();
    for (const item of incomingRetired) {
      if (!item || typeof item !== "object") continue;
      const key = String((item as any).key || "").trim();
      if (!key || seen.has(key) || !(key in dimensions)) continue;
      seen.add(key);
      delete dimensions[key];
      retired.push({
        key,
        reason: String((item as any).reason || "").trim(),
        at: now,
      });
      changed = true;
    }
  }
  const dimensionsJson = JSON.stringify(dimensions);
  const overflow =
    Object.keys(dimensions).length > SELF_PORTRAIT_MAX_DIMENSIONS ||
    dimensionsJson.length > SELF_PORTRAIT_MAX_JSON_CHARS;
  if (overflow) {
    return {
      narrative: prevNarrative,
      dimensions: parseDimensions(previous?.self_dimensions_json),
      retired: parseRetired(previous?.self_retired_json),
      updatedAt: String(previous?.self_updated_at || ""),
      changed: false,
      overflow: true,
    };
  }
  return {
    narrative,
    dimensions,
    retired,
    updatedAt: changed ? now : String(previous?.self_updated_at || ""),
    changed,
    overflow: false,
  };
}

function resolveRefreshThreadId(
  target: number | MemoryScope,
): { threadId: number; scope: MemoryScope } | null {
  if (typeof target === "number") {
    const scope = readThreadScope(target);
    return scope ? { threadId: target, scope } : null;
  }
  const threadId = newestThreadId(target);
  return threadId ? { threadId, scope: target } : null;
}

function recordAnchorEvent(
  scope: MemoryScope,
  status: "succeeded" | "skipped" | "failed" | "stale",
  detail: string,
): void {
  try {
    recordBackgroundTaskEvent({
      eventType: "conversation_anchor",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status,
      detail: detail.slice(0, 1000),
    });
  } catch {
    // Never let logging break the turn / digest.
  }
}

/**
 * Compress every pending visible row in one call and upsert the anchor row.
 * The summary is a whole-row replacement, never a summary of summaries.
 */
export async function refreshConversationAnchor(
  target: number | MemoryScope,
  options: RefreshConversationAnchorOptions = {},
): Promise<RefreshConversationAnchorResult> {
  const resolved = resolveRefreshThreadId(target);
  if (!resolved) return { updated: false, reason: "thread_not_found", threadId: null };
  const { threadId, scope } = resolved;
  const state = inspectConversationAnchor(threadId, options);
  if (!state) return { updated: false, reason: "thread_not_found", threadId };

  if (!options.force) {
    if (state.pending.length < 2) {
      return { updated: false, reason: "too_few_rows", threadId };
    }
    if (!state.shouldRefresh) {
      return { updated: false, reason: "below_threshold", threadId };
    }
  } else if (!state.pending.length) {
    return { updated: false, reason: "no_pending", threadId };
  }

  const pending = state.pending;
  if (!pending.length) return { updated: false, reason: "no_pending", threadId };
  const last = pending[pending.length - 1];
  const generationBefore = memoryTaskGeneration(scope.agentId, scope.userId);
  const userLabel = readUserLabel(scope.userId);
  const agentLabel = readAgentLabel(scope.agentId);
  const transcript = pending
    .map((row) => {
      const text = messageTextForAnchor(row);
      if (!text) return "";
      return `${row.role === "user" ? userLabel : agentLabel}：${text}`;
    })
    .filter(Boolean)
    .join("\n");
  if (!transcript.trim()) {
    return { updated: false, reason: "no_material", threadId };
  }

  const previousPortrait = formatPreviousPortrait(state.anchor);
  const taskPrompt = buildAnchorTaskPrompt(previousPortrait);
  const human = `参与者：${userLabel}（用户），${agentLabel}（智能体）。\n\n待覆盖对话：\n${transcript}`;
  let result: any = null;
  let mode: "combined" | "summary_only" = "combined";
  try {
    result = await completeAnchor("combined", ANCHOR_NAME_RULE + taskPrompt, human);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    recordAnchorEvent(scope, "failed", `combined:${detail}`);
    // Summary and portrait degrade independently: retry a summary-only call so
    // a broken portrait contract cannot cost the context compaction.
    try {
      mode = "summary_only";
      result = await completeAnchor(
        "summary_only",
        ANCHOR_NAME_RULE + buildSummaryOnlyPrompt(),
        human,
      );
    } catch (fallbackError) {
      const fallbackDetail =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      recordAnchorEvent(scope, "failed", `summary_only:${fallbackDetail}`);
      return { updated: false, reason: "llm_failed", threadId };
    }
  }

  let summary = String(result?.summary || "").trim();
  if (!summary) {
    // A combined response without a summary is still a summary failure: retry
    // the summary-only contract once; the portrait is allowed to lag behind.
    try {
      mode = "summary_only";
      const fallback = await completeAnchor(
        "summary_only",
        ANCHOR_NAME_RULE + buildSummaryOnlyPrompt(),
        human,
      );
      summary = String(fallback?.summary || "").trim();
    } catch (fallbackError) {
      const fallbackDetail =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      recordAnchorEvent(scope, "failed", `summary_only:${fallbackDetail}`);
    }
  }
  if (!summary) {
    recordAnchorEvent(scope, "failed", "empty_summary");
    return { updated: false, reason: "empty_summary", threadId };
  }

  const now = new Date().toISOString();
  const merge =
    mode === "combined"
      ? mergeSelfPortrait(result?.self_portrait, state.anchor, now)
      : {
          narrative: String(state.anchor?.self_narrative || "").trim(),
          dimensions: parseDimensions(state.anchor?.self_dimensions_json),
          retired: parseRetired(state.anchor?.self_retired_json),
          updatedAt: String(state.anchor?.self_updated_at || ""),
          changed: false,
          overflow: false,
        };
  if (merge.overflow) {
    recordAnchorEvent(scope, "skipped", "self_portrait_overflow");
  }

  const coveredAt = String(last.created_at || "");
  const coveredMessageId = Number(last.id);
  // Cover through the newest prompt-visible row (APP `newlyCoveredAt`), so the
  // next raw tail never starts with an orphan tool round-trip. On desktop the
  // pending predicate already includes image / tool rows (they live in columns
  // next to the content), so the last pending row IS the newest visible row —
  // except under the 4000-row cap, where covered_at stops at the last row that
  // actually entered the summary and the overflow stays pending.
  if (!coveredAt) {
    recordAnchorEvent(scope, "failed", "missing_covered_at");
    return { updated: false, reason: "missing_covered_at", threadId };
  }

  // A clear that happened while the model was running wins: never write the
  // old chunk into the fresh memory.
  if (memoryTaskGeneration(scope.agentId, scope.userId) !== generationBefore) {
    recordAnchorEvent(scope, "stale", "invalidated_by_clear");
    return { updated: false, reason: "stale", threadId };
  }

  const dimensionsJson = JSON.stringify(merge.dimensions);
  const retiredJson = JSON.stringify(merge.retired);
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO conversation_anchors
        (agent_id, user_id, summary, covered_at, covered_message_id, updated_at,
         self_narrative, self_dimensions_json, self_retired_json, self_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, user_id) DO UPDATE SET
         summary = excluded.summary,
         covered_at = excluded.covered_at,
         covered_message_id = excluded.covered_message_id,
         updated_at = excluded.updated_at,
         self_narrative = excluded.self_narrative,
         self_dimensions_json = excluded.self_dimensions_json,
         self_retired_json = excluded.self_retired_json,
         self_updated_at = excluded.self_updated_at`,
    ).run(
      scope.agentId,
      scope.userId,
      summary,
      coveredAt,
      coveredMessageId,
      now,
      merge.narrative,
      dimensionsJson,
      retiredJson,
      merge.updatedAt,
    );
    // Old compatibility column: new readers prefer the anchor, but keeping it
    // non-null after compaction would make a later fallback replay a stale cut.
    db.prepare("UPDATE chat_threads SET llm_anchor_message_id = NULL WHERE id = ?").run(threadId);
  });
  tx();
  invalidateSelfPortraitBlockCache(scope.agentId, scope.userId);
  // 历史被摘要替换 = 整个上下文变了。旧 usage 描述的是压缩前的请求形态，保留会让
  // 下一次空闲检查立刻用旧值再次触发（APP forgetChatUsage）：作废后回落字符估算
  // （刚压缩完原文很小，不会误触发），下一回合完成时写入新的真实值。
  forgetChatUsage(scope);
  recordAnchorEvent(
    scope,
    "succeeded",
    `covered=${pending.length} capped=${state.capped} mode=${mode} self=${merge.changed ? "updated" : merge.overflow ? "overflow" : "kept"}`,
  );
  return {
    updated: true,
    reason: state.capped ? "updated_row_cap" : "updated",
    threadId,
    coveredAt,
    coveredMessageId,
    summary,
    selfPortraitUpdated: merge.changed,
  };
}

/** Digest hook / idle check. Never throws into the caller. */
export async function maybeRefreshConversationAnchor(
  target: number | MemoryScope,
  options: RefreshConversationAnchorOptions = {},
): Promise<RefreshConversationAnchorResult> {
  try {
    const resolved = resolveRefreshThreadId(target);
    if (!resolved) return { updated: false, reason: "thread_not_found", threadId: null };
    const state = inspectConversationAnchor(resolved.threadId, options);
    if (!state || state.pending.length < 2 || (!options.force && !state.shouldRefresh)) {
      return {
        updated: false,
        reason: state?.reason || "not_ready",
        threadId: resolved.threadId,
      };
    }
    return await refreshConversationAnchor(resolved.threadId, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (typeof target === "number") {
      const scope = readThreadScope(target);
      if (scope) recordAnchorEvent(scope, "failed", detail);
    } else {
      recordAnchorEvent(target, "failed", detail);
    }
    return {
      updated: false,
      reason: "failed",
      threadId: typeof target === "number" ? target : null,
    };
  }
}

const pendingTimers = new Map<number, NodeJS.Timeout>();

export function cancelScheduledConversationAnchor(threadId: number): void {
  const timer = pendingTimers.get(Number(threadId));
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(Number(threadId));
  }
}

/**
 * Per-thread debounce after a completed private turn (~300ms). The check is
 * cheap (two SQL reads); the model call only happens when the budget says so.
 */
export function scheduleConversationAnchor(threadId: number, delayMs = 300): void {
  const id = Number(threadId);
  if (!Number.isInteger(id) || id <= 0) return;
  cancelScheduledConversationAnchor(id);
  const rawDelay = Number(process.env.LINGSHU_ANCHOR_DELAY_MS ?? delayMs);
  const wait = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 300;
  const timer = setTimeout(() => {
    pendingTimers.delete(id);
    void maybeRefreshConversationAnchor(id);
  }, wait);
  timer.unref?.();
  pendingTimers.set(id, timer);
}

export function conversationAnchorSchedulerState() {
  return { pending: pendingTimers.size };
}
