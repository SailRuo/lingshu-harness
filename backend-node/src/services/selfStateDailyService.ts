import { getDb } from "../db/sqlite.js";
import type { MemoryScope } from "./memoryScope.js";
import { dayKey, dayWindow, monthBounds } from "./memoryTime.js";

const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 1000;

export interface SelfStateDailyAggregate {
  scope: MemoryScope;
  day: string;
  closeness: number;
  closenessTrend: number;
  templateRisk: number;
  intimacyTier: string;
  sampleCount: number;
  createdAt: string;
}

export interface SelfStateDailyUpsertResult {
  written: boolean;
  sampleCount: number;
}

export interface SelfStateDailyRunSummary {
  day: string;
  scopes: number;
  written: number;
  skipped: number;
  failed: number;
  writtenScopes: { scope: MemoryScope; sampleCount: number }[];
  failures: { scope: MemoryScope; error: string }[];
}

export interface SelfStateHistoryItem {
  id: number | string;
  trigger: string | null;
  turnId: number | null;
  closeness: number;
  closenessTrend: number;
  intimacyTier: string;
  templateRisk: number;
  createdAt: string;
  granularity: string | null;
  sampleCount: number | null;
  period: string | null;
}

interface AggregateRawRow {
  closeness: number;
  closeness_trend: number;
  intimacy_tier: string;
  template_risk: number;
  created_at: string;
}

interface RawSelfStateRow extends AggregateRawRow {
  id: number;
  trigger: string | null;
  turn_id: number | null;
  granularity: string | null;
  sample_count: number | null;
  period: string | null;
}

interface DailySelfStateRow {
  id: number;
  day: string;
  closeness: number;
  closeness_trend: number;
  intimacy_tier: string;
  template_risk: number;
  sample_count: number | null;
  created_at: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Median matches Python's statistics.median used by the daily merge. */
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function clampLimit(limit: number | null | undefined): number {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_HISTORY_LIMIT));
}

