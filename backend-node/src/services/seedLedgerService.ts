import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { nowIso, parseJson, type MemoryScope } from "./memoryScope.js";

/**
 * M2 seed evolution ledger.
 *
 * `agent_state_changes` is the single authoritative history for seed changes
 * from schema v20 on. `hippocampus_seed_versions` is frozen read-only archive:
 * nothing in this file (or any new write path) appends to it.
 */

export const SEED_SCOPES = ["private", "group", "theater"] as const;
export type SeedScopeName = (typeof SEED_SCOPES)[number];

export interface SeedApplicability {
  scope: SeedScopeName[];
}

export type SeedChangeAction =
  | "new"
  | "reinforce"
  | "merge"
  | "revise"
  | "retire"
  | "reactivate"
  | "manual_create"
  | "manual_edit"
  | "manual_delete";

export interface SeedBody {
  innerOrientation: string;
  outerExpression: string;
  wakeText: string;
  boostText: string;
  suppressText: string;
  tags?: string[];
}

export interface SeedEvidenceRef {
  id: string;
  created_at?: string | null;
}

export interface SeedChangeSummary {
  from: string;
  to: string;
  boundary?: string;
}

export interface SeedTimeScope {
  description: string;
  refs: string[];
}

export interface SeedEvidenceInput {
  refs?: Array<string | SeedEvidenceRef>;
  changeSummary?: SeedChangeSummary | null;
  timeScope?: SeedTimeScope | null;
  supersedes?: { seedId: string; before: Record<string, unknown> | null } | null;
  materialTimeKind?: string;
}

export interface SeedChangeInput {
  action: SeedChangeAction;
  targetSeedId: string | null;
  seedBody?: SeedBody | null;
  reason: string;
  evidence?: SeedEvidenceInput;
  batchKey?: string | null;
  source?: "self_evolution" | "manual" | "system" | "model" | "legacy_backfill" | string;
  expectedRevision?: number | null;
  expectedUpdatedAt?: string | null;
  applicability?: SeedApplicability | null;
  /** Manual edit only: allow switching default/learned, as the UI exposes it. */
  seedSource?: string | null;
}

export interface SeedChangeResult {
  applied: boolean;
  replayed?: boolean;
  stale?: boolean;
  conflict?: string;
  seedId?: string;
  revision?: number;
}

export interface SeedSnapshot {
  [key: string]: unknown;
  id: string;
  subject: string;
  source: string;
  tags: string[];
  innerOrientation: string;
  outerExpression: string;
  wakeText: string;
  boostText: string;
  suppressText: string;
  status: string;
  revision: number;
  applicability: SeedApplicability | null;
  innate: boolean;
  count: number;
  lastSeen: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SeedChangeItem {
  id: string;
  seedId: string;
  action: string;
  reason: string;
  baseRevision: number;
  newRevision: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changeSummary: SeedChangeSummary | null;
  timeScope: SeedTimeScope | null;
  evidence: SeedEvidenceRef[];
  assessment: Record<string, unknown> | null;
  source: string;
  batchKey: string | null;
  createdAt: string;
}

/** Parse `{"scope":["private"]}`. NULL / empty / malformed = unrestricted. */
export function parseSeedApplicability(value: unknown): SeedApplicability | null {
  let raw = value;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return null;
    raw = parseJson<unknown>(text, null);
  }
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw) ? raw : (raw as { scope?: unknown }).scope;
  if (!Array.isArray(list)) return null;
  const seen = new Set<SeedScopeName>();
  for (const item of list) {
    const scope = String(item || "").trim() as SeedScopeName;
    if ((SEED_SCOPES as readonly string[]).includes(scope)) seen.add(scope);
  }
  return seen.size ? { scope: [...seen] } : null;
}

