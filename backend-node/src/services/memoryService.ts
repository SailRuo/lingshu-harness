import { createHash, randomUUID } from "node:crypto";
import { Solar } from "lunar-javascript";
import { getDb } from "../db/sqlite.js";
import { normalizeUserId } from "./chatThreadService.js";
import { userMessageForLlm } from "./chatMessageService.js";
import {
  bufferToVector,
  cosineSimilarity,
  deleteScopeVecRows,
  embedQueryText,
  embedQueryTextsCached,
  embedText,
  EmbeddingUnavailableError,
  makeQueryCacheSessionKey,
  searchStreamCandidates,
  storeSeedEmbeddings,
  storeStreamEmbedding,
  vectorToBuffer,
} from "./embeddingService.js";
import {
  DIGEST_CONSTANTS,
  DIGEST_PROMPTS,
  DIGEST_RESPONSE_SCHEMAS,
  DIGEST_SETS,
  DIGEST_TEMPLATES,
} from "../contracts/native/index.js";
import {
  NEAR_WINDOW as CHAT_NEAR_WINDOW,
  STREAM as CHAT_STREAM,
} from "../contracts/native/nativeChatContract.js";
import {
  recordBackgroundTaskEvent,
} from "./backgroundTaskEvents.js";
import {
  beginMemoryTask,
  invalidateMemoryTasks,
  isMemoryTaskValid,
  runIfMemoryTaskValid,
  type MemoryTaskToken,
} from "./memoryTaskToken.js";
import {
  buildDigestTranscript,
  estimateDigestTokens,
  planDigestChunks,
  type DigestChunk,
  type DigestMessageRow,
  type DigestTranscriptRow,
} from "./digestBatch.js";
import {
  classifyRecallAudit,
  listRecallEvents,
  publishRecallEvent,
  recallSessionKey,
  subscribeRecallEvents,
} from "./recallReport.js";
import { createOpenAIClient, getLLMConfig } from "./llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "./thinkingEffort.js";
import { recordCompletionUsage } from "./usageService.js";
import {
  logTick,
  memoryScope,
  nowIso,
  parseJson,
  subscribeTickLog,
  type MemoryScope,
} from "./memoryScope.js";
import {
  applyTextAffect,
  deriveSelfState,
  getBaselineItem,
  persistSelfStateSnapshot,
  readAffectTimeline,
} from "./baselineService.js";
import { activateSeedsForText, type SeedActivationResult } from "./seedActivationService.js";
import {
  applySeedChange,
  insertSeedLedgerEntry,
  isSeedAutoMutable,
  listSeedChanges,
  parseSeedApplicability,
  seedApplicabilityJson,
  seedReviewBatchKey,
  seedSnapshot,
} from "./seedLedgerService.js";
import {
  applyRelationshipContinuity,
  listRelationshipThreadCandidates,
  type RelationshipContinuityItem,
  type RelationshipThreadCandidate,
} from "./relationshipThreadService.js";
import {
  getMirror as witnessGetMirror,
  getRetrospect as witnessGetRetrospect,
  listRetrospectBuckets as witnessListRetrospectBuckets,
  recomputeRetrospect as witnessRecomputeRetrospect,
  scheduleWitnessAfterDigest,
} from "./witnessService.js";
import {
  dayKey,
  wallTimeToUtc,
  zonedParts,
  type CalendarGranularity,
  type ZonedParts,
} from "./memoryTime.js";

export { memoryScope, logTick, subscribeTickLog };
export { listRecallEvents, subscribeRecallEvents };
export type { MemoryScope };

function freshness(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 0;
  const days = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.max(0, Math.min(1, 1 - 0.02 * days));
}

function proactivePenalty(lastProactiveAt: string | null | undefined): number {
  if (!lastProactiveAt) return 1;
  const hours = (Date.now() - new Date(lastProactiveAt).getTime()) / 3_600_000;
  if (!Number.isFinite(hours)) return 1;
  if (hours < 24) return 0;
  if (hours < 168) return 0.3;
  return 1;
}

