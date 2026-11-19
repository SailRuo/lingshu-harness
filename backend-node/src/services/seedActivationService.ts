import { getDb, vectorExtensionStatus } from "../db/sqlite.js";
import {
  bufferToVector,
  cosineSimilarity,
  embedQueryText,
  embedText,
  storeSeedEmbeddings,
  vectorToBuffer,
} from "./embeddingService.js";
import { seedMatchesScope } from "./seedLedgerService.js";

const CANDIDATE_FLOOR = 0.4;
const INFLUENCE_FLOOR = 0.55;
const SINGLE_BOOST_CAP = 0.08;
const SINGLE_SUPPRESS_CAP = 0.12;
const TOTAL_BOOST_CAP = 0.16;
const TOTAL_SUPPRESS_CAP = 0.24;
const ACTIVE_THRESHOLD = 0.45;
const SUPPRESSED_FLOOR = 0.4;
const ANN_LIMIT = 64;
const CANDIDATE_POOL_LIMIT = 200;
const PROMPT_SEED_LIMIT = 3;
const INNER_CHAR_BUDGET = 1200;
const STYLE_CHAR_BUDGET = 1200;

export interface SeedTrace {
  seedId: string;
  innerOrientation: string;
  outerExpression: string;
  wakeText: string;
  boostText: string;
  suppressText: string;
  wakeScore: number;
  fieldBoost: number;
  fieldGuard: number;
  fieldSuppress: number;
  seedBoost: number;
  seedSuppress: number;
  finalScore: number;
  active: boolean;
  injected: boolean;
  innerInjected: boolean;
  outerInjected: boolean;
  reason: string;
  influences: Record<string, unknown>[];
}

export interface SeedActivationSnapshot {
  field: {
    wakeText: string;
    wakeQueries: string[];
    boostText: string;
    suppressText: string;
    source: string;
  };
  params: Record<string, number | string>;
  candidates: Array<Record<string, unknown>>;
  activeSeedIds: string[];
  injectedSeedIds: string[];
  annAudit: Record<string, unknown>;
  /** 明确标注降级原因（如无 ONNX 向量能力时） */
  degraded?: string | null;
}

export interface SeedActivationResult {
  traces: SeedTrace[];
  snapshot: SeedActivationSnapshot;
  innerLines: string[];
  outerLines: string[];
}

interface SeedRow {
  id: string;
  subject: string;
  source: string;
  revision: number;
  status: string;
  applicability_json: string | null;
  inner_orientation: string;
  outer_expression: string;
  wake_text: string;
  boost_text: string;
  suppress_text: string;
  wake_embedding: Buffer | null;
  boost_embedding: Buffer | null;
  suppress_embedding: Buffer | null;
  updated_at: string;
}

export type SeedLifecycleRejection = "retired" | "out_of_scope";

/**
 * M2 lifecycle/scope gate. Retired seeds never enter scoring or prompt
 * assembly, regardless of vector distance. NULL applicability = all scenes.
 */
export function seedLifecycleRejection(
  seed: Pick<SeedRow, "status" | "applicability_json">,
  scene: "private" | "group" | "theater" = "private",
): SeedLifecycleRejection | null {
  if (String(seed.status || "active") === "retired") return "retired";
  if (!seedMatchesScope(seed.applicability_json, scene)) return "out_of_scope";
  return null;
}

function contribution(match: number, cap: number): number {
  if (match < INFLUENCE_FLOOR) return 0;
  return Math.min(cap, ((match - INFLUENCE_FLOOR) / 0.45) * cap);
}

type SeedVecTable = "seed_wake_vec" | "seed_boost_vec" | "seed_suppress_vec";

interface AnnHit {
  seedId: string;
  distance: number;
}

interface AnnQuery {
  table: SeedVecTable;
  vector: number[];
}

/**
 * Run a real sqlite-vec ANN query. The vec0 tables are global, so scope
 * filtering happens after MATCH by loading the scoped seed rows.
 */
function annQuery(table: SeedVecTable, vector: number[], k: number): AnnHit[] {
  if (!vector.some(Boolean)) return [];
  const rows = getDb()
    .prepare(`SELECT seed_id, distance FROM ${table} WHERE embedding MATCH ? AND k = ?`)
    .all(vectorToBuffer(vector), k) as { seed_id: string; distance: number }[];
  return rows.map((row) => ({ seedId: String(row.seed_id), distance: Number(row.distance) }));
}

