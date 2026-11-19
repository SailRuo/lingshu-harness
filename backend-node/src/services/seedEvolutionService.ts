import { getDb } from "../db/sqlite.js";
import { embedText, storeSeedEmbeddings } from "./embeddingService.js";
import type { MemoryScope } from "./memoryScope.js";
import {
  applySeedChange,
  isSeedAutoMutable,
  normalizeSeedText,
  seedMatchesScope,
  type SeedBody,
  type SeedChangeSummary,
  type SeedTimeScope,
  type SeedApplicability,
} from "./seedLedgerService.js";

/**
 * Policy layer for the APP `SELF_EVOLUTION` / `SEED_REVIEW` contract.
 *
 * The LLM proposes; this module only checks what the APP contract makes
 * mechanical: lifecycle evidence, candidate relations, protection and scope.
 * It never decides semantic similarity itself.
 */

export type SeedReviewAction =
  | "noop"
  | "reinforce"
  | "merge"
  | "revise"
  | "new"
  | "retire"
  | "reactivate";

export type SeedCandidateRelationKind = "duplicate" | "refine" | "independent" | "unclear";

export interface SeedCandidateRelation {
  seedId: string;
  relation: SeedCandidateRelationKind;
  basis: string;
  evidenceRefs: string[];
}

export interface SeedReviewRow {
  id: string;
  role: string;
  created_at?: string | null;
}

export interface SeedReviewCandidate {
  id: string;
  revision: number;
  status: string;
  applicability: SeedApplicability | null;
  autoMutable: boolean;
  innerOrientation: string;
  outerExpression: string;
  wakeText: string;
  boostText: string;
  suppressText: string;
}

export interface SeedReviewPayload {
  action: SeedReviewAction;
  targetSeedId: string | null;
  supersedesSeedId: string | null;
  reason: string;
  body: SeedBody | null;
  candidateRelations: SeedCandidateRelation[];
  changeSummary: SeedChangeSummary | null;
  timeScope: SeedTimeScope | null;
  evidenceRefs: string[];
  /** Raw model action before normalization, for audit. */
  rawAction?: string;
}

export interface SeedReviewDecision extends SeedReviewPayload {
  expectedRevision: number | null;
  expectedSupersedesRevision: number | null;
}

export type SeedReviewValidation =
  | { ok: true; decision: SeedReviewDecision }
  | { ok: false; action: "noop"; reason: string };

function cleanBody(body: SeedBody | null): SeedBody | null {
  if (!body) return null;
  return {
    innerOrientation: String(body.innerOrientation || "").trim(),
    outerExpression: String(body.outerExpression || "").trim(),
    wakeText: String(body.wakeText || "").trim(),
    boostText: String(body.boostText || "").trim(),
    suppressText: String(body.suppressText || "").trim(),
    tags: Array.isArray(body.tags) ? body.tags.map(String).map((tag) => tag.trim()).filter(Boolean) : [],
  };
}

function bodyComplete(body: SeedBody | null): body is SeedBody {
  if (!body) return false;
  return Boolean(
    body.innerOrientation &&
      body.outerExpression &&
      body.wakeText &&
      body.boostText &&
      body.suppressText,
  );
}

export function hasSeedLifecycleEvidence(
  review: Pick<SeedReviewPayload, "reason" | "evidenceRefs">,
  rows: SeedReviewRow[],
): boolean {
  if (!String(review.reason || "").trim()) return false;
  const refs = (Array.isArray(review.evidenceRefs) ? review.evidenceRefs : [])
    .map(String)
    .filter(Boolean);
  if (refs.length < 2) return false;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const seen = new Set<string>();
  let ownResponse = false;
  for (const id of refs) {
    if (seen.has(id)) return false;
    const row = byId.get(id);
    if (!row) return false;
    seen.add(id);
    if (row.role === "assistant") ownResponse = true;
  }
  return seen.size >= 2 && ownResponse;
}