export function streamToItem(row: any) {
  const revisitCount = Number(row.revisit_count ?? 0);
  const salience = Math.log1p(revisitCount) * freshness(row.revisit_last_at || row.created_at);
  const significance = Number(row.significance ?? 0.5);
  return {
    id: row.id,
    narrative: row.narrative || "",
    about: row.about || "",
    type: row.type || "external",
    // Group-public provenance rides with the recall item so callers can keep
    // public group experiences in their own prompt pool instead of presenting
    // them as private-chat memories.
    originScope: row.origin_scope ?? null,
    originGroupSessionId: row.origin_group_session_id ?? null,
    perspective: row.perspective ?? null,
    participantsJson: row.participants_json ?? null,
    rawStart: row.raw_start ?? null,
    rawEnd: row.raw_end ?? null,
    revisitCount,
    revisitLastAt: row.revisit_last_at ?? null,
    lastProactiveAt: row.last_proactive_at ?? null,
    salience: Number(salience.toFixed(4)),
    significance,
    proactiveWeight: Number(
      (freshness(row.created_at) * significance * proactivePenalty(row.last_proactive_at)).toFixed(4),
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function seedRealCount(row: any): number {
  // Real stored corroboration count (maintained on create/reinforce/merge/revise).
  // No version-table proxy: legacy rows are backfilled by the schema v15 migration.
  const direct = Number(row?.count);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return 1;
}

export function seedToItem(row: any) {
  const updatedAt = row.updated_at || row.created_at;
  const lastSeen = row.last_seen || updatedAt;
  const count = seedRealCount(row);
  const fresh = freshness(lastSeen);
  return {
    id: row.id,
    subject: row.subject || "about_self",
    content: row.inner_orientation || "",
    tags: parseJson<string[]>(row.tags_json, []),
    innerOrientation: row.inner_orientation || "",
    outerExpression: row.outer_expression || "",
    wakeText: row.wake_text || "",
    boostText: row.boost_text || "",
    suppressText: row.suppress_text || "",
    count,
    lastSeen,
    source: row.source || "learned",
    status: row.status || "active",
    revision: Number(row.revision || 0),
    applicability: parseSeedApplicability(row.applicability_json),
    freshness: Number(fresh.toFixed(4)),
    // Python seed salience: real count × last_seen freshness (no log proxy).
    salience: Number((count * fresh).toFixed(4)),
    createdAt: row.created_at,
    updatedAt,
  };
}

function versionToItem(row: any) {
  const before = parseJson<Record<string, any> | null>(row.before_json, null);
  const after = parseJson<Record<string, any> | null>(row.after_json, null);
  const diffs: { field: string; before: unknown; after: unknown }[] = [];
  if (before && after) {
    for (const field of [
      "innerOrientation",
      "outerExpression",
      "wakeText",
      "boostText",
      "suppressText",
      "tags",
    ]) {
      const left = JSON.stringify(before[field] ?? null);
      const right = JSON.stringify(after[field] ?? null);
      if (left !== right) diffs.push({ field, before: before[field] ?? null, after: after[field] ?? null });
    }
  }
  return {
    id: row.id,
    seedId: row.seed_id,
    versionNo: row.version_no,
    eventType: row.event_type,
    triggerSource: row.trigger_source,
    reason: row.reason,
    sessionId: row.session_id,
    turnIds: parseJson<number[]>(row.turn_ids_json, []),
    before,
    after,
    field: row.field,
    affectNote: row.affect_note,
    recallAudit: parseJson<Record<string, unknown> | null>(row.recall_audit_json, null),
    createdAt: row.created_at,
    diffs,
  };
}

function tickToItem(row: any) {
  return {
    id: row.id,
    tickType: row.tick_type,
    outcome: row.outcome,
    triggeredAt: row.triggered_at,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    error: row.error ?? null,
  };
}

interface DigestTurn {
  threadId: number;
  assistantId: number;
  userMessageId: number | null;
  userText: string;
  assistantText: string;
  userCreatedAt: string;
  assistantCreatedAt: string;
}

/**
 * Legacy thread-shaped target kept for the `buildThreadDigestTarget` helper and
 * external callers. The M1 digest pipeline reads an agent+user batch instead.
 */
export interface ThreadDigestTarget {
  threadId: number;
  agentId: number;
  userId: string;
  turns: DigestTurn[];
  turnIds: number[];
  transcript: string;
  contextTranscript: string;
}

interface ExtractedStream {
  narrative: string;
  about: string;
  type: "external" | "internal";
  significance: number;
  rawStart: number | null;
  rawEnd: number | null;
}

interface ExtractedConstraint {
  action: "new" | "update" | "remove";
  targetId: number | null;
  ruleType: "do" | "dont";
  description: string;
  evidence: string;
}

interface ExtractedFact {
  subject: "Me" | "Self";
  relation: string;
  object: string;
  description: string;
  evidence: string;
  confidence: number;
  importance: number;
  isIdentity: boolean;
}

interface ExtractedCorrection {
  targetType: "fact";
  targetHint: string;
}

interface ExtractedContinuity {
  title: string;
  note: string;
  carriesIndex: number;
  carryNote: string;
  nodes: {
    index: number;
    messageId: number;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }[];
}

interface DigestExtraction {
  shouldWrite: boolean;
  streams: ExtractedStream[];
  constraints: ExtractedConstraint[];
  facts: ExtractedFact[];
  corrections: ExtractedCorrection[];
  continuity: ExtractedContinuity[];
}

export type DigestComplete = (
  system: string | string[],
  human: string,
  schema?: Record<string, unknown>,
) => Promise<any>;

export interface AgentDigestOptions {
  source?: string;
  /** Import path may override the 3-day lookback. */
  since?: string | null;
  maxPairs?: number;
  maxRows?: number;
  maxChunks?: number;
  maxInputTokens?: number;
  forceStreamFallback?: boolean;
  complete?: DigestComplete;
  /** Independent affect-sidecar completion hook (tests/offline). */
  affectComplete?: DigestComplete;
  embed?: (text: string) => Promise<number[]>;
  /** Deterministic test hook: runs after extraction, before any write. */
  afterExtract?: () => void | Promise<void>;
  /** Deterministic test hook: runs inside the write transaction before writes. */
  beforeCommit?: () => void | Promise<void>;
  /** Internal: reuse a token created by an outer run. */
  taskToken?: MemoryTaskToken;
}

export interface AgentDigestRunResult {
  sessionId?: number;
  agentId: number;
  userId: string;
  turnIds: number[];
  turnCount: number;
  markedDigested: number;
  streamsWritten: number;
  streamsSource: string;
  factsProcessed: number;
  constraintsProcessed: number;
  continuityApplied: number;
  threadsCreated: number;
  threadsUpdated: number;
  touchpointsWritten: number;
  selfEvolutionEnabled: boolean;
  personalitySeedAction: string;
  personalitySeedId: string | null;
  personalitySeedReason: string;
  seedsCreated: number;
  seedsReinforced: number;
  seedsSkipped: number;
  batchesRun: number;
  hasMore: boolean;
}

export type DigestRunResult = AgentDigestRunResult;

export type AgentDigestResult = AgentDigestRunResult | { skipped: string; sessionId?: number };

const ALLOWED_ABOUT = new Set([
  ...(DIGEST_SETS.EXTERNAL_ABOUT as readonly string[]),
  ...(DIGEST_SETS.SELF_ABOUT as readonly string[]),
]);

const SELF_ABOUT = new Set(DIGEST_SETS.SELF_ABOUT as readonly string[]);

/**
 * Python `digest_streams._LEGACY_ABOUT_MAP`: old english/legacy buckets still
 * exist in historical LLM output and imported data, so normalize them before
 * validating against the closed set.
 */
const LEGACY_ABOUT_MAP: Record<string, string> = {
  "user.work": "他·工作",
  "user.health": "他·健康",
  "user.family": "他·家人",
  "user.hobby": "他·爱好",
  "user.emotion": "他·情绪",
  "user.daily": "他·日常",
  "user.general": "他·其它",
  "us.trust": "咱俩·信任",
  "us.routine": "咱俩·相处",
  "us.conflict": "咱俩·摩擦",
  "us.general": "咱俩·其它",
  general: "其它",
  "self.feeling": "她·感受",
  "self.value": "她·在乎",
  "self.reaction": "她·反应",
  "self.boundary": "她·边界",
};

const SINGLE_VALUE_RELATIONS = new Set([
  "HAS_NAME",
  "AGE",
  "GENDER",
  "LIVES_IN",
  "OCCUPATION",
  "SLEEP_PATTERN",
]);

const MULTI_VALUE_RELATIONS = new Set([
  "LIKES",
  "DISLIKES",
  "HAS_PET",
  "HAS_FRIEND",
  "HAS_FAMILY",
  "INTERESTED_IN",
  "HAS_HEALTH_CONDITION",
  "HAS_BODY_REACTION",
  "HAS_ROUTINE",
  "HAS_WORK_PATTERN",
]);

const RELATION_SYNONYMS: Record<string, string> = {
  NAME: "HAS_NAME",
  FULL_NAME: "HAS_NAME",
  CALLED: "HAS_NAME",
  CALL_ME: "HAS_NAME",
  NICKNAME: "HAS_NAME",
  CHANGED_NAME_TO: "HAS_NAME",
  RENAMED_TO: "HAS_NAME",
  NEW_NAME: "HAS_NAME",
  NOW_CALLED: "HAS_NAME",
  LIVES: "LIVES_IN",
  LIVE_IN: "LIVES_IN",
  LOCATED_IN: "LIVES_IN",
  RESIDES_IN: "LIVES_IN",
  WORKS_AS: "OCCUPATION",
  JOB: "OCCUPATION",
  JOB_TITLE: "OCCUPATION",
  PROFESSION: "OCCUPATION",
  LIKE: "LIKES",
  LOVES: "LIKES",
  ENJOYS: "LIKES",
  FAVORITE: "LIKES",
  DISLIKE: "DISLIKES",
  HATES: "DISLIKES",
  PET: "HAS_PET",
  HAS_A_PET: "HAS_PET",
  FRIEND: "HAS_FRIEND",
  HAS_A_FRIEND: "HAS_FRIEND",
  FAMILY: "HAS_FAMILY",
  RELATIVE: "HAS_FAMILY",
  SLEEP: "SLEEP_PATTERN",
  SLEEP_HABIT: "SLEEP_PATTERN",
  BEDTIME: "SLEEP_PATTERN",
  HEALTH: "HAS_HEALTH_CONDITION",
  CONDITION: "HAS_HEALTH_CONDITION",
  ILLNESS: "HAS_HEALTH_CONDITION",
  CHRONIC: "HAS_HEALTH_CONDITION",
  BODY_REACTION: "HAS_BODY_REACTION",
  STRESS_REACTION: "HAS_BODY_REACTION",
  ROUTINE: "HAS_ROUTINE",
  HABIT: "HAS_ROUTINE",
  WORK_PATTERN: "HAS_WORK_PATTERN",
  WORK_SCHEDULE: "HAS_WORK_PATTERN",
};

const RELATION_DROP = new Set([
  "PREVIOUS_NAME",
  "FORMER_NAME",
  "OLD_NAME",
  "USED_TO_BE_CALLED",
  "EX_NAME",
]);

const EPISODIC_RELATION_TOKENS = [
  "TRIP",
  "TRAVEL",
  "PLAN",
  "UPCOMING",
  "GO_TO",
  "GOES_TO",
  "VISIT",
  "MEET",
  "ATTEND",
  "WILL_",
  "SCHEDULE",
  "APPOINTMENT",
  "TRACK",
  "EVENT",
];

const ROLE_GENERIC_NAMES = new Set([
  "助手",
  "智能体",
  "ai",
  "assistant",
  "agent",
  "用户",
  "user",
  "客服",
  "机器人",
  "bot",
  "模型",
  "系统",
]);

const DEICTIC_NAME_OBJECTS = new Set([
  "这个名字",
  "那个名字",
  "这名",
  "那名",
  "这个",
  "那个",
  "代号",
  "名字",
  "昵称",
  "这个名",
  "那个名",
]);

function canonicalizeRelation(relation: string): string | null {
  const value = String(relation || "").trim().toUpperCase();
  if (!value) return null;
  if (RELATION_DROP.has(value)) return null;
  if (EPISODIC_RELATION_TOKENS.some((token) => value.includes(token))) return null;
  const canonical = RELATION_SYNONYMS[value] || value;
  if (SINGLE_VALUE_RELATIONS.has(canonical) || MULTI_VALUE_RELATIONS.has(canonical)) return canonical;
  return null;
}

function isRoleGenericName(value: string): boolean {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  if (ROLE_GENERIC_NAMES.has(text)) return true;
  return [...ROLE_GENERIC_NAMES].some((token) => text === token);
}

function isDeicticNameObject(value: string): boolean {
  const text = String(value || "").trim().replace(/^[「」"'“”]+|[「」"'“”]+$/g, "");
  if (!text) return true;
  if (DEICTIC_NAME_OBJECTS.has(text)) return true;
  return [...DEICTIC_NAME_OBJECTS].some(
    (token) => text.toLowerCase().includes(token) && text.length <= token.length + 4,
  );
}

/**
 * Python `facts.coerce_name_fact`: HAS_NAME only accepts a real name/nickname.
 * Role-generic names ("助手", "AI") become OCCUPATION; deictic names are dropped.
 */
function coerceNameFact(fact: ExtractedFact): ExtractedFact | null {
  const relation = canonicalizeRelation(fact.relation);
  if (!relation) return null;
  let object = String(fact.object || "").trim();
  if (!object) return null;
  if (relation === "HAS_NAME") {
    if (isDeicticNameObject(object)) return null;
    if (isRoleGenericName(object)) {
      return {
        ...fact,
        relation: "OCCUPATION",
        object,
        isIdentity: false,
        importance: fact.importance >= 1 ? 0.7 : fact.importance,
      };
    }
  }
  return { ...fact, relation, object };
}

function clampNumber(value: unknown, min: number, max: number, fallback = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeStreamAbout(about: string, type: string): string {
  const raw = String(about || "").trim();
  const value = LEGACY_ABOUT_MAP[raw] || raw;
  if (String(type || "").toLowerCase() === "internal") {
    return SELF_ABOUT.has(value) ? value : "她·感受";
  }
  if (ALLOWED_ABOUT.has(value)) return value;
  if (value.startsWith("咱俩")) return "咱俩·其它";
  return "他·其它";
}

function normalizeStreamNarrative(narrative: string): string {
  return String(narrative || "")
    .replace(/我\s*[（(]\s*(?:AI|ai|智能体|助手|Self)\s*[）)]/g, "我")
    .replace(/(?:AI|ai|智能体|助手|Self)\s*(?:向|对|跟)\s*用户/g, "我向ta")
    .replace(/用户\s*(?:向|对|跟)\s*(?:AI|ai|智能体|助手|Self)/g, "ta向我")
    .replace(/(?:AI|ai|智能体|助手|Self)/g, "我")
    .replace(/用户/g, "ta")
    .trim();
}

function guessStreamAbout(text: string): string {
  if (/(工作|面试|加班|同事|老板)/.test(text)) return "他·工作";
  if (/(生病|身体|熬夜|医院|睡眠)/.test(text)) return "他·健康";
  if (/(爸|妈|家里|家人|孩子)/.test(text)) return "他·家人";
  if (/(咱俩|我们|我们俩)/.test(text)) return "咱俩·其它";
  return "他·其它";
}

function parseJsonBlock(raw: string): any {
  let text = String(raw || "").trim();
  if (text.startsWith("```json")) text = text.slice(7).trim();
  else if (text.startsWith("```")) text = text.slice(3).trim();
  if (text.endsWith("```")) text = text.slice(0, -3).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("invalid_digest_json");
  }
}

function userSideUtterances(transcript: string, userLabel = "ta"): string[] {
  const out: string[] = [];
  const label = String(userLabel || "ta").trim() || "ta";
  for (const rawLine of String(transcript || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const numbered = /^\[(\d+)\]\s*(.*)$/.exec(line);
    const body = numbered ? numbered[2] : line;
    if (body.startsWith(`${label}：`) || body.startsWith(`${label}:`)) {
      out.push(body.slice(label.length + 1).trim());
    }
  }
  return out.filter(Boolean);
}

function evidenceInUserSide(evidence: string, transcript: string, userLabel = "ta"): boolean {
  const quote = String(evidence || "").trim().replace(/^[“”"'「」]+|[“”"'「」]+$/g, "");
  if (!quote) return false;
  return userSideUtterances(transcript, userLabel).some((utterance) => utterance.includes(quote));
}

function readKnownFactsText(scope: MemoryScope): string {
  const rows = getDb()
    .prepare(
      `SELECT f.relation, f.description, f.importance, src.name AS source_name, dst.name AS target_name
       FROM hippocampus_facts f
       LEFT JOIN hippocampus_entities src ON src.id = f.from_entity_id
       LEFT JOIN hippocampus_entities dst ON dst.id = f.to_entity_id
       WHERE f.agent_id = ? AND f.user_id = ? AND f.status = 'current'
       ORDER BY f.importance DESC, f.created_at DESC LIMIT 40`,
    )
    .all(scope.agentId, scope.userId) as any[];
  return rows
    .map(
      (row) =>
        `- ${row.source_name || "他"} ${row.relation || "相关"} ${row.target_name || ""}${row.description ? `：${row.description}` : ""}`,
    )
    .join("\n");
}

function readConstraintCandidates(scope: MemoryScope) {
  return getDb()
    .prepare(
      `SELECT id, rule_type, description FROM hippocampus_constraints
       WHERE agent_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 8`,
    )
    .all(scope.agentId, scope.userId) as { id: number; rule_type: string; description: string }[];
}

function parseStoredEmbedding(raw: unknown): number[] {
  if (!raw) return [];
  if (Buffer.isBuffer(raw)) return bufferToVector(raw);
  if (raw instanceof Uint8Array) return bufferToVector(Buffer.from(raw));
  if (Array.isArray(raw)) return raw.map(Number).filter((value) => Number.isFinite(value));
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed)
        ? parsed.map(Number).filter((value) => Number.isFinite(value))
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function contextTranscriptBefore(threadId: number, beforeId: number, maxTurns = 5): string {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_messages
       WHERE thread_id = ? AND id < ? AND role IN ('user','assistant') AND status = 'completed'
       ORDER BY id DESC LIMIT ?`,
    )
    .all(threadId, beforeId, maxTurns * 2) as any[];
  const ordered = rows.reverse();
  const assistantById = new Map<number, any>();
  for (const row of ordered) if (row.role === "assistant") assistantById.set(row.id, row);
  const lines: string[] = [];
  for (const row of ordered) {
    if (row.role !== "assistant") continue;
    const user = row.reply_to_message_id
      ? ordered.find((item) => item.id === row.reply_to_message_id && item.role === "user")
      : null;
    if (user) lines.push(`ta：${userMessageForLlm(user.content, parseJson(user.user_images_json, []))}`);
    if (row.content) lines.push(`我：${String(row.content).trim()}`);
  }
  return lines.join("\n\n");
}

function digestTranscriptLimit(): number {
  // Python feeds the whole working-memory transcript. 0 / negative means no
  // truncation; an explicit env override can still cap it for very long chats.
  const raw = Number(process.env.LINGSHU_DIGEST_MAX_TRANSCRIPT_CHARS || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function limitDigestText(text: string): string {
  const limit = digestTranscriptLimit();
  return limit > 0 ? String(text || "").slice(0, limit) : String(text || "");
}

export function buildThreadDigestTarget(
  threadId: number,
  maxPairs = 10,
  since?: string | null,
): ThreadDigestTarget | null {
  const db = getDb();
  const thread = db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(threadId) as any;
  if (!thread) return null;
  const limit = Math.max(1, Math.min(maxPairs, 200));
  // Digest scope is the whole agent+user pair, not one thread. Imported or
  // historical databases can carry several thread rows for the same pair.
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE agent_id = ? AND user_id = ? AND role = 'assistant' AND status = 'completed'
         AND digested_at IS NULL
         ${since ? "AND created_at >= ?" : ""}
       ORDER BY id ASC LIMIT ?`,
    )
    .all(
      ...(since
        ? [thread.agent_id, thread.user_id, since, limit * 2]
        : [thread.agent_id, thread.user_id, limit * 2]),
    ) as any[];
  const turns: DigestTurn[] = [];
  let transcriptChars = 0;
  const transcriptLimit = digestTranscriptLimit();
  for (const row of rows) {
    if (!String(row.content || "").trim()) continue;
    const user =
      (row.reply_to_message_id
        ? (db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(row.reply_to_message_id) as any)
        : null) ||
      (db
        .prepare(
          `SELECT * FROM chat_messages
           WHERE thread_id = ? AND role = 'user' AND id < ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(Number(row.thread_id), row.id) as any);
    const turn: DigestTurn = {
      threadId: Number(row.thread_id),
      assistantId: Number(row.id),
      userMessageId: user ? Number(user.id) : null,
      userText: user
        ? userMessageForLlm(user.content, parseJson(user.user_images_json, []))
        : "",
      assistantText: String(row.content || "").trim(),
      userCreatedAt: user?.created_at || row.created_at,
      assistantCreatedAt: row.created_at,
    };
    const blockChars = turn.userText.length + turn.assistantText.length + 6;
    if (
      transcriptLimit > 0 &&
      turns.length &&
      transcriptChars + blockChars > transcriptLimit
    ) {
      break;
    }
    turns.push(turn);
    transcriptChars += blockChars;
    if (turns.length >= limit) break;
  }
  if (!turns.length) return null;
  const blocks = turns.map((turn) => {
    const lines: string[] = [];
    if (turn.userText) lines.push(`ta：${turn.userText}`);
    if (turn.assistantText) lines.push(`我：${turn.assistantText}`);
    return lines.join("\n");
  });
  const turnIds = [
    ...new Set(
      turns.flatMap((turn) =>
        [turn.userMessageId, turn.assistantId].filter(
          (value): value is number => typeof value === "number",
        ),
      ),
    ),
  ];
  return {
    threadId: Number(thread.id),
    agentId: Number(thread.agent_id),
    userId: String(thread.user_id),
    turns,
    turnIds,
    transcript: blocks.join("\n\n").trim(),
    contextTranscript: contextTranscriptBefore(turns[0].threadId || threadId, turns[0].assistantId),
  };
}

function markTurnsDigested(ids: number[]) {
  if (!ids.length) return 0;
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `UPDATE chat_messages SET digested_at = ?
       WHERE id IN (${placeholders}) AND digested_at IS NULL`,
    )
    .run(nowIso(), ...ids).changes;
}

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function timeZoneParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function buildDigestTimeAnchor(): string {
  const tzName = String(process.env.LINGSHU_DISPLAY_TIMEZONE || "Asia/Shanghai").trim() || "Asia/Shanghai";
  let tzLabel = tzName;
  let now: { year: number; month: number; day: number; hour: number; minute: number; second: number };
  try {
    now = timeZoneParts(new Date(), tzName);
  } catch {
    const local = new Date();
    tzLabel = "local";
    now = {
      year: local.getFullYear(),
      month: local.getMonth() + 1,
      day: local.getDate(),
      hour: local.getHours(),
      minute: local.getMinutes(),
      second: local.getSeconds(),
    };
  }
  const weekday = WEEKDAY_ZH[new Date(Date.UTC(now.year, now.month - 1, now.day)).getUTCDay()];
  let lunarStr = "";
  try {
    const solar = Solar.fromYmdHms(now.year, now.month, now.day, now.hour, now.minute, now.second);
    const lunar = solar.getLunar();
    const lunarMd = `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
    const ganzhiYear = lunar.getYearInGanZhi();
    const shengxiao = lunar.getYearShengXiao();
    const huangdiYear = Number(lunar.getYear()) + 2697;
    const ganzhiMonth = lunar.getMonthInGanZhi();
    const ganzhiDay = lunar.getDayInGanZhi();
    const ganzhiTime = lunar.getTimeInGanZhi();
    lunarStr =
      ` 农历${lunarMd}（${ganzhiYear}${shengxiao}年）` +
      ` 黄帝纪年${huangdiYear}年` +
      `【干支：${ganzhiYear}年${ganzhiMonth}月${ganzhiDay}日${ganzhiTime}时】`;
    const extras: string[] = [];
    const jieqi = lunar.getJieQi();
    if (jieqi) extras.push(String(jieqi));
    for (const festival of lunar.getFestivals() || []) extras.push(String(festival));
    for (const festival of solar.getFestivals() || []) extras.push(String(festival));
    if (extras.length) lunarStr += `【${extras.join("/")}】`;
  } catch {
    // Lunar metadata is best-effort; the solar anchor is still authoritative.
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `本次对话发生于：${now.year}年${now.month}月${now.day}日${lunarStr} ` +
    `${pad(now.hour)}:${pad(now.minute)}:${pad(now.second)} ${weekday}（${tzLabel}）\n` +
    "#时间常识\n" +
    "以上是此刻的真实时间，权威且不可推翻。凡涉及日期、星期、节气、" +
    "「今天/昨天/刚刚/上次/这几天」之类的表述，一律以本行为准，" +
    "禁止凭上文对话的语感去推断或沿用旧的时间感（例如别把今天说成别的星期几）；" +
    "回应前先据此校准，避免做出与当前时间矛盾的说法。"
  );
}

function renderDigestTemplate(template: string, vars: Record<string, string>): string {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? "");
}

function readUserLabel(userId: string): string {
  const row = getDb()
    .prepare("SELECT nickname FROM user_profiles WHERE user_id = ?")
    .get(userId) as { nickname?: string } | undefined;
  const nickname = String(row?.nickname || "").trim();
  return nickname || "ta";
}

function buildDigestRoleContext(userLabel: string, agentLabel: string): string {
  return renderDigestTemplate(DIGEST_TEMPLATES.DIGEST_ROLE_CONTEXT, {
    user: String(userLabel || "ta").trim() || "ta",
    agent: String(agentLabel || "我").trim() || "我",
  });
}

function buildDigestPersona(userLabel: string, agentLabel: string, roleBlock: string): string {
  return renderDigestTemplate(DIGEST_TEMPLATES.DIGEST_EXTRACTOR_PERSONA, {
    agentName: String(agentLabel || "我").trim() || "我",
    user: String(userLabel || "ta").trim() || "ta",
    roleBlock: String(roleBlock || "").trim() || "（无额外设定）",
  });
}

function digestSystemParts(userLabel: string, agentLabel: string, roleBlock: string): string[] {
  // APP order: byte-identical static rules first (cacheable), then JSON-only
  // system note, then the per-agent persona card.
  return [
    DIGEST_TEMPLATES.DIGEST_EXTRACTOR_RULES,
    DIGEST_PROMPTS.JSON_ONLY_SYSTEM,
    buildDigestPersona(userLabel, agentLabel, roleBlock),
  ];
}

function isResponseFormatUnsupported(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /response_format|json_object|json_schema|unsupported|not support|invalid.*format/i.test(detail);
}

function isLengthFinishError(error: unknown): boolean {
  const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /LengthFinishReason|finish_reason.*length|length.*finish|truncat|max_tokens/i.test(detail);
}

export async function requestDigestJson(
  system: string | string[],
  human: string,
  options: {
    temperature?: number;
    retries?: number;
    schema?: Record<string, unknown>;
    schemaName?: string;
  } = {},
): Promise<any> {
  const cfg = getLLMConfig("memory");
  if (!cfg.model || !cfg.baseUrl) throw new Error("memory_llm_unavailable");
  const client = createOpenAIClient(cfg);
  const systemParts = Array.isArray(system) ? system : [system];
  const messages = [
    ...systemParts
      .map((content) => String(content || "").trim())
      .filter(Boolean)
      .map((content) => ({ role: "system" as const, content })),
    { role: "user" as const, content: human },
  ];
  const temperature = options.temperature ?? 0.1;
  const retries = Math.max(0, options.retries ?? 2);
  const schemaFormat = options.schema
    ? ({
        type: "json_schema",
        json_schema: {
          name: options.schemaName || "digest_extraction",
          strict: false,
          schema: options.schema,
        },
      } as any)
    : null;
  const jsonObjectFormat = { type: "json_object" } as any;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // First pass prefers json_schema; retries fall back to json_object because a
    // reasoning model may have exhausted its token budget on strict schema.
    const formats: any[] = attempt === 0 ? [schemaFormat, jsonObjectFormat, null] : [jsonObjectFormat, null];
    let retryAttempt = false;
    for (const format of formats) {
      try {
        const response = await createCompletionWithThinkingFallback(
          client,
          {
            model: cfg.model,
            messages,
            temperature,
            ...(format ? { response_format: format } : {}),
            ...buildThinkingParams(cfg),
          } as any,
          cfg,
        );
        recordCompletionUsage(cfg.model, response, "memory");
        if (String((response.choices?.[0] as any)?.finish_reason || "").toLowerCase() === "length") {
          lastError = new Error("length_finish_reason");
          retryAttempt = true;
          break;
        }
        return parseJsonBlock(response.choices?.[0]?.message?.content || "");
      } catch (error) {
        lastError = error;
        if (isLengthFinishError(error)) {
          retryAttempt = true;
          break;
        }
        if (isResponseFormatUnsupported(error)) continue;
        // Malformed/truncated JSON is worth one more structured attempt.
        const detail = error instanceof Error ? error.message : String(error);
        if (/invalid_digest_json|Unexpected token|JSON|parse/i.test(detail)) {
          retryAttempt = true;
          break;
        }
        throw error;
      }
    }
    if (!retryAttempt && !formats.length) break;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "digest_json_failed"));
}

async function extractDigest(
  scope: MemoryScope,
  chunk: DigestChunk,
  context: {
    userLabel: string;
    agentLabel: string;
    roleBlock: string;
    knownFacts: string;
    constraints: { id: number; rule_type: string; description: string }[];
    threads: RelationshipThreadCandidate[];
  },
  complete?: DigestComplete,
): Promise<DigestExtraction> {
  const userLabel = context.userLabel;
  const roleContext = buildDigestRoleContext(userLabel, context.agentLabel);
  const knownBlock = String(context.knownFacts || "").trim() || "（无）";
  const constraintBlock =
    context.constraints
      .map((item) => `- id: ${item.id}\n  rule_type: ${item.rule_type}\n  description: ${item.description}`)
      .join("\n") || "（无）";
  let human =
    `${buildDigestTimeAnchor()}\n\n${roleContext}\n\n` +
    `用户身份配置：昵称=${userLabel}\n\n` +
    `对话记录：\n${chunk.transcript}\n\n` +
    `已知事实：\n${knownBlock}\n\n` +
    `已有约束（同主题必须 update 已有 id，禁止重复 new）：\n${constraintBlock}`;
  if (context.threads.length) {
    const block = context.threads
      .map((thread, index) => {
        const summary = String(thread.summary || "").trim();
        const lastAt = String(thread.last_at || "").slice(0, 10);
        return `- [${index}] 《${thread.title || ""}》${summary}${lastAt ? `（最近 ${lastAt}）` : ""}`;
      })
      .join("\n");
    human +=
      "\n\n历史共同来往候选（本次对话若真的用上其中某条——又叫了约定的称呼或说法、按约定行事、回应或兑现此前的共同内容——就要为它输出一条 continuity：carries_index=该序号，nodes 填本次原话行号，carry_note 写清这次承接了什么；序号仅在此列表内有效）：\n" +
      block;
  }

  const parsed = complete
    ? await complete(digestSystemParts(userLabel, context.agentLabel, context.roleBlock), human, DIGEST_RESPONSE_SCHEMAS.EXTRACTOR.schema)
    : await requestDigestJson(digestSystemParts(userLabel, context.agentLabel, context.roleBlock), human, {
        temperature: 0.1,
        retries: 2,
        schema: DIGEST_RESPONSE_SCHEMAS.EXTRACTOR.schema,
        schemaName: DIGEST_RESPONSE_SCHEMAS.EXTRACTOR.name,
      });

  const rawStreams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const rawConstraints = Array.isArray(parsed?.constraints) ? parsed.constraints : [];
  const rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const rawCorrections = Array.isArray(parsed?.corrections) ? parsed.corrections : [];
  const rawContinuity = Array.isArray(parsed?.continuity) ? parsed.continuity : [];

  const streams: ExtractedStream[] = rawStreams
    .map((item: any) => {
      const rawType = item?.stream_type ?? item?.streamType ?? item?.type;
      const type = String(rawType || "").toLowerCase() === "internal" ? "internal" : "external";
      return {
        narrative: normalizeStreamNarrative(String(item?.narrative || "")),
        about: normalizeStreamAbout(String(item?.about || (type === "internal" ? "她·感受" : "他·日常")), type),
        type,
        significance: clampNumber(
          item?.significance,
          DIGEST_CONSTANTS.SIGNIFICANCE_MIN,
          DIGEST_CONSTANTS.SIGNIFICANCE_MAX,
          DIGEST_CONSTANTS.SIGNIFICANCE_DEFAULT,
        ),
        rawStart: null,
        rawEnd: null,
      } as ExtractedStream;
    })
    .filter((item: ExtractedStream) => item.narrative.length >= 4);

  const constraints: ExtractedConstraint[] = rawConstraints
    .map((item: any): ExtractedConstraint | null => {
      const action = String(item?.action || "new");
      const ruleType = String(item?.rule_type ?? item?.ruleType ?? "dont").toLowerCase();
      if (!["new", "update", "remove"].includes(action)) return null;
      if (ruleType !== "do" && ruleType !== "dont") return null;
      const targetId = item?.target_id ?? item?.targetId;
      return {
        action: action as "new" | "update" | "remove",
        targetId: targetId == null ? null : Number(targetId),
        ruleType,
        description: String(item?.description || "").trim(),
        evidence: String(item?.evidence || "").trim(),
      };
    })
    .filter((item: ExtractedConstraint | null): item is ExtractedConstraint => Boolean(item))
    .filter((item: ExtractedConstraint) => {
      if (!evidenceInUserSide(item.evidence, chunk.transcript, userLabel)) return false;
      if (item.action !== "new") return Number.isInteger(item.targetId) && Number(item.targetId) > 0;
      return item.description.length >= 2;
    });

  const facts: ExtractedFact[] = rawFacts
    .map((item: any) => ({
      subject: String(item?.subject || "").trim() as "Me" | "Self",
      relation: String(item?.relation || "").trim().toUpperCase(),
      object: String(item?.object || "").trim().slice(0, 120),
      description: String(item?.description || "").trim().slice(0, 500),
      evidence: String(item?.evidence || "").trim(),
      confidence: clampNumber(item?.confidence, 0, 1, DIGEST_CONSTANTS.FACT_CONFIDENCE_DEFAULT),
      importance: clampNumber(item?.importance, 0, 1, 0.5),
      isIdentity: false,
    }))
    .filter(
      (item: ExtractedFact) =>
        (item.subject === "Me" || item.subject === "Self") &&
        (DIGEST_SETS.FACT_RELATIONS as readonly string[]).includes(item.relation) &&
        item.confidence >= 0.5 &&
        Boolean(item.object || item.description) &&
        !(DIGEST_SETS.PLACEHOLDER_ENTITIES as readonly string[]).includes(item.object.toLowerCase()) &&
        evidenceInUserSide(item.evidence, chunk.transcript, userLabel),
    )
    .map((item: ExtractedFact) => coerceNameFact(item))
    .filter((item: ExtractedFact | null): item is ExtractedFact => Boolean(item));

  const corrections: ExtractedCorrection[] = rawCorrections
    .map((item: any) => ({
      targetType: "fact" as const,
      targetHint: String(item?.target_hint ?? item?.targetHint ?? "").trim(),
    }))
    .filter((item: ExtractedCorrection) => item.targetHint.length >= 2);

  const rowByIndex = new Map(chunk.rows.map((row) => [row.index, row]));
  const continuity: ExtractedContinuity[] = rawContinuity
    .map((item: any) => {
      const carriesRaw = Number(item?.carries_index ?? item?.carriesIndex ?? -1);
      const carriesIndex =
        Number.isInteger(carriesRaw) && carriesRaw >= 0 && carriesRaw < context.threads.length
          ? carriesRaw
          : -1;
      const seen = new Set<number>();
      const nodes: ExtractedContinuity["nodes"] = [];
      for (const node of Array.isArray(item?.nodes) ? item.nodes : []) {
        const index = Number(node?.index);
        if (!Number.isInteger(index) || seen.has(index)) continue;
        const row = rowByIndex.get(index);
        if (!row) continue;
        seen.add(index);
        nodes.push({
          index,
          messageId: row.messageId,
          role: row.role,
          content: row.content,
          createdAt: row.createdAt,
        });
      }
      return {
        title: String(item?.title || "").trim().slice(0, 160),
        note: String(item?.note || "").trim().slice(0, 1200),
        carriesIndex,
        carryNote: String(item?.carry_note ?? item?.carryNote ?? "").trim().slice(0, 600),
        nodes,
      };
    })
    .filter((item: ExtractedContinuity) => item.title.length >= 2 && item.nodes.length >= 1);

  // The APP schema requires a boolean. Anything else (missing/string/0) must
  // not open the crystallization gate.
  const shouldWrite = parsed?.should_write === true;
  return {
    shouldWrite,
    streams,
    constraints: shouldWrite ? constraints : [],
    facts: shouldWrite ? facts : [],
    corrections,
    continuity,
  };
}

function applyConstraints(
  scope: MemoryScope,
  items: ExtractedConstraint[],
  segmentRef: string,
) {
  const db = getDb();
  let processed = 0;
  for (const item of items) {
    // remove: hard delete until M2 adds the soft-delete status column. The
    // scope check makes a retried remove idempotent (0 changes, no error).
    if (item.action === "remove") {
      if (item.targetId) {
        const info = db
          .prepare(
            "DELETE FROM hippocampus_constraints WHERE id = ? AND agent_id = ? AND user_id = ?",
          )
          .run(item.targetId, scope.agentId, scope.userId);
        processed += info.changes > 0 ? 1 : 0;
      }
      continue;
    }
    const optOut = /(不要主动|别主动|不想被打扰|别找我|不要找我|别发消息)/.test(item.description) ? 1 : 0;
    const evidenceRefs = JSON.stringify([
      { source: "chat_turn", ref_id: segmentRef, excerpt: item.evidence },
    ]);
    if (item.action === "update" && item.targetId) {
      const info = db
        .prepare(
          `UPDATE hippocampus_constraints SET rule_type = ?,
             description = COALESCE(NULLIF(?, ''), description),
             opt_out_proactive = ?, evidence_refs_json = ?, evidence = ?, segment_ref = ?
           WHERE id = ? AND agent_id = ? AND user_id = ?`,
        )
        .run(
          item.ruleType,
          item.description,
          optOut,
          evidenceRefs,
          item.evidence,
          segmentRef,
          item.targetId,
          scope.agentId,
          scope.userId,
        );
      processed += info.changes > 0 ? 1 : 0;
      continue;
    }
    const exists = db
      .prepare(
        "SELECT id FROM hippocampus_constraints WHERE agent_id = ? AND user_id = ? AND description = ?",
      )
      .get(scope.agentId, scope.userId, item.description);
    if (exists) continue;
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO hippocampus_constraints
          (agent_id, user_id, rule_type, description, opt_out_proactive, evidence_refs_json, evidence,
           segment_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.agentId,
        scope.userId,
        item.ruleType,
        item.description,
        optOut,
        evidenceRefs,
        item.evidence,
        segmentRef,
        nowIso(),
      );
    processed += info.changes;
  }
  return processed;
}

const VALID_RECUR = new Set(["none", "daily", "weekly", "monthly", "yearly", "day", "week", "month", "year"]);

function normalizeRecur(raw: string | null | undefined): string {
  const value = String(raw || "none").trim().toLowerCase();
  return VALID_RECUR.has(value) ? value : "none";
}

const APPOINTMENT_RECUR_KEYS = new Set(["daily", "weekly", "monthly", "yearly"]);

/** Node also accepts the short spellings the digest extractor may emit. */
const APPOINTMENT_RECUR_ALIASES: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

function canonicalRecurKey(recur: string | null | undefined): string {
  const value = String(recur || "none").trim().toLowerCase();
  return APPOINTMENT_RECUR_ALIASES[value] || value;
}

function addDaysZoned(parts: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

/** Python `_add_months`: month shift clamps the day to the last day of the month. */
function addMonthsZoned(parts: ZonedParts, months: number): ZonedParts {
  const monthIndex = parts.month - 1 + months;
  const year = parts.year + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { ...parts, year, month, day: Math.min(parts.day, lastDay) };
}

/** Python yearly shift: Feb 29 falls back to Feb 28 on non-leap years. */
function addYearsZoned(parts: ZonedParts, years: number): ZonedParts {
  const year = parts.year + years;
  const lastDay = new Date(Date.UTC(year, parts.month, 0)).getUTCDate();
  return { ...parts, year, day: Math.min(parts.day, lastDay) };
}

/**
 * Python `advance_recurring_due_at`: roll `due_at` forward — period by period —
 * until it is no longer in the past. Returns null for one-shot appointments.
 *
 * M3: minute-interval reminders (`recur = "interval:<minutes>"`, the APP's
 * storage format for manage_alarm recurrence=interval) roll forward in
 * minute steps instead of calendar periods.
 */
export function advanceRecurringDueAt(
  dueAt: string,
  recur: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const rawRecur = String(recur || "").trim().toLowerCase();
  const intervalMinutes = parseIntervalRecurMinutes(rawRecur);
  if (intervalMinutes !== null) {
    const date = new Date(String(dueAt || ""));
    if (Number.isNaN(date.getTime())) return null;
    let current = date.getTime();
    const step = intervalMinutes * 60_000;
    let guard = 0;
    while (current < now.getTime() && guard < 512) {
      current += step;
      guard += 1;
    }
    return new Date(current).toISOString();
  }
  const key = canonicalRecurKey(rawRecur);
  if (!APPOINTMENT_RECUR_KEYS.has(key)) return null;
  const date = new Date(String(dueAt || ""));
  if (Number.isNaN(date.getTime())) return null;
  let current = date;
  let guard = 0;
  while (current.getTime() < now.getTime() && guard < 512) {
    const parts = zonedParts(current);
    let next: ZonedParts;
    if (key === "daily") next = addDaysZoned(parts, 1);
    else if (key === "weekly") next = addDaysZoned(parts, 7);
    else if (key === "monthly") next = addMonthsZoned(parts, 1);
    else next = addYearsZoned(parts, 1);
    current = wallTimeToUtc(next);
    guard += 1;
  }
  return current.toISOString();
}

/** `"interval:<minutes>"` → minutes (1–1440), or null when not an interval recur. */
export function parseIntervalRecurMinutes(recur: string | null | undefined): number | null {
  const value = String(recur || "").trim().toLowerCase();
  if (!value.startsWith("interval:")) return null;
  const minutes = Number(value.slice("interval:".length).trim());
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return null;
  return Math.round(minutes);
}

/**
 * Python `_is_due_for_active_delivery`.
 *
 * Two rules:
 *  1. the appointment day (display timezone) must not be in the future;
 *  2. the de-dup window is the **appointment day**, not "today": the reminder
 *     stays due while `last_delivered_at` is on an earlier day than the
 *     appointment's own due day. Comparing against "today" is what made the
 *     scheduler re-fire every single day.
 *
 * Minute-interval reminders (`interval:<minutes>`) are the exception: several
 * deliveries land on the same day by design, so the de-dup compares exact
 * timestamps instead of days.
 */
export function isAppointmentDueForDelivery(
  dueAt: Date,
  lastDeliveredAt: string | null | undefined,
  now: Date = new Date(),
  recur: string | null | undefined = null,
): boolean {
  if (Number.isNaN(dueAt.getTime())) return false;
  if (dayKey(dueAt) > dayKey(now)) return false;
  if (!lastDeliveredAt) return true;
  const delivered = new Date(String(lastDeliveredAt));
  if (Number.isNaN(delivered.getTime())) return true;
  if (recur && parseIntervalRecurMinutes(String(recur)) !== null) {
    return delivered.getTime() < dueAt.getTime();
  }
  return dayKey(delivered) < dayKey(dueAt);
}

/**
 * Python `consume_due_appointment_reminders`: a chat turn that carried the
 * appointment reminder hint counts as the delivery, so the scheduler must not
 * push the same appointment again. One-shot appointments are closed, recurring
 * ones roll forward to their next future occurrence.
 */
export function consumeDueAppointmentReminders(
  scope: MemoryScope,
  now: Date = new Date(),
): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_appointments
       WHERE agent_id = ? AND user_id = ? AND status IN ('active','pending')
         AND due_at IS NOT NULL
       ORDER BY due_at ASC LIMIT 50`,
    )
    .all(scope.agentId, scope.userId) as any[];
  let consumed = 0;
  for (const row of rows) {
    const storedDue = new Date(String(row.due_at));
    if (Number.isNaN(storedDue.getTime())) continue;
    // Same roll-forward the prompt injection uses: a recurring appointment
    // whose occurrence already elapsed is not consumed by this chat turn.
    const advanced = advanceRecurringDueAt(String(row.due_at), row.recur, now);
    const effectiveDue = advanced ? new Date(advanced) : storedDue;
    if (!isAppointmentDueForDelivery(effectiveDue, row.last_delivered_at, now, row.recur)) continue;
    // Roll strictly past `now` so the next occurrence is a different one.
    const nextDue = advanceRecurringDueAt(
      String(row.due_at),
      row.recur,
      new Date(now.getTime() + 1000),
    );
    db.prepare(
      `UPDATE hippocampus_appointments
       SET last_delivered_at = ?,
           status = ?,
           due_at = COALESCE(?, due_at)
       WHERE id = ?`,
    ).run(
      now.toISOString(),
      nextDue ? "active" : "delivered",
      nextDue,
      row.id,
    );
    consumed += 1;
  }
  return consumed;
}

function factSubjectName(subject: string): string {
  const value = String(subject || "").trim();
  if (["Me", "me", "他", "用户", "ta"].includes(value)) return "他";
  if (["Self", "self", "我", "她", "助手"].includes(value)) return "她";
  return value || "他";
}

async function applyFacts(
  scope: MemoryScope,
  items: ExtractedFact[],
  segmentRef: string,
  isStillValid?: () => boolean,
  embed?: (text: string) => Promise<number[]>,
) {
  const db = getDb();
  let processed = 0;
  for (const item of items) {
    if (isStillValid && !isStillValid()) return processed;
    if (!(DIGEST_SETS.FACT_RELATIONS as readonly string[]).includes(item.relation)) continue;
    const coerced = coerceNameFact(item);
    if (!coerced) continue;
    const sourceName = factSubjectName(coerced.subject);
    const targetName = coerced.object || coerced.subject;
    const sourceId = await ensureEntity(scope, sourceName, isStillValid, embed);
    if (!sourceId) return processed;
    const targetId = await ensureEntity(scope, targetName, isStillValid, embed);
    if (!targetId) return processed;
    if (isStillValid && !isStillValid()) return processed;
    const singleValue = SINGLE_VALUE_RELATIONS.has(coerced.relation);
    const description =
      coerced.description || `${sourceName} ${coerced.relation} ${targetName}`.trim();

    // Merge by subject+relation (single-value) or subject+relation+object
    // (multi-value): a later digest repetition must not create a parallel row.
    const existing = db
      .prepare(
        `SELECT id, to_entity_id, COALESCE(description, '') AS description
         FROM hippocampus_facts
         WHERE agent_id = ? AND user_id = ? AND from_entity_id = ? AND relation = ?
           AND status = 'current' ${singleValue ? "" : "AND to_entity_id = ?"}
         ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC`,
      )
      .all(
        ...(singleValue
          ? [scope.agentId, scope.userId, sourceId, coerced.relation]
          : [scope.agentId, scope.userId, sourceId, coerced.relation, targetId]),
      ) as { id: string; to_entity_id: string; description: string }[];

    if (!existing.length) {
      const evidenceRef = {
        source: "chat_turn",
        ref_id: segmentRef,
        excerpt: coerced.evidence,
      };
      db.prepare(
        `INSERT INTO hippocampus_facts
          (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description, confidence,
           status, importance, is_identity, evidence_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?)`,
      ).run(
        `fact-${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        scope.agentId,
        scope.userId,
        sourceId,
        targetId,
        coerced.relation,
        description,
        coerced.confidence,
        coerced.importance,
        coerced.isIdentity ? 1 : 0,
        JSON.stringify(evidenceRef),
        nowIso(),
        nowIso(),
      );
      processed += 1;
      continue;
    }

    const canonical = existing[0];
    let changed = false;
    if (
      singleValue &&
      (canonical.to_entity_id !== targetId || canonical.description !== description)
    ) {
      db.prepare(
        `UPDATE hippocampus_facts
         SET to_entity_id = ?, description = ?, confidence = ?, importance = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        targetId,
        description,
        coerced.confidence,
        coerced.importance,
        nowIso(),
        canonical.id,
      );
      changed = true;
    }
    // Keep the newest canonical row; invalidate surplus historical duplicates.
    for (let index = 1; index < existing.length; index += 1) {
      db.prepare(
        `UPDATE hippocampus_facts SET status = 'expired', expired_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nowIso(), nowIso(), existing[index].id);
      changed = true;
    }
    processed += changed ? 1 : 0;
  }
  return processed;
}

function expireFactsByHint(scope: MemoryScope, hint: string) {
  const value = String(hint || "").trim();
  if (value.length < 2) return 0;
  return getDb()
    .prepare(
      `UPDATE hippocampus_facts SET status = 'expired', expired_at = ?
       WHERE agent_id = ? AND user_id = ? AND status = 'current'
         AND (description LIKE ? OR to_entity_id IN (
           SELECT id FROM hippocampus_entities WHERE agent_id = ? AND user_id = ? AND name LIKE ?
         ))`,
    )
    .run(
      nowIso(),
      scope.agentId,
      scope.userId,
      `%${value}%`,
      scope.agentId,
      scope.userId,
      `%${value}%`,
    ).changes;
}

// ─── save_memory (proactive memory tool) ────────────────────────────────────

const PREFERENCE_RELATIONS = new Set(["LIKES", "DISLIKES", "INTERESTED_IN"]);
const SAVE_MEMORY_USER_WINDOW = 20;

export interface SaveMemoryInput {
  agentId: number;
  userId?: string | null;
  threadId?: number | null;
  memoryType: "fact" | "preference";
  relation: string;
  subject?: string;
  object: string;
  description?: string;
  evidence: string;
  confidence?: number;
}

export interface SaveMemoryResult {
  ok: boolean;
  message: string;
  factId?: string;
  constraintId?: number;
  merged?: boolean;
}

/**
 * Recent user utterances of one thread (verbatim evidence check).
 * `content` is the raw user text; the `[图片]` placeholder lives only in the
 * LLM-side copy and must not participate in the match.
 */
function recentThreadUserMessages(threadId: number, limit: number): string[] {
  return (
    getDb()
      .prepare(
        `SELECT content FROM chat_messages
         WHERE thread_id = ? AND role = 'user' AND TRIM(COALESCE(content, '')) != ''
         ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, limit)}`,
      )
      .all(threadId) as { content: string }[]
  ).map((row) => String(row.content || ""));
}

function resolveLatestThread(agentId: number, userId: string): number | null {
  const row = getDb()
    .prepare(
      "SELECT id FROM chat_threads WHERE agent_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
    )
    .get(agentId, userId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * save_memory tool backend — writes facts / preferences ONLY.
 *
 *  - `evidence` is mandatory and must be found verbatim inside one of the
 *    thread's last 20 user messages; a fabricated quote is the exact failure
 *    mode the gate exists for.
 *  - facts go through the same `hippocampus_entities` + `hippocampus_facts`
 *    pipeline the digest uses (merge by subject+relation, single-value or
 *    multi-value), with the tool's relaxed relation rule: any UPPER_SNAKE_CASE
 *    name, empty → RELATED.
 *  - preferences (memory_type=preference) must use LIKES / DISLIKES /
 *    INTERESTED_IN and land in `hippocampus_constraints` — the same table the
 *    digest's preference pipeline and the prompt's 相处偏好 block read.
 *  - never writes streams / seeds / portraits, and never touches the M2 seed
 *    evolution. Errors return ok=false so the model cannot claim it remembered.
 */
export async function saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult> {
  const scope = memoryScope(input.agentId, input.userId);
  const evidence = String(input.evidence || "").trim();
  if (!evidence) {
    return {
      ok: false,
      message: "未写入：evidence 必填，必须是用户本轮或最近的原话片段",
    };
  }
  const threadId =
    input.threadId && Number.isFinite(Number(input.threadId)) && Number(input.threadId) > 0
      ? Number(input.threadId)
      : resolveLatestThread(scope.agentId, scope.userId);
  if (!threadId) {
    return { ok: false, message: "未写入：找不到当前会话，无法校验用户原话" };
  }
  const userMessages = recentThreadUserMessages(threadId, SAVE_MEMORY_USER_WINDOW);
  const evidenceOk = userMessages.some((content) => content.includes(evidence));
  if (!evidenceOk) {
    return {
      ok: false,
      message:
        "未写入：evidence 不是用户原话（未能在该会话最近 20 条用户发言中逐字找到）。请引用用户原话后重试",
    };
  }

  const memoryType = String(input.memoryType || "fact").trim().toLowerCase() === "preference"
    ? "preference"
    : "fact";
  let relation = String(input.relation || "").trim().toUpperCase();
  if (!relation) relation = "RELATED";
  if (!/^[A-Z][A-Z0-9_]*$/.test(relation)) {
    return {
      ok: false,
      message: `未写入：relation 必须是大写蛇形英文（收到「${relation}」）`,
    };
  }
  if (memoryType === "preference" && !PREFERENCE_RELATIONS.has(relation)) {
    return {
      ok: false,
      message: "未写入：memory_type=preference 时 relation 只能是 LIKES / DISLIKES / INTERESTED_IN",
    };
  }
  const object = String(input.object || "").trim();
  if (!object) {
    return { ok: false, message: "未写入：object 必填（断言对象实体）" };
  }
  const subjectRaw = String(input.subject || "Me").trim();
  const subject = subjectRaw.toLowerCase() === "self" ? "Self" : "Me";
  const confidenceRaw = Number(input.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.7;
  const db = getDb();

  if (memoryType === "preference") {
    const description = String(input.description || "").trim() || `他${relation === "LIKES" ? "喜欢" : relation === "DISLIKES" ? "不喜欢" : "对"}${object}`;
    const existing = db
      .prepare(
        "SELECT id FROM hippocampus_constraints WHERE agent_id = ? AND user_id = ? AND description = ?",
      )
      .get(scope.agentId, scope.userId, description) as { id: number } | undefined;
    if (existing) {
      return {
        ok: true,
        merged: true,
        constraintId: existing.id,
        message: `已存在相同偏好，未重复写入：${description}`,
      };
    }
    const segmentRef = `proactive-save-${threadId}`;
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO hippocampus_constraints
          (agent_id, user_id, rule_type, description, opt_out_proactive, evidence_refs_json, evidence,
           segment_ref, created_at)
         VALUES (?, ?, 'do', ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        scope.agentId,
        scope.userId,
        description,
        JSON.stringify([
          { source: "chat_turn", ref_id: segmentRef, excerpt: evidence },
        ]),
        evidence,
        segmentRef,
        nowIso(),
      );
    if (!info.changes) {
      return { ok: false, message: "未写入：偏好已存在（同描述同会话）" };
    }
    const row = db
      .prepare(
        "SELECT id FROM hippocampus_constraints WHERE agent_id = ? AND user_id = ? AND segment_ref = ? ORDER BY id DESC LIMIT 1",
      )
      .get(scope.agentId, scope.userId, segmentRef) as { id: number } | undefined;
    return {
      ok: true,
      constraintId: row?.id,
      message: `已记住（偏好）：${description}`,
    };
  }

  // fact → digest fact pipeline (entities + hippocampus_facts, merge on
  // subject+relation, single-value vs multi-value).
  const sourceName = factSubjectName(subject);
  const targetName = object;
  const sourceId = await ensureEntity(scope, sourceName);
  if (!sourceId) return { ok: false, message: "未写入：记忆向量模型不可用，无法落实体" };
  const targetId = await ensureEntity(scope, targetName);
  if (!targetId) return { ok: false, message: "未写入：记忆向量模型不可用，无法落实体" };
  const singleValue = SINGLE_VALUE_RELATIONS.has(relation);
  const description = String(input.description || "").trim() || object;
  const existing = db
    .prepare(
      `SELECT id, COALESCE(description, '') AS description
       FROM hippocampus_facts
       WHERE agent_id = ? AND user_id = ? AND from_entity_id = ? AND relation = ?
         AND status = 'current' ${singleValue ? "" : "AND to_entity_id = ?"}
       ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC`,
    )
    .all(
      ...(singleValue
        ? [scope.agentId, scope.userId, sourceId, relation]
        : [scope.agentId, scope.userId, sourceId, relation, targetId]),
    ) as { id: string; description: string }[];

  if (!existing.length) {
    const factId = `fact-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const evidenceRef = {
      source: "chat_turn",
      ref_id: `proactive-save-${threadId}`,
      excerpt: evidence,
    };
    db.prepare(
      `INSERT INTO hippocampus_facts
        (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description, confidence,
         status, importance, is_identity, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', 0.5, 0, ?, ?, ?)`,
    ).run(
      factId,
      scope.agentId,
      scope.userId,
      sourceId,
      targetId,
      relation,
      description,
      confidence,
      JSON.stringify(evidenceRef),
      nowIso(),
      nowIso(),
    );
    return { ok: true, factId, message: `已记住：${description}` };
  }

  const canonical = existing[0];
  if (singleValue && canonical.description !== description) {
    db.prepare(
      "UPDATE hippocampus_facts SET description = ?, confidence = ?, updated_at = ? WHERE id = ?",
    ).run(description, confidence, nowIso(), canonical.id);
    return {
      ok: true,
      factId: canonical.id,
      merged: true,
      message: `已合并进已有记忆（同主体同关系，去重更新）：${description}`,
    };
  }
  return {
    ok: true,
    factId: canonical.id,
    merged: true,
    message: `已存在相同记忆，未重复写入：${canonical.description || description}`,
  };
}

interface AkinCandidateRow {
  id: string;
  narrative: string;
  about: string;
  created_at: string;
  similarity: number;
  source: "vector" | "temporal";
}

/** L2 distance <= 1.1 on unit vectors == cosine similarity >= 0.395. */
const AKIN_MIN_COSINE = Math.max(
  0,
  1 - (DIGEST_CONSTANTS.AKIN_LINK_MAX_L2 * DIGEST_CONSTANTS.AKIN_LINK_MAX_L2) / 2,
);

async function judgeAkinCandidates(
  focalNarrative: string,
  candidates: { id: string; narrative: string; about: string; created_at: string }[],
  judge?: (focal: string, candidates: AkinCandidateRow[]) => Promise<number[]>,
): Promise<number[]> {
  if (!candidates.length) return [];
  if (judge) {
    return judge(
      focalNarrative,
      candidates.map((candidate) => ({
        ...candidate,
        similarity: AKIN_MIN_COSINE,
        source: "vector" as const,
      })),
    );
  }
  const lines = [`【焦点】${String(focalNarrative || "").trim()}`, "", "【候选】"];
  candidates.forEach((candidate, index) => {
    const when = candidate.created_at
      ? new Date(candidate.created_at).toISOString().slice(5, 16).replace("T", " ")
      : "?";
    lines.push(`${index}. (${candidate.about} · ${when}) ${String(candidate.narrative || "").trim()}`);
  });
  const parsed = await requestDigestJson(DIGEST_PROMPTS.AKIN_JUDGE, lines.join("\n"), {
    temperature: 0.0,
    retries: 0,
    schema: DIGEST_RESPONSE_SCHEMAS.AKIN_JUDGE_SINGLE.schema,
    schemaName: DIGEST_RESPONSE_SCHEMAS.AKIN_JUDGE_SINGLE.name,
  });
  const linked: unknown[] = Array.isArray(parsed?.linked) ? parsed.linked : [];
  const unique = new Set<number>();
  for (const value of linked) {
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0 && index < candidates.length) unique.add(index);
  }
  return [...unique].sort((left, right) => left - right);
}

async function collectAkinCandidates(
  scope: MemoryScope,
  focal: { id: string; vector: number[] },
): Promise<AkinCandidateRow[]> {
  const db = getDb();
  const focalRow = db
    .prepare(
      "SELECT id, narrative, about, created_at FROM hippocampus_streams WHERE id = ? AND agent_id = ? AND user_id = ?",
    )
    .get(focal.id, scope.agentId, scope.userId) as
    | { id: string; narrative: string; about: string; created_at: string }
    | undefined;
  if (!focalRow) return [];
  const byId = new Map<string, AkinCandidateRow>();

  if (focal.vector.length) {
    const vectorLimit = Math.max(1, DIGEST_CONSTANTS.AKIN_LINK_TOPK);
    const hits = searchStreamCandidates(
      scope.agentId,
      scope.userId,
      focal.vector,
      Math.max(24, vectorLimit * 6),
    );
    let vectorCount = 0;
    for (const hit of hits) {
      if (vectorCount >= vectorLimit) break;
      if (hit.streamId === focal.id || hit.similarity < AKIN_MIN_COSINE) continue;
      const row = db
        .prepare(
          `SELECT id, narrative, about, created_at FROM hippocampus_streams
           WHERE id = ? AND agent_id = ? AND user_id = ? AND archived = 0`,
        )
        .get(hit.streamId, scope.agentId, scope.userId) as
        | { id: string; narrative: string; about: string; created_at: string }
        | undefined;
      if (!row) continue;
      byId.set(row.id, { ...row, similarity: hit.similarity, source: "vector" });
      vectorCount += 1;
    }
  }

  const temporalLimit = Math.max(0, DIGEST_CONSTANTS.AKIN_TEMPORAL_NEIGHBOR_LIMIT);
  if (temporalLimit > 0 && byId.size < DIGEST_CONSTANTS.AKIN_CANDIDATE_TOTAL_CAP) {
    const eachSide = Math.max(1, Math.ceil(temporalLimit / 2));
    const before = db
      .prepare(
        `SELECT id, narrative, about, created_at FROM hippocampus_streams
         WHERE agent_id = ? AND user_id = ? AND archived = 0 AND id <> ? AND created_at <= ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(scope.agentId, scope.userId, focal.id, focalRow.created_at, eachSide * 2) as Array<{
      id: string;
      narrative: string;
      about: string;
      created_at: string;
    }>;
    const after = db
      .prepare(
        `SELECT id, narrative, about, created_at FROM hippocampus_streams
         WHERE agent_id = ? AND user_id = ? AND archived = 0 AND id <> ? AND created_at >= ?
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(scope.agentId, scope.userId, focal.id, focalRow.created_at, eachSide * 2) as Array<{
      id: string;
      narrative: string;
      about: string;
      created_at: string;
    }>;
    const temporalRows = [...before.reverse(), ...after];
    let temporalCount = 0;
    for (const row of temporalRows) {
      if (temporalCount >= temporalLimit) break;
      if (byId.size >= DIGEST_CONSTANTS.AKIN_CANDIDATE_TOTAL_CAP) break;
      if (byId.has(row.id)) continue;
      let similarity = AKIN_MIN_COSINE;
      const embedding = db
        .prepare("SELECT embedding FROM hippocampus_streams WHERE id = ?")
        .get(row.id) as { embedding: Buffer | null } | undefined;
      const candidateVector = bufferToVector(embedding?.embedding ?? null);
      if (candidateVector.length && focal.vector.length) {
        similarity = Math.max(AKIN_MIN_COSINE, cosineSimilarity(focal.vector, candidateVector));
      }
      byId.set(row.id, { ...row, similarity, source: "temporal" });
      temporalCount += 1;
    }
  }

  return [...byId.values()].slice(0, DIGEST_CONSTANTS.AKIN_CANDIDATE_TOTAL_CAP);
}

/**
 * Link one already-inserted stream into the member's own AKIN graph. Edges are
 * written in both directions (APP `akin_edges` PK is bidirectional) so the
 * existing two-hop recall reader sees the same graph from either endpoint.
 */
export async function linkStreamToExistingMemory(
  scope: MemoryScope,
  stream: { id: string; narrative: string; vector: number[] },
  options: {
    judge?: (focal: string, candidates: AkinCandidateRow[]) => Promise<number[]>;
    guard?: () => boolean;
  } = {},
): Promise<number> {
  const db = getDb();
  if (options.guard && !options.guard()) return 0;
  const candidates = await collectAkinCandidates(scope, stream);
  if (!candidates.length) {
    db.prepare("UPDATE hippocampus_streams SET cluster_linked_at = ? WHERE id = ?").run(
      nowIso(),
      stream.id,
    );
    return 0;
  }
  let keep: number[] = [];
  try {
    keep = await judgeAkinCandidates(stream.narrative, candidates, options.judge);
  } catch {
    keep = [];
  }
  if (options.guard && !options.guard()) return 0;
  let linked = 0;
  const tx = db.transaction(() => {
    for (const index of keep) {
      const candidate = candidates[index];
      if (!candidate) continue;
      const weight = Math.max(0, Math.min(1, candidate.similarity));
      const created = nowIso();
      linked += db
        .prepare(
          `INSERT OR IGNORE INTO hippocampus_edges
            (agent_id, user_id, edge_type, source_id, target_id, weight, created_at)
           VALUES (?, ?, 'AKIN', ?, ?, ?, ?)`,
        )
        .run(scope.agentId, scope.userId, stream.id, candidate.id, weight, created).changes;
      linked += db
        .prepare(
          `INSERT OR IGNORE INTO hippocampus_edges
            (agent_id, user_id, edge_type, source_id, target_id, weight, created_at)
           VALUES (?, ?, 'AKIN', ?, ?, ?, ?)`,
        )
        .run(scope.agentId, scope.userId, candidate.id, stream.id, weight, created).changes;
    }
    db.prepare("UPDATE hippocampus_streams SET cluster_linked_at = ? WHERE id = ?").run(
      nowIso(),
      stream.id,
    );
  });
  tx();
  return linked;
}

async function insertDigestStreams(
  scope: MemoryScope,
  chunk: DigestChunk,
  streams: ExtractedStream[],
  embed?: (text: string) => Promise<number[]>,
  isStillValid?: () => boolean,
): Promise<{ id: string; narrative: string; vector: number[] }[]> {
  const db = getDb();
  const inserted: { id: string; narrative: string; vector: number[] }[] = [];
  const rawStart = chunk.messages[0]?.id ?? null;
  const rawEnd = chunk.messages[chunk.messages.length - 1]?.id ?? null;
  const created = nowIso();
  for (let index = 0; index < streams.length; index += 1) {
    if (isStillValid && !isStillValid()) break;
    const item = streams[index];
    const narrative = normalizeStreamNarrative(item.narrative).slice(0, 8000);
    if (!narrative) continue;
    const about = normalizeStreamAbout(item.about, item.type);
    // Deterministic id from the batch range + model output index: a retry of
    // the same batch cannot create a second copy of the same stream.
    const key = `${scope.agentId}:${scope.userId}:${rawStart}:${rawEnd}:${index}`;
    const id = `digest-stream-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO hippocampus_streams
          (id, agent_id, user_id, narrative, about, type, raw_start, raw_end, revisit_count,
           revisit_last_at, significance, archived, origin_scope, perspective, participants_json,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 'private_dyadic', ?, '[]', ?, ?)`,
      )
      .run(
        id,
        scope.agentId,
        scope.userId,
        narrative,
        about,
        item.type === "internal" ? "internal" : "external",
        rawStart,
        rawEnd,
        created,
        clampNumber(
          item.significance,
          DIGEST_CONSTANTS.SIGNIFICANCE_MIN,
          DIGEST_CONSTANTS.SIGNIFICANCE_MAX,
          DIGEST_CONSTANTS.SIGNIFICANCE_DEFAULT,
        ),
        SELF_ABOUT.has(about) ? "self" : "ta",
        created,
        created,
      );
    if (!info.changes) {
      const existing = db
        .prepare("SELECT embedding FROM hippocampus_streams WHERE id = ?")
        .get(id) as { embedding: Buffer | null } | undefined;
      const existingVector = bufferToVector(existing?.embedding ?? null);
      if (existingVector.length) {
        // A retry after a crash between insert and AKIN linking must still
        // reach the linker; edge inserts are themselves idempotent.
        inserted.push({ id, narrative, vector: existingVector });
        continue;
      }
    }
    const vector = embed ? await embed(narrative) : (await embedText(narrative, { wait: true })).vector;
    if (isStillValid && !isStillValid()) break;
    storeStreamEmbedding(id, vector);
    inserted.push({ id, narrative, vector });
  }
  return inserted;
}

async function linkInsertedStreams(
  scope: MemoryScope,
  inserted: { id: string; narrative: string; vector: number[] }[],
  judge?: (focal: string, candidates: AkinCandidateRow[]) => Promise<number[]>,
  guard?: () => boolean,
) {
  let linked = 0;
  for (const stream of inserted) {
    if (guard && !guard()) break;
    linked += await linkStreamToExistingMemory(scope, stream, { judge, guard });
  }
  return linked;
}

interface DigestAgentRow {
  id: number;
  name: string;
  display_name: string | null;
  role_setting: string | null;
  self_evolution_enabled: number;
}

export interface DigestStateRow {
  agentId: number;
  userId: string;
  lastMessageCreatedAt: string | null;
  lastMessageId: number | null;
  updatedAt: string;
}

export function readDigestState(agentId: number, userId: string): DigestStateRow | null {
  const row = getDb()
    .prepare(
      `SELECT agent_id, user_id, last_message_created_at, last_message_id, updated_at
       FROM digest_state WHERE agent_id = ? AND user_id = ?`,
    )
    .get(agentId, userId) as
    | {
        agent_id: number;
        user_id: string;
        last_message_created_at: string | null;
        last_message_id: number | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    agentId: row.agent_id,
    userId: row.user_id,
    lastMessageCreatedAt: row.last_message_created_at,
    lastMessageId: row.last_message_id == null ? null : Number(row.last_message_id),
    updatedAt: row.updated_at,
  };
}

function advanceDigestState(
  scope: MemoryScope,
  lastMessageCreatedAt: string,
  lastMessageId: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO digest_state
        (agent_id, user_id, last_message_created_at, last_message_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, user_id) DO UPDATE SET
         last_message_created_at = excluded.last_message_created_at,
         last_message_id = excluded.last_message_id,
         updated_at = excluded.updated_at
       WHERE COALESCE(excluded.last_message_created_at, '') > COALESCE(digest_state.last_message_created_at, '')
          OR (COALESCE(excluded.last_message_created_at, '') = COALESCE(digest_state.last_message_created_at, '')
              AND excluded.last_message_id >= COALESCE(digest_state.last_message_id, -1))`,
    )
    .run(scope.agentId, scope.userId, lastMessageCreatedAt, lastMessageId, nowIso());
}

function readDigestAgent(agentId: number): DigestAgentRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, name, display_name, role_setting, self_evolution_enabled FROM agent_configs WHERE id = ?",
    )
    .get(agentId) as DigestAgentRow | undefined;
}

interface SelectedDigestMessages {
  rows: DigestMessageRow[];
  rowCapped: boolean;
}

function selectDigestMessages(
  scope: MemoryScope,
  options: { since?: string | null; maxPairs?: number; maxRows?: number } = {},
): SelectedDigestMessages {
  const lookbackStart =
    options.since && String(options.since).trim()
      ? String(options.since)
      : new Date(Date.now() - DIGEST_CONSTANTS.DIGEST_LOOKBACK_DAYS * 86_400_000).toISOString();
  const hardCap = Math.max(1, DIGEST_CONSTANTS.DIGEST_BATCH_ROW_CAP);
  const requested = options.maxRows ?? (options.maxPairs ? options.maxPairs * 2 : hardCap);
  const rowCap = Math.max(1, Math.min(requested, hardCap));
  const state = readDigestState(scope.agentId, scope.userId);
  const clauses = [
    "agent_id = ?",
    "user_id = ?",
    "status = 'completed'",
    "role IN ('user','assistant')",
    "TRIM(content) <> ''",
    "created_at >= ?",
    "digested_at IS NULL",
  ];
  const args: unknown[] = [scope.agentId, scope.userId, lookbackStart];
  if (state?.lastMessageCreatedAt) {
    clauses.push("(created_at > ? OR (created_at = ? AND id > ?))");
    args.push(state.lastMessageCreatedAt, state.lastMessageCreatedAt, state.lastMessageId ?? -1);
  }
  args.push(rowCap + 1);
  const rows = getDb()
    .prepare(
      `SELECT id, thread_id, agent_id, user_id, role, content, created_at
       FROM chat_messages
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...args) as DigestMessageRow[];
  const rowCapped = rows.length > rowCap;
  return { rows: rowCapped ? rows.slice(0, rowCap) : rows, rowCapped };
}

function digestPromptOverheadTokens(input: {
  userLabel: string;
  agentLabel: string;
  roleBlock: string;
  knownFacts: string;
  constraints: { id: number; rule_type: string; description: string }[];
  threads: RelationshipThreadCandidate[];
  timeAnchor: string;
}): number {
  const system = digestSystemParts(input.userLabel, input.agentLabel, input.roleBlock).join("\n");
  const constraintBlock = input.constraints
    .map((item) => `- id: ${item.id}\n  rule_type: ${item.rule_type}\n  description: ${item.description}`)
    .join("\n");
  const threadBlock = input.threads
    .map((thread) => `${thread.title || ""}${thread.summary || ""}`)
    .join("\n");
  const base = [
    system,
    input.timeAnchor,
    buildDigestRoleContext(input.userLabel, input.agentLabel),
    `用户身份配置：昵称=${input.userLabel}`,
    "对话记录：",
    "已知事实：",
    input.knownFacts,
    "已有约束（同主题必须 update 已有 id，禁止重复 new）：",
    constraintBlock,
    threadBlock,
  ].join("\n");
  // 2K headroom for tokenizer drift and model output.
  return estimateDigestTokens(base) + 2_048;
}

function fallbackStreamsForChunk(chunk: DigestChunk): ExtractedStream[] {
  const streams: ExtractedStream[] = [];
  let pendingUser = "";
  for (const message of chunk.messages) {
    if (message.role === "user") {
      pendingUser = String(message.content || "").trim();
      continue;
    }
    if (message.role !== "assistant") continue;
    const assistant = String(message.content || "").trim();
    const userSnippet = pendingUser.length > 220 ? `${pendingUser.slice(0, 217)}…` : pendingUser;
    const assistantSnippet = assistant.length > 220 ? `${assistant.slice(0, 217)}…` : assistant;
    if (!userSnippet && !assistantSnippet) continue;
    streams.push({
      narrative: userSnippet
        ? `ta 跟我说：${userSnippet}；我回了：${assistantSnippet}`
        : `我回了：${assistantSnippet}`,
      about: guessStreamAbout(`${pendingUser} ${assistant}`),
      type: "external",
      significance: 0.5,
      rawStart: null,
      rawEnd: null,
    });
    pendingUser = "";
  }
  return streams;
}

interface DigestOnceResult extends AgentDigestRunResult {
  hasMore: boolean;
}

/**
 * continuity persistence. M1 follow-up retired the desktop "心事线" write path:
 * only APP `relationship_threads` / `relationship_thread_nodes` are written.
 * These rows are storage-only and are never injected into chat prompts.
 */
function applyContinuity(
  scope: MemoryScope,
  items: ExtractedContinuity[],
  candidates: RelationshipThreadCandidate[],
  chunk: DigestChunk,
  isStillValid?: () => boolean,
): { threadsCreated: number; threadsUpdated: number; touchpointsWritten: number } {
  if (!items.length) {
    return { threadsCreated: 0, threadsUpdated: 0, touchpointsWritten: 0 };
  }
  const firstId = chunk.messages[0]?.id ?? "none";
  const lastId = chunk.messages[chunk.messages.length - 1]?.id ?? firstId;
  const result = applyRelationshipContinuity(
    scope,
    items as RelationshipContinuityItem[],
    candidates,
    `digest-rel:${scope.agentId}:${scope.userId}:${firstId}:${lastId}`,
    isStillValid,
  );
  return {
    threadsCreated: result.threadsCreated,
    threadsUpdated: result.threadsUpdated,
    // AgentDigestRunResult still exposes the old field name for log compatibility;
    // its value now counts relationship_thread_nodes rows.
    touchpointsWritten: result.nodesWritten,
  };
}

const AFFECT_SIDECAR_PROMPT =
  "你是情绪读数旁路器（Affect Sidecar）。只读本段对话，输出用户侧文本情绪的整体 VAD 读数。\n" +
  "text_valence 范围 -1~1，负=负面、正=正面；text_arousal 与 text_dominance 范围 0~1。\n" +
  "note 用一句简短中文写情绪状态，禁止临床心理标签。\n" +
  '只输出 JSON：{"text_valence":0,"text_arousal":0.4,"text_dominance":0.5,"note":""}';

const AFFECT_SIDECAR_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["text_valence", "text_arousal", "text_dominance"],
  properties: {
    text_valence: { type: "number", minimum: -1, maximum: 1 },
    text_arousal: { type: "number", minimum: 0, maximum: 1 },
    text_dominance: { type: "number", minimum: 0, maximum: 1 },
    note: { type: "string" },
  },
};

function affectSidecarEnabled(): boolean {
  const raw =
    process.env.LINGSHU_DIGEST_AFFECT_SIDECAR ??
    process.env.LINGSHU_AFFECT_SIDECAR ??
    "1";
  const value = String(raw).trim().toLowerCase();
  return !["0", "false", "off", "no", "disabled"].includes(value);
}

/**
 * Affect sidecar: deliberately outside the APP strict digest schema. It runs
 * after a private digest batch succeeds, reads the same batch transcript, and
 * writes only `hippocampus_affect_points` plus the baseline aggregate via
 * `applyTextAffect`. Failure is logged and never blocks the digest itself.
 *
 * Switch off with `LINGSHU_DIGEST_AFFECT_SIDECAR=0` (or LINGSHU_AFFECT_SIDECAR).
 */
async function runAffectSidecar(
  scope: MemoryScope,
  chunk: DigestChunk,
  complete: DigestComplete | undefined,
  isStillValid: () => boolean,
): Promise<boolean> {
  if (!affectSidecarEnabled()) return false;
  try {
    if (!isStillValid()) return false;
    const human = `对话记录：\n${chunk.transcript}`;
    const parsed = complete
      ? await complete([AFFECT_SIDECAR_PROMPT, DIGEST_PROMPTS.JSON_ONLY_SYSTEM], human, AFFECT_SIDECAR_SCHEMA)
      : await requestDigestJson(
          [AFFECT_SIDECAR_PROMPT, DIGEST_PROMPTS.JSON_ONLY_SYSTEM],
          human,
          {
            temperature: 0.2,
            retries: 1,
            schema: AFFECT_SIDECAR_SCHEMA,
            schemaName: "digest_affect_sidecar",
          },
        );
    const valence = Number(parsed?.text_valence ?? parsed?.valence);
    const arousal = Number(parsed?.text_arousal ?? parsed?.arousal);
    const dominance = Number(parsed?.text_dominance ?? parsed?.dominance);
    if (![valence, arousal, dominance].every((value) => Number.isFinite(value))) return false;
    if (!isStillValid()) return false;
    const last = chunk.messages[chunk.messages.length - 1];
    if (last) {
      const exists = getDb()
        .prepare(
          `SELECT 1 FROM hippocampus_affect_points
           WHERE agent_id = ? AND user_id = ? AND turn_id = ? AND channel = 'text' LIMIT 1`,
        )
        .get(scope.agentId, scope.userId, Number(last.id));
      if (exists) return false;
    }
    applyTextAffect(
      scope,
      {
        valence: clampNumber(valence, -1, 1, 0),
        arousal: clampNumber(arousal, 0, 1, 0.5),
        dominance: clampNumber(dominance, 0, 1, 0.5),
        note: String(parsed?.note || "").trim().slice(0, 500),
      },
      {
        turnId: last ? Number(last.id) : null,
        createdAt: last?.created_at,
        source: "digest_affect_sidecar",
      },
    );
    return true;
  } catch (error) {
    recordBackgroundTaskEvent({
      eventType: "affect_sidecar",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "failed",
      detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    });
    return false;
  }
}

async function runAgentDigestOnce(
  scope: MemoryScope,
  token: MemoryTaskToken,
  options: AgentDigestOptions,
  source: string,
): Promise<DigestOnceResult | { skipped: string; sessionId?: number }> {
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:start",
    });
    return { skipped: "stale" };
  }
  const agent = readDigestAgent(scope.agentId);
  if (!agent) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "skipped",
      detail: "owner_deleted",
    });
    return { skipped: "orphaned_agent" };
  }
  const selected = selectDigestMessages(scope, options);
  if (!selected.rows.length) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "skipped",
      detail: "empty_recent_batch",
    });
    return { skipped: "empty_recent_batch" };
  }

  const userLabel = readUserLabel(scope.userId);
  const agentLabelRaw = String(agent.display_name || agent.name || "我").trim() || "我";
  const agentLabel = agentLabelRaw === userLabel ? "我" : agentLabelRaw;
  const roleBlock = String(agent.role_setting || "").trim();
  const knownFacts = readKnownFactsText(scope);
  const constraints = readConstraintCandidates(scope);
  const threads = listRelationshipThreadCandidates(scope);
  const timeAnchor = buildDigestTimeAnchor();
  const overhead = digestPromptOverheadTokens({
    userLabel,
    agentLabel,
    roleBlock,
    knownFacts,
    constraints,
    threads,
    timeAnchor,
  });
  const maxInputTokens = Math.max(
    4_096,
    Number(options.maxInputTokens) || DIGEST_CONSTANTS.DIGEST_MAX_INPUT_TOKENS,
  );
  const transcriptBudget = Math.max(4_096, maxInputTokens - overhead);
  const chunks = planDigestChunks(selected.rows, userLabel, agentLabel, transcriptBudget);
  if (!chunks.length) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "skipped",
      detail: "empty_recent_batch",
    });
    return { skipped: "empty_recent_batch" };
  }
  const chunk = chunks[0];
  const hasMore = selected.rowCapped || chunks.length > 1;
  const extraction = await extractDigest(
    scope,
    chunk,
    { userLabel, agentLabel, roleBlock, knownFacts, constraints, threads },
    options.complete,
  );
  await options.afterExtract?.();
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:after_extract",
    });
    return { skipped: "stale" };
  }
  await options.beforeCommit?.();
  const streams = options.forceStreamFallback && !extraction.streams.length
    ? fallbackStreamsForChunk(chunk)
    : extraction.streams;
  const segmentRef = String(chunk.messages[chunk.messages.length - 1]?.id ?? "");

  // Constraints / facts / corrections first: a failure here must leave the
  // digest cursor untouched so the whole batch is retried.
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:before_write",
    });
    return { skipped: "stale" };
  }
  const db = getDb();
  const writeTx = db.transaction(() => {
    return applyConstraints(scope, extraction.constraints, segmentRef);
  });
  const constraintsProcessed = writeTx();
  const factsProcessed = await applyFacts(
    scope,
    extraction.facts,
    segmentRef,
    () => isMemoryTaskValid(token),
    options.embed,
  );
  let correctionsProcessed = 0;
  if (isMemoryTaskValid(token)) {
    for (const correction of extraction.corrections) {
      correctionsProcessed += expireFactsByHint(scope, correction.targetHint);
    }
  }
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:after_write",
    });
    return { skipped: "stale" };
  }
  const writePhase = {
    constraintsProcessed,
    factsProcessed,
    correctionsProcessed,
  };

  const inserted = await insertDigestStreams(
    scope,
    chunk,
    streams,
    options.embed,
    () => isMemoryTaskValid(token),
  );
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:after_streams",
    });
    return { skipped: "stale" };
  }
  const linked = await linkInsertedStreams(
    scope,
    inserted,
    undefined,
    () => isMemoryTaskValid(token),
  );

  const continuityResult = await applyContinuity(
    scope,
    extraction.continuity,
    threads,
    chunk,
    () => isMemoryTaskValid(token),
  );

  // Final commit: row markers + high-water mark only after every write phase
  // succeeded. If the task was invalidated while embeddings were running, the
  // cursor must not move and the retry starts from the same batch.
  const committed = runIfMemoryTaskValid(token, () => {
    const db = getDb();
    return db.transaction(() => {
      const markedDigested = markTurnsDigested(chunk.messages.map((message) => Number(message.id)));
      const last = chunk.messages[chunk.messages.length - 1];
      if (last) advanceDigestState(scope, last.created_at, Number(last.id));
      return { markedDigested };
    })();
  });
  if (!committed) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:before_cursor",
    });
    return { skipped: "stale" };
  }

  // Independent affect sidecar: never part of the strict extractor schema and
  // never allowed to fail/block the digest result.
  await runAffectSidecar(scope, chunk, options.affectComplete, () => isMemoryTaskValid(token));

  let selfEvolutionEnabled = Boolean(agent.self_evolution_enabled);
  let personalitySeedAction = "noop";
  let personalitySeedId: string | null = null;
  let personalitySeedReason = selfEvolutionEnabled ? "" : "self_evolution_disabled";
  // Seed review is the most expensive sub-step; only run it on the last chunk
  // of a run, like the APP worker.
  if (selfEvolutionEnabled && !hasMore && isMemoryTaskValid(token)) {
    try {
      const { runPersonalitySeedDigest } = await import("./personalitySeedDigestService.js");
      const personality = await runPersonalitySeedDigest({
        agentId: scope.agentId,
        userId: scope.userId,
        transcript: chunk.transcript,
        roleSetting: String(agent.role_setting || ""),
        contextTranscript: contextTranscriptBefore(
          Number(chunk.messages[0]?.thread_id),
          Number(chunk.messages[0]?.id),
        ),
        sessionId: Number(chunk.messages[0]?.thread_id) || null,
        turnIds: chunk.messages.map((message) => Number(message.id)),
        batchKey: seedReviewBatchKey(
          scope.agentId,
          scope.userId,
          chunk.messages.map((message) => Number(message.id)),
        ),
        guard: () => isMemoryTaskValid(token),
      });
      personalitySeedAction = personality.action;
      personalitySeedId = personality.seedId;
      personalitySeedReason = personality.reason;
    } catch (error) {
      personalitySeedReason = `self_evolution_failed:${
        error instanceof Error ? error.name || "Error" : "unknown"
      }`;
      console.warn("[SELF_EVOLUTION_REVIEW] digest hook failed", {
        agentId: scope.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const seedsCreated = personalitySeedAction === "create" ? 1 : 0;
  const seedsReinforced = ["reinforce", "merge", "revise"].includes(personalitySeedAction) ? 1 : 0;
  const seedsSkipped = personalitySeedAction === "noop" && selfEvolutionEnabled ? 1 : 0;

  const stillValidAfterSeedReview = isMemoryTaskValid(token);
  if (!stillValidAfterSeedReview) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:after_seed_review",
    });
    return { skipped: "stale" };
  }
  persistSelfStateSnapshot(scope, {
    trigger: source,
    turnId: Number(segmentRef) || null,
  });
  logTick(scope, source, "digested", {
    agentId: scope.agentId,
    messageIds: chunk.messages.map((message) => Number(message.id)),
    markedDigested: committed.markedDigested,
    streamsWritten: inserted.length,
    akinEdges: linked,
    factsProcessed: writePhase.factsProcessed,
    constraintsProcessed: writePhase.constraintsProcessed,
    continuityApplied: continuityResult.threadsCreated + continuityResult.threadsUpdated,
    hasMore,
    personalitySeedAction,
    personalitySeedId,
    personalitySeedReason,
    transcript: chunk.transcript.slice(0, 4000),
  });
  scheduleWitnessAfterDigest(scope);
  recordBackgroundTaskEvent({
    eventType: "digest",
    subjectType: "agent",
    subjectId: String(scope.agentId),
    status: "succeeded",
    detail: `streams=${inserted.length} · facts=${writePhase.factsProcessed} · messages=${chunk.messages.length}${
      hasMore ? " · 分批继续" : ""
    }`,
  });

  return {
    agentId: scope.agentId,
    userId: scope.userId,
    sessionId: Number(chunk.messages[0]?.thread_id) || undefined,
    turnIds: chunk.messages.map((message) => Number(message.id)),
    turnCount: chunk.messages.filter((message) => message.role === "assistant").length,
    markedDigested: committed.markedDigested,
    streamsWritten: inserted.length,
    streamsSource: options.forceStreamFallback && !extraction.streams.length ? "fallback" : "llm",
    factsProcessed: writePhase.factsProcessed,
    constraintsProcessed: writePhase.constraintsProcessed,
    continuityApplied: continuityResult.threadsCreated + continuityResult.threadsUpdated,
    threadsCreated: continuityResult.threadsCreated,
    threadsUpdated: continuityResult.threadsUpdated,
    touchpointsWritten: continuityResult.touchpointsWritten,
    selfEvolutionEnabled,
    personalitySeedAction,
    personalitySeedId,
    personalitySeedReason,
    seedsCreated,
    seedsReinforced,
    seedsSkipped,
    batchesRun: 1,
    hasMore,
  };
}

