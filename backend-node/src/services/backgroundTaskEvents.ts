import { randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";

export type BackgroundTaskStatus = "succeeded" | "skipped" | "failed" | "stale";

export interface BackgroundTaskEventInput {
  eventType: string;
  subjectType?: string;
  subjectId?: string;
  status: BackgroundTaskStatus;
  detail?: string;
  createdAt?: string;
}

/**
 * Cross-object background task log (v19).
 *
 * This is not `task_events` (the agent task runtime) and not
 * `hippocampus_tick_log` (per agent+user memory audit). Keep `detail` short:
 * a reason or summary, never a prompt or transcript.
 */
export function recordBackgroundTaskEvent(input: BackgroundTaskEventInput): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO background_task_events
        (id, event_type, subject_type, subject_id, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      String(input.eventType || "").trim() || "unknown",
      String(input.subjectType || "").trim(),
      String(input.subjectId || "").trim(),
      input.status,
      String(input.detail || "").slice(0, 2000),
      input.createdAt || new Date().toISOString(),
    );
  return id;
}

/**
 * Retention policy (decided 2026-11-15): this is an append-only ops log, not a
 * memory — keep only the most recent week so digest/anchor/migration events do
 * not grow unbounded on a long-lived desktop install. Override with
 * `LINGSHU_BACKGROUND_TASK_RETENTION_DAYS` (positive integer); the default is 7.
 */
export const DEFAULT_BACKGROUND_TASK_RETENTION_DAYS = 7;

export function backgroundTaskRetentionDays(): number {
  const raw = String(process.env.LINGSHU_BACKGROUND_TASK_RETENTION_DAYS || "").trim();
  if (!raw) return DEFAULT_BACKGROUND_TASK_RETENTION_DAYS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BACKGROUND_TASK_RETENTION_DAYS;
  return Math.max(1, Math.floor(value));
}

export interface BackgroundTaskRetentionResult {
  deleted: number;
  retentionDays: number;
  cutoff: string;
}

/**
 * Delete rows older than the retention window (`created_at < now - N days`).
 * The purge itself must NOT be recorded back into `background_task_events` —
 * callers log the summary instead.
 */
export function purgeExpiredBackgroundTaskEvents(now: Date = new Date()): BackgroundTaskRetentionResult {
  const retentionDays = backgroundTaskRetentionDays();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const result = getDb()
    .prepare("DELETE FROM background_task_events WHERE created_at < ?")
    .run(cutoff);
  return { deleted: Number(result.changes || 0), retentionDays, cutoff };
}

export function listBackgroundTaskEvents(input: {
  eventType?: string;
  subjectType?: string;
  subjectId?: string;
  limit?: number;
} = {}) {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (input.eventType) {
    clauses.push("event_type = ?");
    args.push(input.eventType);
  }
  if (input.subjectType) {
    clauses.push("subject_type = ?");
    args.push(input.subjectType);
  }
  if (input.subjectId) {
    clauses.push("subject_id = ?");
    args.push(input.subjectId);
  }
  const limit = Math.max(1, Math.min(Number(input.limit) || 50, 500));
  args.push(limit);
  return getDb()
    .prepare(
      `SELECT * FROM background_task_events
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...args) as Array<{
    id: string;
    event_type: string;
    subject_type: string;
    subject_id: string;
    status: BackgroundTaskStatus;
    detail: string;
    created_at: string;
  }>;
}
