import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the backend at a throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-background-events-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const { getDb } = await import("../src/db/sqlite.js");
const events = await import("../src/services/backgroundTaskEvents.js");

const db = getDb();

function countRows(): number {
  return Number(
    (db.prepare("SELECT count(*) AS n FROM background_task_events").get() as any).n,
  );
}

test("retention default is 7 days; invalid or non-positive overrides fall back", () => {
  delete process.env.LINGSHU_BACKGROUND_TASK_RETENTION_DAYS;
  assert.equal(events.backgroundTaskRetentionDays(), 7);
  assert.equal(events.DEFAULT_BACKGROUND_TASK_RETENTION_DAYS, 7);
  for (const bad of ["abc", "0", "-3", "1.5e", "  "]) {
    process.env.LINGSHU_BACKGROUND_TASK_RETENTION_DAYS = bad;
    assert.equal(events.backgroundTaskRetentionDays(), 7, `fallback for ${JSON.stringify(bad)}`);
  }
  process.env.LINGSHU_BACKGROUND_TASK_RETENTION_DAYS = "30";
  assert.equal(events.backgroundTaskRetentionDays(), 30);
  process.env.LINGSHU_BACKGROUND_TASK_RETENTION_DAYS = "2.9";
  assert.equal(events.backgroundTaskRetentionDays(), 2, "positive floats floor to whole days");
  delete process.env.LINGSHU_BACKGROUND_TASK_RETENTION_DAYS;
});

test("purge keeps rows within the retention window and deletes older ones; fresh rows survive", () => {
  const now = new Date();
  const dayMs = 86_400_000;

  // Direct rows with controlled created_at (recordBackgroundTaskEvent only writes "now").
  const insertAt = (createdAt: string, marker: string): string => {
    const id = `probe-${marker}`;
    db.prepare(
      `INSERT INTO background_task_events (id, event_type, subject_type, subject_id, status, detail, created_at)
       VALUES (?, 'unit_probe_row', '', '', 'succeeded', ?, ?)`,
    ).run(id, marker, createdAt);
    return id;
  };

  const freshId = insertAt(new Date(now.getTime() - 1 * 3_600_000).toISOString(), "fresh");
  const withinWeek = insertAt(new Date(now.getTime() - 6 * dayMs).toISOString(), "within-week");
  const justOverWeek = insertAt(new Date(now.getTime() - 7.5 * dayMs).toISOString(), "just-over-week");
  const farOld = insertAt(new Date(now.getTime() - 30 * dayMs).toISOString(), "far-old");

  const result = events.purgeExpiredBackgroundTaskEvents(now);
  assert.equal(result.retentionDays, 7, "default retention applies when env unset");
  assert.equal(result.deleted, 2, "rows older than 7 days are deleted");

  const remaining = db
    .prepare("SELECT id FROM background_task_events ORDER BY created_at ASC")
    .all() as { id: string }[];
  const remainingIds = remaining.map((row) => row.id);
  assert.ok(remainingIds.includes(freshId), "recent row survives");
  assert.ok(remainingIds.includes(withinWeek), "6-day-old row survives (within one week)");
  assert.ok(!remainingIds.includes(justOverWeek), "7.5-day-old row is purged");
  assert.ok(!remainingIds.includes(farOld), "30-day-old row is purged");

  // The purge must not write itself back into the log:
  const probeRows = db
    .prepare("SELECT count(*) AS n FROM background_task_events WHERE event_type LIKE '%retention%' OR event_type LIKE '%purge%'")
    .get() as any;
  assert.equal(probeRows.n, 0, "cleanup action is never recorded into background_task_events");
  const probeRowsLeft = db
    .prepare("SELECT count(*) AS n FROM background_task_events WHERE event_type = 'unit_probe_row'")
    .get() as any;
  assert.equal(probeRowsLeft.n, 2);
});

test("purge respects an env override (LINGSHU_BACKGROUND_TASK_RETENTION_DAYS)", () => {
  const now = new Date();
  // Start from a clean slate so leftovers from earlier tests cannot skew counts.
  db.prepare("DELETE FROM background_task_events WHERE event_type = 'unit_probe_row'").run();
  const insertAt = (createdAt: string, marker: string): string => {
    const id = `probe-${marker}`;
    db.prepare(
      `INSERT INTO background_task_events (id, event_type, subject_type, subject_id, status, detail, created_at)
       VALUES (?, 'unit_probe_row', '', '', 'succeeded', ?, ?)`,
    ).run(id, marker, createdAt);
    return id;
  };

  const fresh = insertAt(new Date(now.getTime() - 6 * 3_600_000).toISOString(), "env-fresh");
  const twoDaysOld = insertAt(new Date(now.getTime() - 2 * 86_400_000).toISOString(), "env-two-days");

  process.env.LINGSHU_BACKGROUND_TASK_RETENTION_DAYS = "1";
  try {
    const result = events.purgeExpiredBackgroundTaskEvents(now);
    assert.equal(result.retentionDays, 1);
    assert.equal(result.deleted, 1);
    const remainingIds = (db.prepare("SELECT id FROM background_task_events").all() as { id: string }[]).map(
      (row) => row.id,
    );
    assert.ok(remainingIds.includes(fresh), "row newer than the override window survives");
    assert.ok(!remainingIds.includes(twoDaysOld), "row older than the override window is purged");
  } finally {
    delete process.env.LINGSHU_BACKGROUND_TASK_RETENTION_DAYS;
  }
});

test("recordBackgroundTaskEvent keeps working and listBackgroundTaskEvents reads back", () => {
  const before = countRows();
  const id = events.recordBackgroundTaskEvent({
    eventType: "unit_probe",
    subjectType: "test",
    subjectId: "42",
    status: "succeeded",
    detail: "probe row",
  });
  assert.ok(id);
  assert.equal(countRows(), before + 1);
  const listed = events.listBackgroundTaskEvents({ eventType: "unit_probe", limit: 10 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, id);
  assert.equal(listed[0].subject_id, "42");
});