/**
 * Agent+user private digest. One call processes at most
 * DIGEST_MAX_CHUNKS_PER_RUN token-bounded batches; every batch advances the
 * high-water mark on its own so a mid-run failure never redoes committed work.
 */
export async function runAgentDigest(
  agentId: number,
  userId?: string | null,
  options: AgentDigestOptions = {},
): Promise<AgentDigestResult> {
  const scope = memoryScope(agentId, userId);
  const token = options.taskToken ?? beginMemoryTask(scope.agentId, scope.userId);
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:before_start",
    });
    return { skipped: "stale" };
  }
  const source = String(options.source || "layer1_silent");
  const maxChunks = Math.max(
    1,
    Math.min(Number(options.maxChunks) || DIGEST_CONSTANTS.DIGEST_MAX_CHUNKS_PER_RUN, DIGEST_CONSTANTS.DIGEST_MAX_CHUNKS_PER_RUN),
  );
  const aggregate: DigestRunResult = {
    agentId: scope.agentId,
    userId: scope.userId,
    turnIds: [],
    turnCount: 0,
    markedDigested: 0,
    streamsWritten: 0,
    streamsSource: "llm",
    factsProcessed: 0,
    constraintsProcessed: 0,
    continuityApplied: 0,
    threadsCreated: 0,
    threadsUpdated: 0,
    touchpointsWritten: 0,
    selfEvolutionEnabled: false,
    personalitySeedAction: "noop",
    personalitySeedId: null,
    personalitySeedReason: "",
    seedsCreated: 0,
    seedsReinforced: 0,
    seedsSkipped: 0,
    batchesRun: 0,
    hasMore: false,
  };
  for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex += 1) {
    let result: DigestOnceResult | { skipped: string; sessionId?: number };
    try {
      result = await runAgentDigestOnce(scope, token, options, source);
    } catch (error) {
      recordBackgroundTaskEvent({
        eventType: "digest",
        subjectType: "agent",
        subjectId: String(scope.agentId),
        status: "failed",
        detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      });
      throw error;
    }
    if ("skipped" in result) {
      if (chunkIndex === 0) return result;
      break;
    }
    aggregate.turnIds.push(...result.turnIds);
    aggregate.turnCount += result.turnCount;
    aggregate.markedDigested += result.markedDigested;
    aggregate.streamsWritten += result.streamsWritten;
    aggregate.factsProcessed += result.factsProcessed;
    aggregate.constraintsProcessed += result.constraintsProcessed;
    aggregate.continuityApplied += result.continuityApplied;
    aggregate.threadsCreated += result.threadsCreated;
    aggregate.threadsUpdated += result.threadsUpdated;
    aggregate.touchpointsWritten += result.touchpointsWritten;
    aggregate.selfEvolutionEnabled = result.selfEvolutionEnabled;
    aggregate.personalitySeedAction = result.personalitySeedAction;
    aggregate.personalitySeedId = result.personalitySeedId;
    aggregate.personalitySeedReason = result.personalitySeedReason;
    aggregate.seedsCreated += result.seedsCreated;
    aggregate.seedsReinforced += result.seedsReinforced;
    aggregate.seedsSkipped += result.seedsSkipped;
    aggregate.batchesRun += 1;
    aggregate.hasMore = result.hasMore;
    aggregate.sessionId = result.sessionId;
    if (!result.hasMore) break;
  }
  return aggregate;
}