/** NULL/empty applicability means every scene, matching APP `seedMatchesScope`. */
export function seedMatchesScope(value: unknown, scene: SeedScopeName): boolean {
  const applicability = parseSeedApplicability(value);
  if (!applicability) return true;
  return applicability.scope.includes(scene);
}

export function seedApplicabilityJson(value: unknown): string | null {
  const applicability = parseSeedApplicability(value);
  return applicability ? JSON.stringify(applicability) : null;
}

export function normalizeSeedText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\s\u3000]+/g, "")
    .trim();
}

export function seedSnapshot(row: any): SeedSnapshot {
  return {
    id: String(row.id),
    subject: String(row.subject || "about_self"),
    source: String(row.source || "learned"),
    tags: parseJson<string[]>(row.tags_json, []),
    innerOrientation: String(row.inner_orientation || ""),
    outerExpression: String(row.outer_expression || ""),
    wakeText: String(row.wake_text || ""),
    boostText: String(row.boost_text || ""),
    suppressText: String(row.suppress_text || ""),
    status: String(row.status || "active"),
    revision: Number(row.revision || 0),
    applicability: parseSeedApplicability(row.applicability_json),
    innate: Boolean(Number(row.innate || 0)),
    count: Number(row.count || 0),
    lastSeen: row.last_seen || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/**
 * APP-derived auto-mutable rule: only learned, about-self seeds with no manual
 * edit/create/delete ever are eligible for automatic evolution.
 */
export function isSeedAutoMutable(scope: MemoryScope, seed: any): boolean {
  if (!seed) return false;
  if (Number(seed.innate || 0)) return false;
  if (String(seed.source || "") !== "learned") return false;
  if (String(seed.subject || "about_self") !== "about_self") return false;
  const manual = getDb()
    .prepare(
      `SELECT 1 FROM agent_state_changes
       WHERE agent_id = ? AND user_id = ? AND target_kind = 'seed' AND target_id = ?
         AND (source = 'manual' OR action IN ('manual_create','manual_edit','manual_delete'))
       UNION ALL
       SELECT 1 FROM hippocampus_seed_versions
       WHERE agent_id = ? AND user_id = ? AND seed_id = ?
         AND event_type LIKE 'manual%'
       LIMIT 1`,
    )
    .get(
      scope.agentId,
      scope.userId,
      String(seed.id),
      scope.agentId,
      scope.userId,
      String(seed.id),
    );
  return !manual;
}

function seedBodyComplete(body: SeedBody | null | undefined): body is SeedBody {
  if (!body) return false;
  return Boolean(
    String(body.innerOrientation || "").trim() &&
      String(body.outerExpression || "").trim() &&
      String(body.wakeText || "").trim() &&
      String(body.boostText || "").trim() &&
      String(body.suppressText || "").trim(),
  );
}

function cleanTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    const tag = String(item || "").trim().slice(0, 24);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= 12) break;
  }
  return result;
}

function normalizeEvidenceRefs(refs: SeedEvidenceInput["refs"]): SeedEvidenceRef[] {
  if (!Array.isArray(refs)) return [];
  const seen = new Set<string>();
  const result: SeedEvidenceRef[] = [];
  for (const item of refs) {
    const id =
      typeof item === "string" ? String(item || "").trim() : String((item as SeedEvidenceRef)?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      created_at:
        typeof item === "string" ? null : ((item as SeedEvidenceRef)?.created_at ?? null),
    });
  }
  return result;
}

function buildEvidenceJson(input: SeedChangeInput, baseRevision: number, newRevision: number) {
  const evidence = input.evidence || {};
  const payload: Record<string, unknown> = {
    refs: normalizeEvidenceRefs(evidence.refs),
    assessment: {
      assessed_at: nowIso(),
      material_time_kind: evidence.materialTimeKind || "message_time_recorded",
      base_revision: baseRevision,
      new_revision: newRevision,
    },
  };
  if (evidence.changeSummary) payload.change_summary = evidence.changeSummary;
  if (evidence.timeScope) payload.time_scope = evidence.timeScope;
  if (evidence.supersedes) {
    payload.supersedes = {
      seed_id: evidence.supersedes.seedId,
      before: evidence.supersedes.before,
    };
  }
  return JSON.stringify(payload);
}

