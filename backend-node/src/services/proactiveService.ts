import { getDb } from "../db/sqlite.js";
import { logTick } from "./memoryService.js";
import { getAgent } from "./agentService.js";
import { getProactiveRoute } from "./proactiveRouteService.js";
import { qqBotClientForAgent } from "./qqbotGateway.js";
import { sendWechatText } from "./wechatService.js";
import { createOpenAIClient, getLLMConfig } from "./llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "./thinkingEffort.js";
import { appendAssistantOnly } from "./chatMessageService.js";
import {
  ensureThread,
  getThread,
  getThreadForAgent,
  normalizeUserId,
  recalculateUnreadCount,
  type ChatThreadRow,
} from "./chatThreadService.js";
import { dayWindow, displayTimeZone, zonedParts } from "./memoryTime.js";
import { getGeneralSettings } from "./settingsService.js";
import { sessionHub } from "./sessionHub.js";

export const PROACTIVE_DEFAULTS = {
  pressureThreshold: 1.0,
  growthPerTick: 0.1,
  initFactor: 0.15,
  topK: 5,
  cooldownHours: 48,
  engagedHours: 168,
  tickSeconds: 300,
  dailyLimit: 100,
  userSilencePeakGrowth: 0.35,
  userSilenceMinGrowth: 0.01,
  userSilenceDecayDays: 7.0,
  unansweredStreakLimit: 3,
  dndStartHour: 0,
  dndEndHour: 5,
  enabled: true,
};

export interface ProactiveConfig {
  pressureThreshold: number;
  growthPerTick: number;
  initFactor: number;
  topK: number;
  cooldownHours: number;
  engagedHours: number;
  tickSeconds: number;
  dailyLimit: number;
  userSilencePeakGrowth: number;
  userSilenceMinGrowth: number;
  userSilenceDecayDays: number;
  unansweredStreakLimit: number;
  // null = 免打扰未配置（Python: settings 未填 → 回落 env 默认；env 也为 null → 不静默）
  dndStartHour: number | null;
  dndEndHour: number | null;
  enabled: boolean;
}

// Mirrors backend/core/companion/stream_metrics.py
const PROACTIVE_PENALTY_FULL_HOURS = 24;
const PROACTIVE_PENALTY_PARTIAL_HOURS = 24 * 7;
const PROACTIVE_PENALTY_PARTIAL_FACTOR = 0.3;
const SIGNIFICANCE_DEFAULT = 0.5;
const SIGNIFICANCE_MIN = 0.1;
const SIGNIFICANCE_MAX = 1.0;

interface PoolEntry {
  streamId: string;
  narrative: string;
  candidateWeight: number;
  significance: number;
  pressure: number;
  streamCreatedAt: string | null;
  lastProactiveAt: string | null;
}

interface PoolState {
  agentId: number;
  userId: string;
  threadId: number | null;
  entries: Map<string, PoolEntry>;
  engagedUntil: Map<string, number>;
}

const pools = new Map<string, PoolState>();
let runtimeOverrides: Record<string, unknown> = {};
let lastTickAt: string | null = null;
let tickCount = 0;
let schedulerRunning = false;

function poolKey(agentId: number, userId: string) {
  return `${agentId}:${userId}`;
}

function persistedOverrides(): Record<string, unknown> {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings_rows WHERE id = 'PROACTIVE_POOL'").get() as
    | { value: string }
    | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value);
  } catch {
    return {};
  }
}

/**
 * Read the user-facing proactive settings. Python reads the same flat keys from
 * the `GENERAL` settings row via `ConfigService._normalize_flat_settings` and
 * re-exposes them as `model.proactive.{enabled,dnd_start_hour,dnd_end_hour}`,
 * so `general.proactiveEnabled` is the exact counterpart of Python's
 * `proactive.enabled`, and `general.proactiveDnd*Hour` of `proactive.dnd_*_hour`.
 */
function proactiveSettings(): {
  enabled: boolean | null;
  dndStartHour: number | null;
  dndEndHour: number | null;
} {
  let settings: Record<string, unknown> = {};
  try {
    settings = getGeneralSettings() as Record<string, unknown>;
  } catch {
    settings = {};
  }
  const asHour = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    enabled: typeof settings.proactiveEnabled === "boolean" ? settings.proactiveEnabled : null,
    dndStartHour: asHour(settings.proactiveDndStartHour),
    dndEndHour: asHour(settings.proactiveDndEndHour),
  };
}