/**
 * Backfill vec0 rows from the BLOB columns for databases written before the
 * extension was available (or before a seed was indexed). This keeps ANN from
 * silently missing existing seeds.
 */
function ensureSeedVecIndex(agentId: number, userId: string) {
  const db = getDb();
  const columns: Array<[SeedVecTable, "wake_embedding" | "boost_embedding" | "suppress_embedding"]> = [
    ["seed_wake_vec", "wake_embedding"],
    ["seed_boost_vec", "boost_embedding"],
    ["seed_suppress_vec", "suppress_embedding"],
  ];

  for (const [table, column] of columns) {
    const sourceCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM hippocampus_seeds
           WHERE agent_id = ? AND user_id = ? AND ${column} IS NOT NULL`,
        )
        .get(agentId, userId) as { c: number }
    ).c;
    if (!sourceCount) continue;
    const indexedCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM hippocampus_seeds s
           WHERE s.agent_id = ? AND s.user_id = ? AND s.${column} IS NOT NULL
             AND EXISTS (SELECT 1 FROM ${table} v WHERE v.seed_id = s.id)`,
        )
        .get(agentId, userId) as { c: number }
    ).c;
    if (indexedCount >= sourceCount) continue;

    const indexed = new Set(
      (db.prepare(`SELECT seed_id FROM ${table}`).all() as { seed_id: string }[]).map((row) =>
        String(row.seed_id),
      ),
    );
    const missing = (
      db
        .prepare(
          `SELECT id, ${column} AS embedding FROM hippocampus_seeds
           WHERE agent_id = ? AND user_id = ? AND ${column} IS NOT NULL`,
        )
        .all(agentId, userId) as { id: string; embedding: Buffer | null }[]
    ).filter((row) => row.embedding && !indexed.has(row.id));
    if (!missing.length) continue;
    db.transaction(() => {
      for (const row of missing) {
        db.prepare(`DELETE FROM ${table} WHERE seed_id = ?`).run(row.id);
        db.prepare(`INSERT INTO ${table} (seed_id, embedding) VALUES (?, ?)`).run(
          row.id,
          row.embedding,
        );
      }
    })();
  }
}