function deleteSeedVectors(seedId: string) {
  const db = getDb();
  for (const table of ["seed_wake_vec", "seed_boost_vec", "seed_suppress_vec"]) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE seed_id = ?`).run(seedId);
    } catch {
      // Optional vec tables may not be available before sqlite-vec loads.
    }
  }
}

function readSeed(scope: MemoryScope, seedId: string): any | null {
  return (
    (getDb()
      .prepare("SELECT * FROM hippocampus_seeds WHERE id = ? AND agent_id = ? AND user_id = ?")
      .get(seedId, scope.agentId, scope.userId) as any) || null
  );
}

function findReplay(scope: MemoryScope, batchKey: string | null | undefined) {
  if (!batchKey) return null;
  return getDb()
    .prepare(
      `SELECT * FROM agent_state_changes
       WHERE batch_key = ? AND agent_id = ? AND user_id = ? AND target_kind = 'seed'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(batchKey, scope.agentId, scope.userId) as any;
}

/**
 * Insert one ledger row. Exported only for system-owned seed creation
 * (`ensureDefaultSeeds`), which must keep `source='default'` instead of the
 * learned seed produced by `applySeedChange`.
 */
export function insertSeedLedgerEntry(
  scope: MemoryScope,
  input: {
    action: SeedChangeAction;
    targetSeedId: string;
    baseRevision: number;
    newRevision: number;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason: string;
    evidence?: SeedEvidenceInput;
    source: string;
    batchKey?: string | null;
    createdAt?: string;
  },
): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO agent_state_changes
        (id, agent_id, user_id, target_kind, target_id, action,
         base_revision, new_revision, before_json, after_json,
         reason, evidence_json, batch_key, source, created_at)
       VALUES (?, ?, ?, 'seed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      scope.agentId,
      scope.userId,
      input.targetSeedId,
      input.action,
      input.baseRevision,
      input.newRevision,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      String(input.reason || ""),
      buildEvidenceJson(
        {
          action: input.action,
          targetSeedId: input.targetSeedId,
          reason: input.reason,
          evidence: input.evidence,
        },
        input.baseRevision,
        input.newRevision,
      ),
      input.batchKey ?? null,
      input.source,
      input.createdAt || nowIso(),
    );
  return id;
}

/**
 * Apply one seed change atomically: lifecycle row + revision + ledger row.
 * Embeddings are intentionally NOT computed here; callers run the async
 * embedding pass after commit so a slow model can never hold the DB lock.
 */