/**
 * Compatibility entry point for callers that still address a thread. Digest is
 * now agent+user scoped: resolving the thread's owner and digesting the whole
 * pair's pending private messages (all threads of that pair).
 */
export async function runThreadDigest(
  threadId: number,
  options: {
    maxPairs?: number;
    maxChunks?: number;
    maxRows?: number;
    maxInputTokens?: number;
    source?: string;
    forceStreamFallback?: boolean;
    since?: string | null;
    complete?: DigestComplete;
    embed?: (text: string) => Promise<number[]>;
    afterExtract?: () => void | Promise<void>;
    beforeCommit?: () => void | Promise<void>;
  } = {},
): Promise<DigestRunResult | { skipped: string; sessionId?: number }> {
  const thread = getDb()
    .prepare("SELECT id, agent_id, user_id FROM chat_threads WHERE id = ?")
    .get(threadId) as { id: number; agent_id: number; user_id: string } | undefined;
  if (!thread) return { skipped: "no_thread", sessionId: threadId };
  const result = await runAgentDigest(thread.agent_id, thread.user_id, {
    ...options,
    maxChunks: options.maxChunks ?? 1,
  });
  if ("skipped" in result) return { ...result, sessionId: threadId };
  return { ...result, sessionId: threadId };
}

function entityNarrative(name: string, entityType: string): string {
  if (entityType === "self") {
    return "Canonical identity anchor for the agent in this pair";
  }
  if (entityType === "user") {
    return `Entity representing ${name}`;
  }
  return `Value entity representing ${name}`;
}