function loadSeedsByIds(ids: string[], agentId: number, userId: string): SeedRow[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT * FROM hippocampus_seeds
       WHERE id IN (${placeholders}) AND agent_id = ? AND user_id = ? AND subject = 'about_self'`,
    )
    .all(...ids, agentId, userId) as SeedRow[];
}

function loadRecentScopedSeeds(agentId: number, userId: string, limit: number): SeedRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM hippocampus_seeds
       WHERE agent_id = ? AND user_id = ? AND subject = 'about_self'
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(agentId, userId, limit) as SeedRow[];
}

function loadUnindexedSeeds(agentId: number, userId: string, limit: number): SeedRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM hippocampus_seeds
       WHERE agent_id = ? AND user_id = ? AND subject = 'about_self'
         AND (wake_embedding IS NULL OR boost_embedding IS NULL OR suppress_embedding IS NULL)
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(agentId, userId, limit) as SeedRow[];
}

interface AnnCandidates {
  seeds: SeedRow[];
  mode: "sqlite_vec_ann" | "exact_scan_fallback";
  annReturned: number;
  vecReady: boolean;
  vecError: string | null;
  degradedReason: string | null;
}

/**
 * Build the 200-row candidate pool from ANN results across the wake / boost /
 * suppress vec tables, then exact-score the pool downstream and keep 64.
 *
 * When sqlite-vec is unavailable (or a MATCH query fails) we do NOT pretend ANN
 * ran: the snapshot is labelled `exact_scan_fallback` and `degraded` names the
 * exact reason.
 */
function collectAnnCandidates(
  queries: AnnQuery[],
  agentId: number,
  userId: string,
): AnnCandidates {
  const status = vectorExtensionStatus();
  if (!status.ready) {
    console.warn("[SEED_ACTIVATION_ANN_UNAVAILABLE]", { error: status.error });
    return {
      seeds: loadRecentScopedSeeds(agentId, userId, CANDIDATE_POOL_LIMIT),
      mode: "exact_scan_fallback",
      annReturned: 0,
      vecReady: false,
      vecError: status.error,
      degradedReason: "sqlite_vec_unavailable",
    };
  }

  try {
    ensureSeedVecIndex(agentId, userId);

    const bestDistance = new Map<string, number>();
    let annReturned = 0;
    for (const query of queries) {
      if (!query.vector.some(Boolean)) continue;
      const hits = annQuery(query.table, query.vector, CANDIDATE_POOL_LIMIT);
      annReturned += hits.length;
      for (const hit of hits) {
        const previous = bestDistance.get(hit.seedId);
        if (previous === undefined || hit.distance < previous) {
          bestDistance.set(hit.seedId, hit.distance);
        }
      }
    }

    const orderedIds = [...bestDistance.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([seedId]) => seedId)
      .slice(0, CANDIDATE_POOL_LIMIT);
    const seeds = loadSeedsByIds(orderedIds, agentId, userId);

    // Seeds without complete BLOB vectors cannot be ANN hits yet; keep them in
    // the pool so the existing embed-and-store pass can complete them.
    if (seeds.length < CANDIDATE_POOL_LIMIT) {
      const seen = new Set(seeds.map((seed) => seed.id));
      for (const seed of loadUnindexedSeeds(agentId, userId, CANDIDATE_POOL_LIMIT)) {
        if (seeds.length >= CANDIDATE_POOL_LIMIT) break;
        if (seen.has(seed.id)) continue;
        seeds.push(seed);
        seen.add(seed.id);
      }
    }

    return {
      seeds,
      mode: "sqlite_vec_ann",
      annReturned,
      vecReady: true,
      vecError: null,
      degradedReason: null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("[SEED_ACTIVATION_ANN_FAILED]", { error: detail });
    return {
      seeds: loadRecentScopedSeeds(agentId, userId, CANDIDATE_POOL_LIMIT),
      mode: "exact_scan_fallback",
      annReturned: 0,
      vecReady: true,
      vecError: detail,
      degradedReason: "sqlite_vec_query_failed",
    };
  }
}

function maxPairCos(left: number[], rightA: number[], rightB: number[]): number {
  return Math.max(cosineSimilarity(left, rightA), cosineSimilarity(left, rightB));
}

function maxVectorScore(queries: number[][], target: number[]): number {
  let best = 0;
  for (const query of queries) {
    best = Math.max(best, cosineSimilarity(query, target));
  }
  return best;
}

function frameTextWakeQuery(role: string, text: string): string {
  const value = String(text || "").trim();
  if (!value) return "";
  return String(role || "").toLowerCase() === "assistant"
    ? `她刚才说：${value}`
    : `他在说：${value}`;
}

function wakeUtterances(
  userText: string,
  recentMessages: { role: string; content: string }[] = [],
): { role: string; text: string }[] {
  const rows = recentMessages
    .filter((item) => ["user", "assistant"].includes(item.role))
    .map((item) => ({ role: item.role, text: String(item.content || "").trim() }))
    .filter((item) => item.text);
  const current = String(userText || "").trim();
  if (current) {
    const last = rows[rows.length - 1];
    if (!last || last.role !== "user" || last.text !== current) {
      rows.push({ role: "user", text: current });
    }
  }
  const users = rows.filter((item) => item.role === "user").slice(-3);
  const assistants = rows.filter((item) => item.role === "assistant").slice(-2);
  const keep = new Set([...users, ...assistants]);
  return rows.filter((item) => keep.has(item));
}

function params() {
  return {
    candidateFloor: CANDIDATE_FLOOR,
    candidateGate: "ann_complete_seed",
    influenceFloor: INFLUENCE_FLOOR,
    singleBoostCap: SINGLE_BOOST_CAP,
    singleSuppressCap: SINGLE_SUPPRESS_CAP,
    totalBoostCap: TOTAL_BOOST_CAP,
    totalSuppressCap: TOTAL_SUPPRESS_CAP,
    activeThreshold: ACTIVE_THRESHOLD,
    suppressedFloor: SUPPRESSED_FLOOR,
    seedPropagationRounds: 1,
    promptSeedLimit: PROMPT_SEED_LIMIT,
  };
}

function reasonFor(wakeScore: number, finalScore: number, portraitOk = true): string {
  if (!portraitOk) return "missing_portrait";
  if (wakeScore < CANDIDATE_FLOOR) return "wake_below_floor";
  if (finalScore < SUPPRESSED_FLOOR) return "suppressed_below_floor";
  if (finalScore < ACTIVE_THRESHOLD) return "final_below_threshold";
  return "active";
}

function scaleInfluences(
  influences: Record<string, unknown>[],
  kind: string,
  rawTotal: number,
  appliedTotal: number,
) {
  if (rawTotal <= 0) return;
  const scale = appliedTotal / rawTotal;
  for (const item of influences) {
    if (item.kind !== kind) continue;
    item.appliedDelta = Number((Number(item.rawDelta || 0) * scale).toFixed(4));
  }
}

function applyPromptBudget(traces: SeedTrace[], limit: number): { inner: string[]; outer: string[] } {
  const inner: string[] = [];
  const outer: string[] = [];
  let innerChars = 0;
  let outerChars = 0;
  let injectedCount = 0;
  for (const trace of traces) {
    if (!trace.active) continue;
    const canInject = injectedCount < limit;
    const innerOk = Boolean(
      canInject && trace.innerOrientation && innerChars + trace.innerOrientation.length <= INNER_CHAR_BUDGET,
    );
    const outerOk = Boolean(
      canInject && trace.outerExpression && outerChars + trace.outerExpression.length <= STYLE_CHAR_BUDGET,
    );
    if (innerOk) {
      inner.push(trace.innerOrientation);
      innerChars += trace.innerOrientation.length;
    }
    if (outerOk) {
      outer.push(trace.outerExpression);
      outerChars += trace.outerExpression.length;
    }
    trace.innerInjected = innerOk;
    trace.outerInjected = outerOk;
    trace.injected = innerOk || outerOk;
    if (trace.injected) {
      injectedCount += 1;
      trace.reason = "active";
    } else if (trace.active) {
      trace.reason = "budget_truncated";
    }
  }
  return { inner, outer };
}

export async function activateSeedsForText(input: {
  agentId: number;
  userId: string;
  userText: string;
  recentMessages?: { role: string; content: string }[];
}): Promise<SeedActivationResult> {
  const utterances = wakeUtterances(input.userText, input.recentMessages);
  const framed = utterances
    .map((item) => frameTextWakeQuery(item.role, item.text))
    .filter((text) => text.length >= 2);
  const wakeText = framed.join("\n");
  const emptySnapshot: SeedActivationSnapshot = {
    field: {
      wakeText,
      wakeQueries: framed,
      boostText: "",
      suppressText: "",
      source: "text_embed",
    },
    params: params(),
    candidates: [],
    activeSeedIds: [],
    injectedSeedIds: [],
    annAudit: {
      mode: "no_query",
      annLimit: ANN_LIMIT,
      candidatePoolLimit: CANDIDATE_POOL_LIMIT,
      annReturned: 0,
      queryCount: framed.length,
      poolSize: 0,
      rejected: [],
    },
  };
  if (!framed.length) {
    return { traces: [], snapshot: emptySnapshot, innerLines: [], outerLines: [] };
  }

  // ONNX embedding is a hard dependency: embedText throws a 503-shaped error
  // when the model is unavailable. There is no lexical/hash fallback here.
  // Wake queries are search-side: they carry the BGE query instruction
  // (EMBEDDING contract, query role), stored seed vectors stay document-side.
  const embedded = await Promise.all(framed.map((text) => embedQueryText(text, { wait: true })));
  const wakeVectors = embedded.map((item) => item.vector);

  const annCandidates = collectAnnCandidates(
    wakeVectors.map((vector) => ({ table: "seed_wake_vec" as const, vector })),
    input.agentId,
    input.userId,
  );
  const seeds = annCandidates.seeds;

  const traces: SeedTrace[] = [];
  const rejected: Record<string, unknown>[] = [];
  const eligible: SeedRow[] = [];

  for (const seed of seeds) {
    const lifecycleRejection = seedLifecycleRejection(seed, "private");
    if (lifecycleRejection) {
      rejected.push({
        seedId: seed.id,
        reason: lifecycleRejection,
        wakeScore: null,
        seedWakeText: String(seed.wake_text || "").slice(0, 240),
      });
      continue;
    }
    let wake = bufferToVector(seed.wake_embedding);
    let boost = bufferToVector(seed.boost_embedding);
    let suppress = bufferToVector(seed.suppress_embedding);
    if (!wake.some(Boolean) || !boost.some(Boolean) || !suppress.some(Boolean)) {
      const [wakeEmbedding, boostEmbedding, suppressEmbedding] = await Promise.all([
        embedText(seed.wake_text, { wait: true }),
        embedText(seed.boost_text, { wait: true }),
        embedText(seed.suppress_text, { wait: true }),
      ]);
      wake = wakeEmbedding.vector;
      boost = boostEmbedding.vector;
      suppress = suppressEmbedding.vector;
      if (wake.some(Boolean) && boost.some(Boolean) && suppress.some(Boolean)) {
        storeSeedEmbeddings(seed.id, wake, boost, suppress);
        seed.wake_embedding = vectorToBuffer(wake);
        seed.boost_embedding = vectorToBuffer(boost);
        seed.suppress_embedding = vectorToBuffer(suppress);
      }
    }
    const complete =
      seed.subject === "about_self" &&
      String(seed.source || "").toLowerCase() !== "innate" &&
      String(seed.inner_orientation || "").trim() &&
      String(seed.outer_expression || "").trim() &&
      String(seed.wake_text || "").trim() &&
      String(seed.boost_text || "").trim() &&
      String(seed.suppress_text || "").trim() &&
      wake.some(Boolean) &&
      boost.some(Boolean) &&
      suppress.some(Boolean);
    if (!complete) {
      rejected.push({
        seedId: seed.id,
        reason: "incomplete_portrait",
        wakeScore: null,
        seedWakeText: String(seed.wake_text || "").slice(0, 240),
      });
      continue;
    }
    const wakeScore = maxVectorScore(wakeVectors, wake);
    eligible.push(seed);
    traces.push({
      seedId: seed.id,
      innerOrientation: seed.inner_orientation,
      outerExpression: seed.outer_expression,
      wakeText: seed.wake_text,
      boostText: seed.boost_text,
      suppressText: seed.suppress_text,
      wakeScore,
      fieldBoost: 0,
      fieldGuard: 0,
      fieldSuppress: 0,
      seedBoost: 0,
      seedSuppress: 0,
      finalScore: 0,
      active: false,
      injected: false,
      innerInjected: false,
      outerInjected: false,
      reason: "final_below_threshold",
      influences: [],
    });
  }

  const ranked = [...traces]
    .sort((left, right) => right.wakeScore - left.wakeScore)
    .slice(0, ANN_LIMIT);
  traces.length = 0;
  traces.push(...ranked);
  const propagationIds = new Set(ranked.map((trace) => trace.seedId));
  const propagationPool = eligible.filter((seed) => propagationIds.has(seed.id));
  const byId = new Map(propagationPool.map((seed) => [seed.id, seed]));
  const boostAcc = new Map<string, number>(propagationPool.map((seed) => [seed.id, 0]));
  const suppressAcc = new Map<string, number>(propagationPool.map((seed) => [seed.id, 0]));
  const influencesById = new Map<string, Record<string, unknown>[]>(
    traces.map((trace) => [trace.seedId, []]),
  );

  for (const source of propagationPool) {
    const sourceBoost = bufferToVector(source.boost_embedding);
    const sourceSuppress = bufferToVector(source.suppress_embedding);
    for (const target of propagationPool) {
      if (source.id === target.id) continue;
      const targetBoost = bufferToVector(target.boost_embedding);
      const targetWake = bufferToVector(target.wake_embedding);
      const boostMatch = maxPairCos(sourceBoost, targetBoost, targetWake);
      if (boostMatch >= INFLUENCE_FLOOR) {
        const raw = contribution(boostMatch, SINGLE_BOOST_CAP);
        boostAcc.set(target.id, Number(boostAcc.get(target.id) || 0) + raw);
        influencesById.get(target.id)?.push({
          kind: "seed_boost",
          fromSeedId: source.id,
          match: Number(boostMatch.toFixed(4)),
          rawDelta: Number(raw.toFixed(4)),
          appliedDelta: 0,
        });
      }
      const suppressMatch = maxPairCos(sourceSuppress, targetBoost, targetWake);
      if (suppressMatch >= INFLUENCE_FLOOR) {
        const raw = contribution(suppressMatch, SINGLE_SUPPRESS_CAP);
        suppressAcc.set(target.id, Number(suppressAcc.get(target.id) || 0) + raw);
        influencesById.get(target.id)?.push({
          kind: "seed_suppress",
          fromSeedId: source.id,
          match: Number(suppressMatch.toFixed(4)),
          rawDelta: Number(raw.toFixed(4)),
          appliedDelta: 0,
        });
      }
    }
  }

  for (const trace of traces) {
    const rawBoost = Number(boostAcc.get(trace.seedId) || 0);
    const rawSuppress = Number(suppressAcc.get(trace.seedId) || 0);
    trace.seedBoost = Math.min(rawBoost, TOTAL_BOOST_CAP);
    trace.seedSuppress = Math.min(rawSuppress, TOTAL_SUPPRESS_CAP);
    const influences = influencesById.get(trace.seedId) || [];
    scaleInfluences(influences, "seed_boost", rawBoost, trace.seedBoost);
    scaleInfluences(influences, "seed_suppress", rawSuppress, trace.seedSuppress);
    trace.influences = influences;
    trace.finalScore =
      trace.wakeScore +
      trace.fieldBoost +
      trace.fieldGuard -
      trace.fieldSuppress +
      trace.seedBoost -
      trace.seedSuppress;
    trace.reason = reasonFor(trace.wakeScore, trace.finalScore, true);
    trace.active = trace.reason === "active";
  }

  traces.sort(
    (left, right) =>
      right.finalScore - left.finalScore ||
      right.wakeScore - left.wakeScore ||
      (byId.get(right.seedId)?.updated_at || "").localeCompare(byId.get(left.seedId)?.updated_at || ""),
  );
  const budget = applyPromptBudget(traces, PROMPT_SEED_LIMIT);

  const snapshot: SeedActivationSnapshot = {
    field: {
      wakeText,
      wakeQueries: framed,
      boostText: "",
      suppressText: "",
      source: "text_embed",
    },
    params: params(),
    candidates: traces.map((trace) => ({
      seedId: trace.seedId,
      innerOrientation: trace.innerOrientation,
      outerExpression: trace.outerExpression,
      wakeText: trace.wakeText,
      boostText: trace.boostText,
      suppressText: trace.suppressText,
      wakeScore: Number(trace.wakeScore.toFixed(4)),
      fieldBoost: Number(trace.fieldBoost.toFixed(4)),
      fieldGuard: Number(trace.fieldGuard.toFixed(4)),
      fieldSuppress: Number(trace.fieldSuppress.toFixed(4)),
      seedBoost: Number(trace.seedBoost.toFixed(4)),
      seedSuppress: Number(trace.seedSuppress.toFixed(4)),
      finalScore: Number(trace.finalScore.toFixed(4)),
      active: trace.active,
      injected: trace.injected,
      innerInjected: trace.innerInjected,
      outerInjected: trace.outerInjected,
      reason: trace.reason,
      influences: trace.influences,
    })),
    activeSeedIds: traces.filter((trace) => trace.active).map((trace) => trace.seedId),
    injectedSeedIds: traces.filter((trace) => trace.injected).map((trace) => trace.seedId),
    annAudit: {
      mode: annCandidates.mode,
      annLimit: ANN_LIMIT,
      candidatePoolLimit: CANDIDATE_POOL_LIMIT,
      annReturned: annCandidates.annReturned,
      queryCount: wakeVectors.length,
      poolSize: eligible.length,
      rejected,
      vecReady: annCandidates.vecReady,
      vecError: annCandidates.vecError,
    },
    degraded: annCandidates.degradedReason,
  };

  return {
    traces,
    snapshot,
    innerLines: budget.inner,
    outerLines: budget.outer,
  };
}