export function applySeedChange(scope: MemoryScope, input: SeedChangeInput): SeedChangeResult {
  const db = getDb();
  const action = String(input.action || "").trim() as SeedChangeAction;
  const allowed: SeedChangeAction[] = [
    "new",
    "reinforce",
    "merge",
    "revise",
    "retire",
    "reactivate",
    "manual_create",
    "manual_edit",
    "manual_delete",
  ];
  if (!allowed.includes(action)) return { applied: false, conflict: "invalid_action" };
  const source = String(input.source || (action.startsWith("manual_") ? "manual" : "self_evolution"));
  const batchKey = input.batchKey ? String(input.batchKey) : null;

  const replay = findReplay(scope, batchKey);
  if (replay) {
    return {
      applied: true,
      replayed: true,
      seedId: String(replay.target_id),
      revision: Number(replay.new_revision || 0),
    };
  }

  const isCreate = action === "new" || action === "manual_create";
  const targetSeedId = String(input.targetSeedId || "").trim();
  if (!isCreate && !targetSeedId) return { applied: false, conflict: "missing_target" };
  if (isCreate && !seedBodyComplete(input.seedBody || null)) {
    return { applied: false, conflict: "invalid_body" };
  }
  if (
    ["merge", "revise", "manual_edit"].includes(action) &&
    action !== "manual_edit" &&
    !seedBodyComplete(input.seedBody || null)
  ) {
    return { applied: false, conflict: "invalid_body" };
  }

  return db.transaction((): SeedChangeResult => {
    const duplicate = findReplay(scope, batchKey);
    if (duplicate) {
      return {
        applied: true,
        replayed: true,
        seedId: String(duplicate.target_id),
        revision: Number(duplicate.new_revision || 0),
      };
    }

    const now = nowIso();
    let before: SeedSnapshot | null = null;
    let after: SeedSnapshot | null = null;
    let seedId = targetSeedId;
    let baseRevision = 0;
    let revision = 1;

    if (isCreate) {
      seedId = `seed-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const body = input.seedBody as SeedBody;
      const tags = cleanTags(body.tags);
      db.prepare(
        `INSERT INTO hippocampus_seeds
          (id, agent_id, user_id, subject, source, tags_json, revision, status,
           applicability_json, inner_orientation, outer_expression, wake_text,
           boost_text, suppress_text, count, last_seen, created_at, updated_at)
         VALUES (?, ?, ?, 'about_self', 'learned', ?, 1, 'active', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        seedId,
        scope.agentId,
        scope.userId,
        JSON.stringify(tags),
        seedApplicabilityJson(input.applicability),
        String(body.innerOrientation).trim(),
        String(body.outerExpression).trim(),
        String(body.wakeText).trim(),
        String(body.boostText).trim(),
        String(body.suppressText).trim(),
        now,
        now,
        now,
      );
      after = seedSnapshot(readSeed(scope, seedId));
    } else {
      const row = readSeed(scope, seedId);
      if (!row) return { applied: false, stale: true, conflict: "target_missing" };
      before = seedSnapshot(row);
      baseRevision = Number(row.revision || 0);
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== null &&
        Number(input.expectedRevision) !== baseRevision
      ) {
        return { applied: false, conflict: "revision_conflict" };
      }
      if (
        input.expectedUpdatedAt &&
        String(input.expectedUpdatedAt) !== String(row.updated_at || "")
      ) {
        return { applied: false, conflict: "updated_at_conflict" };
      }
      const status = String(row.status || "active");
      if (["reinforce", "merge", "revise"].includes(action) && status === "retired") {
        return { applied: false, conflict: "target_retired" };
      }
      if (action === "retire" && status === "retired") {
        return { applied: false, conflict: "already_retired" };
      }
      if (action === "reactivate" && status !== "retired") {
        return { applied: false, conflict: "not_retired" };
      }
      revision = baseRevision + 1;

      if (action === "reinforce") {
        db.prepare(
          `UPDATE hippocampus_seeds
           SET count = COALESCE(count, 0) + 1, last_seen = ?, updated_at = ?, revision = ?
           WHERE id = ?`,
        ).run(now, now, revision, seedId);
      } else if (action === "retire" || action === "reactivate") {
        db.prepare(
          `UPDATE hippocampus_seeds SET status = ?, updated_at = ?, revision = ? WHERE id = ?`,
        ).run(action === "retire" ? "retired" : "active", now, revision, seedId);
      } else if (action === "manual_delete") {
        db.prepare("DELETE FROM hippocampus_seeds WHERE id = ?").run(seedId);
        deleteSeedVectors(seedId);
      } else {
        const body = input.seedBody;
        const assignments: string[] = ["updated_at = ?", "revision = ?"];
        const params: any[] = [now, revision];
        if (body) {
          assignments.push(
            "inner_orientation = ?",
            "outer_expression = ?",
            "wake_text = ?",
            "boost_text = ?",
            "suppress_text = ?",
          );
          params.push(
            String(body.innerOrientation).trim(),
            String(body.outerExpression).trim(),
            String(body.wakeText).trim(),
            String(body.boostText).trim(),
            String(body.suppressText).trim(),
          );
          if (body.tags !== undefined) {
            assignments.push("tags_json = ?");
            params.push(JSON.stringify(cleanTags(body.tags)));
          }
          assignments.push("last_seen = ?");
          params.push(now);
          if (action === "merge" || action === "revise") {
            assignments.push("count = COALESCE(count, 0) + 1");
          }
        }
        if (input.applicability !== undefined) {
          assignments.push("applicability_json = ?");
          params.push(seedApplicabilityJson(input.applicability));
        }
        if (
          action === "manual_edit" &&
          input.seedSource &&
          ["default", "learned"].includes(String(input.seedSource))
        ) {
          assignments.push("source = ?");
          params.push(String(input.seedSource));
        }
        params.push(seedId);
        db.prepare(`UPDATE hippocampus_seeds SET ${assignments.join(", ")} WHERE id = ?`).run(
          ...params,
        );
      }
      const updated = readSeed(scope, seedId);
      after = updated ? seedSnapshot(updated) : null;
    }

    insertSeedLedgerEntry(scope, {
      action,
      targetSeedId: seedId,
      baseRevision: isCreate ? 0 : baseRevision,
      newRevision: revision,
      before,
      after,
      reason: String(input.reason || "").trim(),
      evidence: input.evidence,
      source,
      batchKey,
      createdAt: now,
    });
    return { applied: true, seedId, revision };
  })();
}