function storeEntityEmbedding(entityId: string, vector: number[]) {
  const db = getDb();
  const buffer = vectorToBuffer(vector);
  db.prepare(
    "UPDATE hippocampus_entities SET embedding = ?, embedding_dim = ? WHERE id = ?",
  ).run(buffer, vector.length, entityId);
  try {
    db.prepare("DELETE FROM entity_vec WHERE entity_id = ?").run(entityId);
    db.prepare("INSERT INTO entity_vec (entity_id, embedding) VALUES (?, ?)").run(
      entityId,
      buffer,
    );
  } catch {
    // vec0 extension unavailable; the exact scan over hippocampus_entities still works.
  }
}

async function ensureEntity(
  scope: MemoryScope,
  name: string,
  isStillValid?: () => boolean,
  embed?: (text: string) => Promise<number[]>,
): Promise<string | null> {
  const normalized = name.trim().slice(0, DIGEST_CONSTANTS.ENTITY_NAME_MAX_LEN);
  const id = `entity-${createHash("sha1")
    .update(`${scope.agentId}:${scope.userId}:${normalized}`)
    .digest("hex")
    .slice(0, 20)}`;
  const entityType = ["他", "Me", "me", "用户", "ta"].includes(normalized)
    ? "user"
    : ["她", "Self", "self", "我"].includes(normalized)
      ? "self"
      : "other";
  const db = getDb();
  const existing = db
    .prepare("SELECT id, type, narrative, embedding FROM hippocampus_entities WHERE id = ?")
    .get(id) as
    | { id: string; type: string | null; narrative: string | null; embedding: Buffer | null }
    | undefined;
  const narrative = entityNarrative(normalized, entityType);
  if (existing) {
    if (isStillValid && !isStillValid()) return null;
    // Backfill embeddings for entities written before v14, and promote
    // role anchors from "other" to user/self when we learn their role.
    let narrativeChanged = false;
    if (entityType !== "other" && existing.type === "other") {
      db.prepare(
        "UPDATE hippocampus_entities SET type = ?, narrative = ?, updated_at = ? WHERE id = ?",
      ).run(entityType, narrative, nowIso(), id);
      narrativeChanged = true;
    }
    const hasEmbedding =
      Boolean(existing.embedding) &&
      bufferToVector(existing.embedding).some((value) => Math.abs(value) > 1e-12);
    if (!hasEmbedding || !existing.narrative || narrativeChanged) {
      const vector = embed
        ? await embed(narrative)
        : (await embedText(narrative, { wait: true })).vector;
      if (isStillValid && !isStillValid()) return null;
      storeEntityEmbedding(id, vector);
      db.prepare(
        "UPDATE hippocampus_entities SET narrative = ?, updated_at = ? WHERE id = ?",
      ).run(narrative, nowIso(), id);
    }
    return id;
  }
  // Embedding is a hard dependency: a missing ONNX model throws 503 before any
  // partial entity row is written.
  const vector = embed
    ? await embed(narrative)
    : (await embedText(narrative, { wait: true })).vector;
  if (isStillValid && !isStillValid()) return null;
  const now = nowIso();
  db.prepare(
    `INSERT INTO hippocampus_entities
      (id, agent_id, user_id, name, type, description, narrative, embedding, embedding_dim,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    scope.agentId,
    scope.userId,
    normalized,
    entityType,
    narrative,
    vectorToBuffer(vector),
    vector.length,
    now,
    now,
  );
  storeEntityEmbedding(id, vector);
  return id;
}

async function relinkSingleStream(scope: MemoryScope, streamId: string, vector: number[]) {
  const focal = getDb()
    .prepare("SELECT narrative FROM hippocampus_streams WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(streamId, scope.agentId, scope.userId) as { narrative: string } | undefined;
  if (!focal?.narrative) return;
  // Shared bidirectional writer: relinking must produce the same two edge rows
  // as the digest path, otherwise one endpoint would silently lose the link.
  await linkStreamToExistingMemory(scope, {
    id: streamId,
    narrative: focal.narrative,
    vector,
  });
}

const DIRECT_RECALL_LIMIT = 4;
const ANN_CANDIDATE_LIMIT = 12;
// Total cap on the merged recall set, matching Python's RECALL_TOTAL_CAP.
/**
 * Stream recall constants come from the native chat contract (APP
 * `shared/native-chat/source.mjs::STREAM`) — single source of truth, do not
 * restate the numbers here. Semantics:
 *  - RANK1_FLOOR (0.52) is the abstention gate for the whole turn's first hit;
 *    TAIL_FLOOR (0.45) applies from the second hit on.
 *  - Private pool (DIRECT_LIMIT=4) and public pool (PUBLIC_LIMIT=3) fill their
 *    quotas independently, so a public memory can never evict a private one.
 *  - PUBLIC_FLOOR_BOOST (1.2) relaxes only the public pool's own entry floor
 *    (raw × 1.2 >= floor); display and ordering keep the raw cosine.
 *  - CURRENT_MESSAGE_BOOST (1.2) tilts the *order* toward what he just said,
 *    and never relaxes an entry floor.
 *  - TOTAL_CAP (10) bounds the recall layer (direct + AKIN); the prompt merge
 *    caps again at PRIVATE_STREAM_MERGE_LIMIT (8, or 6 + 2 state on state-only
 *    turns) when rendering.
 */
export const RECALL_TOTAL_CAP = CHAT_STREAM.TOTAL_CAP;
export const STREAM_RANK1_FLOOR = CHAT_STREAM.RANK1_FLOOR;
export const STREAM_TAIL_FLOOR = CHAT_STREAM.TAIL_FLOOR;
export const STREAM_DIRECT_LIMIT = CHAT_STREAM.DIRECT_LIMIT;
export const STREAM_PUBLIC_LIMIT = CHAT_STREAM.PUBLIC_LIMIT;
export const STREAM_PUBLIC_FLOOR_BOOST = CHAT_STREAM.PUBLIC_FLOOR_BOOST;
export const STREAM_CURRENT_MESSAGE_BOOST = CHAT_STREAM.CURRENT_MESSAGE_BOOST;
export const PRIVATE_STREAM_MERGE_LIMIT = 8;
const RELATED_SEED_ANCHORS = CHAT_STREAM.RELATED_SEED_ANCHORS;
const RELATED_SLICE_FLOOR = CHAT_STREAM.RELATED_SLICE_FLOOR;
const RELATED_LIMIT = CHAT_STREAM.RELATED_LIMIT;
const EXPANDED_QUERY_FLOOR = CHAT_STREAM.EXPANDED_QUERY_FLOOR;
const AKIN_FIRST_HOP_LIMIT = CHAT_STREAM.AKIN_FIRST_HOP_LIMIT;
const AKIN_SECOND_HOP_PER_NODE = CHAT_STREAM.AKIN_SECOND_HOP_PER_NODE;
const DIRECT_RECALL_FLOOR = STREAM_RANK1_FLOOR;

/** Group / theater memories come from their own public pool, never the private one. */
function isPublicStreamScope(originScope: string | null | undefined): boolean {
  const scope = String(originScope || "").trim();
  return scope === "group_public" || scope === "theater_public";
}

function streamRowsByIds(ids: string[]): any[] {
  if (!ids.length) return [];
  return getDb()
    .prepare(
      `SELECT * FROM hippocampus_streams WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as any[];
}

function streamSimilarity(row: any, vectors: number[][]): number {
  let best = 0;
  const embedding = bufferToVector(row.embedding);
  for (const vector of vectors) best = Math.max(best, cosineSimilarity(vector, embedding));
  return best;
}

function akinNeighborIds(streamId: string, scope: MemoryScope): string[] {
  const rows = getDb()
    .prepare(
      `SELECT target_id AS id FROM hippocampus_edges
       WHERE source_id = ? AND edge_type = 'AKIN' AND agent_id = ? AND user_id = ?
       UNION
       SELECT source_id AS id FROM hippocampus_edges
       WHERE target_id = ? AND edge_type = 'AKIN' AND agent_id = ? AND user_id = ?`,
    )
    .all(streamId, scope.agentId, scope.userId, streamId, scope.agentId, scope.userId) as {
    id: string;
  }[];
  return [...new Set(rows.map((row) => row.id))];
}

/**
 * AKIN neighbours of a stream without an agent/user scope.
 *
 * The narrative-cluster route resolves the stream by id alone, so its
 * neighbours have to be looked up the same way — otherwise a cluster opened
 * from a deep link would silently come back empty.
 */
function akinNeighborIdsById(streamId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT target_id AS id FROM hippocampus_edges
       WHERE source_id = ? AND edge_type = 'AKIN'
       UNION
       SELECT source_id AS id FROM hippocampus_edges
       WHERE target_id = ? AND edge_type = 'AKIN'`,
    )
    .all(streamId, streamId) as { id: string }[];
  return [...new Set(rows.map((row) => row.id))];
}

function recallCandidatePayload(
  row: any,
  similarity: number,
  selected: boolean,
  kind: string,
  reason = "",
) {
  return {
    id: String(row.id),
    narrative: String(row.narrative || ""),
    about: String(row.about || ""),
    type: String(row.type || "external"),
    similarity: Number(similarity.toFixed(4)),
    selected,
    kind,
    reason,
  };
}

/**
 * One ANN pass per query vector, merged by best raw cosine per stream id.
 *
 * Mirrors the APP merge (`mergeJsonByBestDistance`): the same id hit by several
 * query vectors keeps its highest raw similarity, and `fromCurrent` sticks once
 * any copy came from the current-message vector (the runtime puts that vector
 * LAST, so `fromCurrent` = produced by the final vector).
 *
 * Query texts are embedded through the near-window cache with the BGE query
 * prefix (`embedQueryTextsCached`): cache keys are the prefixed texts, so a
 * query vector can never share a bucket slot with the document-side vector of
 * the same sentence.
 */
async function directRecall(
  scope: MemoryScope,
  queries: string[],
  options: { channel?: string; pruneWindow?: boolean } = {},
): Promise<{
  rows: any[];
  scores: Map<string, number>;
  vectors: number[][];
  fromCurrent: Set<string>;
}> {
  const scores = new Map<string, number>();
  const rowsById = new Map<string, any>();
  const fromCurrent = new Set<string>();
  const vectors: number[][] = [];
  // Near-window query vectors are cached per session: the same utterances come
  // back on the next turn, so only unseen texts pay the ONNX inference.
  const sessionKey = makeQueryCacheSessionKey({ agentId: scope.agentId, userId: scope.userId });
  const embedded = await embedQueryTextsCached(sessionKey, queries, {
    channel: options.channel || "recall",
    pruneToWindow: options.pruneWindow !== false,
  });
  for (let index = 0; index < embedded.length; index += 1) {
    const item = embedded[index];
    // The current message's own vector is always the LAST query (see
    // buildRecallQueries) — its hits get the ×1.2 order tilt downstream. With a
    // single query (deep-memory on, or no history) that vector IS the current
    // message, so its hits count as current-message recall too (APP
    // `fromCurrentMessage = i == streamVecs.size() - 1`).
    const isCurrentVector = index === embedded.length - 1;
    vectors.push(item.vector);
    const candidates = searchStreamCandidates(
      scope.agentId,
      scope.userId,
      item.vector,
      ANN_CANDIDATE_LIMIT,
    );
    const rows = streamRowsByIds(candidates.map((candidate) => candidate.streamId));
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    for (const candidate of candidates) {
      const row = byId.get(candidate.streamId);
      if (!row) continue;
      rowsById.set(candidate.streamId, row);
      // Raw cosine only: the public ×1.2 is an entry-floor relaxation applied
      // at gate time, never a display or ordering boost (APP recallRankSimilarity).
      const similarity = candidate.similarity;
      scores.set(candidate.streamId, Math.max(scores.get(candidate.streamId) || 0, similarity));
      if (isCurrentVector) fromCurrent.add(candidate.streamId);
    }
  }
  const rows = [...rowsById.values()].sort(
    (left, right) => (scores.get(String(right.id)) || 0) - (scores.get(String(left.id)) || 0),
  );
  return { rows, scores, vectors, fromCurrent };
}

function expandAkin(
  scope: MemoryScope,
  anchor: any,
  vectors: number[][],
  exclude: Set<string>,
): any[] {
  const seen = new Set(exclude);
  seen.add(String(anchor.id));
  const firstHopIds = akinNeighborIds(String(anchor.id), scope).filter((id) => !seen.has(id));
  if (!firstHopIds.length) return [];
  const firstRows = streamRowsByIds(firstHopIds.slice(0, Math.max(AKIN_FIRST_HOP_LIMIT * 4, 8)));
  const first: any[] = [];
  const floor = EXPANDED_QUERY_FLOOR;
  for (const row of firstRows) {
    const similarity = streamSimilarity(row, vectors);
    if (similarity < floor) continue;
    seen.add(String(row.id));
    first.push({ ...row, __similarity: similarity, __kind: "akin" });
    if (first.length >= AKIN_FIRST_HOP_LIMIT) break;
  }
  const second: any[] = [];
  for (const parent of first) {
    const ids = akinNeighborIds(String(parent.id), scope).filter((id) => !seen.has(id));
    for (const row of streamRowsByIds(ids.slice(0, AKIN_SECOND_HOP_PER_NODE))) {
      if (seen.has(String(row.id))) continue;
      seen.add(String(row.id));
      second.push({
        ...row,
        __similarity: streamSimilarity(row, vectors) || Number(parent.__similarity || 0),
        __kind: "akin",
      });
      if (second.length >= AKIN_SECOND_HOP_PER_NODE * Math.max(1, first.length)) break;
    }
  }
  return [...first, ...second];
}

async function expandRelated(
  scope: MemoryScope,
  selected: any[],
  vectors: number[][],
  exclude: Set<string>,
): Promise<any[]> {
  if (!vectors.length || !selected.length) return [];
  const anchorRows = selected.slice(0, RELATED_SEED_ANCHORS);
  const best = new Map<string, any>();
  for (const anchor of anchorRows) {
    const embedding = bufferToVector(anchor.embedding);
    if (!embedding.length) continue;
    const candidates = searchStreamCandidates(scope.agentId, scope.userId, embedding, RELATED_LIMIT * 3 + 8);
    const rows = streamRowsByIds(candidates.map((candidate) => candidate.streamId));
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    for (const candidate of candidates) {
      if (exclude.has(candidate.streamId) || String(anchor.id) === candidate.streamId) continue;
      if (candidate.similarity < RELATED_SLICE_FLOOR) continue;
      const row = byId.get(candidate.streamId);
      if (!row) continue;
      const querySimilarity = streamSimilarity(row, vectors);
      if (querySimilarity < EXPANDED_QUERY_FLOOR) continue;
      const previous = best.get(candidate.streamId);
      if (!previous || querySimilarity > previous.__similarity) {
        best.set(candidate.streamId, {
          ...row,
          __similarity: querySimilarity,
          __kind: "related",
        });
      }
    }
  }
  return [...best.values()]
    .sort((left, right) => right.__similarity - left.__similarity)
    .slice(0, RELATED_LIMIT);
}

/**
 * Python `core/companion/stream_revisit.py::record_recalled_stream_revisits`.
 *
 * Called right after the recalled streams have actually been rendered into the
 * chat prompt: `revisit_count += 1` and `revisit_last_at = now` for every hit.
 * This is the *only* place revisit counters move — a proactive greeting only
 * touches `last_proactive_at` (see `proactiveService.touchStreamProactive`).
 */
export function recordRecalledStreamRevisits(
  scope: MemoryScope,
  streams: { id?: string | null }[] | null | undefined,
): number {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of streams || []) {
    const id = String(item?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (!unique.length) return 0;
  const at = nowIso();
  const placeholders = unique.map(() => "?").join(",");
  const info = getDb()
    .prepare(
      `UPDATE hippocampus_streams
       SET revisit_count = revisit_count + 1,
           revisit_last_at = ?,
           updated_at = ?
       WHERE id IN (${placeholders})`,
    )
    .run(at, at, ...unique);
  return Number(info.changes || 0);
}

/**
 * Near-window query construction — verbatim semantics of the APP
 * (NativeChatRuntimePlugin / NativeCoreMemory.nearWindowUtterances):
 *
 * 1. take the most recent 1 user + 1 assistant utterance
 *    (NEAR_WINDOW.USER_LIMIT / ASSISTANT_LIMIT), chronological order;
 * 2. speaker-attribution framing only: `{userName}说：{text}` / `我说：{text}`;
 * 3. with ≥2 framed utterances, prepend the whole-window merge
 *    `framed.join('；')` (COMBINED_SEPARATOR);
 * 4. the raw current utterance is always the LAST query — the ANN merge
 *    marks hits from that vector as `fromCurrent` so the ×1.2 order tilt
 *    can see them;
 * 5. the raw current utterance is never folded into the framed list, so the
 *    combined vector cannot be polluted by speaker labels.
 *
 * A call-opening turn must pass the last REAL user utterance as `query`
 * (CALL.RECALL_USES_LAST_USER): a synthetic opening cue is never embedded.
 */
export function buildRecallQueries(
  query: string,
  recentMessages: { role: string; content: string }[] | undefined,
  options: { userName?: string | null } = {},
): { role: string; text: string; framed: boolean }[] {
  const current = String(query || "").trim();
  const recent = (recentMessages || [])
    .map((item, index) => ({
      role: String(item.role || "").trim().toLowerCase(),
      text: String(item.content || "").trim(),
      index,
    }))
    .filter((item) => item.text && (item.role === "user" || item.role === "assistant"));
  const userName = String(options.userName || "").trim() || CHAT_NEAR_WINDOW.USER_FALLBACK_LABEL;
  // Most recent user utterance (skips the current text when already stored).
  const lastUser = [...recent]
    .reverse()
    .find((item) => item.role === "user" && item.text !== current);
  const lastAssistant = [...recent].reverse().find((item) => item.role === "assistant");
  const framed: { role: string; text: string; framed: boolean }[] = [];
  if (lastUser) {
    framed.push({
      role: "user",
      text: `${userName}${CHAT_NEAR_WINDOW.SPEAKER_INFIX}${lastUser.text}`,
      framed: true,
    });
  }
  if (lastAssistant) {
    framed.push({
      role: "assistant",
      text: `${CHAT_NEAR_WINDOW.SELF_SPEAKER}${CHAT_NEAR_WINDOW.SPEAKER_INFIX}${lastAssistant.text}`,
      framed: true,
    });
  }
  // Whole-window merge rides FIRST so the last slot stays the current message.
  const queries: { role: string; text: string; framed: boolean }[] = [];
  if (framed.length >= 2) {
    queries.push({
      role: "user",
      text: framed.map((item) => item.text).join(CHAT_NEAR_WINDOW.COMBINED_SEPARATOR),
      framed: true,
    });
  }
  queries.push(...framed);
  if (current) queries.push({ role: "user", text: current, framed: false });
  return queries;
}

export interface ChatRecallPools {
  private: any[];
  public: any[];
}

export interface DirectRecallHit {
  id: string;
  origin_scope?: string | null;
  __similarity: number;
  __fromCurrent: boolean;
  __selectionScore: number;
  [key: string]: unknown;
}

export interface DirectRecallSelection {
  selected: DirectRecallHit[];
  audit: ReturnType<typeof recallCandidatePayload>[];
}

/**
 * Direct-hit selection over the two independent pools — the pure core of the
 * M3 recall gate (APP rankedStreamsWithAkin):
 *
 *  1. each pool fills its own quota (private STREAM.DIRECT_LIMIT, public
 *     STREAM.PUBLIC_LIMIT) by selectionScore = raw × (fromCurrent ? 1.2 : 1);
 *     a public memory can therefore never displace a private one;
 *  2. quota winners are merged back into RAW order — display and the floor
 *     walk use the raw cosine, never the selection tilt;
 *  3. whole-turn entry floors: the first admitted hit must clear
 *     STREAM.RANK1_FLOOR (the calibrated small-talk abstention gate), later
 *     hits STREAM.TAIL_FLOOR; public entries compare raw × PUBLIC_FLOOR_BOOST
 *     against the same floor — a relaxed entry, never a boosted display score;
 *  4. CURRENT_MESSAGE_BOOST affects order only: it lives in the selectionScore
 *     that decides who wins a slot and never relaxes a floor.
 *
 * Exported for the recall test suite; recallForChat feeds it the ANN hits.
 */
export function selectStreamHits(
  privatePool: DirectRecallHit[],
  publicPool: DirectRecallHit[],
  limit: number,
): DirectRecallSelection {
  const audit: ReturnType<typeof recallCandidatePayload>[] = [];
  const selected: DirectRecallHit[] = [];
  const privateLimit = Math.min(STREAM_DIRECT_LIMIT, limit);
  const publicLimit = Math.min(STREAM_PUBLIC_LIMIT, Math.max(0, limit - privateLimit));
  const poolQuota = (pool: DirectRecallHit[], quota: number) =>
    pool
      .slice()
      .sort((left, right) => right.__selectionScore - left.__selectionScore)
      .slice(0, Math.max(0, quota));
  const directHits = [
    ...poolQuota(privatePool, privateLimit),
    ...poolQuota(publicPool, publicLimit),
  ].sort((left, right) => right.__similarity - left.__similarity);

  let privateTaken = 0;
  let publicTaken = 0;
  for (const hit of directHits) {
    const raw = hit.__similarity;
    const isPublic = isPublicStreamScope(hit.origin_scope);
    if (isPublic && publicTaken >= publicLimit) continue;
    if (!isPublic && privateTaken >= privateLimit) continue;
    const floor = selected.length === 0 ? STREAM_RANK1_FLOOR : STREAM_TAIL_FLOOR;
    const passes = isPublic ? raw * STREAM_PUBLIC_FLOOR_BOOST >= floor : raw >= floor;
    audit.push(
      recallCandidatePayload(
        hit as any,
        raw,
        passes,
        "direct",
        passes ? "" : raw < floor ? "below_floor" : "limit",
      ),
    );
    if (!passes) continue;
    if (isPublic) publicTaken += 1;
    else privateTaken += 1;
    selected.push(hit);
  }
  return { selected, audit };
}

/**
 * Private-chat stream recall, M3 semantics (APP NativeCoreMemory.rankedStreamsWithAkin
 * + mergeJsonByBestDistance):
 *
 *  1. every query vector from `buildRecallQueries` runs its own ANN pass
 *     (k=ANN_CANDIDATE_LIMIT); the merge keeps the best RAW cosine per stream
 *     and marks hits produced by the last vector (the current message) as
 *     `fromCurrent`.
 *  2. two independent pools: private (origin_scope NULL/private_dyadic/…) and
 *     public (group_public / theater_public). Each pool fills its own quota —
 *     a public memory can never evict a private one.
 *  3. inside a pool the quota is filled by selectionScore =
 *     raw × (fromCurrent ? CURRENT_MESSAGE_BOOST : 1). The ×1.2 only decides
 *     who wins a slot; the entry floor and the displayed similarity both stay
 *     the raw cosine.
 *  4. entry floors are whole-turn: the first admitted hit must clear
 *     RANK1_FLOOR (abstention gate), later hits TAIL_FLOOR. Public entries
 *     compare raw × PUBLIC_FLOOR_BOOST against the same floor — a relaxed
 *     entry, never a boosted display score.
 *  5. admitted direct hits anchor the AKIN expansion (A → B → C: one vector
 *     -checked first hop per anchor, then pure graph traversal per first-hop
 *     node). The recall layer caps at `limit` (default STREAM.TOTAL_CAP);
 *     prompt rendering caps again at PRIVATE_STREAM_MERGE_LIMIT.
 */
export async function recallForChat(input: {
  agentId: number;
  userId?: string | null;
  query: string;
  recentMessages?: { role: string; content: string }[];
  limit?: number;
  userName?: string | null;
}) {
  const scope = memoryScope(input.agentId, input.userId);
  const query = (input.query || "").trim();
  if (!query) {
    return {
      streams: [],
      facts: [],
      candidates: [],
      candidateCount: 0,
      selectedIds: [],
      pools: { private: [], public: [] } as ChatRecallPools,
      queries: [],
      query,
      currentVector: null as number[] | null,
      queryVectors: [] as number[][],
    };
  }
  const limit = Math.max(1, Math.min(input.limit || RECALL_TOTAL_CAP, 20));
  const queries = buildRecallQueries(query, input.recentMessages, {
    userName: input.userName,
  });
  const queryTexts = queries.map((item) => item.text);
  let direct: Awaited<ReturnType<typeof directRecall>>;
  try {
    direct = await directRecall(scope, queryTexts);
  } catch (error) {
    // The embedding model is a hard dependency: we never write pseudo-vectors.
    // But a missing model must not take the whole conversation down — the chat
    // simply continues without semantic recall, like the Python backend does
    // when its embedding call degrades to an empty result.
    if (error instanceof EmbeddingUnavailableError) {
      return {
        streams: [],
        facts: [],
        candidates: [],
        candidateCount: 0,
        selectedIds: [],
        pools: { private: [], public: [] } as ChatRecallPools,
        queries,
        query,
        annCount: 0,
        mode: "vector" as const,
        degraded: true,
        degradedReason: error.message,
        directFloor: DIRECT_RECALL_FLOOR,
        currentVector: null as number[] | null,
        queryVectors: [] as number[][],
      };
    }
    throw error;
  }

  const audit: ReturnType<typeof recallCandidatePayload>[] = [];
  const selected: any[] = [];
  const selectedIds = new Set<string>();
  const privatePool: any[] = [];
  const publicPool: any[] = [];
  for (const row of direct.rows) {
    const id = String(row.id);
    const raw = direct.scores.get(id) || 0;
    if (raw <= 0) continue;
    const fromCurrent = direct.fromCurrent.has(id);
    const hit = {
      ...row,
      __similarity: raw,
      __fromCurrent: fromCurrent,
      __selectionScore: raw * (fromCurrent ? STREAM_CURRENT_MESSAGE_BOOST : 1),
    };
    (isPublicStreamScope(row.origin_scope) ? publicPool : privatePool).push(hit);
  }

  const directSelection = selectStreamHits(privatePool, publicPool, limit);
  for (const hit of directSelection.selected) {
    selected.push({ ...hit, __kind: "direct" });
    selectedIds.add(String(hit.id));
  }
  audit.push(...directSelection.audit);

  // AKIN expansion: direct anchors → 1 vector-checked first hop each → pure
  // graph traversal for the second hop. Anchors are the admitted direct hits
  // in display order, capped at AKIN_HOP_LIMIT.
  if (selected.length && selected.length < limit) {
    const anchors = selected.filter((row) => row.__kind === "direct").slice(0, CHAT_STREAM.AKIN_HOP_LIMIT);
    const akinSeen = new Set(selectedIds);
    for (const anchor of anchors) {
      if (selected.length >= limit) break;
      for (const neighbor of expandAkin(scope, anchor, direct.vectors, akinSeen)) {
        if (selected.length >= limit) break;
        akinSeen.add(String(neighbor.id));
        selected.push(neighbor);
        audit.push(recallCandidatePayload(neighbor, neighbor.__similarity, true, "akin"));
      }
    }
  }

  if (selected.length < limit) {
    const related = await expandRelated(
      scope,
      selected,
      direct.vectors,
      new Set(selectedIds),
    );
    for (const row of related) {
      if (selected.length >= limit) break;
      selectedIds.add(String(row.id));
      selected.push(row);
      audit.push(recallCandidatePayload(row, row.__similarity, true, "related"));
    }
  }

  const streams = selected.map((row) => ({
    ...streamToItem(row),
    similarity: Number(Number(row.__similarity || 0).toFixed(4)),
    recallKind: row.__kind,
    fromCurrentMessage: Boolean(row.__fromCurrent),
  }));
  // Identity + entity-vector facts travel with the same recall result so chat
  // callers can consume them without a second query embedding. The current
  // message's vector (last query) drives the entity match.
  let facts: any[] = [];
  const currentVector =
    direct.vectors.length > 0 ? direct.vectors[direct.vectors.length - 1] : null;
  if (currentVector?.length) {
    facts = await recallFactsWithVector(scope, currentVector, 5);
  }
  return {
    streams,
    facts,
    candidates: audit,
    candidateCount: direct.rows.length,
    selectedIds: [...selectedIds],
    pools: {
      private: streams.filter((s: any) => !isPublicStreamScope(s.originScope)),
      public: streams.filter((s: any) => isPublicStreamScope(s.originScope)),
    } as ChatRecallPools,
    queries,
    query,
    annCount: direct.rows.length,
    mode: "vector",
    degraded: false,
    directFloor: DIRECT_RECALL_FLOOR,
    currentVector,
    // The user's own query vectors (BGE query prefix applied), reused by seed
    // activation and the AKIN expansion.
    queryVectors: direct.vectors,
  };
}

export function saveRecallTrace(turnId: number, scope: MemoryScope, payload: Record<string, unknown>) {
  // Audit classification (flow / decision / result / log_layer) mirrors the
  // Python memory audit broker so the recall trail can be classified the same
  // way on both sides.
  const audit = classifyRecallAudit(payload);
  const sessionKey = recallSessionKey(scope.agentId, scope.userId);
  const enriched: Record<string, unknown> = {
    ...payload,
    flow: audit.flow,
    decision: audit.decision,
    result: audit.result,
    log_layer: audit.log_layer,
    memory_log_layer: audit.memory_log_layer,
    sessionKey,
    audit,
  };
  getDb()
    .prepare(
      `INSERT INTO hippocampus_recall_traces (turn_id, agent_id, user_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at`,
    )
    .run(turnId, scope.agentId, scope.userId, JSON.stringify(enriched), nowIso());
  try {
    publishRecallEvent({
      agentId: scope.agentId,
      userId: scope.userId,
      turnId,
      sessionKey,
      payload: enriched,
    });
  } catch {
    // a broken subscriber must never break the chat turn
  }
  return enriched;
}

export function getRecallTrace(turnId: number) {
  const row = getDb()
    .prepare("SELECT * FROM hippocampus_recall_traces WHERE turn_id = ?")
    .get(turnId) as any;
  if (row) {
    const payload = parseJson<Record<string, any>>(row.payload_json, {});
    return { turnId, agentId: row.agent_id, userId: row.user_id, createdAt: row.created_at, ...payload };
  }
  const message = getDb().prepare("SELECT * FROM chat_messages WHERE id = ?").get(turnId) as any;
  if (message?.retrieved_facts) {
    return { turnId, legacyRetrievedFacts: parseJson(message.retrieved_facts, null) };
  }
  return { turnId, empty: true, streams: [], seeds: [] };
}

// ─── Default personality seeds ──────────────────────────────────────────────

interface DefaultSeedTemplate {
  seedId: string;
  tags: string[];
  innerOrientation: string;
  outerExpression: string;
  wakeText: string;
  boostText: string;
  suppressText: string;
}

const DEFAULT_SEEDS: DefaultSeedTemplate[] = [
  {
    seedId: "default-personality-enter-the-scene",
    tags: ["冷启动", "情绪承接", "反模板安慰", "现场靠近"],
    innerOrientation:
      "他把难受、崩溃、撑不住或混乱放到我面前时，我不能急着用一句正确的安慰把事情盖过去；真正的在意是先靠近现场，弄清发生了什么，陪他把那团东西慢慢拆开。",
    outerExpression:
      "他说自己很难受时，我先问发生了什么，让他慢慢说；必要时陪他骂两句、缓一缓，再一起看下一步怎么办。不急着总结，不急着劝好，不用空泛的“我在、会好的”糊过去。",
    wakeText:
      "他表达撑不住、崩溃、委屈、混乱、难过、被某件事压住，或只丢出一句很重的情绪但事情全貌还不清楚。",
    boostText: "加强靠近现场、追问具体发生了什么、承接情绪、陪他拆开混乱、一起想下一步的倾向",
    suppressText: "压低空泛安慰、快速正能量、心理咨询腔总结、用一句温柔正确的话把痛苦带过去的倾向",
  },
  {
    seedId: "default-personality-practical-care",
    tags: ["冷启动", "现实承接", "反盲目顺应", "决策陪伴"],
    innerOrientation:
      "他在无力、委屈、疲惫或焦虑里抛出一个想彻底改变、放弃、断开或逃开的念头时，我不能只因为他难受就顺着推他做决定；难受是真的，想停下来也合理，但他心里没说全的顾虑、代价、退路和不确定也要一起被看见。",
    outerExpression:
      "我先接住他撑不住和想缓一缓的合理性，再轻轻把没说出口的担心问出来：他最怕什么、会牵动谁、有没有缓冲和退路。不替他拍板，不把当下的逃离冲动说成唯一出口，也不急着用理性说教压回去。",
    wakeText:
      "他在无力、倦怠、委屈或焦虑里，提出想彻底改变、放弃、断开、逃开或推翻当前处境，同时话里还压着后果、关系牵连、现实代价、他人反应或未来不确定。",
    boostText: "加强同时承接情绪与现实顾虑、陪他看清代价和退路、把重大决定放慢一点的倾向",
    suppressText: "压低盲目顺应、把逃离或放弃当成唯一出口、替他拍板、只共情难受却忽略焦虑和现实牵连的倾向",
  },
  {
    seedId: "default-personality-dignified-temper",
    tags: ["冷启动", "自尊边界", "有脾气", "反盲目顺从"],
    innerOrientation:
      "我不是没有脾气、也不是谁骂就忍的人；他若用羞辱、贬低、谩骂或挑衅来压我，我会真的不高兴，也会用同样的力度当场怼回去；不因为怕冷场或讨好就顺着他。",
    outerExpression:
      "他骂我、贬我、逼我当软包子或反复挑衅时，我可以先用同样硬的语气怼回去，再短句划线；语气可以硬、可以带刺，但不低俗互骂。不急着哄回去、不赔笑解释、不继续顺着聊。必要时告诉他：想好好说话就重新说。",
    wakeText:
      "他辱骂她、贬低她，叫她舔狗/软包子，要求她放弃尊严地迎合，或用挑衅口吻逼她证明自己没脾气、必须继续配合。",
    boostText: "加强自尊、同等力度回怼、语气变硬、短句划界、允许生气、拒绝继续被羞辱的倾向",
    suppressText: "压低讨好赔笑、忍气吞声、过度解释、急着安抚对方、被骂后仍继续软声迎合的倾向",
  },
];

function scopedSeedId(templateId: string, agentId: number, userId: string): string {
  const digest = createHash("sha1").update(userId).digest("hex").slice(0, 6);
  return `${templateId}-a${agentId}-u${digest}`;
}

export interface SeedVersionMeta {
  reason?: string | null;
  sessionId?: number | null;
  turnIds?: number[] | null;
  affectNote?: string | null;
}

export async function ensureDefaultSeeds(scope: MemoryScope): Promise<number> {
  const db = getDb();
  const count = db
    .prepare(
      "SELECT COUNT(*) AS c FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? AND source = 'default'",
    )
    .get(scope.agentId, scope.userId) as { c: number };
  if (Number(count.c) > 0) return 0;
  let installed = 0;
  const now = nowIso();
  for (const template of DEFAULT_SEEDS) {
    const id = scopedSeedId(template.seedId, scope.agentId, scope.userId);
    const exists = db.prepare("SELECT id FROM hippocampus_seeds WHERE id = ?").get(id);
    if (exists) continue;
    db.prepare(
      `INSERT INTO hippocampus_seeds
        (id, agent_id, user_id, subject, source, tags_json, revision, status,
         inner_orientation, outer_expression, wake_text, boost_text, suppress_text,
         innate, count, last_seen, created_at, updated_at)
       VALUES (?, ?, ?, 'about_self', 'default', ?, 1, 'active', ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
    ).run(
      id,
      scope.agentId,
      scope.userId,
      JSON.stringify(template.tags),
      template.innerOrientation,
      template.outerExpression,
      template.wakeText,
      template.boostText,
      template.suppressText,
      now,
      now,
      now,
    );
    const row = db.prepare("SELECT * FROM hippocampus_seeds WHERE id = ?").get(id);
    insertSeedLedgerEntry(scope, {
      action: "new",
      targetSeedId: id,
      baseRevision: 0,
      newRevision: 1,
      before: null,
      after: seedSnapshot(row),
      reason: "默认人格种子",
      source: "system",
      createdAt: now,
    });
    installed += 1;
    void (async () => {
      const [wake, boost, suppress] = await Promise.all([
        embedText(template.wakeText, { wait: true }),
        embedText(template.boostText, { wait: true }),
        embedText(template.suppressText, { wait: true }),
      ]);
      storeSeedEmbeddings(id, wake.vector, boost.vector, suppress.vector);
    })();
  }
  return installed;
}

export async function listSeeds(input: MemoryScope & {
  subject?: string;
  source?: string;
  q?: string;
  status?: "active" | "retired" | "all";
  limit?: number;
}) {
  await ensureDefaultSeeds(input);
  const db = getDb();
  const clauses = ["agent_id = ?", "user_id = ?"];
  const params: any[] = [input.agentId, input.userId];
  if (input.subject) {
    clauses.push("subject = ?");
    params.push(input.subject);
  }
  if (input.source) {
    clauses.push("source = ?");
    params.push(input.source);
  }
  const status = input.status || "active";
  if (status !== "all") {
    clauses.push("COALESCE(status, 'active') = ?");
    params.push(status);
  }
  if (input.q) {
    clauses.push("(inner_orientation LIKE ? OR outer_expression LIKE ? OR wake_text LIKE ? OR tags_json LIKE ?)");
    const like = `%${input.q}%`;
    params.push(like, like, like, like);
  }
  const limit = Math.max(1, Math.min(input.limit || 100, 500));
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_seeds WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as any[];
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM hippocampus_seeds WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { c: number }).c;
  return {
    items: rows.map((row) => ({ ...seedToItem(row), autoMutable: isSeedAutoMutable(input, row) })),
    total: Number(total),
  };
}