function effectiveConfig(): ProactiveConfig {
  const settings = proactiveSettings();
  const overrides = { ...persistedOverrides(), ...runtimeOverrides } as Partial<ProactiveConfig>;
  // Python `_in_dnd_window`: settings 为 null 表示「未配置」→ 回落 env 默认 0/5，
  // 而不是「关闭免打扰」。settings 有值才用 settings 的值。
  const dndStartHour =
    overrides.dndStartHour !== undefined && overrides.dndStartHour !== null
      ? overrides.dndStartHour
      : settings.dndStartHour !== null
        ? settings.dndStartHour
        : PROACTIVE_DEFAULTS.dndStartHour;
  const dndEndHour =
    overrides.dndEndHour !== undefined && overrides.dndEndHour !== null
      ? overrides.dndEndHour
      : settings.dndEndHour !== null
        ? settings.dndEndHour
        : PROACTIVE_DEFAULTS.dndEndHour;
  const enabled =
    overrides.enabled !== undefined
      ? Boolean(overrides.enabled)
      : settings.enabled !== null
        ? settings.enabled
        : PROACTIVE_DEFAULTS.enabled;
  return {
    ...PROACTIVE_DEFAULTS,
    ...overrides,
    dndStartHour,
    dndEndHour,
    enabled,
  } as ProactiveConfig;
}