function parseEvidence(raw: string | null | undefined): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(raw, {});
}

function changeToItem(row: any): SeedChangeItem {
  const evidence = parseEvidence(row.evidence_json);
  const refsRaw = Array.isArray(evidence.refs) ? evidence.refs : [];
  return {
    id: row.id,
    seedId: row.target_id,
    action: row.action,
    reason: row.reason || "",
    baseRevision: Number(row.base_revision || 0),
    newRevision: Number(row.new_revision || 0),
    before: parseJson<Record<string, unknown> | null>(row.before_json, null),
    after: parseJson<Record<string, unknown> | null>(row.after_json, null),
    changeSummary:
      (evidence.change_summary as SeedChangeSummary | undefined) || null,
    timeScope: (evidence.time_scope as SeedTimeScope | undefined) || null,
    evidence: refsRaw.map((item: any) => ({
      id: String(item?.id ?? item ?? ""),
      created_at: item?.created_at ?? null,
    })),
    assessment: (evidence.assessment as Record<string, unknown> | undefined) || null,
    source: row.source || "model",
    batchKey: row.batch_key ?? null,
    createdAt: row.created_at,
  };
}

export function listSeedChanges(
  scope: MemoryScope,
  input: { seedId?: string; limit?: number } = {},
) {
  const clauses = ["agent_id = ?", "user_id = ?", "target_kind = 'seed'"];
  const params: any[] = [scope.agentId, scope.userId];
  if (input.seedId) {
    clauses.push("target_id = ?");
    params.push(input.seedId);
  }
  const limit = Math.max(1, Math.min(Number(input.limit || 100), 500));
  const rows = getDb()
    .prepare(
      `SELECT * FROM agent_state_changes WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit) as any[];
  const total = Number(
    (
      getDb()
        .prepare(`SELECT COUNT(*) AS c FROM agent_state_changes WHERE ${clauses.join(" AND ")}`)
        .get(...params) as { c: number }
    ).c,
  );
  return { items: rows.map(changeToItem), total };
}

/** Deterministic batch key helper used by self-evolution reviews. */
export function seedReviewBatchKey(agentId: number, userId: string, messageIds: number[]): string {
  const digest = createHash("sha1")
    .update(`${agentId}:${userId}:${messageIds.join(",")}`)
    .digest("hex")
    .slice(0, 16);
  return `seed-review:${agentId}:${digest}`;
}
