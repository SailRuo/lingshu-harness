import { getDb } from "../db/sqlite.js";
import { STATE as APP_STATE } from "../contracts/native/nativeChatContract.js";
import { memoryScope, type MemoryScope } from "./memoryScope.js";

/**
 * State channel — the second recall path, for turns that carry a state but no
 * topic. Direct port of the APP (NativeCoreMemory.isStateOnlyUtterance /
 * stateChannelStreams / markStateRecalled), constants single-sourced from the
 * native chat contract (`STATE`).
 *
 * STREAM.RANK1_FLOOR is an abstention gate calibrated against small talk, so a
 * bare「唉」abstains exactly like「你好呀」does. A sigh is a state signal, and
 * the useful question is not "which memory resembles this utterance" but "what
 * was already weighing on me":
 *
 *     weight = openLoopFreshness(hours) × significance
 *
 * No similarity is computed here at all. Private streams only — a group-public
 * memory was never a private worry between the two of us.
 */

export interface StateChannelStream {
  id: string;
  narrative: string;
  originScope: string | null;
  perspective: string | null;
  createdAt: string | null;
  significance: number;
  stateWeight: number;
  /** The narrative names the state he is in right now (ranks first). */
  stateClue: boolean;
  source: "state";
}

/** STATE_SCAN_CAP: recent streams scanned; the 72h window filters the rest. */
const STATE_SCAN_CAP = 64;

/** agent:stream → last time the state channel actually injected it into a prompt. */
const stateRecallAt = new Map<string, number>();

function stripToCore(
  text: string,
): { core: string; sawSigh: boolean } {
  const trimmed = String(text || "").trim();
  let core = "";
  let sawSigh = false;
  for (const char of trimmed) {
    const lower = char.toLowerCase();
    if (APP_STATE.NEUTRAL_INTERJECTIONS.includes(lower)) continue;
    if (APP_STATE.SIGH_INTERJECTIONS.includes(lower)) {
      sawSigh = true;
      continue;
    }
    // Punctuation / whitespace / symbols drop out; letters, digits and CJK stay.
    if (!/[\p{L}\p{N}]/u.test(char)) continue;
    core += lower;
  }
  return { core, sawSigh };
}

/**
 * Whether this turn carries a state but no topic.
 *
 * Two shapes qualify (utterance ≤ STATE.MAX_CHARS):
 *  - nothing but interjections left once punctuation and neutral
 *    acknowledgements are stripped, at least one of them dispirited
 *    (「唉」「唉…」「唉，哎」);
 *  - a short utterance whose remaining core contains a state word (「我好累」).
 *
 * Anything longer is someone telling you about something and stays with the
 * semantic path, even when it contains 「唉」.
 */
export function isStateOnlyUtterance(text: string): boolean {
  const trimmed = String(text || "").trim();
  // Length gate uses the same UTF-16 measure as the APP.
  if (!trimmed || trimmed.length > APP_STATE.MAX_CHARS) return false;
  const { core, sawSigh } = stripToCore(trimmed);
  if (!core) return sawSigh;
  for (const word of APP_STATE.STATE_WORDS) {
    const needle = String(word || "").toLowerCase();
    if (needle && core.includes(needle)) return true;
  }
  return false;
}

/**
 * The state channel's own vocabulary, taken from the utterance: for a bare
 * sigh its written forms (SIGH_NARRATIVE_FORMS), otherwise the state words it
 * matched. Empty for a turn that is not state-only.
 */
export function stateClueWords(text: string): string[] {
  const out: string[] = [];
  const trimmed = String(text || "").trim();
  if (!trimmed) return out;
  const { core, sawSigh } = stripToCore(trimmed);
  if (!core) {
    if (sawSigh) out.push(...APP_STATE.SIGH_NARRATIVE_FORMS);
    return out;
  }
  for (const word of APP_STATE.STATE_WORDS) {
    const needle = String(word || "").toLowerCase();
    if (needle && core.includes(needle)) out.push(word);
  }
  return out;
}

/** Whether a memory's narrative puts him in the same state he is in now. */
function narrativeNamesState(narrative: string, clueWords: string[]): boolean {
  const text = String(narrative || "");
  if (!text || !clueWords.length) return false;
  return clueWords.some((word) => word && text.includes(word));
}

/** normalizeSignificance (APP NativeProactiveShared): 0..1 with a 0.5 default. */
function normalizeSignificance(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.5;
  return Math.max(0, Math.min(1, num));
}

/** Linear open-loop decay over the state channel's own 72h window. */
export function stateFreshness(createdAt: string | null | undefined, nowMs: number): number {
  const time = new Date(String(createdAt || "")).getTime();
  if (!Number.isFinite(time) || time <= 0) return 0;
  const hours = Math.max(0, (nowMs - time) / 3_600_000);
  if (hours >= APP_STATE.WINDOW_HOURS) return 0;
  return Math.max(0, 1 - hours / Math.max(1, APP_STATE.WINDOW_HOURS));
}