function persistOverrides(overrides: Record<string, unknown>) {
  const db = getDb();
  db.prepare(
    "INSERT INTO settings_rows (id, value) VALUES ('PROACTIVE_POOL', ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(overrides));
}

export function getProactiveConfig() {
  return effectiveConfig();
}

const POOL_REBUILD_KEYS = new Set([
  "pressureThreshold",
  "growthPerTick",
  "initFactor",
  "topK",
  "cooldownHours",
  "engagedHours",
  "dailyLimit",
]);

export function patchProactiveConfig(patch: Record<string, unknown>) {
  const allowed = Object.keys(PROACTIVE_DEFAULTS);
  const nextRuntime: Record<string, unknown> = { ...runtimeOverrides };
  let rebuild = false;
  for (const [key, value] of Object.entries(patch)) {
    if (allowed.includes(key) && key !== "enabled") {
      nextRuntime[key] = value;
      if (POOL_REBUILD_KEYS.has(key)) rebuild = true;
    }
  }
  runtimeOverrides = nextRuntime;
  const persisted = { ...persistedOverrides(), ...nextRuntime };
  persistOverrides(persisted);
  if (rebuild) pools.clear();
  return getProactiveConfig();
}

export function resetProactiveConfig() {
  runtimeOverrides = {};
  pools.clear();
  persistOverrides({});
  return getProactiveConfig();
}

function scopes(): { agentId: number; userId: string }[] {
  return getDb()
    .prepare(
      "SELECT DISTINCT agent_id AS agentId, user_id AS userId FROM hippocampus_streams WHERE archived = 0",
    )
    .all() as { agentId: number; userId: string }[];
}

function clampSignificance(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return SIGNIFICANCE_DEFAULT;
  return Math.max(SIGNIFICANCE_MIN, Math.min(SIGNIFICANCE_MAX, parsed));
}

function streamFreshness(createdAt: string | null, nowMs: number): number {
  if (!createdAt) return 1;
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  const ageDays = Math.max(0, (nowMs - created) / 86_400_000);
  return Math.max(0, Math.min(1, 1 - 0.02 * ageDays));
}

function proactivePenalty(lastProactiveAt: string | null, nowMs: number): number {
  if (!lastProactiveAt) return 1;
  const touched = new Date(lastProactiveAt).getTime();
  if (!Number.isFinite(touched)) return 1;
  const hours = Math.max(0, (nowMs - touched) / 3_600_000);
  if (hours < PROACTIVE_PENALTY_FULL_HOURS) return 0;
  if (hours < PROACTIVE_PENALTY_PARTIAL_HOURS) return PROACTIVE_PENALTY_PARTIAL_FACTOR;
  return 1;
}

function candidateWeight(row: any, nowMs: number): number {
  return (
    streamFreshness(row.created_at ?? null, nowMs) *
    clampSignificance(row.significance) *
    proactivePenalty(row.last_proactive_at ?? null, nowMs)
  );
}

function userSilenceGrowthFactor(hoursSinceLastUser: number | null, config: ProactiveConfig): number {
  const peak = Number(config.userSilencePeakGrowth);
  const min = Number(config.userSilenceMinGrowth);
  const decayDays = Number(config.userSilenceDecayDays);
  if (hoursSinceLastUser === null) return peak;
  const hours = Math.max(0, hoursSinceLastUser);
  const decayHours = Math.max(1, decayDays * 24);
  const progress = Math.min(1, hours / decayHours);
  return peak - (peak - min) * progress;
}

function lastUserAt(pool: PoolState): string | null {
  const db = getDb();
  const row = pool.threadId
    ? (db
        .prepare(
          "SELECT created_at FROM chat_messages WHERE thread_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
        )
        .get(pool.threadId) as { created_at: string } | undefined)
    : (db
        .prepare(
          "SELECT created_at FROM chat_messages WHERE agent_id = ? AND user_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
        )
        .get(pool.agentId, normalizeUserId(pool.userId)) as { created_at: string } | undefined);
  return row?.created_at ?? null;
}

function hoursSinceLastUser(pool: PoolState): number | null {
  const created = lastUserAt(pool);
  if (!created) return null;
  const anchor = new Date(created).getTime();
  if (!Number.isFinite(anchor)) return null;
  return Math.max(0, (Date.now() - anchor) / 3_600_000);
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Derive the per-stream "engaged" window from the local chat thread.
 * Python extends engaged_until for the last proactive stream whenever a user turn
 * completes; here we replay that from persisted messages so restarts keep the state.
 */
function deriveEngagedUntil(threadId: number, engagedHours: number): Map<string, number> {
  const engaged = new Map<string, number>();
  const windowMs = Math.max(0, Number(engagedHours)) * 3_600_000;
  if (windowMs <= 0) return engaged;
  const rows = getDb()
    .prepare(
      `SELECT role, message_kind, input_metadata, created_at FROM chat_messages
       WHERE thread_id = ? AND (
         role = 'user' OR (role = 'assistant' AND message_kind = 'proactive_outreach')
       )
       ORDER BY id ASC`,
    )
    .all(threadId) as {
    role: string;
    message_kind: string | null;
    input_metadata: string | null;
    created_at: string;
  }[];
  let pendingStreamId: string | null = null;
  for (const row of rows) {
    if (row.role === "assistant" && row.message_kind === "proactive_outreach") {
      const metadata = parseMetadata(row.input_metadata);
      const streamId = String(metadata.streamId ?? metadata.stream_id ?? "").trim();
      if (streamId) pendingStreamId = streamId;
      continue;
    }
    if (row.role === "user" && pendingStreamId) {
      const at = new Date(row.created_at).getTime();
      if (Number.isFinite(at)) engaged.set(pendingStreamId, at + windowMs);
    }
  }
  return engaged;
}

function getOrCreatePool(agentId: number, userId: string): PoolState {
  const key = poolKey(agentId, userId);
  let pool = pools.get(key);
  if (!pool) {
    const thread = getThreadForAgent(userId, agentId);
    pool = {
      agentId,
      userId,
      threadId: thread?.id ?? null,
      entries: new Map(),
      engagedUntil: new Map(),
    };
    pools.set(key, pool);
  } else if (pool.threadId === null) {
    const thread = getThreadForAgent(userId, agentId);
    if (thread) pool.threadId = thread.id;
  }
  return pool;
}

function refreshEngaged(pool: PoolState, config: ProactiveConfig) {
  if (pool.threadId === null) {
    pool.engagedUntil = new Map();
    return;
  }
  const nowMs = Date.now();
  const derived = deriveEngagedUntil(pool.threadId, Number(config.engagedHours));
  for (const [streamId, until] of derived) {
    if (until <= nowMs) derived.delete(streamId);
  }
  pool.engagedUntil = derived;
}

function loadCandidateRows(agentId: number, userId: string, topK: number): any[] {
  const db = getDb();
  const limit = Math.max(30, topK * 6);
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND archived = 0 AND type = 'external'
         AND (origin_scope IS NULL OR origin_scope = 'private_dyadic')
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, userId, limit) as any[];
  const nowMs = Date.now();
  const scored: { weight: number; row: any }[] = [];
  for (const row of rows) {
    const weight = candidateWeight(row, nowMs);
    if (weight <= 0) continue;
    scored.push({ weight, row });
  }
  scored.sort((a, b) => b.weight - a.weight);
  return scored.slice(0, Math.max(0, topK)).map((item) => item.row);
}

function syncPool(
  pool: PoolState,
  config: ProactiveConfig,
  nowMs: number,
  grow: boolean,
): number {
  const topK = Math.max(1, Number(config.topK));
  const initFactor = Number(config.initFactor);
  const rows = loadCandidateRows(pool.agentId, pool.userId, topK);
  const candidateIds = new Set(rows.map((row) => String(row.id)));

  for (const streamId of [...pool.entries.keys()]) {
    if (!candidateIds.has(streamId)) pool.entries.delete(streamId);
  }

  for (const row of rows) {
    const streamId = String(row.id);
    const weight = candidateWeight(row, nowMs);
    const significance = clampSignificance(row.significance);
    const existing = pool.entries.get(streamId);
    if (existing) {
      existing.candidateWeight = weight;
      existing.significance = significance;
      existing.narrative = row.narrative ?? "";
      existing.streamCreatedAt = row.created_at ?? null;
      existing.lastProactiveAt = row.last_proactive_at ?? null;
      continue;
    }
    pool.entries.set(streamId, {
      streamId,
      narrative: row.narrative ?? "",
      candidateWeight: weight,
      significance,
      pressure: weight * initFactor,
      streamCreatedAt: row.created_at ?? null,
      lastProactiveAt: row.last_proactive_at ?? null,
    });
  }

  const silenceHours = hoursSinceLastUser(pool);
  const growthFactor = userSilenceGrowthFactor(silenceHours, config);
  if (!grow) return growthFactor;

  const growth = Number(config.growthPerTick) * Math.max(0, growthFactor);
  if (growth <= 0) return growthFactor;
  for (const entry of pool.entries.values()) {
    if (blockReason(pool, entry, config, nowMs)) continue;
    entry.pressure += growth * Math.max(entry.candidateWeight, 0.01);
  }
  return growthFactor;
}

function blockReason(
  pool: PoolState,
  entry: PoolEntry,
  config: ProactiveConfig,
  nowMs: number,
): string | null {
  if (entry.lastProactiveAt) {
    const touched = new Date(entry.lastProactiveAt).getTime();
    if (
      Number.isFinite(touched) &&
      nowMs < touched + Number(config.cooldownHours) * 3_600_000
    ) {
      return "cooldown";
    }
  }
  const engaged = pool.engagedUntil.get(entry.streamId);
  if (engaged && nowMs < engaged) return "user_engaged";
  return null;
}

function eligibleEntries(pool: PoolState, config: ProactiveConfig, nowMs: number): PoolEntry[] {
  const threshold = Number(config.pressureThreshold);
  return [...pool.entries.values()].filter(
    (entry) => entry.pressure >= threshold && !blockReason(pool, entry, config, nowMs),
  );
}

function pickWeighted(entries: PoolEntry[]): PoolEntry {
  const weights = entries.map((entry) => Math.max(entry.pressure, 0.01));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let roll = Math.random() * total;
  for (let index = 0; index < entries.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return entries[index];
  }
  return entries[entries.length - 1];
}

function bleedPressure(entry: PoolEntry, threshold: number) {
  // Mirrors Python `_bleed_pressure`: min(pressure, max(threshold*0.85, threshold-0.05)).
  // For the default threshold of 1 this caps the pool at 0.95, not a flat 0.85.
  entry.pressure = Math.min(entry.pressure, Math.max(threshold * 0.85, threshold - 0.05));
}

/**
 * Persist a successful proactive touch for one stream.
 *
 * Mirrors Python `record_proactive_stream_touch` / `touch_stream_proactive`:
 * ONLY `last_proactive_at` moves (it drives the C penalty). `revisit_count` /
 * `revisit_last_at` describe *chat recall* and are bumped exclusively by
 * `memoryService.recordRecalledStreamRevisits`.
 */
function touchStreamProactive(streamId: string, at: string) {
  getDb()
    .prepare(
      `UPDATE hippocampus_streams
       SET last_proactive_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(at, at, streamId);
}

function topEligibleEntry(
  pool: PoolState,
  config: ProactiveConfig,
  nowMs: number,
): PoolEntry | null {
  const eligible = eligibleEntries(pool, config, nowMs);
  if (!eligible.length) return null;
  return eligible.reduce((best, entry) => (entry.pressure > best.pressure ? entry : best));
}

export function isProactiveDndActive(now = new Date()): boolean {
  return inDndWindow(effectiveConfig(), now);
}

function inDndWindow(config: ProactiveConfig, now = new Date()): boolean {
  const startRaw = config.dndStartHour as unknown;
  const endRaw = config.dndEndHour as unknown;
  if (startRaw === null || startRaw === undefined || endRaw === null || endRaw === undefined) {
    return false;
  }
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  // Quiet hours are wall-clock hours in the display timezone, never the host
  // timezone (Python: `_local_hour` -> LINGSHU_DISPLAY_TIMEZONE).
  const hour = zonedParts(now, displayTimeZone()).hour;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function countTodayOutreach(agentId: number, userId: string, now = new Date()): number {
  // "Today" is a display-timezone day (Python `_count_today_outreach`).
  let dayStartIso: string;
  let dayEndIso: string;
  try {
    const parts = zonedParts(now, displayTimeZone());
    const day = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    const window = dayWindow(day, displayTimeZone());
    dayStartIso = window.startIso;
    dayEndIso = window.endIso;
  } catch {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    dayStartIso = dayStart.toISOString();
    dayEndIso = new Date(dayStart.getTime() + 86_400_000).toISOString();
  }
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM chat_messages
       WHERE agent_id = ? AND user_id = ? AND role = 'assistant'
         AND message_kind = 'proactive_outreach'
         AND created_at >= ? AND created_at < ?`,
    )
    .get(agentId, normalizeUserId(userId), dayStartIso, dayEndIso) as
    | { c: number }
    | undefined;
  return Number(row?.c || 0);
}

function unansweredStreak(pool: PoolState): number {
  const db = getDb();
  const uid = normalizeUserId(pool.userId);
  const scope = pool.threadId
    ? "thread_id = ?"
    : "agent_id = ? AND user_id = ?";
  const params = pool.threadId ? [pool.threadId] : [pool.agentId, uid];
  const lastUser = db
    .prepare(
      `SELECT id FROM chat_messages WHERE ${scope} AND role = 'user' ORDER BY id DESC LIMIT 1`,
    )
    .get(...params) as { id: number } | undefined;
  const conditions = [`${scope}`, "role = 'assistant'", "message_kind = 'proactive_outreach'"];
  const values: unknown[] = [...params];
  if (lastUser) {
    conditions.push("id > ?");
    values.push(lastUser.id);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM chat_messages WHERE ${conditions.join(" AND ")}`)
    .get(...values) as { c: number } | undefined;
  return Number(row?.c || 0);
}

/**
 * Phrases that mean "do not reach out on your own".
 *
 * Kept in sync with the Python backend's `_OUTREACH_OPT_OUT_MARKERS` and with
 * the detector that stamps `opt_out_proactive` when a constraint is written,
 * so a constraint recorded before the flag existed is still honoured.
 */
const OPT_OUT_MARKERS = ["别主动发", "不要主动发", "别再主动", "别主动找我"];

/**
 * Normalize a constraint into a topic key, mirroring Python's
 * `_constraint_topic_key`: "叫宝贝" and "不叫宝贝" are the same topic.
 */
function constraintTopicKey(description: string): string {
  let text = String(description || "").replace(/\s+/g, "");
  text = text.replace(/^(?:千万别|请不要|不要|别|不许|禁止|得|要|应该|可以|让)/, "");
  const match = /(?:被叫|称呼为?|名叫|叫)(.+)$/.exec(text);
  if (match) return `call:${match[1]}`;
  return text.slice(0, 32) || String(description || "");
}

/**
 * Whether the user asked not to be contacted proactively.
 *
 * Mirrors Python's `_user_opted_out`: a constraint flagged with
 * `opt_out_proactive`, or any constraint whose text carries one of the opt-out
 * markers. The constraints are superseded first — newest per topic wins — so
 * an older "don't reach out" cannot veto a newer "you may reach out".
 */
function userOptedOut(agentId: number, userId: string): boolean {
  const rows = getDb()
    .prepare(
      `SELECT description, opt_out_proactive, created_at FROM hippocampus_constraints
       WHERE agent_id = ? AND user_id = ?`,
    )
    .all(agentId, userId) as {
    description: string | null;
    opt_out_proactive: number | null;
    created_at: string | null;
  }[];
  if (!rows.length) return false;

  const sorted = [...rows].sort((left, right) =>
    String(right.created_at || "").localeCompare(String(left.created_at || "")),
  );
  const seenTopics = new Set<string>();
  const kept: typeof sorted = [];
  for (const row of sorted) {
    const key = constraintTopicKey(String(row.description || ""));
    if (seenTopics.has(key)) continue;
    seenTopics.add(key);
    kept.push(row);
  }

  if (kept.some((row) => Number(row.opt_out_proactive) === 1)) return true;
  const haystack = kept
    .map((row) => String(row.description || ""))
    .join(" ");
  return OPT_OUT_MARKERS.some((marker) => haystack.includes(marker));
}

function deliveryGate(
  pool: PoolState,
  config: ProactiveConfig,
  now = new Date(),
): { allowed: boolean; reason: string | null } {
  if (inDndWindow(config, now)) return { allowed: false, reason: "dnd_window" };
  if (userOptedOut(pool.agentId, pool.userId)) {
    return { allowed: false, reason: "user_opt_out" };
  }

  const streakLimit = Math.max(0, Number(config.unansweredStreakLimit));
  if (streakLimit > 0 && unansweredStreak(pool) >= streakLimit) {
    return { allowed: false, reason: "unanswered_streak" };
  }

  const dailyLimit = Math.max(0, Number(config.dailyLimit));
  if (countTodayOutreach(pool.agentId, pool.userId, now) >= dailyLimit) {
    return { allowed: false, reason: "daily_cap" };
  }

  return { allowed: true, reason: null };
}

export function proactiveSnapshot() {
  const config = effectiveConfig();
  const groups = scopes();
  const nowMs = Date.now();
  const threshold = Number(config.pressureThreshold);
  const initFactor = Number(config.initFactor);
  const growthPerTick = Number(config.growthPerTick);

  const poolsOut = groups.map((scope) => {
    const pool = getOrCreatePool(scope.agentId, scope.userId);
    refreshEngaged(pool, config);
    const growthFactor = syncPool(pool, config, nowMs, false);
    const agent = getAgent(scope.agentId);
    const thread = pool.threadId !== null ? getThread(pool.threadId) : null;
    const silenceHours = hoursSinceLastUser(pool);

    const entries = [...pool.entries.values()].map((entry) => {
      const blocked = blockReason(pool, entry, config, nowMs);
      const ready = entry.pressure >= threshold && !blocked;
      const initial = initFactor * entry.candidateWeight;
      const effectiveGrowth = growthPerTick * Math.max(0, growthFactor) * Math.max(entry.candidateWeight, 0.01);
      const estimatedGrowthTicks =
        effectiveGrowth > 1e-9
          ? Math.max(0, Math.ceil(Math.max(0, threshold - entry.pressure) / effectiveGrowth))
          : 0;
      const cooldownAt = entry.lastProactiveAt
        ? new Date(
            new Date(entry.lastProactiveAt).getTime() + Number(config.cooldownHours) * 3_600_000,
          ).toISOString()
        : null;
      const engagedMs = pool.engagedUntil.get(entry.streamId) ?? null;
      return {
        streamId: entry.streamId,
        narrative: entry.narrative,
        candidateWeight: Number(entry.candidateWeight.toFixed(4)),
        significance: entry.significance,
        pressure: Number(entry.pressure.toFixed(4)),
        ready,
        blockedReason: blocked ?? (entry.pressure >= threshold ? null : "below_threshold"),
        cooldownUntil: cooldownAt,
        engagedUntil: engagedMs !== null ? new Date(engagedMs).toISOString() : null,
        streamCreatedAt: entry.streamCreatedAt,
        pressureFormula: `初始 ${initFactor}×${entry.candidateWeight.toFixed(4)}=${initial.toFixed(4)}；每 tick +${growthPerTick}×${growthFactor.toFixed(4)}×${Math.max(entry.candidateWeight, 0.01).toFixed(4)}`,
        initialPressure: Number(initial.toFixed(4)),
        effectiveGrowthPerTick: Number(effectiveGrowth.toFixed(4)),
        estimatedGrowthTicks,
        pressureThreshold: threshold,
      };
    });
    const candidates = entries
      .filter((entry) => entry.ready)
      .sort((a, b) => b.pressure - a.pressure)
      .slice(0, Math.max(1, Number(config.topK)));
    const externalRow = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM hippocampus_streams WHERE agent_id = ? AND user_id = ? AND archived = 0 AND type = 'external'",
      )
      .get(scope.agentId, scope.userId) as { c: number } | undefined;

    return {
      agentId: scope.agentId,
      agentDisplayName: agent?.displayName || agent?.name || "",
      agentName: agent?.name || "",
      proactiveEnabled: Boolean(agent?.proactiveEnabled),
      isActive: Boolean(agent?.isActive),
      userId: scope.userId,
      threadId: thread?.id ?? null,
      entryCount: entries.length,
      maxPressure: entries.reduce((max, entry) => Math.max(max, entry.pressure), 0),
      entries,
      deliveryGate: deliveryGate(pool, config),
      userSilence: {
        lastUserAt: lastUserAt(pool),
        silenceHours: silenceHours === null ? null : Number(silenceHours.toFixed(2)),
        growthFactor: Number(growthFactor.toFixed(3)),
      },
      externalStreamCount: Number(externalRow?.c || 0),
      eligibleCandidateCount: candidates.length,
      candidates,
    };
  });

  return {
    serverTime: new Date().toISOString(),
    config,
    hasRuntimeOverrides: Object.keys(runtimeOverrides).length > 0,
    hasPersistedOverrides: Object.keys(persistedOverrides()).length > 0,
    runtimeOverrides,
    persistedOverrides: persistedOverrides(),
    poolCount: poolsOut.length,
    scopes: groups,
    schedulerRunning,
    lastTickAt,
    tickCount,
    effectiveTickSeconds: Number(config.tickSeconds),
    pools: poolsOut,
  };
}

async function generateProactiveText(agentId: number, narrative: string): Promise<string> {
  const agent = getAgent(agentId);
  const name = agent?.displayName || agent?.name || "助手";
  const role = agent?.roleSetting || "";
  const cfg = getLLMConfig("chat");
  if (!cfg.model || !cfg.baseUrl) return narrative.slice(0, 80);
  try {
    const client = createOpenAIClient(cfg);
    const response = await createCompletionWithThinkingFallback(
      client,
      {
        model: cfg.model,
        messages: [
          {
            role: "system",
            content: `你是「${name}」。${role ? `\n${role}` : ""}\n你想起了一件过去的事，想主动给用户发一条消息。不要提到系统、记忆、推送或 AI，1-2 句，自然口语化。`,
          },
          { role: "user", content: `你想起的事：${narrative.slice(0, 1200)}` },
        ],
        temperature: 0.8,
        ...buildThinkingParams(cfg),
      },
      cfg,
    );
    return (response.choices?.[0]?.message?.content || "").trim() || narrative.slice(0, 80);
  } catch {
    return narrative.slice(0, 80);
  }
}

export interface DeliverProactiveOptions {
  threadId?: number | null;
  userId?: string;
  messageKind?: string;
  streamId?: string | null;
  inputMetadata?: Record<string, unknown> | null;
}

export interface DeliverProactiveResult {
  channel: string;
  messageId: number | string | null;
  threadId: number | null;
  externalChannel: string | null;
  localMessageId: number | null;
}

/**
 * Deliver a proactive message to the local chat thread and the configured
 * QQ / WeChat route. The local thread write is authoritative; external route
 * failures degrade to local-only delivery.
 *
 * After the local write the message is pushed to every live GUI socket bound
 * to that thread through the session hub, so an open desktop client sees the
 * proactive message without polling the unread endpoints.
 */
export async function deliverProactiveMessage(
  agentId: number,
  text: string,
  options: DeliverProactiveOptions = {},
): Promise<DeliverProactiveResult | null> {
  const messageKind = options.messageKind || "proactive_outreach";
  let thread: ChatThreadRow | null = null;
  try {
    thread = options.threadId ? getThread(options.threadId) : null;
    if (!thread) thread = getThreadForAgent(options.userId, agentId);
    if (!thread) thread = ensureThread(options.userId, agentId);
  } catch {
    thread = null;
  }

  let localMessageId: number | null = null;
  let localContent = "";
  let localCreatedAt: string | null = null;
  let localUnreadCount = 0;
  if (thread) {
    try {
      const metadata =
        options.inputMetadata ??
        ({
          kind: messageKind,
          ...(options.streamId ? { streamId: options.streamId } : {}),
        } as Record<string, unknown>);
      // 用户在线时消息会被实时推给 GUI，不需要再计入未读（与 Python 的 mark_read=is_online 一致）
      const isOnline = sessionHub.getBinding(
        thread.user_id,
        thread.id,
      ) !== null;
      const message = appendAssistantOnly(thread, text, messageKind, metadata);
      localMessageId = message.id;
      localContent = message.content || "";
      localCreatedAt = message.created_at || null;
      // 离线投递的主动消息保持未读；appendAssistantOnly 默认标记为已读
      if (!isOnline) {
        getDb()
          .prepare("UPDATE chat_messages SET assistant_read_at = NULL WHERE id = ?")
          .run(message.id);
      }
      localUnreadCount = recalculateUnreadCount(thread.id);
    } catch {
      localMessageId = null;
    }
  }

  // 推给该 session 下所有在线 GUI 连接（Python 的 session_hub.broadcast_json）
  if (thread && localMessageId !== null) {
    try {
      sessionHub.broadcastJson(thread.id, {
        type: "chat.proactive",
        threadId: thread.id,
        agentId,
        messageId: localMessageId,
        messageKind,
        content: localContent,
        createdAt: localCreatedAt,
        unreadCount: localUnreadCount,
      });
    } catch (error) {
      console.warn("[PROACTIVE_DELIVERY] session hub broadcast failed:", error);
    }
  }

  let externalChannel: string | null = null;
  let externalMessageId: number | string | null = null;

  try {
    const qqRoute = getProactiveRoute(agentId, "qqbot");
    if (qqRoute) {
      const client = qqBotClientForAgent(agentId);
      if (client) {
        const result = await client.sendText(qqRoute.targetType, qqRoute.targetId, text);
        externalChannel = "qqbot";
        externalMessageId = result.id ?? null;
      }
    }
  } catch {
    externalChannel = null;
  }

  if (!externalChannel) {
    try {
      const wechatRoute = getProactiveRoute(agentId, "wechat");
      if (wechatRoute?.contextToken) {
        await sendWechatText(wechatRoute.targetId, wechatRoute.contextToken, text);
        externalChannel = "wechat";
      }
    } catch {
      externalChannel = null;
    }
  }

  if (localMessageId === null && !externalChannel) return null;
  const channel = [localMessageId !== null ? "local" : null, externalChannel]
    .filter(Boolean)
    .join("+");
  return {
    channel: channel || "local",
    messageId: localMessageId ?? externalMessageId,
    threadId: thread?.id ?? null,
    externalChannel,
    localMessageId,
  };
}

const deliverProactive = deliverProactiveMessage;

export function setProactiveSchedulerRunning(value: boolean) {
  schedulerRunning = Boolean(value);
}

export async function proactiveTick() {
  const config = effectiveConfig();
  const results: Record<string, unknown>[] = [];
  if (!config.enabled) {
    lastTickAt = new Date().toISOString();
    tickCount += 1;
    return { results, snapshot: proactiveSnapshot() };
  }

  const threshold = Number(config.pressureThreshold);

  for (const scope of scopes()) {
    const agent = getAgent(scope.agentId);
    if (!agent?.proactiveEnabled || !agent?.isActive) {
      results.push({
        agentId: scope.agentId,
        userId: scope.userId,
        skipped: true,
        reason: "proactive_disabled",
      });
      continue;
    }

    const pool = getOrCreatePool(scope.agentId, scope.userId);
    refreshEngaged(pool, config);
    const nowMs = Date.now();
    const growthFactor = syncPool(pool, config, nowMs, true);

    const gate = deliveryGate(pool, config);
    if (!gate.allowed) {
      // A gate that holds messages back must not let pressure pile up forever.
      const top = topEligibleEntry(pool, config, nowMs);
      if (top) bleedPressure(top, threshold);
      results.push({
        agentId: pool.agentId,
        userId: pool.userId,
        userSilenceGrowthFactor: Number(growthFactor.toFixed(4)),
        skipped: true,
        reason: gate.reason,
      });
      continue;
    }

    const eligible = eligibleEntries(pool, config, nowMs);
    if (!eligible.length) {
      results.push({
        agentId: pool.agentId,
        userId: pool.userId,
        userSilenceGrowthFactor: Number(growthFactor.toFixed(4)),
        skipped: true,
        reason: "below_threshold",
      });
      logTick(
        { agentId: pool.agentId, userId: pool.userId },
        "stream_proactive",
        "nothing",
        { reason: "below_threshold" },
      );
      continue;
    }

    const winner = pickWeighted(eligible);
    try {
      const text = await generateProactiveText(pool.agentId, winner.narrative);
      const delivered = await deliverProactiveMessage(pool.agentId, text, {
        threadId: pool.threadId,
        userId: pool.userId,
        messageKind: "proactive_outreach",
        streamId: winner.streamId,
      });
      if (!delivered) {
        bleedPressure(winner, threshold);
        results.push({
          agentId: pool.agentId,
          userId: pool.userId,
          userSilenceGrowthFactor: Number(growthFactor.toFixed(4)),
          skipped: true,
          reason: "delivery_blocked",
          streamId: winner.streamId,
        });
        logTick(
          { agentId: pool.agentId, userId: pool.userId },
          "stream_proactive",
          "nothing",
          { streamId: winner.streamId, reason: "delivery_blocked" },
        );
        continue;
      }

      const sentAt = new Date().toISOString();
      winner.pressure = 0;
      winner.lastProactiveAt = sentAt;
      if (pool.threadId === null && delivered.threadId !== null) {
        pool.threadId = delivered.threadId;
      }
      touchStreamProactive(winner.streamId, sentAt);
      results.push({
        agentId: pool.agentId,
        userId: pool.userId,
        userSilenceGrowthFactor: Number(growthFactor.toFixed(4)),
        skipped: false,
        reason: null,
        streamId: winner.streamId,
        messageId: delivered.messageId,
        channel: delivered.channel,
        externalChannel: delivered.externalChannel,
      });
      logTick(
        { agentId: pool.agentId, userId: pool.userId },
        "stream_proactive",
        "delivered",
        {
          threadId: delivered.threadId,
          streamId: winner.streamId,
          messageId: delivered.messageId,
          channel: delivered.channel,
          externalChannel: delivered.externalChannel,
          contentPreview: text.slice(0, 120),
        },
      );
    } catch (error) {
      results.push({
        agentId: pool.agentId,
        userId: pool.userId,
        userSilenceGrowthFactor: Number(growthFactor.toFixed(4)),
        skipped: true,
        reason: error instanceof Error ? error.message : String(error),
        streamId: winner.streamId,
      });
      logTick(
        { agentId: pool.agentId, userId: pool.userId },
        "stream_proactive",
        "failed",
        { streamId: winner.streamId },
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  lastTickAt = new Date().toISOString();
  tickCount += 1;
  return { results, snapshot: proactiveSnapshot() };
}

export function proactiveReload() {
  runtimeOverrides = {};
  pools.clear();
  return proactiveSnapshot();
}

export async function testQqPush(agentId: number, text?: string) {
  const route = getProactiveRoute(agentId, "qqbot");
  if (!route) {
    return { ok: false, reason: "qqbot_route_missing", detail: "尚无 QQBot 私聊路由，请先让用户给机器人发一条消息" };
  }
  const client = qqBotClientForAgent(agentId);
  if (!client) {
    return { ok: false, reason: "qqbot_not_bound", detail: "该智能体尚未绑定 QQBot" };
  }
  const content = (text || "这是一条来自灵枢的测试消息。").trim();
  try {
    const result = await client.sendText(route.targetType, route.targetId, content);
    return { ok: true, route: route.targetType, messageId: result.id ?? null, text: content };
  } catch (error) {
    return {
      ok: false,
      reason: "send_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
