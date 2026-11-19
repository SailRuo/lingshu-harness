import { getDb } from "../db/sqlite.js";
import type { MemoryScope } from "./memoryScope.js";
import { dayWindow, monthBounds } from "./memoryTime.js";

export interface AffectDailyPoint {
  kind: "aggregate";
  granularity: "day";
  channel: string;
  period: string;
  createdAt: string;
  sampleCount: number;
  affect: { valence: number; arousal: number; dominance: number };
}

export interface AffectDailyRunSummary {
  day: string;
  written: number;
  skipped: number;
  failed: number;
  failures: string[];
}

interface RawAffectRow {
  channel: string;
  valence: number | null;
  arousal: number | null;
  dominance: number | null;
  created_at: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasCompleteVad(row: RawAffectRow): boolean {
  return (
    row.valence != null &&
    row.arousal != null &&
    row.dominance != null &&
    Number.isFinite(Number(row.valence)) &&
    Number.isFinite(Number(row.arousal)) &&
    Number.isFinite(Number(row.dominance))
  );
}

function aggregateRows(
  rows: RawAffectRow[],
  channel: string,
  day: string,
  createdAt: string,
): AffectDailyPoint | null {
  // Python snapshots always carry all three VAD dims; a row missing one is not
  // a usable sample, so drop it instead of treating the gap as 0.
  const complete = rows.filter(hasCompleteVad);
  if (!complete.length) return null;
  return {
    kind: "aggregate",
    granularity: "day",
    channel,
    period: day,
    createdAt,
    sampleCount: complete.length,
    affect: {
      valence: median(complete.map((row) => numeric(row.valence))),
      arousal: median(complete.map((row) => numeric(row.arousal))),
      dominance: median(complete.map((row) => numeric(row.dominance))),
    },
  };
}

export function aggregateAffectDay(scope: MemoryScope, day: string): AffectDailyPoint[] {
  const window = dayWindow(day);
  const rows = getDb()
    .prepare(
      `SELECT channel, valence, arousal, dominance, created_at
       FROM hippocampus_affect_points
       WHERE agent_id = ? AND user_id = ?
         AND created_at >= ? AND created_at < ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(scope.agentId, scope.userId, window.startIso, window.endIso) as RawAffectRow[];
  const byChannel = new Map<string, RawAffectRow[]>();
  for (const row of rows) {
    const channel = String(row.channel || "text").trim() || "text";
    const list = byChannel.get(channel) || [];
    list.push(row);
    byChannel.set(channel, list);
  }
  const points: AffectDailyPoint[] = [];
  for (const [channel, group] of byChannel) {
    const point = aggregateRows(group, channel, window.day, window.createdAt);
    if (point) points.push(point);
  }
  return points;
}

export function upsertAffectDaily(
  scope: MemoryScope,
  day: string,
): { written: number; skipped: number } {
  const points = aggregateAffectDay(scope, day);
  const db = getDb();
  let written = 0;
  let skipped = 0;
  for (const point of points) {
    const result = db
      .prepare(
        `INSERT INTO hippocampus_affect_daily
          (agent_id, user_id, channel, day, valence, arousal, dominance, sample_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, user_id, channel, day) DO NOTHING`,
      )
      .run(
        scope.agentId,
        scope.userId,
        point.channel,
        point.period,
        point.affect.valence,
        point.affect.arousal,
        point.affect.dominance,
        point.sampleCount,
        point.createdAt,
      );
    if (Number(result.changes) > 0) written += 1;
    else skipped += 1;
  }
  return { written, skipped };
}

export function runAffectDailyRollup(day: string): AffectDailyRunSummary {
  const window = dayWindow(day);
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT agent_id AS agentId, user_id AS userId
       FROM hippocampus_affect_points
       WHERE created_at >= ? AND created_at < ?`,
    )
    .all(window.startIso, window.endIso) as { agentId: number; userId: string }[];
  const summary: AffectDailyRunSummary = {
    day: window.day,
    written: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };
  for (const row of rows) {
    if (!Number.isInteger(Number(row.agentId)) || !row.userId) continue;
    try {
      const result = upsertAffectDaily({ agentId: Number(row.agentId), userId: row.userId }, window.day);
      summary.written += result.written;
      summary.skipped += result.skipped;
    } catch (error) {
      summary.failed += 1;
      summary.failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return summary;
}

/** Merge a closed month into daily affect rollups, then delete the raw points. */
export function mergeAffectMonth(
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
      const summary = runAffectDailyRollup(day);
      if (summary.failures.length) {
        throw new Error(`affect_daily_rollup_failed:${day}:${summary.failures[0]}`);
      }
      written += summary.written;
      skipped += summary.skipped;
    }
    const rawDeleted = Number(
      db
        .prepare(
          `DELETE FROM hippocampus_affect_points
           WHERE created_at >= ? AND created_at < ?`,
        )
        .run(bounds.startIso, bounds.endIso).changes,
    );
    return { days: bounds.days, written, skipped, rawDeleted };
  });
  return merge();
}

export function readAffectDailyPoints(
  scope: MemoryScope,
  channel: string,
  limit: number,
): AffectDailyPoint[] {
  const rows = getDb()
    .prepare(
      `SELECT channel, day, valence, arousal, dominance, sample_count, created_at
       FROM hippocampus_affect_daily
       WHERE agent_id = ? AND user_id = ? AND channel = ?
       ORDER BY day ASC
       LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, channel, Math.max(1, Math.min(limit, 20000))) as {
    channel: string;
    day: string;
    valence: number;
    arousal: number;
    dominance: number;
    sample_count: number;
    created_at: string;
  }[];
  return rows.map((row) => ({
    kind: "aggregate",
    granularity: "day",
    channel: row.channel,
    period: row.day,
    createdAt: row.created_at,
    sampleCount: Number(row.sample_count || 0),
    affect: {
      valence: numeric(row.valence),
      arousal: numeric(row.arousal),
      dominance: numeric(row.dominance),
    },
  }));
}