function stateCooldownActive(agentId: number, streamId: string, nowMs: number): boolean {
  const last = stateRecallAt.get(`${agentId}:${streamId}`);
  if (last === undefined) return false;
  return nowMs - last < APP_STATE.COOLDOWN_MINUTES * 60_000;
}

/**
 * Only called when the state channel's streams actually reach a prompt — the
 * cooldown measures "already told him I am carrying this", not "already looked".
 */
export function markStateRecalled(
  scopeOrAgentId: MemoryScope | number,
  streams: { id?: string | null }[],
): number {
  const agentId =
    typeof scopeOrAgentId === "number" ? scopeOrAgentId : scopeOrAgentId.agentId;
  const nowMs = Date.now();
  let marked = 0;
  for (const item of streams || []) {
    const id = String(item?.id ?? "").trim();
    if (!id) continue;
    stateRecallAt.set(`${agentId}:${id}`, nowMs);
    marked += 1;
  }
  // Keep the in-process map bounded; cooldowns older than the window are dead.
  if (stateRecallAt.size > 2048) {
    for (const [key, at] of stateRecallAt) {
      if (nowMs - at > APP_STATE.WINDOW_HOURS * 3_600_000) stateRecallAt.delete(key);
    }
  }
  return marked;
}

/** Test hook: clear the in-process cooldown map. */
export function clearStateRecallCooldown(): void {
  stateRecallAt.clear();
}

/**
 * The state channel's stream slot. Ranked by how much the memory still weighs
 * on me (`weight = freshness × significance`), with memories whose narrative
 * names the current state sorting first inside the pool.
 *
 * @param respectCooldown true for real turns; false for projections/previews
 *   that must show a stable pool.
 * @param excludedIds streams the semantic channel already injected this turn.
 */
export function collectStateChannelStreams(input: {
  agentId: number;
  userId?: string | null;
  utterance: string;
  limit?: number;
  respectCooldown?: boolean;
  excludedIds?: Iterable<string>;
  now?: Date;
}): StateChannelStream[] {
  const scope: MemoryScope = memoryScope(input.agentId, input.userId);
  const utterance = String(input.utterance || "");
  const out: StateChannelStream[] = [];
  if (!isStateOnlyUtterance(utterance)) return out;
  const clueWords = stateClueWords(utterance);
  const excluded = new Set(
    Array.from(input.excludedIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const respectCooldown = input.respectCooldown !== false;
  const limit = Math.max(1, Math.min(input.limit ?? APP_STATE.LIMIT, 10));
  const nowMs = (input.now || new Date()).getTime();
  const ranked: StateChannelStream[] = [];
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, narrative, origin_scope, perspective, created_at, significance
         FROM hippocampus_streams
         WHERE agent_id = ? AND user_id = ? AND archived = 0
           -- IFNULL: a NULL scope would make NOT IN evaluate to NULL and drop
           -- the row silently; NULL scope = private memory.
           AND IFNULL(origin_scope, 'private_dyadic') NOT IN ('group_public', 'theater_public')
         ORDER BY created_at DESC
         LIMIT ${STATE_SCAN_CAP}`,
      )
      .all(scope.agentId, scope.userId) as {
      id: string;
      narrative: string;
      origin_scope: string | null;
      perspective: string | null;
      created_at: string | null;
      significance: number | null;
    }[];
    for (const row of rows) {
      const id = String(row.id || "").trim();
      if (!id || excluded.has(id)) continue;
      if (respectCooldown && stateCooldownActive(scope.agentId, id, nowMs)) continue;
      const freshness = stateFreshness(row.created_at, nowMs);
      if (freshness <= 0) continue;
      const significance = normalizeSignificance(row.significance);
      const weight = freshness * significance;
      if (weight < APP_STATE.MIN_WEIGHT) continue;
      ranked.push({
        id,
        narrative: String(row.narrative || ""),
        originScope: row.origin_scope ?? null,
        perspective: row.perspective ?? null,
        createdAt: row.created_at ?? null,
        significance,
        stateWeight: weight,
        stateClue: narrativeNamesState(row.narrative, clueWords),
        source: "state",
      });
    }
  } catch {
    // A failed state-channel lookup must never break the turn.
    return out;
  }
  // Same-state first, then weight. Both tiers live inside the pool that already
  // cleared STATE.MIN_WEIGHT, so this reorders rather than widens.
  ranked.sort((left, right) => {
    if (left.stateClue !== right.stateClue) return left.stateClue ? -1 : 1;
    return right.stateWeight - left.stateWeight;
  });
  out.push(...ranked.slice(0, limit));
  return out;
}