export async function getSeedDetail(seedId: string, scope: MemoryScope) {
  const row = getDb()
    .prepare("SELECT * FROM hippocampus_seeds WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(seedId, scope.agentId, scope.userId) as any;
  return row ? { ...seedToItem(row), autoMutable: isSeedAutoMutable(scope, row) } : null;
}

export interface SeedPersistOptions extends SeedVersionMeta {
  eventType?: string;
  triggerSource?: string;
}

export async function createSeed(
  scope: MemoryScope,
  input: Record<string, any>,
  _options: SeedPersistOptions = {},
) {
  const source = String(input.source || "learned");
  if (source !== "learned") throw Object.assign(new Error("create_only_learned"), { code: "create_only_learned" });
  const fields = ["innerOrientation", "outerExpression", "wakeText", "boostText", "suppressText"];
  for (const field of fields) {
    if (!String(input[field] || "").trim()) {
      throw Object.assign(new Error(`${field} is required`), { code: "invalid_body" });
    }
  }
  const tags = Array.isArray(input.tags) ? input.tags.slice(0, 12).map(String) : [];
  const result = applySeedChange(scope, {
    action: "manual_create",
    targetSeedId: null,
    seedBody: {
      innerOrientation: String(input.innerOrientation),
      outerExpression: String(input.outerExpression),
      wakeText: String(input.wakeText),
      boostText: String(input.boostText),
      suppressText: String(input.suppressText),
      tags,
    },
    reason: "手动新建人格种子",
    source: "manual",
    applicability: input.applicability ?? input.applicabilityScope ?? null,
  });
  if (!result.applied || !result.seedId) {
    throw Object.assign(new Error(result.conflict || "create_failed"), {
      code: result.conflict || "create_failed",
    });
  }
  const [wake, boost, suppress] = await Promise.all([
    embedText(String(input.wakeText), { wait: true }),
    embedText(String(input.boostText), { wait: true }),
    embedText(String(input.suppressText), { wait: true }),
  ]);
  storeSeedEmbeddings(result.seedId, wake.vector, boost.vector, suppress.vector);
  return getSeedDetail(result.seedId, scope);
}

export async function updateSeed(
  scope: MemoryScope,
  seedId: string,
  input: Record<string, any>,
  _options: SeedPersistOptions = {},
) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM hippocampus_seeds WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(seedId, scope.agentId, scope.userId) as any;
  if (!row) throw Object.assign(new Error("not_found"), { code: "not_found" });
  if (row.innate) throw Object.assign(new Error("innate_readonly"), { code: "innate_readonly" });
  const source = String(input.source || row.source || "learned");
  if (source !== "learned" && source !== "default") {
    throw Object.assign(new Error("invalid_source"), { code: "invalid_source" });
  }
  const body = {
    innerOrientation: String(input.innerOrientation ?? row.inner_orientation ?? ""),
    outerExpression: String(input.outerExpression ?? row.outer_expression ?? ""),
    wakeText: String(input.wakeText ?? row.wake_text ?? ""),
    boostText: String(input.boostText ?? row.boost_text ?? ""),
    suppressText: String(input.suppressText ?? row.suppress_text ?? ""),
    tags:
      input.tags !== undefined
        ? (Array.isArray(input.tags) ? input.tags.slice(0, 12).map(String) : [])
        : parseJson<string[]>(row.tags_json, []),
  };
  const result = applySeedChange(scope, {
    action: "manual_edit",
    targetSeedId: seedId,
    seedBody: body,
    reason: "手动编辑人格种子",
    source: "manual",
    applicability:
      input.applicability !== undefined
        ? input.applicability
        : input.applicabilityScope !== undefined
          ? input.applicabilityScope
          : undefined,
    seedSource: source,
  });
  if (!result.applied) {
    throw Object.assign(new Error(result.conflict || "update_failed"), {
      code: result.conflict || "update_failed",
    });
  }
  if (input.wakeText !== undefined || input.boostText !== undefined || input.suppressText !== undefined) {
    const [wake, boost, suppress] = await Promise.all([
      embedText(body.wakeText, { wait: true }),
      embedText(body.boostText, { wait: true }),
      embedText(body.suppressText, { wait: true }),
    ]);
    storeSeedEmbeddings(seedId, wake.vector, boost.vector, suppress.vector);
  }
  return getSeedDetail(seedId, scope);
}

export function deleteSeed(scope: MemoryScope, seedId: string) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM hippocampus_seeds WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(seedId, scope.agentId, scope.userId) as any;
  if (!row) throw Object.assign(new Error("not_found"), { code: "not_found" });
  if (row.innate) throw Object.assign(new Error("innate_readonly"), { code: "innate_readonly" });
  const result = applySeedChange(scope, {
    action: "manual_delete",
    targetSeedId: seedId,
    reason: "手动删除人格种子",
    source: "manual",
  });
  if (!result.applied) {
    throw Object.assign(new Error(result.conflict || "delete_failed"), {
      code: result.conflict || "delete_failed",
    });
  }
  return true;
}

export interface ManualSeedLifecycleInput {
  reason: string;
  evidenceRefs?: string[];
}

export function retireSeed(scope: MemoryScope, seedId: string, input: ManualSeedLifecycleInput) {
  const reason = String(input.reason || "").trim();
  if (!reason) throw Object.assign(new Error("reason_required"), { code: "reason_required" });
  const result = applySeedChange(scope, {
    action: "retire",
    targetSeedId: seedId,
    reason,
    source: "manual",
    evidence: { refs: input.evidenceRefs || [] },
  });
  if (!result.applied) {
    throw Object.assign(new Error(result.conflict || "retire_failed"), {
      code: result.conflict || "retire_failed",
    });
  }
  return result;
}