function refsShapeValid(refs: string[]): boolean {
  if (!refs.length) return false;
  const seen = new Set<string>();
  for (const ref of refs) {
    const id = String(ref || "").trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function evidenceRefsExist(refs: string[], rows: SeedReviewRow[]): boolean {
  if (!refsShapeValid(refs)) return false;
  const known = new Set(rows.map((row) => String(row.id)));
  for (const ref of refs) {
    if (!known.has(String(ref).trim())) return false;
  }
  return true;
}

function participatingCandidates(candidates: SeedReviewCandidate[]): SeedReviewCandidate[] {
  return candidates.filter(
    (candidate) =>
      String(candidate.status || "active") === "active" &&
      candidate.autoMutable &&
      seedMatchesScope(candidate.applicability, "private") &&
      String(candidate.innerOrientation || "").trim(),
  );
}

function findCandidate(
  candidates: SeedReviewCandidate[],
  seedId: string | null,
): SeedReviewCandidate | null {
  const id = String(seedId || "").trim();
  if (!id) return null;
  return candidates.find((candidate) => candidate.id === id) || null;
}

/**
 * Mechanical `action=new` gate. Returns null when allowed, otherwise the
 * rejection reason persisted in the seed_review task event.
 */
function candidateRelationRejection(
  body: SeedBody,
  relations: SeedCandidateRelation[],
  candidates: SeedReviewCandidate[],
): string | null {
  const active = participatingCandidates(candidates);
  const normalizedNew = normalizeSeedText(body.innerOrientation);
  for (const candidate of active) {
    if (normalizedNew && normalizeSeedText(candidate.innerOrientation) === normalizedNew) {
      return "duplicate_active_candidate";
    }
  }

  const known = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const declared = new Map<string, SeedCandidateRelation>();
  for (const relation of relations) {
    const id = String(relation.seedId || "").trim();
    if (!id || !known.has(id)) return `relation_unknown_candidate:${id || "empty"}`;
    if (declared.has(id)) return `relation_duplicate_declaration:${id}`;
    if (!relation.basis || !String(relation.basis).trim()) return `relation_invalid_basis:${id}`;
    if (!refsShapeValid(relation.evidenceRefs || [])) return `relation_invalid_evidence:${id}`;
    declared.set(id, relation);
  }

  for (const candidate of active) {
    const relation = declared.get(candidate.id);
    if (!relation) return `relation_missing_candidate:${candidate.id}`;
    if (relation.relation === "duplicate") return "duplicate_active_candidate";
    if (relation.relation === "refine") return "refine_requires_target";
    if (relation.relation === "unclear") return "relation_unclear";
    if (relation.relation !== "independent") return `relation_invalid:${candidate.id}`;
  }
  return null;
}

/**
 * Full policy validation. `rows` are the real messages of the current digest
 * segment; every evidence ref must resolve inside it.
 */
export function validateSeedReview(input: {
  review: SeedReviewPayload;
  candidates: SeedReviewCandidate[];
  rows: SeedReviewRow[];
}): SeedReviewValidation {
  const review: SeedReviewPayload = {
    ...input.review,
    body: cleanBody(input.review.body),
    reason: String(input.review.reason || "").trim(),
    targetSeedId: String(input.review.targetSeedId || "").trim() || null,
    supersedesSeedId: String(input.review.supersedesSeedId || "").trim() || null,
    candidateRelations: Array.isArray(input.review.candidateRelations)
      ? input.review.candidateRelations.map((relation) => ({
          seedId: String(relation.seedId || "").trim(),
          relation: relation.relation,
          basis: String(relation.basis || ""),
          evidenceRefs: Array.isArray(relation.evidenceRefs)
            ? relation.evidenceRefs.map(String)
            : [],
        }))
      : [],
    evidenceRefs: Array.isArray(input.review.evidenceRefs)
      ? input.review.evidenceRefs.map(String).filter(Boolean)
      : [],
  };
  const candidates = input.candidates;

  if (review.action === "noop" || !review.action) {
    return { ok: true, decision: { ...review, action: "noop", expectedRevision: null, expectedSupersedesRevision: null } };
  }
  if (!review.reason) return { ok: false, action: "noop", reason: "missing_reason" };

  if (review.action === "new") {
    if (!bodyComplete(review.body)) return { ok: false, action: "noop", reason: "invalid_body" };
    for (const relation of review.candidateRelations) {
      if (!evidenceRefsExist(relation.evidenceRefs || [], input.rows)) {
        return { ok: false, action: "noop", reason: `relation_invalid_evidence:${relation.seedId || "empty"}` };
      }
    }
    const relationRejection = candidateRelationRejection(
      review.body,
      review.candidateRelations,
      candidates,
    );
    if (relationRejection) return { ok: false, action: "noop", reason: relationRejection };

    let expectedSupersedesRevision: number | null = null;
    if (review.supersedesSeedId) {
      const old = findCandidate(candidates, review.supersedesSeedId);
      if (!old) return { ok: false, action: "noop", reason: "supersedes_target_missing" };
      if (String(old.status || "active") !== "retired") {
        return { ok: false, action: "noop", reason: "supersedes_target_not_retired" };
      }
      if (!old.autoMutable) return { ok: false, action: "noop", reason: "supersedes_target_protected" };
      if (!seedMatchesScope(old.applicability, "private")) {
        return { ok: false, action: "noop", reason: "supersedes_target_out_of_scope" };
      }
      if (
        !normalizeSeedText(review.body.innerOrientation) ||
        normalizeSeedText(review.body.innerOrientation) === normalizeSeedText(old.innerOrientation)
      ) {
        return { ok: false, action: "noop", reason: "supersedes_body_not_new" };
      }
      if (!hasSeedLifecycleEvidence(review, input.rows)) {
        return { ok: false, action: "noop", reason: "insufficient_lifecycle_evidence" };
      }
      expectedSupersedesRevision = Number(old.revision || 0);
    }
    return {
      ok: true,
      decision: { ...review, expectedRevision: null, expectedSupersedesRevision },
    };
  }

  const target = findCandidate(candidates, review.targetSeedId);
  if (!target) return { ok: false, action: "noop", reason: "target_missing" };
  if (!target.autoMutable) return { ok: false, action: "noop", reason: "target_protected" };
  if (!seedMatchesScope(target.applicability, "private")) {
    return { ok: false, action: "noop", reason: "target_out_of_scope" };
  }

  if (["reinforce", "merge", "revise"].includes(review.action)) {
    if (String(target.status || "active") !== "active") {
      return { ok: false, action: "noop", reason: "target_not_active" };
    }
    if (review.action !== "reinforce" && !bodyComplete(review.body)) {
      return { ok: false, action: "noop", reason: "invalid_body" };
    }
  }
  if (review.action === "retire") {
    if (String(target.status || "active") !== "active") {
      return { ok: false, action: "noop", reason: "target_not_active" };
    }
    if (!hasSeedLifecycleEvidence(review, input.rows)) {
      return { ok: false, action: "noop", reason: "insufficient_lifecycle_evidence" };
    }
  }
  if (review.action === "reactivate") {
    if (String(target.status || "active") !== "retired") {
      return { ok: false, action: "noop", reason: "target_not_retired" };
    }
    if (!hasSeedLifecycleEvidence(review, input.rows)) {
      return { ok: false, action: "noop", reason: "insufficient_lifecycle_evidence" };
    }
  }

  return {
    ok: true,
    decision: {
      ...review,
      expectedRevision: Number(target.revision || 0),
      expectedSupersedesRevision: null,
    },
  };
}

export interface SeedReviewApplyResult {
  action: "noop" | "create" | "reinforce" | "merge" | "revise" | "retire" | "reactivate";
  reason: string;
  seedId: string | null;
  rawAction?: string;
}

function refObjects(refs: string[], rows: SeedReviewRow[]) {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return refs.map((id) => ({
    id: String(id),
    created_at: byId.get(String(id))?.created_at ?? null,
  }));
}

async function refreshSeedEmbeddings(seedId: string) {
  const row = getDb()
    .prepare("SELECT wake_text, boost_text, suppress_text FROM hippocampus_seeds WHERE id = ?")
    .get(seedId) as
    | { wake_text: string; boost_text: string; suppress_text: string }
    | undefined;
  if (!row) return;
  try {
    const [wake, boost, suppress] = await Promise.all([
      embedText(String(row.wake_text || ""), { wait: true }),
      embedText(String(row.boost_text || ""), { wait: true }),
      embedText(String(row.suppress_text || ""), { wait: true }),
    ]);
    storeSeedEmbeddings(seedId, wake.vector, boost.vector, suppress.vector);
  } catch (error) {
    console.warn("[SEED_EVOLUTION_EMBED_FAILED]", {
      seedId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Commit a validated decision. `reason` from a rejected/conflicted change is
 * returned so the caller can record why the review ended as noop.
 */
export async function applySeedReview(
  scope: MemoryScope,
  decision: SeedReviewDecision,
  context: {
    rows: SeedReviewRow[];
    batchKey?: string | null;
    guard?: () => boolean;
  },
): Promise<SeedReviewApplyResult> {
  if (decision.action === "noop") {
    return { action: "noop", reason: decision.reason || "noop", seedId: null, rawAction: "noop" };
  }
  if (context.guard && !context.guard()) {
    return { action: "noop", reason: "stale", seedId: null, rawAction: decision.action };
  }

  if (decision.supersedesSeedId && decision.expectedSupersedesRevision !== null) {
    const old = getDb()
      .prepare("SELECT revision FROM hippocampus_seeds WHERE id = ? AND agent_id = ? AND user_id = ?")
      .get(decision.supersedesSeedId, scope.agentId, scope.userId) as { revision: number } | undefined;
    if (!old || Number(old.revision || 0) !== decision.expectedSupersedesRevision) {
      return {
        action: "noop",
        reason: "supersedes_revision_conflict",
        seedId: null,
        rawAction: decision.action,
      };
    }
  }

  const supersedesBefore = decision.supersedesSeedId
    ? (getDb()
        .prepare("SELECT * FROM hippocampus_seeds WHERE id = ? AND agent_id = ? AND user_id = ?")
        .get(decision.supersedesSeedId, scope.agentId, scope.userId) as any)
    : null;

  const result = applySeedChange(scope, {
    action: decision.action,
    targetSeedId: decision.targetSeedId,
    seedBody: decision.body,
    reason: decision.reason,
    batchKey: context.batchKey ?? null,
    source: "self_evolution",
    expectedRevision: decision.expectedRevision,
    evidence: {
      refs: refObjects(decision.evidenceRefs, context.rows),
      changeSummary: decision.changeSummary,
      timeScope: decision.timeScope,
      supersedes:
        decision.supersedesSeedId && supersedesBefore
          ? { seedId: decision.supersedesSeedId, before: supersedesBefore }
          : null,
    },
  });

  if (!result.applied) {
    return {
      action: "noop",
      reason: result.conflict || "seed_change_not_applied",
      seedId: null,
      rawAction: decision.action,
    };
  }
  if (result.replayed) {
    return {
      action: decision.action === "new" ? "create" : decision.action,
      reason: decision.reason,
      seedId: result.seedId || null,
      rawAction: decision.action,
    };
  }

  if (decision.action === "new" || decision.action === "merge" || decision.action === "revise") {
    if (result.seedId) await refreshSeedEmbeddings(result.seedId);
  }

  return {
    action: decision.action === "new" ? "create" : decision.action,
    reason: decision.reason,
    seedId: result.seedId || null,
    rawAction: decision.action,
  };
}

export function loadSeedReviewRows(
  scope: MemoryScope,
  messageIds: number[],
): SeedReviewRow[] {
  const ids = messageIds.map(Number).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT id, role, created_at FROM chat_messages
       WHERE agent_id = ? AND user_id = ? AND id IN (${placeholders})`,
    )
    .all(scope.agentId, scope.userId, ...ids) as Array<{
    id: number;
    role: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: String(row.id),
    role: String(row.role || ""),
    created_at: row.created_at || null,
  }));
}

export function isCandidateAutoMutable(scope: MemoryScope, row: any): boolean {
  return isSeedAutoMutable(scope, row);
}