function timestampValue(value: string | null | undefined): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Raw scopes for a day (or all raw scopes) — the Python `_distinct_scopes_in_month` analogue. */
export function listSelfStateScopes(day?: string | null): MemoryScope[] {
  const db = getDb();
  const clauses = ["(granularity IS NULL OR granularity <> 'day')"];
  const params: string[] = [];
  if (day) {
    const window = dayWindow(day);
    clauses.push("created_at >= ?", "created_at < ?");
    params.push(window.startIso, window.endIso);
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT agent_id AS agentId, user_id AS userId
       FROM hippocampus_self_state
       WHERE ${clauses.join(" AND ")}
       ORDER BY agent_id ASC, user_id ASC`,
    )
    .all(...params) as { agentId: number; userId: string }[];
  return rows
    .filter((row) => Number.isInteger(Number(row.agentId)) && Number(row.agentId) > 0 && row.userId)
    .map((row) => ({ agentId: Number(row.agentId), userId: String(row.userId) }));
}

/** Aggregate one scope's raw turn snapshots into a single local-day rollup. */
export function aggregateSelfStateDay(scope: MemoryScope, day: string): SelfStateDailyAggregate | null {
  const window = dayWindow(day);
  const rows = getDb()
    .prepare(
      `SELECT closeness, closeness_trend, intimacy_tier, template_risk, created_at
       FROM hippocampus_self_state
       WHERE agent_id = ? AND user_id = ?
         AND created_at >= ? AND created_at < ?
         AND (granularity IS NULL OR granularity <> 'day')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(scope.agentId, scope.userId, window.startIso, window.endIso) as AggregateRawRow[];
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return {
    scope,
    day: window.day,
    closeness: median(rows.map((row) => numeric(row.closeness))),
    closenessTrend: median(rows.map((row) => numeric(row.closeness_trend))),
    templateRisk: median(rows.map((row) => numeric(row.template_risk))),
    intimacyTier: String(last.intimacy_tier || "surface"),
    sampleCount: rows.length,
    createdAt: window.createdAt,
  };
}

/** Insert-once daily rollup; the unique (agent, user, day) key makes reruns idempotent. */
export function upsertSelfStateDaily(scope: MemoryScope, day: string): SelfStateDailyUpsertResult {
  const aggregate = aggregateSelfStateDay(scope, day);
  if (!aggregate) return { written: false, sampleCount: 0 };
  const result = getDb()
    .prepare(
      `INSERT INTO hippocampus_self_state_daily
        (agent_id, user_id, day, closeness, closeness_trend, template_risk, intimacy_tier,
         sample_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, user_id, day) DO NOTHING`,
    )
    .run(
      scope.agentId,
      scope.userId,
      aggregate.day,
      aggregate.closeness,
      aggregate.closenessTrend,
      aggregate.templateRisk,
      aggregate.intimacyTier,
      aggregate.sampleCount,
      aggregate.createdAt,
    );
  return { written: Number(result.changes) > 0, sampleCount: aggregate.sampleCount };
}

/** Daily job entry: roll up every scope that has raw samples for the target day. */
export function runSelfStateDailyRollup(day: string): SelfStateDailyRunSummary {
  const window = dayWindow(day);
  const scopes = listSelfStateScopes(window.day);
  const summary: SelfStateDailyRunSummary = {
    day: window.day,
    scopes: scopes.length,
    written: 0,
    skipped: 0,
    failed: 0,
    writtenScopes: [],
    failures: [],
  };
  for (const scope of scopes) {
    try {
      const result = upsertSelfStateDaily(scope, window.day);
      if (result.written) {
        summary.written += 1;
        summary.writtenScopes.push({ scope, sampleCount: result.sampleCount });
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.failed += 1;
      summary.failures.push({
        scope,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}

/**
 * Merge a closed calendar month into daily rollups, then drop the raw snapshots
 * that the rollups replaced. Mirrors Python obs_snapshot_daily_merge: abort the
 * whole transaction if any day/scope fails so raw data is never deleted without
 * a persisted rollup.
 */
export function mergeSelfStateMonth(
  year: number,
  month: number,
): { days: number; written: number; skipped: number; rawDeleted: number } {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("invalid_month");
  }
  const db = getDb();
  const bounds = monthBounds(year, month);
  const merge = db.transaction(() => {
    let written = 0;
    let skipped = 0;
    for (let date = 1; date <= bounds.days; date += 1) {
      const day = `${year}-${pad2(month)}-${pad2(date)}`;
      const summary = runSelfStateDailyRollup(day);
      if (summary.failures.length) {
        throw new Error(
          `self_state_daily_rollup_failed:${day}:${summary.failures[0].error}`,
        );
      }
      written += summary.written;
      skipped += summary.skipped;
    }
    const rawDeleted = Number(
      db
        .prepare(
          `DELETE FROM hippocampus_self_state
           WHERE created_at >= ? AND created_at < ?
             AND (granularity IS NULL OR granularity <> 'day')`,
        )
        .run(bounds.startIso, bounds.endIso).changes,
    );
    return { days: bounds.days, written, skipped, rawDeleted };
  });
  return merge();
}

/**
 * Merge daily rollups with recent turn snapshots (raw wins on overlap), newest first.
 * Mirrors Python `list_self_state_history` while keeping the existing `{ items, total }` shape.
 */
export function readSelfStateHistory(
  scope: MemoryScope,
  limit: number | null | undefined = DEFAULT_HISTORY_LIMIT,
): { items: SelfStateHistoryItem[]; total: number } {
  const db = getDb();
  const capped = clampLimit(limit);
  const rawRows = db
    .prepare(
      `SELECT * FROM hippocampus_self_state
       WHERE agent_id = ? AND user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, capped) as RawSelfStateRow[];
  const rawDayRows = db
    .prepare(
      `SELECT created_at
       FROM hippocampus_self_state
       WHERE agent_id = ? AND user_id = ?`,
    )
    .all(scope.agentId, scope.userId) as { created_at: string | null }[];
  const dailyRows = db
    .prepare(
      `SELECT * FROM hippocampus_self_state_daily
       WHERE agent_id = ? AND user_id = ?
       ORDER BY day DESC`,
    )
    .all(scope.agentId, scope.userId) as DailySelfStateRow[];

  const rawDays = new Set(
    rawDayRows
      .map((row) => {
        const parsed = Date.parse(String(row.created_at ?? ""));
        return Number.isFinite(parsed) ? dayKey(new Date(parsed)) : null;
      })
      .filter((day): day is string => Boolean(day)),
  );
  const items: SelfStateHistoryItem[] = rawRows.map((row) => ({
    id: row.id,
    trigger: row.trigger,
    turnId: row.turn_id,
    closeness: row.closeness,
    closenessTrend: row.closeness_trend,
    intimacyTier: row.intimacy_tier,
    templateRisk: row.template_risk,
    createdAt: row.created_at,
    granularity: row.granularity || "turn",
    sampleCount: row.sample_count,
    period: row.period,
  }));

  for (const row of dailyRows) {
    if (rawDays.has(row.day)) continue;
    items.push({
      // Daily rows live in a separate table; prefix keeps merged feed ids unique.
      id: `daily:${row.id}`,
      trigger: "daily",
      turnId: null,
      closeness: row.closeness,
      closenessTrend: row.closeness_trend,
      intimacyTier: row.intimacy_tier,
      templateRisk: row.template_risk,
      createdAt: row.created_at,
      granularity: "day",
      sampleCount: Number(row.sample_count || 0),
      period: row.day,
    });
  }

  items.sort((left, right) => timestampValue(right.createdAt) - timestampValue(left.createdAt));
  const limited = items.slice(0, capped);
  return { items: limited, total: limited.length };
}