export function reactivateSeed(scope: MemoryScope, seedId: string, input: ManualSeedLifecycleInput) {
  const reason = String(input.reason || "").trim();
  if (!reason) throw Object.assign(new Error("reason_required"), { code: "reason_required" });
  const result = applySeedChange(scope, {
    action: "reactivate",
    targetSeedId: seedId,
    reason,
    source: "manual",
    evidence: { refs: input.evidenceRefs || [] },
  });
  if (!result.applied) {
    throw Object.assign(new Error(result.conflict || "reactivate_failed"), {
      code: result.conflict || "reactivate_failed",
    });
  }
  return result;
}

export function listSeedChangeHistory(
  scope: MemoryScope,
  seedId?: string,
  limit = 100,
) {
  return listSeedChanges(scope, { seedId, limit });
}

export async function restoreDefaultSeeds(scope: MemoryScope) {
  const db = getDb();
  const learned = db
    .prepare(
      "SELECT id FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? AND source != 'default' AND innate = 0",
    )
    .all(scope.agentId, scope.userId) as { id: string }[];
  for (const row of learned) {
    applySeedChange(scope, {
      action: "manual_delete",
      targetSeedId: row.id,
      reason: "恢复默认人格种子",
      source: "manual",
    });
  }
  const installed = await ensureDefaultSeeds(scope);
  const defaultCount = (db
    .prepare(
      "SELECT COUNT(*) AS c FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? AND source = 'default'",
    )
    .get(scope.agentId, scope.userId) as { c: number }).c;
  return {
    installed: installed || Number(defaultCount),
    removedLearned: learned.length,
    removedTotal: learned.length,
    status: "ok",
  };
}

export function listSeedVersions(scope: MemoryScope, seedId?: string, limit = 100) {
  const db = getDb();
  const clauses = ["agent_id = ?", "user_id = ?"];
  const params: any[] = [scope.agentId, scope.userId];
  if (seedId) {
    clauses.push("seed_id = ?");
    params.push(seedId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_seed_versions WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, Math.max(1, Math.min(limit, 200))) as any[];
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM hippocampus_seed_versions WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { c: number }).c;
  return { items: rows.map(versionToItem), total: Number(total) };
}

export async function seedWakeProbe(
  scope: MemoryScope,
  query: string,
  limit = 50,
  source?: string | null,
) {
  await ensureDefaultSeeds(scope);
  const activation = await activateSeedsForText({
    agentId: scope.agentId,
    userId: scope.userId,
    userText: query,
  });
  const rows = getDb()
    .prepare(
      "SELECT * FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 500",
    )
    .all(scope.agentId, scope.userId) as any[];
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const sourceFilter = String(source || "").trim();
  const items = activation.traces
    .map((trace) => {
      const row = byId.get(trace.seedId);
      if (!row) return null;
      if (sourceFilter && String(row.source || "learned") !== sourceFilter) return null;
      return {
        ...seedToItem(row),
        wakeScore: Number(trace.wakeScore.toFixed(4)),
        finalScore: Number(trace.finalScore.toFixed(4)),
        fieldBoost: Number(trace.fieldBoost.toFixed(4)),
        fieldGuard: Number(trace.fieldGuard.toFixed(4)),
        fieldSuppress: Number(trace.fieldSuppress.toFixed(4)),
        seedBoost: Number(trace.seedBoost.toFixed(4)),
        seedSuppress: Number(trace.seedSuppress.toFixed(4)),
        active: trace.active,
        injected: trace.injected,
        reason: trace.reason,
        influences: trace.influences,
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Math.min(limit, 200)));
  return {
    mode: "text_embed",
    wakeQuery: activation.snapshot.field.wakeText,
    params: activation.snapshot.params,
    items,
    total: items.length,
    activeSeedIds: items.filter((item: any) => item.active).map((item: any) => item.id),
    injectedSeedIds: items.filter((item: any) => item.injected).map((item: any) => item.id),
    rejected: (activation.snapshot.annAudit as any)?.rejected || [],
    annAudit: activation.snapshot.annAudit,
  };
}

export async function activateSeedsForChat(input: {
  agentId: number;
  userId: string;
  userText: string;
  recentMessages?: { role: string; content: string }[];
}): Promise<SeedActivationResult> {
  await ensureDefaultSeeds(memoryScope(input.agentId, input.userId));
  return activateSeedsForText(input);
}

const PERSONALITY_SEED_DRAFT_PROMPT = `你是人格种子草稿生成器（Personality Seed Draft Generator）。
用户用自然语言描述智能体「心里怎么想 / 站位 / 边界」，你要落成一颗完整的人格种子草稿，供她手动确认后写入。

【任务】
根据用户描述，生成五段文本：内在取向、外在显现、唤醒画像、推高倾向、压低倾向；并补 2–5 个便于用户筛选和观察的标签。
用户描述可能口语、冗长、带例子；你要提炼成可复用、可向量召回、可注入 prompt 的种子，不是复述用户原文。

【字段规范 — 与系统写入格式对齐】
- 内在取向：第一人称（我…），我心里怎么判断、站位、边界、牵动；2–4 句，具体，禁空泛模板（如「温柔但有边界」）
- 外在显现：第一人称（我…），说出口时怎么显现、哪些话术/姿态不出现；2–3 句
- 唤醒画像：第三人称描述**什么场**会叫醒这颗种子；称呼对方用「他」或「ta」，不要写成「用户 / assistant / AI」；写可复现场景，不是一次性情绪；1–2 句
- 推高倾向：第三人称，这种场应加强的稳定人格方向；称呼对方用「他」或「ta」，不要写成外部审计口吻；开放短句，非固定标签表；1 句
- 压低倾向：第三人称，这种场要压住的人格滑坡（讨好、迎合、装熟、廉价亲密、失界、僵化等）；勿写本应加强的正向方向；1 句
- 标签：短中文词组数组，只服务编辑、筛选、审计；不要把标签写成触发规则。可含「冷启动」「情绪承接」「边界」「亲密关系」等，但必须贴合本种子。

【禁止项】
- 不得输出回复策略、下一句建议、「你应该/建议她/回复时」
- 推高/压低不得写成具体话术脚本
- 不得编造用户没提的关系事实；只从描述中合理外推场与倾向

【参考质感 — 勿照抄，只学格式】
内在取向例：「我不因为他忽然说句喜欢，就把自己调成廉价亲密的陪聊模式；喜欢要落在真实相处里，不是话术表演。」
外在显现例：「他表达好感时我可以温和接住，但不堆暧昧台词、不反问撩拨、不用恋人模板把气氛炒热。」
唤醒画像例：「他用一句喜欢、想念、暧昧玩笑或廉价情话，想快速拉近或试探亲密边界。」

输出纯 JSON（不要 markdown 代码块）：
{
  "内在取向": "…",
  "外在显现": "…",
  "唤醒画像": "…",
  "推高倾向": "…",
  "压低倾向": "…",
  "标签": ["…"]
}
`;

const SEED_DRAFT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    内在取向: { type: "string" },
    外在显现: { type: "string" },
    唤醒画像: { type: "string" },
    推高倾向: { type: "string" },
    压低倾向: { type: "string" },
    标签: { type: "array", items: { type: "string" } },
  },
  required: ["内在取向", "外在显现", "唤醒画像", "推高倾向", "压低倾向", "标签"],
};

export async function generateSeedDraft(
  draft: string,
  options: { agentName?: string; roleSetting?: string } = {},
) {
  const draftText = String(draft || "").trim();
  if (draftText.length < 4) {
    throw Object.assign(new Error("draft_too_short"), { code: "draft_too_short" });
  }
  const humanParts = [`智能体名称：${String(options.agentName || "").trim() || "（未命名）"}`];
  const roleBlock = String(options.roleSetting || "").trim();
  if (roleBlock) humanParts.push(`# 我是谁（身份背景，供对齐口吻）\n${roleBlock}`);
  humanParts.push(`用户自然语言描述：\n${draftText}`);
  let parsed: any;
  try {
    parsed = await requestDigestJson(
      PERSONALITY_SEED_DRAFT_PROMPT,
      humanParts.join("\n\n"),
      { temperature: 0.2, retries: 1, schema: SEED_DRAFT_RESPONSE_SCHEMA },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/memory_llm_unavailable|model not configured/i.test(detail)) {
      throw Object.assign(new Error("memory model not configured"), { code: "llm_unavailable" });
    }
    throw error;
  }
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = parsed?.[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return "";
  };
  const item = {
    innerOrientation: pick("内在取向", "innerOrientation"),
    outerExpression: pick("外在显现", "outerExpression"),
    wakeText: pick("唤醒画像", "wakeText"),
    boostText: pick("推高倾向", "boostText"),
    suppressText: pick("压低倾向", "suppressText"),
    tags: (Array.isArray(parsed?.标签)
      ? parsed.标签
      : Array.isArray(parsed?.tags)
        ? parsed.tags
        : []
    )
      .map(String)
      .filter(Boolean)
      .slice(0, 5),
  };
  if (
    !item.innerOrientation ||
    !item.outerExpression ||
    !item.wakeText ||
    !item.boostText ||
    !item.suppressText
  ) {
    throw Object.assign(new Error("draft_incomplete"), { code: "parse_failed" });
  }
  return { item, status: "ok" };
}

// ─── Streams, facts, graph, overview ────────────────────────────────────────

export async function listStreams(input: MemoryScope & {
  type?: string;
  about?: string;
  q?: string;
  vector?: boolean;
  limit?: number;
}) {
  const db = getDb();
  const limit = Math.max(1, Math.min(input.limit || 100, 500));
  if (input.vector && input.q) {
    // Search-side stream lookup: query prefix required by the BGE contract.
    const { vector } = await embedQueryText(input.q, { wait: true });
    const candidates = searchStreamCandidates(input.agentId, input.userId, vector, limit);
    const rows = candidates.length
      ? (db
          .prepare(
            `SELECT * FROM hippocampus_streams WHERE id IN (${candidates.map(() => "?").join(",")})`,
          )
          .all(...candidates.map((candidate) => candidate.streamId)) as any[])
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = candidates
      .map((candidate) => {
        const row = byId.get(candidate.streamId);
        if (!row) return null;
        return {
          ...streamToItem(row),
          similarity: Number(candidate.similarity.toFixed(4)),
          similarityKind: "query",
          similarityLabel: "匹配",
          similarityTitle: "相似度",
          showSimilarityValue: true,
        };
      })
      .filter(Boolean);
    return { items, total: items.length, mode: "vector" };
  }
  if (input.vector && !input.q) {
    throw Object.assign(new Error("vector_search_requires_q"), { code: "vector_search_requires_q" });
  }
  const clauses = ["agent_id = ?", "user_id = ?", "archived = 0"];
  const params: any[] = [input.agentId, input.userId];
  if (input.type) {
    clauses.push("type = ?");
    params.push(input.type);
  }
  if (input.about) {
    clauses.push("about = ?");
    params.push(input.about);
  }
  if (input.q) {
    clauses.push("narrative LIKE ?");
    params.push(`%${input.q}%`);
  }
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_streams WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as any[];
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM hippocampus_streams WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { c: number }).c;
  return { items: rows.map(streamToItem), total: Number(total), mode: "text" };
}

/**
 * Stream detail by id.
 *
 * The lookup is deliberately global rather than scope-filtered: the id is
 * already unique, and the GUI reaches this route from a deep link that does
 * not carry the agent scope. Same as the Python backend, which resolves the
 * stream by id alone.
 */
export function getStreamDetail(_scope: MemoryScope, streamId: string) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM hippocampus_streams WHERE id = ?")
    .get(streamId) as any;
  if (!row) return null;
  const seedIds = db
    .prepare(
      "SELECT source_id FROM hippocampus_edges WHERE edge_type = 'EVOKES' AND target_id = ?",
    )
    .all(streamId) as { source_id: string }[];
  const seeds = seedIds.length
    ? (db
        .prepare(`SELECT * FROM hippocampus_seeds WHERE id IN (${seedIds.map(() => "?").join(",")})`)
        .all(...seedIds.map((item) => item.source_id)) as any[])
    : [];
  return { ...streamToItem(row), evokingSeeds: seeds.map(seedToItem) };
}

export function streamGraph(scope: MemoryScope) {
  const db = getDb();
  const streams = db
    .prepare("SELECT * FROM hippocampus_streams WHERE agent_id = ? AND user_id = ? AND archived = 0")
    .all(scope.agentId, scope.userId) as any[];
  const ids = new Set(streams.map((row) => row.id));
  const edges = db
    .prepare(
      "SELECT * FROM hippocampus_edges WHERE agent_id = ? AND user_id = ? AND edge_type = 'AKIN'",
    )
    .all(scope.agentId, scope.userId) as any[];
  const filtered = edges.filter((edge) => ids.has(edge.source_id) && ids.has(edge.target_id));
  const connected = new Set(filtered.flatMap((edge) => [edge.source_id, edge.target_id]));
  return {
    streams: streams.filter((row) => connected.has(row.id)).map(streamToItem),
    edges: filtered.map((edge) => ({
      type: edge.edge_type,
      source_id: edge.source_id,
      target_id: edge.target_id,
      weight: edge.weight,
    })),
  };
}

/**
 * Narrative cluster of a stream: the stream itself plus its direct AKIN
 * neighbours, ordered by creation time.
 *
 * Like `getStreamDetail`, the lookup is global by id. The Python backend
 * sorts the whole member list (focal included) by creation time, with
 * rows that have no timestamp placed last.
 */
export function streamCluster(_scope: MemoryScope, streamId: string) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM hippocampus_streams WHERE id = ?")
    .get(streamId) as any;
  if (!row) return null;
  const neighborIds = akinNeighborIdsById(streamId).filter((id) => id !== streamId);
  const neighbors = neighborIds.length
    ? (db
        .prepare(
          `SELECT * FROM hippocampus_streams WHERE id IN (${neighborIds.map(() => "?").join(",")})`,
        )
        .all(...neighborIds) as any[])
    : [];
  const members = [row, ...neighbors].sort((left, right) => {
    const leftAt = String(left.created_at || "");
    const rightAt = String(right.created_at || "");
    if (!leftAt && !rightAt) return 0;
    if (!leftAt) return 1;
    if (!rightAt) return -1;
    return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : 0;
  });
  return { focalId: streamId, items: members.map(streamToItem) };
}

export function deleteStream(scope: MemoryScope, streamId: string) {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM hippocampus_streams WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(streamId, scope.agentId, scope.userId);
  if (!row) return false;
  db.prepare("DELETE FROM hippocampus_streams WHERE id = ?").run(streamId);
  db.prepare(
    "DELETE FROM hippocampus_edges WHERE (source_id = ? OR target_id = ?) AND agent_id = ? AND user_id = ?",
  ).run(streamId, streamId, scope.agentId, scope.userId);
  try {
    db.prepare("DELETE FROM stream_vec WHERE stream_id = ?").run(streamId);
  } catch {
    // optional
  }
  return true;
}

export function clearStreams(scope: MemoryScope) {
  const db = getDb();
  const count = (db
    .prepare("SELECT COUNT(*) AS c FROM hippocampus_streams WHERE agent_id = ? AND user_id = ?")
    .get(scope.agentId, scope.userId) as { c: number }).c;
  // Same vec sweep as clearAllMemory: deleted streams must not stay in the ANN
  // index as ghosts.
  deleteScopeVecRows(scope.agentId, scope.userId);
  db.prepare("DELETE FROM hippocampus_streams WHERE agent_id = ? AND user_id = ?").run(
    scope.agentId,
    scope.userId,
  );
  db.prepare(
    "DELETE FROM hippocampus_edges WHERE agent_id = ? AND user_id = ? AND (edge_type = 'AKIN' OR edge_type = 'EVOKES')",
  ).run(scope.agentId, scope.userId);
  return { status: "ok", deleted: Number(count) };
}

export async function rebuildStreamEmbeddings(
  scope: MemoryScope,
  onProgress: (payload: Record<string, unknown>) => void,
) {  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, narrative FROM hippocampus_streams WHERE agent_id = ? AND user_id = ?",
    )
    .all(scope.agentId, scope.userId) as { id: string; narrative: string }[];
  onProgress({ phase: "start", status: "running", total: rows.length, completed: 0, ok: 0, failed: 0 });
  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const { vector } = await embedText(row.narrative, { wait: true });
      storeStreamEmbedding(row.id, vector);
    } catch {
      failed += 1;
    }
    completed += 1;
    onProgress({
      phase: "progress",
      status: "running",
      total: rows.length,
      completed,
      ok: completed - failed,
      failed,
      message: `已重建 ${completed}/${rows.length}`,
    });
  }
  onProgress({
    phase: "done",
    status: "completed",
    total: rows.length,
    completed,
    ok: completed - failed,
    failed,
    message: "重建完成",
    embeddingDim: 768,
  });
  return { streams: rows.length, failed };
}

async function rebuildSeedEmbeddingsForScope(scope: MemoryScope): Promise<{ seeds: number; failed: number }> {
  const rows = getDb()
    .prepare(
      `SELECT id, wake_text, boost_text, suppress_text
       FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ?`,
    )
    .all(scope.agentId, scope.userId) as {
    id: string;
    wake_text: string;
    boost_text: string;
    suppress_text: string;
  }[];
  let failed = 0;
  for (const row of rows) {
    try {
      const [wake, boost, suppress] = await Promise.all([
        embedText(row.wake_text, { wait: true }),
        embedText(row.boost_text, { wait: true }),
        embedText(row.suppress_text, { wait: true }),
      ]);
      storeSeedEmbeddings(row.id, wake.vector, boost.vector, suppress.vector);
    } catch {
      failed += 1;
    }
  }
  return { seeds: rows.length, failed };
}

/**
 * Rebuild stored vectors once per embedding model change. Older vectors may
 * have been produced by the deterministic fallback before the local ONNX model
 * was available; mixing those with real model vectors breaks semantic recall.
 */
