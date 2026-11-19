import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// A dedicated throwaway DB: this test deliberately corrupts a v22 database by
// removing columns that the current code requires, then verifies that opening
// it again repairs the schema without waiting for a version bump.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-schema-repair-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const { getDb, closeDb } = await import("../src/db/sqlite.js");

test("a v22 database missing seed lifecycle columns is repaired on open", () => {
  let db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 22);
  closeDb();

  // Simulate the hot-reload race: user_version advanced, but the version-guarded
  // seed migration did not land on this file.
  db = new Database(process.env.DB_PATH!);
  db.exec(`
    DROP INDEX IF EXISTS ix_hc_seeds_scope_status;
    DROP INDEX IF EXISTS ix_hc_streams_theater_origin;
    ALTER TABLE hippocampus_seeds DROP COLUMN revision;
    ALTER TABLE hippocampus_seeds DROP COLUMN status;
    ALTER TABLE hippocampus_seeds DROP COLUMN applicability_json;
    ALTER TABLE hippocampus_streams DROP COLUMN origin_theater_id;
  `);
  db.pragma("user_version = 22");
  const before = db.prepare("PRAGMA table_info(hippocampus_seeds)").all() as { name: string }[];
  assert.ok(!before.some((column) => column.name === "status"));
  db.close();

  db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 22);
  const seedColumns = db.prepare("PRAGMA table_info(hippocampus_seeds)").all() as { name: string }[];
  for (const column of ["revision", "status", "applicability_json"]) {
    assert.ok(seedColumns.some((item) => item.name === column), column);
  }
  const streamColumns = db.prepare("PRAGMA table_info(hippocampus_streams)").all() as { name: string }[];
  assert.ok(streamColumns.some((column) => column.name === "origin_theater_id"));
  const overview = db
    .prepare(
      `SELECT COUNT(*) AS active FROM hippocampus_seeds
       WHERE agent_id = -1 AND user_id = 'missing' AND COALESCE(status, 'active') = 'active'`,
    )
    .get() as { active: number };
  assert.equal(Number(overview.active), 0);
  closeDb();
});