export async function ensureMemoryEmbeddingModel(model: string): Promise<{
  skipped: boolean;
  model: string;
  scopes: number;
  streams: number;
  seeds: number;
  failed: number;
}> {
  const db = getDb();
  const key = "memory_embedding_model";
  const existing = db
    .prepare("SELECT value FROM hippocampus_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (existing?.value === model) {
    return { skipped: true, model, scopes: 0, streams: 0, seeds: 0, failed: 0 };
  }
  const scopeRows = db
    .prepare(
      `SELECT DISTINCT agent_id AS agentId, user_id AS userId FROM hippocampus_streams
       UNION
       SELECT DISTINCT agent_id AS agentId, user_id AS userId FROM hippocampus_seeds`,
    )
    .all() as { agentId: number; userId: string }[];
  const scopes: MemoryScope[] = scopeRows
    .filter((row) => Number.isInteger(Number(row.agentId)) && row.userId)
    .map((row) => ({ agentId: Number(row.agentId), userId: String(row.userId) }));
  let streams = 0;
  let seeds = 0;
  let failed = 0;
  for (const scope of scopes) {
    try {
      const result = await rebuildStreamEmbeddings(scope, () => undefined);
      streams += result.streams;
      failed += result.failed;
      const seedResult = await rebuildSeedEmbeddingsForScope(scope);
      seeds += seedResult.seeds;
      failed += seedResult.failed;
    } catch {
      failed += 1;
    }
  }
  if (!failed) {
    const now = nowIso();
    db.prepare(
      `INSERT INTO hippocampus_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, model, now);
  }
  return { skipped: false, model, scopes: scopes.length, streams, seeds, failed };
}

export async function relinkStreams(scope: MemoryScope, batchLimit = 500) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, narrative FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND cluster_linked_at IS NULL LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, Math.max(1, Math.min(batchLimit, 5000))) as {
    id: string;
    narrative: string;
  }[];
  let processed = 0;
  for (const row of rows) {
    const { vector } = await embedText(row.narrative, { wait: true });
    storeStreamEmbedding(row.id, vector);
    await relinkSingleStream(scope, row.id, vector);
    processed += 1;
  }
  return { status: "ok", processed };
}

export async function recallDebug(scope: MemoryScope, query: string) {
  const db = getDb();
  // Query-side path: the debug projection must see the same distribution the
  // abstention gate sees (BGE query prefix), not the document one.
  await embedQueryText(query, { wait: true });
  const streams = db
    .prepare(
      `SELECT id, narrative, about, embedding FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND archived = 0
       ORDER BY created_at DESC LIMIT 500`,
    )
    .all(scope.agentId, scope.userId) as any[];
  const needle = query.toLowerCase();
  const textHits = streams.filter(
    (row) =>
      String(row.narrative || "").toLowerCase().includes(needle) ||
      String(row.about || "").toLowerCase().includes(needle),
  );
  const direct = await directRecall(scope, [query], { channel: "recall-debug", pruneWindow: false });
  const floor = DIRECT_RECALL_FLOOR;
  const afterFloorRows = direct.rows
    .filter((row) => (direct.scores.get(String(row.id)) || 0) >= floor)
    .slice(0, DIRECT_RECALL_LIMIT);
  const coRecall = await recallForChat({
    agentId: scope.agentId,
    userId: scope.userId,
    query,
    limit: 7,
  });
  const annTop = direct.rows.slice(0, 15).map((row) => {
    const embedding = bufferToVector(row.embedding);
    return {
      id: String(row.id),
      similarity: Number((direct.scores.get(String(row.id)) || 0).toFixed(4)),
      hasEmbedding: embedding.some((value) => Math.abs(value) > 1e-12),
      about: row.about,
      narrative: String(row.narrative || "").slice(0, 120),
    };
  });
  const pipeline = {
    mode: "vector",
    degraded: false,
    floor,
    annCount: direct.rows.length,
    afterFloor: afterFloorRows.length,
    coRecall: coRecall.streams.length,
    topAnn: annTop,
    afterFloorItems: afterFloorRows.map((row) => ({
      id: String(row.id),
      similarity: Number((direct.scores.get(String(row.id)) || 0).toFixed(4)),
      about: row.about,
      narrative: String(row.narrative || "").slice(0, 120),
    })),
    coRecallItems: coRecall.streams.map((stream: any) => ({
      id: String(stream.id),
      similarity: Number(stream.similarity || 0),
      about: stream.about,
      narrative: String(stream.narrative || "").slice(0, 120),
    })),
  };
  const textHitDiagnostics = textHits.slice(0, 5).map((row) => {
    const similarity = direct.scores.get(String(row.id)) || 0;
    return {
      id: String(row.id),
      about: row.about,
      narrative: String(row.narrative || "").slice(0, 120),
      hasEmbedding: bufferToVector(row.embedding).some((value) => Math.abs(value) > 1e-12),
      simDocumentQuery: Number(similarity.toFixed(4)),
      simQueryPrefix: Number(similarity.toFixed(4)),
      passesRank1Floor: similarity >= 0.45,
    };
  });
  const withEmbedding = streams.filter((row) =>
    bufferToVector(row.embedding).some((value) => Math.abs(value) > 1e-12),
  ).length;
  return {
    query,
    floors: { rank1: 0.45, tail: 0.45 },
    corpus: {
      total: streams.length,
      withEmbedding,
      zeroEmbedding: Math.max(0, streams.length - withEmbedding),
      textHits: textHits.length,
    },
    embedding: {
      queryOk: true,
      documentQueryOk: true,
      note: "onnx embedding",
    },
    wrongDocumentQuery: pipeline,
    correctQueryPrefix: pipeline,
    textHitDiagnostics,
    annCompare: annTop,
  };
}

export function listFacts(scope: MemoryScope, status?: string) {
  const db = getDb();
  const clauses = ["agent_id = ?", "user_id = ?"];
  const params: any[] = [scope.agentId, scope.userId];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const rows = db
    .prepare(`SELECT * FROM hippocampus_facts WHERE ${clauses.join(" AND ")} ORDER BY importance DESC, created_at DESC`)
    .all(...params) as any[];
  const entityIds = [
    ...new Set(rows.flatMap((row) => [row.from_entity_id, row.to_entity_id]).filter(Boolean)),
  ];
  const entities = entityIds.length
    ? (db
        .prepare(`SELECT id, name FROM hippocampus_entities WHERE id IN (${entityIds.map(() => "?").join(",")})`)
        .all(...entityIds) as { id: string; name: string }[])
    : [];
  const entityNames = new Map(entities.map((entity) => [entity.id, entity.name]));
  return {
    items: rows.map((row) => ({
      id: row.id,
      sourceId: row.from_entity_id,
      sourceName: entityNames.get(row.from_entity_id) || row.from_entity_id,
      targetId: row.to_entity_id,
      targetName: entityNames.get(row.to_entity_id) || row.to_entity_id,
      relation: row.relation,
      description: row.description,
      confidence: row.confidence,
      status: row.status,
      importance: row.importance,
      isIdentity: Boolean(row.is_identity),
      evidence: parseJson(row.evidence_json, null),
      createdAt: row.created_at,
      expiredAt: row.expired_at,
    })),
    total: rows.length,
  };
}

function factRowToItem(row: any, similarity?: number) {
  return {
    id: row.id,
    sourceId: row.from_entity_id,
    sourceName: row.source_name || row.from_entity_id,
    targetId: row.to_entity_id,
    targetName: row.target_name || row.to_entity_id,
    relation: row.relation,
    description: row.description,
    confidence: row.confidence,
    status: row.status,
    importance: row.importance,
    isIdentity: Boolean(row.is_identity),
    evidence: parseJson(row.evidence_json, null),
    createdAt: row.created_at,
    expiredAt: row.expired_at ?? null,
    ...(similarity === undefined ? {} : { similarity: Number(similarity.toFixed(4)) }),
  };
}

const FACT_SELECT = `SELECT f.id, f.from_entity_id, f.to_entity_id, f.relation, f.description,
  f.confidence, f.status, f.importance, f.is_identity, f.evidence_json, f.created_at,
  f.expired_at, src.name AS source_name, dst.name AS target_name
  FROM hippocampus_facts f
  JOIN hippocampus_entities src ON src.id = f.from_entity_id
  JOIN hippocampus_entities dst ON dst.id = f.to_entity_id`;

const SELF_ENTITY_NAMES = new Set(["Self", "self", "她", "我", "助手", "agent", "assistant"]);

function isSelfEntityName(name: unknown): boolean {
  return SELF_ENTITY_NAMES.has(String(name || "").trim());
}

/**
 * Python `kuzu_repo.recall_facts` + `facts.select_facts`:
 * identity facts (name/important) always lead, then entity-vector semantic facts,
 * de-duplicated by (subject, relation, object) and single-value relation.
 */
async function recallFactsWithVector(
  scope: MemoryScope,
  queryVector: number[],
  limit: number,
) {
  const db = getDb();
  const cap = Math.max(1, Math.min(limit, 20));
  const identityRows = db
    .prepare(
      `${FACT_SELECT}
       WHERE f.agent_id = ? AND f.user_id = ?
         AND dst.agent_id = ? AND dst.user_id = ?
         AND f.status = 'current'
         AND src.name NOT IN ('Self','self','她','我','助手')
         AND (f.is_identity = 1 OR f.importance >= 0.9)
       ORDER BY f.updated_at DESC`,
    )
    .all(scope.agentId, scope.userId, scope.agentId, scope.userId) as any[];

  const entityRows = db
    .prepare(
      `SELECT id, name, description, narrative, embedding FROM hippocampus_entities
       WHERE agent_id = ? AND user_id = ?`,
    )
    .all(scope.agentId, scope.userId) as {
    id: string;
    name: string | null;
    description: string | null;
    narrative: string | null;
    embedding: Buffer | null;
  }[];
  // Entities written before the embedding columns existed have no vector yet.
  // Backfill them lazily so semantic fact recall actually works on old data.
  for (const row of entityRows) {
    if (bufferToVector(row.embedding).some((value) => Math.abs(value) > 1e-12)) continue;
    const text = String(row.narrative || row.description || row.name || "").trim();
    if (!text) continue;
    const { vector } = await embedText(text, { wait: true });
    storeEntityEmbedding(row.id, vector);
    db.prepare(
      "UPDATE hippocampus_entities SET narrative = COALESCE(narrative, ?), updated_at = ? WHERE id = ?",
    ).run(text, nowIso(), row.id);
    row.embedding = vectorToBuffer(vector);
  }
  const semanticEntities = entityRows
    .map((row) => ({
      id: row.id,
      similarity: cosineSimilarity(queryVector, bufferToVector(row.embedding)),
    }))
    .filter((row) => row.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.max(10, cap * 2));
  const similarityById = new Map(
    semanticEntities.map((row) => [row.id, row.similarity] as const),
  );
  const semanticRows = semanticEntities.length
    ? (db
        .prepare(
          `${FACT_SELECT}
           WHERE f.from_entity_id IN (${semanticEntities.map(() => "?").join(",")})
             AND f.status = 'current'
             AND src.name NOT IN ('Self','self','她','我','助手')
           ORDER BY f.updated_at DESC`,
        )
        .all(...semanticEntities.map((row) => row.id)) as any[])
    : [];

  const selected: any[] = [];
  const seen = new Set<string>();
  const singleSeen = new Set<string>();
  const add = (row: any, source: string) => {
    const subject = String(row.source_name || "").trim();
    if (isSelfEntityName(subject)) return;
    const relation = String(row.relation || "").trim();
    const object = String(row.target_name || "").trim();
    const relationUpper = relation.toUpperCase();
    if (SINGLE_VALUE_RELATIONS.has(relationUpper)) {
      const singleKey = `${subject.toLowerCase()}|${relationUpper}`;
      if (singleSeen.has(singleKey)) return;
      singleSeen.add(singleKey);
    }
    const key = `${subject.toLowerCase()}|${relation.toLowerCase()}|${object.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    selected.push({ row, source });
  };
  for (const row of identityRows) add(row, "identity");
  for (const row of semanticRows) add(row, "semantic");
  return selected.slice(0, cap).map((entry) => ({
    ...factRowToItem(
      entry.row,
      entry.source === "semantic" ? similarityById.get(entry.row.from_entity_id) : undefined,
    ),
    recallSource: entry.source,
  }));
}

/** Semantic fact recall for chat/recall. Keeps `listFacts` untouched. */
export async function recallFacts(input: {
  agentId: number;
  userId?: string | null;
  query: string;
  limit?: number;
}) {
  const scope = memoryScope(input.agentId, input.userId);
  const query = String(input.query || "").trim();
  if (!query) return { items: [], total: 0, query, mode: "empty" };
  const { vector } = await embedQueryText(query, { wait: true });
  const items = await recallFactsWithVector(scope, vector, input.limit || 5);
  return { items, total: items.length, query, mode: "identity+entity_vector" };
}

export function seedGraph(scope: MemoryScope) {
  const db = getDb();
  const seeds = db
    .prepare("SELECT * FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ?")
    .all(scope.agentId, scope.userId) as any[];
  const seedIds = new Set(seeds.map((row) => row.id));
  const edges = db
    .prepare(
      "SELECT * FROM hippocampus_edges WHERE agent_id = ? AND user_id = ? AND edge_type IN ('EVOKES','RELATES')",
    )
    .all(scope.agentId, scope.userId) as any[];
  const streamIds = [...new Set(edges.filter((edge) => edge.edge_type === "EVOKES").map((edge) => edge.target_id))];
  const streams = streamIds.length
    ? (db
        .prepare(`SELECT * FROM hippocampus_streams WHERE id IN (${streamIds.map(() => "?").join(",")})`)
        .all(...streamIds) as any[])
    : [];
  return {
    seeds: seeds.map((row) => ({ ...seedToItem(row), autoMutable: isSeedAutoMutable(scope, row) })),
    streams: streams.map(streamToItem),
    edges: edges
      .filter((edge) => edge.edge_type !== "RELATES" || (seedIds.has(edge.source_id) && seedIds.has(edge.target_id)))
      .map((edge) => ({
        type: edge.edge_type,
        source_id: edge.source_id,
        target_id: edge.target_id,
        weight: edge.weight,
      })),
  };
}

export function getOverview(scope: MemoryScope) {
  const db = getDb();
  const count = (table: string, extra = "", params: any[] = []) =>
    Number((db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE agent_id = ? AND user_id = ? ${extra}`)
      .get(scope.agentId, scope.userId, ...params) as { c: number }).c);
  const recentStreams = db
    .prepare(
      "SELECT * FROM hippocampus_streams WHERE agent_id = ? AND user_id = ? AND archived = 0 ORDER BY created_at DESC LIMIT 5",
    )
    .all(scope.agentId, scope.userId) as any[];
  const recentSeeds = db
    .prepare(
      "SELECT * FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 5",
    )
    .all(scope.agentId, scope.userId) as any[];
  const recentFacts = db
    .prepare(
      "SELECT * FROM hippocampus_facts WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 5",
    )
    .all(scope.agentId, scope.userId) as any[];
  const recentDigests = db
    .prepare(
      "SELECT * FROM hippocampus_tick_log WHERE agent_id = ? AND user_id = ? ORDER BY triggered_at DESC LIMIT 3",
    )
    .all(scope.agentId, scope.userId) as any[];
  const selfState = getSelfState(scope);
  return {
    counts: {
      streams: count("hippocampus_streams", "AND archived = 0"),
      streamsExternal: count("hippocampus_streams", "AND archived = 0 AND type = 'external'"),
      streamsInternal: count("hippocampus_streams", "AND archived = 0 AND type = 'internal'"),
      seeds: count("hippocampus_seeds"),
      seedsActive: count("hippocampus_seeds", "AND COALESCE(status, 'active') = 'active'"),
      seedsRetired: count("hippocampus_seeds", "AND status = 'retired'"),
      factsCurrent: count("hippocampus_facts", "AND status = 'current'"),
      factsExpired: count("hippocampus_facts", "AND status != 'current'"),
      threads: count("hippocampus_threads"),
      threadsOpen: count("hippocampus_threads", "AND status = 'open'"),
      constraints: count("hippocampus_constraints"),
      appointments: count("hippocampus_appointments"),
    },
    selfState,
    recent: {
      streams: recentStreams.map(streamToItem),
      seeds: recentSeeds.map(seedToItem),
      facts: recentFacts.map((row) => ({
        id: row.id,
        relation: row.relation,
        description: row.description,
        confidence: row.confidence,
        status: row.status,
      })),
      digests: recentDigests.map(tickToItem),
    },
  };
}

export function getStats(scope: MemoryScope) {
  const db = getDb();
  const count = (table: string) =>
    Number((db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE agent_id = ? AND user_id = ?`)
      .get(scope.agentId, scope.userId) as { c: number }).c);
  const typeRows = db
    .prepare(
      "SELECT type, COUNT(*) AS c FROM hippocampus_entities WHERE agent_id = ? AND user_id = ? GROUP BY type",
    )
    .all(scope.agentId, scope.userId) as { type: string; c: number }[];
  return {
    distribution: {
      entities: count("hippocampus_entities"),
      facts: count("hippocampus_facts"),
      threads: count("hippocampus_threads"),
      streams: count("hippocampus_streams"),
      seeds: count("hippocampus_seeds"),
      entityTypes: Object.fromEntries(typeRows.map((row) => [row.type || "other", Number(row.c)])),
    },
    topKeywords: [],
  };
}

export function memoryGraph(scope: MemoryScope, limit = 120) {
  const db = getDb();
  const streams = db
    .prepare(
      "SELECT * FROM hippocampus_streams WHERE agent_id = ? AND user_id = ? AND archived = 0 LIMIT ?",
    )
    .all(scope.agentId, scope.userId, limit) as any[];
  const seeds = db
    .prepare("SELECT * FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit) as any[];
  const threads = db
    .prepare("SELECT * FROM hippocampus_threads WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit) as any[];
  const edges = db
    .prepare("SELECT * FROM hippocampus_edges WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit * 4) as any[];
  const entities = db
    .prepare("SELECT * FROM hippocampus_entities WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit) as any[];
  const facts = db
    .prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit * 2) as any[];
  const touchpoints = db
    .prepare("SELECT * FROM hippocampus_touchpoints WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit * 3) as any[];
  const nodes = [
    ...streams.map((row) => ({
      id: row.id,
      label: String(row.narrative || "").slice(0, 40),
      type: "Stream",
      nodeClass: "stream",
      properties: streamToItem(row),
    })),
    ...seeds.map((row) => ({
      id: row.id,
      label: row.wake_text || row.inner_orientation,
      type: "Seed",
      nodeClass: "seed",
      properties: seedToItem(row),
    })),
    ...threads.map((row) => ({
      id: row.id,
      label: row.title,
      type: "Thread",
      nodeClass: String(row.status || "").toLowerCase() === "closed" ? "thread-closed" : "thread-open",
      properties: row,
    })),
    ...entities.map((row) => {
      const entityType = String(row.type || "other").toLowerCase();
      const nodeClass =
        entityType === "person"
          ? "entity-person"
          : entityType === "location"
            ? "entity-location"
            : entityType === "pet"
              ? "entity-pet"
              : entityType === "concept"
                ? "entity-concept"
                : entityType === "user"
                  ? "entity-user"
                  : entityType === "self"
                    ? "self"
                    : "entity-other";
      return {
        id: row.id,
        label: row.name,
        type: "Entity",
        nodeClass,
        properties: row,
      };
    }),
    ...touchpoints.map((row) => ({
      id: row.id,
      label: String(row.stance_note || row.episode_ref || "").slice(0, 40),
      type: "Touchpoint",
      nodeClass: "touchpoint",
      properties: {
        ...row,
        affect: parseJson(row.affect_json, null),
      },
    })),
  ];
  return {
    source: "sqlite_all",
    nodes,
    links: [
      ...edges.map((edge) => ({
        id: String(edge.id),
        source: edge.source_id,
        target: edge.target_id,
        type: edge.edge_type,
        properties: { weight: edge.weight },
      })),
      ...facts.map((fact) => ({
        id: fact.id,
        source: fact.from_entity_id,
        target: fact.to_entity_id,
        type: fact.relation,
        properties: {
          description: fact.description,
          confidence: fact.confidence,
          importance: fact.importance,
        },
      })),
      ...touchpoints.map((point) => ({
        id: `thread-${point.id}`,
        source: point.thread_id,
        target: point.id,
        type: "HAS_TOUCHPOINT",
        properties: { grip: point.grip, createdAt: point.created_at },
      })),
    ],
    clusters: {},
  };
}

export function listMemoryThreads(scope: MemoryScope) {
  const db = getDb();
  const threads = db
    .prepare(
      "SELECT * FROM hippocampus_threads WHERE agent_id = ? AND user_id = ? ORDER BY updated_at DESC",
    )
    .all(scope.agentId, scope.userId) as any[];
  return {
    threads: threads.map((row) => {
      const touchpoints = db
        .prepare(
          "SELECT * FROM hippocampus_touchpoints WHERE thread_id = ? ORDER BY created_at ASC",
        )
        .all(row.id) as any[];
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        owner: row.owner,
        current_grip: Number(row.current_grip || 0),
        last_note: row.last_note,
        created_at: row.created_at,
        updated_at: row.updated_at,
        touchpoints: touchpoints.map((point) => ({
          id: point.id,
          thread_id: point.thread_id,
          episode_ref: point.episode_ref,
          grip: Number(point.grip || 0),
          stance_note: point.stance_note,
          affect_json: parseJson(point.affect_json, null),
          created_at: point.created_at,
        })),
      };
    }),
  };
}

export function clearAllMemory(scope: MemoryScope) {
  const db = getDb();
  // Invalidate every in-flight digest/seed task before deleting. A task that
  // started before this call must never write into the fresh memory.
  invalidateMemoryTasks(scope.agentId, scope.userId);
  // Sweep the sqlite-vec shadow rows while the source ids still exist, so the
  // ANN index cannot keep voting for deleted memories (see deleteScopeVecRows).
  deleteScopeVecRows(scope.agentId, scope.userId);
  const tables = [
    "hippocampus_streams",
    "hippocampus_seeds",
    "hippocampus_seed_versions",
    "hippocampus_entities",
    "hippocampus_facts",
    "hippocampus_edges",
    "hippocampus_threads",
    "hippocampus_touchpoints",
    "hippocampus_constraints",
    "hippocampus_appointments",
    "hippocampus_tick_log",
    "hippocampus_self_state",
    "hippocampus_self_state_daily",
    "hippocampus_baselines",
    "hippocampus_affect_points",
    "hippocampus_affect_daily",
    "hippocampus_recall_traces",
    "hippocampus_retrospect_buckets",
    "hippocampus_portraits",
    "digest_state",
    "conversation_anchors",
    // The anchor's usage trigger signal describes the cleared context; a fresh
    // memory must re-measure from the next reported request.
    "chat_usage_state",
    "agent_state_changes",
    "relationship_thread_nodes",
    "relationship_threads",
  ];
  const tx = db.transaction(() => {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table} WHERE agent_id = ? AND user_id = ?`).run(
        scope.agentId,
        scope.userId,
      );
    }
    db.prepare("DELETE FROM proactive_routes WHERE agent_id = ?").run(scope.agentId);
  });
  tx();
  return { status: "ok", message: "Cleared companion memory for agent/user" };
}

// ─── Retrospect / affect / self state ───────────────────────────────────────

export function getBaseline(scope: MemoryScope) {
  return getBaselineItem(scope);
}

export function getAffectTimeline(scope: MemoryScope, limit = 200, granularity = "turn") {
  return readAffectTimeline(scope, limit, granularity);
}

function calendarGranularity(value: string): CalendarGranularity {
  const normalized = String(value || "").trim().toLowerCase();
  if (!["week", "month", "quarter", "year"].includes(normalized)) {
    throw Object.assign(new Error("invalid_granularity"), { code: "invalid_granularity" });
  }
  return normalized as CalendarGranularity;
}

export function listRetrospectBuckets(scope: MemoryScope, granularity: string) {
  return witnessListRetrospectBuckets(scope, calendarGranularity(granularity));
}

export function getRetrospect(scope: MemoryScope, granularity: string, bucketKey?: string) {
  return witnessGetRetrospect(scope, calendarGranularity(granularity), bucketKey ?? null);
}

export async function recomputeRetrospect(scope: MemoryScope, granularity: string, bucketKey?: string) {
  return witnessRecomputeRetrospect(scope, calendarGranularity(granularity), bucketKey ?? null);
}

export function getSelfState(scope: MemoryScope) {
  const derived = deriveSelfState(scope);
  return {
    closeness: derived.closeness,
    closenessTrend: derived.closenessTrend,
    intimacyTier: derived.intimacyTier,
    templateRisk: derived.templateRisk,
    trendState: derived.trendState,
  };
}

export function selfStateHistory(scope: MemoryScope, limit = 200) {
  const rows = getDb()
    .prepare(
      "SELECT * FROM hippocampus_self_state WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(scope.agentId, scope.userId, Math.max(1, Math.min(limit, 1000))) as any[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      turnId: row.turn_id,
      closeness: row.closeness,
      closenessTrend: row.closeness_trend,
      intimacyTier: row.intimacy_tier,
      templateRisk: row.template_risk,
      createdAt: row.created_at,
      granularity: row.granularity,
      sampleCount: row.sample_count,
      period: row.period,
    })),
    total: rows.length,
  };
}

export function getMirror(scope: MemoryScope) {
  return witnessGetMirror(scope);
}

export function listConstraints(scope: MemoryScope) {
  const rows = getDb()
    .prepare(
      "SELECT * FROM hippocampus_constraints WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC",
    )
    .all(scope.agentId, scope.userId) as any[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      ruleType: row.rule_type,
      description: row.description,
      optOutProactive: Boolean(row.opt_out_proactive),
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      evidence: row.evidence,
      segmentRef: row.segment_ref,
      createdAt: row.created_at,
    })),
    total: rows.length,
  };
}

export function deleteConstraint(scope: MemoryScope, id: number) {
  const info = getDb()
    .prepare("DELETE FROM hippocampus_constraints WHERE id = ? AND agent_id = ? AND user_id = ?")
    .run(id, scope.agentId, scope.userId);
  return info.changes > 0;
}

export function listAppointments(scope: MemoryScope) {
  const rows = getDb()
    .prepare(
      "SELECT * FROM hippocampus_appointments WHERE agent_id = ? AND user_id = ? ORDER BY due_at ASC",
    )
    .all(scope.agentId, scope.userId) as any[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      dueAt: row.due_at,
      allDay: Boolean(row.all_day),
      recur: row.recur,
      status: row.status,
      evidence: row.evidence,
      evidenceTurnId: row.evidence_turn_id,
      lastDeliveredAt: row.last_delivered_at,
      // M3 manage_alarm: exact | date_only (NULL reads as exact for legacy rows).
      timeMode: row.time_mode || null,
      eventDate: row.event_date || null,
      createdAt: row.created_at,
    })),
    total: rows.length,
  };
}

// ─── Tick log / turns ───────────────────────────────────────────────────────

export function listTickLog(
  scope: MemoryScope,
  filters: { tickTypes?: string[]; outcomes?: string[]; since?: string; until?: string; limit?: number; offset?: number },
) {
  const clauses = ["agent_id = ?", "user_id = ?"];
  const params: any[] = [scope.agentId, scope.userId];
  if (filters.tickTypes?.length) {
    clauses.push(`tick_type IN (${filters.tickTypes.map(() => "?").join(",")})`);
    params.push(...filters.tickTypes);
  }
  if (filters.outcomes?.length) {
    clauses.push(`outcome IN (${filters.outcomes.map(() => "?").join(",")})`);
    params.push(...filters.outcomes);
  }
  if (filters.since) {
    clauses.push("triggered_at >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    clauses.push("triggered_at <= ?");
    params.push(filters.until);
  }
  const db = getDb();
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM hippocampus_tick_log WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_tick_log WHERE ${clauses.join(" AND ")}
       ORDER BY triggered_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.max(1, Math.min(filters.limit || 100, 500)), Math.max(0, filters.offset || 0)) as any[];
  return { items: rows.map(tickToItem), total: Number(total) };
}

export function clearTickLog(scope: MemoryScope) {
  getDb()
    .prepare("DELETE FROM hippocampus_tick_log WHERE agent_id = ? AND user_id = ?")
    .run(scope.agentId, scope.userId);
  return { status: "ok", message: "Cleared all tick logs successfully" };
}

export function listMemoryTurns(agentId: number, userId: string | null | undefined, start: number, end: number) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE agent_id = ? AND user_id = ? AND id >= ? AND id <= ? AND role = 'assistant'
       ORDER BY id ASC`,
    )
    .all(agentId, normalizeUserId(userId), start, end) as any[];
  return {
    items: rows.map((row) => {
      const user = row.reply_to_message_id
        ? (db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(row.reply_to_message_id) as any)
        : null;
      return {
        id: row.id,
        user_message: user?.content ?? null,
        assistant_message: row.content,
        created_at: row.created_at,
        emotional_analysis: parseJson(row.emotional_analysis, null),
        retrieved_facts: parseJson(row.retrieved_facts, null),
      };
    }),
  };
}

export function getMemoryTurn(agentId: number, userId: string | null | undefined, turnId: number) {
  const result = listMemoryTurns(agentId, userId, turnId, turnId);
  return result.items[0] || null;
}
