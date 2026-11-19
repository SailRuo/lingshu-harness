import { getDb } from "../db/sqlite.js";
import { bufferToVector, cosineSimilarity, embedText } from "./embeddingService.js";
import { createOpenAIClient, getLLMConfig } from "./llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "./thinkingEffort.js";
import { recordCompletionUsage } from "./usageService.js";
import { buildCurrentTimePromptBlock } from "./memoryPromptBlocks.js";
import { recordBackgroundTaskEvent } from "./backgroundTaskEvents.js";
import {
  CHAT_SEED,
  DIGEST_PROMPTS,
  DIGEST_RESPONSE_SCHEMAS,
} from "../contracts/native/index.js";
import type { MemoryScope } from "./memoryScope.js";
import {
  isSeedAutoMutable,
  type SeedApplicability,
  type SeedBody,
  type SeedChangeSummary,
  type SeedTimeScope,
} from "./seedLedgerService.js";
import {
  applySeedReview,
  loadSeedReviewRows,
  validateSeedReview,
  type SeedReviewCandidate,
  type SeedReviewPayload,
  type SeedReviewRow,
  type SeedCandidateRelation,
  type SeedReviewAction,
} from "./seedEvolutionService.js";

/**
 * Desktop M2 port of the APP self-evolution review. Prompt/schema come from
 * the M0 contract mirror; this file only builds context and parses the model
 * response.
 */

const WRITE_FIELD_ANN_LIMIT = 64;
const WRITE_FIELD_RECALL_FLOOR = 0.45;
const WRITE_FIELD_RECALL_TOP_K = 5;
const TRANSCRIPT_RECALL_TOP_K = 5;
const WRITE_FIELD_TIMEOUT_MS = 60_000;
const REVIEW_TIMEOUT_MS = 90_000;

interface ResponseSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export type PersonalitySeedAction =
  | "create"
  | "merge"
  | "reinforce"
  | "revise"
  | "retire"
  | "reactivate"
  | "noop";

export interface PersonalitySeedDigestInput {
  agentId: number;
  userId: string;
  transcript: string;
  roleSetting?: string;
  contextTranscript?: string;
  affectNote?: string;
  sessionId?: number | null;
  turnIds?: number[];
  /** Known facts summary (anti-pollution); defaults to hippocampus_facts. */
  knownFacts?: string;
  /** Existing constraints; defaults to hippocampus_constraints. */
  constraintCandidates?: Array<{ description?: string | null }>;
  /** Stable per-digest-batch key; makes a retried review idempotent. */
  batchKey?: string | null;
  /** Memory task guard: return false after clear/delete and no seed is written. */
  guard?: () => boolean;
}

export interface PersonalitySeedDigestResult {
  action: PersonalitySeedAction;
  reason: string;
  seedId: string | null;
  rawAction?: string;
}

interface DigestWriteField {
  wakeText: string;
  boostText: string;
  suppressText: string;
  evidence: string[];
  wakeEmbedding: number[];
  boostEmbedding: number[];
  suppressEmbedding: number[];
}

interface SeedRow {
  id: string;
  subject: string;
  source: string;
  innate: number;
  revision: number;
  status: string;
  applicability_json: string | null;
  inner_orientation: string;
  outer_expression: string;
  wake_text: string;
  boost_text: string;
  suppress_text: string;
  wake_embedding: Buffer | null;
  tags_json: string | null;
  last_change_action: string | null;
  last_change_base_revision: number | null;
  last_change_new_revision: number | null;
  last_change_reason: string | null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(tag: string, error: unknown, extra: Record<string, unknown> = {}) {
  console.warn(tag, { error: errorMessage(error), ...extra });
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
    throw new Error("invalid_personality_seed_json");
  }
}

async function requestJson(
  system: string,
  human: string,
  timeoutMs: number,
  responseSchema?: ResponseSchemaSpec,
): Promise<any> {
  const cfg = getLLMConfig("memory");
  if (!cfg.model || !cfg.baseUrl) throw new Error("memory_llm_unavailable");
  const client = createOpenAIClient(cfg);
  const messages = [
    { role: "system" as const, content: system },
    { role: "system" as const, content: DIGEST_PROMPTS.JSON_ONLY_SYSTEM },
    { role: "user" as const, content: human },
  ];
  const responseFormat = responseSchema
    ? ({
        type: "json_schema",
        json_schema: {
          name: responseSchema.name,
          // APP schemas are intentionally not strict: several fields are
          // optional and must stay absent rather than forced to null.
          strict: false,
          schema: responseSchema.schema,
        },
      } as any)
    : ({ type: "json_object" } as any);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await createCompletionWithThinkingFallback(
        client,
        {
          model: cfg.model,
          messages,
          temperature: 0.1,
          response_format: responseFormat,
          ...buildThinkingParams(cfg),
        } as any,
        cfg,
        { signal: controller.signal },
      );
      recordCompletionUsage(cfg.model, response, "memory");
    } catch (error) {
      const detail = errorMessage(error);
      const aborted =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError") ||
        /abort/i.test(detail);
      if (aborted) {
        const timeoutError = new Error("llm_timeout");
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }
      if (!/response_format|json_schema|json_object|unsupported/i.test(detail)) throw error;
      // Providers without structured-output support: retry prompt-only.
      response = await createCompletionWithThinkingFallback(
        client,
        { model: cfg.model, messages, temperature: 0.1, ...buildThinkingParams(cfg) } as any,
        cfg,
        { signal: controller.signal },
      );
      recordCompletionUsage(cfg.model, response, "memory");
    }
    return parseJsonBlock(response.choices?.[0]?.message?.content || "");
  } finally {
    clearTimeout(timer);
  }
}

function pickText(source: any, keys: string[]): string {
  if (!source || typeof source !== "object") return "";
  for (const key of keys) {
    const value = source[key];
    if (value != null) {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function normalizePortraitActorTerms(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text
    .replace(/用户/g, "他")
    .replace(/\b(?:assistant|Assistant|AI|ai)\b|智能体|助手/g, "她")
    .trim();
}

function coerceStringArray(value: unknown): string[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function coerceTags(value: unknown): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of coerceStringArray(value)) {
    if (seen.has(item)) continue;
    seen.add(item);
    tags.push(item.slice(0, 24));
    if (tags.length >= 12) break;
  }
  return tags;
}

function filterEvidenceToDigestScope(evidence: string[], transcript: string): string[] {
  const digest = String(transcript || "").trim();
  if (!digest) return [];
  const filtered: string[] = [];
  for (const item of evidence) {
    const text = String(item || "").trim();
    if (!text) continue;
    if (digest.includes(text)) {
      filtered.push(text);
      continue;
    }
    const payload = text.includes("：") ? text.split("：").slice(1).join("：").trim() : text;
    if (payload && digest.includes(payload)) filtered.push(text);
  }
  return filtered;
}

function emptyWriteField(partial: Partial<DigestWriteField> = {}): DigestWriteField {
  return {
    wakeText: partial.wakeText ?? "",
    boostText: partial.boostText ?? "",
    suppressText: partial.suppressText ?? "",
    evidence: partial.evidence ?? [],
    wakeEmbedding: partial.wakeEmbedding ?? [],
    boostEmbedding: partial.boostEmbedding ?? [],
    suppressEmbedding: partial.suppressEmbedding ?? [],
  };
}

function buildDigestTimeAnchor(): string {
  return buildCurrentTimePromptBlock().replace("当前时间：", "本次对话发生于：");
}

function formatConstraintSummary(
  candidates: Array<{ description?: string | null }> | undefined,
): string {
  if (!candidates || !candidates.length) return "";
  return candidates
    .map((item) => String(item?.description || "").trim())
    .filter(Boolean)
    .map((description) => `- ${description}`)
    .join("\n");
}

function readKnownFactsText(scope: MemoryScope): string {
  try {
    const rows = getDb()
      .prepare(
        `SELECT f.relation, f.description, src.name AS source_name, dst.name AS target_name
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
          `- ${row.source_name || "他"} ${row.relation || "相关"} ${row.target_name || ""}${
            row.description ? `：${row.description}` : ""
          }`,
      )
      .join("\n");
  } catch {
    return "";
  }
}

function readConstraintCandidates(scope: MemoryScope): Array<{ description: string }> {
  try {
    return getDb()
      .prepare(
        `SELECT id, rule_type, description FROM hippocampus_constraints
         WHERE agent_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 40`,
      )
      .all(scope.agentId, scope.userId) as Array<{ description: string }>;
  } catch {
    return [];
  }
}

function buildDigestRoleContext(userLabel = "ta", agentLabel = "我"): string {
  const user = (userLabel || "ta").trim() || "ta";
  const agent = (agentLabel || "我").trim() || "我";
  return (
    `对话角色标识：ta 侧发言以「${user}：」开头；我侧发言以「${agent}：」开头。\n` +
    `抽取时 subject="Me" 指 ta（${user}）；subject="Self" 指我（${agent}）。`
  );
}

function formatWriteField(field: DigestWriteField): string {
  const evidence = field.evidence.map((item) => `- ${item}`).join("\n") || "（无）";
  return [
    `唤醒画像：${field.wakeText || "（空）"}`,
    `推高倾向：${field.boostText || "（空）"}`,
    `压低倾向：${field.suppressText || "（空）"}`,
    `证据片段：\n${evidence}`,
  ].join("\n");
}

function applicabilityText(seed: SeedRow): string {
  const applicability = seedApplicability(seed);
  return applicability ? JSON.stringify(applicability) : "不限";
}

function seedApplicability(seed: SeedRow): SeedApplicability | null {
  if (!seed.applicability_json) return null;
  try {
    const parsed = JSON.parse(seed.applicability_json);
    if (!parsed || typeof parsed !== "object") return null;
    const scope = Array.isArray(parsed.scope)
      ? parsed.scope.map(String).filter((item: string) => ["private", "group", "theater"].includes(item))
      : [];
    return scope.length ? { scope: scope as SeedApplicability["scope"] } : null;
  } catch {
    return null;
  }
}

function formatSimilarSeeds(scope: MemoryScope, seeds: SeedRow[]): string {
  if (!seeds.length) return "（当前无相关历史人格种子参与重审）";
  return seeds
    .map((seed) => {
      const autoMutable = isSeedAutoMutable(scope, seed);
      const recent = seed.last_change_action
        ? `v${Number(seed.last_change_base_revision ?? 0)}→v${Number(
            seed.last_change_new_revision ?? 0,
          )} ${seed.last_change_action}${seed.last_change_reason ? ` ${seed.last_change_reason}` : ""}`
        : "（无）";
      return [
        `- id: ${seed.id}`,
        `  版本/状态: ${Number(seed.revision || 0)} / ${seed.status || "active"}`,
        `  适用范围: ${applicabilityText(seed)}`,
        `  自动可修改: ${autoMutable ? "true" : "false"}`,
        `  内在取向: ${seed.inner_orientation}`,
        `  外在显现: ${seed.outer_expression}`,
        `  唤醒画像: ${seed.wake_text}`,
        `  推高倾向: ${seed.boost_text}`,
        `  压低倾向: ${seed.suppress_text}`,
        `  最近变化: ${recent}`,
      ].join("\n");
    })
    .join("\n\n");
}

function appendDigestContextParts(
  humanParts: string[],
  input: { contextTranscript: string; digestTranscript: string; digestLabel: string },
) {
  const context = String(input.contextTranscript || "").trim();
  const digest = String(input.digestTranscript || "").trim();
  humanParts.push(`${input.digestLabel}（场画像与证据片段必须锚定此块）：\n${digest}`);
  if (context) {
    humanParts.push(
      "最近上下文（只读辅助，仅用于理解本段之前延续的未解决张力，不落库）：\n" + context,
    );
  }
}

async function readDigestWriteField(input: {
  transcript: string;
  roleSetting: string;
  contextTranscript: string;
  knownFacts: string;
  constraintCandidates: Array<{ description?: string | null }>;
}): Promise<DigestWriteField> {
  const transcript = String(input.transcript || "").trim();
  if (transcript.length < 2) return emptyWriteField();

  const humanParts = ["# 我是谁\n" + (String(input.roleSetting || "").trim() || "（未配置）")];
  appendDigestContextParts(humanParts, {
    contextTranscript: input.contextTranscript,
    digestTranscript: transcript,
    digestLabel: "本次待写入工作记忆原文",
  });
  const factsBlock = String(input.knownFacts || "").trim();
  if (factsBlock) {
    humanParts.push(`已知事实摘要（防污染，勿当成本段新事实）：\n${factsBlock}`);
  }
  const constraintBlock = formatConstraintSummary(input.constraintCandidates);
  if (constraintBlock) {
    humanParts.push(`已有约束摘要：\n${constraintBlock}`);
  }

  let parsed: any;
  try {
    parsed = await requestJson(
      DIGEST_PROMPTS.WRITE_FIELD,
      humanParts.join("\n\n"),
      WRITE_FIELD_TIMEOUT_MS,
      DIGEST_RESPONSE_SCHEMAS.WRITE_FIELD,
    );
  } catch (error) {
    warn("[PERSONALITY_SEED_WRITE_FIELD_LLM_FAILED]", error, {
      transcriptChars: transcript.length,
      contextChars: String(input.contextTranscript || "").length,
    });
    return emptyWriteField();
  }

  const wakeText = normalizePortraitActorTerms(
    pickText(parsed, ["唤醒画像", "wakePortrait", "wakeText", "wake_text"]),
  );
  const boostText = normalizePortraitActorTerms(
    pickText(parsed, ["推高倾向", "boostTendency", "boostText", "boost_text"]),
  );
  const suppressText = normalizePortraitActorTerms(
    pickText(parsed, ["压低倾向", "suppressTendency", "suppressText", "suppress_text"]),
  );
  const evidence = filterEvidenceToDigestScope(
    coerceStringArray(parsed?.["证据片段"] ?? parsed?.evidence),
    transcript,
  );
  if (!wakeText || !boostText || !suppressText) {
    return emptyWriteField({ wakeText, boostText, suppressText, evidence });
  }

  try {
    const [wake, boost, suppress] = await Promise.all([
      embedText(wakeText, { wait: true }),
      embedText(boostText, { wait: true }),
      embedText(suppressText, { wait: true }),
    ]);
    return {
      wakeText,
      boostText,
      suppressText,
      evidence,
      wakeEmbedding: wake.vector,
      boostEmbedding: boost.vector,
      suppressEmbedding: suppress.vector,
    };
  } catch (error) {
    warn("[PERSONALITY_SEED_WRITE_FIELD_EMBED_FAILED]", error);
    return emptyWriteField({ wakeText, boostText, suppressText, evidence });
  }
}

function loadSeedRows(scope: MemoryScope): SeedRow[] {
  // Deliberately no status filter: retired seeds still participate in recall
  // for duplicate/接棒 context. Lifecycle/scope filtering happens in policy.
  return getDb()
    .prepare(
      `SELECT s.*,
        (SELECT c.action FROM agent_state_changes c
          WHERE c.agent_id = s.agent_id AND c.user_id = s.user_id
            AND c.target_kind = 'seed' AND c.target_id = s.id
          ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS last_change_action,
        (SELECT c.base_revision FROM agent_state_changes c
          WHERE c.agent_id = s.agent_id AND c.user_id = s.user_id
            AND c.target_kind = 'seed' AND c.target_id = s.id
          ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS last_change_base_revision,
        (SELECT c.new_revision FROM agent_state_changes c
          WHERE c.agent_id = s.agent_id AND c.user_id = s.user_id
            AND c.target_kind = 'seed' AND c.target_id = s.id
          ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS last_change_new_revision,
        (SELECT c.reason FROM agent_state_changes c
          WHERE c.agent_id = s.agent_id AND c.user_id = s.user_id
            AND c.target_kind = 'seed' AND c.target_id = s.id
          ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS last_change_reason
       FROM hippocampus_seeds s
       WHERE s.agent_id = ? AND s.user_id = ? AND s.subject = 'about_self'
       ORDER BY s.updated_at DESC LIMIT 500`,
    )
    .all(scope.agentId, scope.userId) as SeedRow[];
}

async function recallSimilarSeeds(
  scope: MemoryScope,
  field: DigestWriteField,
  transcript: string,
): Promise<SeedRow[]> {
  const rows = loadSeedRows(scope);
  const hasWakeVector = field.wakeEmbedding.some((value) => value !== 0);
  if (hasWakeVector) {
    const scored = rows
      .map((seed) => {
        const embedding = bufferToVector(seed.wake_embedding);
        if (!embedding.length) return null;
        return { seed, score: cosineSimilarity(field.wakeEmbedding, embedding) };
      })
      .filter(
        (item): item is { seed: SeedRow; score: number } =>
          item !== null && item.score >= WRITE_FIELD_RECALL_FLOOR,
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(WRITE_FIELD_RECALL_TOP_K, CHAT_SEED.CANDIDATE_POOL_SIZE));
    if (scored.length) return scored.map((item) => item.seed);
  }

  const text = String(transcript || "").trim();
  if (text.length < 2) return [];
  const { vector } = await embedText(text.slice(0, 4000), { wait: true });
  if (!vector.length) return [];
  return rows
    .map((seed) => {
      const embedding = bufferToVector(seed.wake_embedding);
      if (!embedding.length) return null;
      return { seed, score: cosineSimilarity(vector, embedding) };
    })
    .filter((item): item is { seed: SeedRow; score: number } => item !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(TRANSCRIPT_RECALL_TOP_K, CHAT_SEED.CANDIDATE_POOL_SIZE))
    .map((item) => item.seed);
}

function normalizeAction(value: unknown): SeedReviewAction | null {
  const action = String(value || "").trim().toLowerCase();
  if (action === "create") return "new";
  if (["new", "merge", "reinforce", "revise", "noop", "retire", "reactivate"].includes(action)) {
    return action as SeedReviewAction;
  }
  return null;
}

function parseSeedBody(value: any): SeedBody | null {
  if (!value || typeof value !== "object") return null;
  return {
    innerOrientation: pickText(value, ["内在取向", "innerOrientation", "inner_orientation"]),
    outerExpression: pickText(value, ["外在显现", "outerExpression", "outer_expression"]),
    wakeText: normalizePortraitActorTerms(
      pickText(value, ["唤醒画像", "wakePortrait", "wakeText", "wake_text"]),
    ),
    boostText: normalizePortraitActorTerms(
      pickText(value, ["推高倾向", "boostTendency", "boostText", "boost_text"]),
    ),
    suppressText: normalizePortraitActorTerms(
      pickText(value, ["压低倾向", "suppressTendency", "suppressText", "suppress_text"]),
    ),
    tags: coerceTags(value?.["标签"] ?? value?.tags),
  };
}

function parseCandidateRelations(value: any): SeedCandidateRelation[] {
  if (!Array.isArray(value)) return [];
  const result: SeedCandidateRelation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const relation = String(item.relation || "").trim() as SeedCandidateRelation["relation"];
    if (!["duplicate", "refine", "independent", "unclear"].includes(relation)) continue;
    result.push({
      seedId: String(item.seed_id ?? item.seedId ?? "").trim(),
      relation,
      basis: String(item.basis || "").trim(),
      evidenceRefs: coerceStringArray(item.evidence_refs ?? item.evidenceRefs),
    });
  }
  return result;
}

function parseChangeSummary(value: any): SeedChangeSummary | null {
  if (!value || typeof value !== "object") return null;
  const from = String(value.from || "").trim();
  const to = String(value.to || "").trim();
  if (!from && !to) return null;
  const boundary = String(value.boundary || "").trim();
  return boundary ? { from, to, boundary } : { from, to };
}

function parseTimeScope(value: any): SeedTimeScope | null {
  if (!value || typeof value !== "object") return null;
  const description = String(value.description || "").trim();
  const refs = coerceStringArray(value.refs);
  if (!description) return null;
  return { description, refs };
}

function toCandidateView(scope: MemoryScope, seed: SeedRow): SeedReviewCandidate {
  return {
    id: seed.id,
    revision: Number(seed.revision || 0),
    status: String(seed.status || "active"),
    applicability: seedApplicability(seed),
    autoMutable: isSeedAutoMutable(scope, seed),
    innerOrientation: String(seed.inner_orientation || ""),
    outerExpression: String(seed.outer_expression || ""),
    wakeText: String(seed.wake_text || ""),
    boostText: String(seed.boost_text || ""),
    suppressText: String(seed.suppress_text || ""),
  };
}

async function runReviewLlm(input: {
  scope: MemoryScope;
  transcript: string;
  roleSetting: string;
  contextTranscript: string;
  affectNote: string;
  writeField: DigestWriteField;
  similarSeeds: SeedRow[];
}): Promise<SeedReviewPayload> {
  const humanParts = [
    buildDigestTimeAnchor(),
    buildDigestRoleContext("ta", "我"),
    "# 我是谁（身份根与初始自我背景）\n" + (String(input.roleSetting || "").trim() || "（未配置）"),
    "本段写入场画像（这段经历在她心里被理解成什么场；不落库，不直接写成种子）：\n" +
      formatWriteField(input.writeField),
    "相关历史人格种子（当前参与重审的既有自我倾向；不是查重列表）：\n" +
      formatSimilarSeeds(input.scope, input.similarSeeds),
  ];
  if (String(input.affectNote || "").trim()) {
    humanParts.push(`本段情绪读数摘要：\n${String(input.affectNote).trim()}`);
  }
  appendDigestContextParts(humanParts, {
    contextTranscript: input.contextTranscript,
    digestTranscript: input.transcript,
    digestLabel: "工作记忆原文（触发本次重审的原始经历）",
  });

  const parsed = await requestJson(
    DIGEST_PROMPTS.SELF_EVOLUTION,
    humanParts.join("\n\n"),
    REVIEW_TIMEOUT_MS,
    DIGEST_RESPONSE_SCHEMAS.SEED_REVIEW,
  );
  const action = normalizeAction(parsed?.action);
  if (!action) {
    return {
      action: "noop",
      targetSeedId: null,
      supersedesSeedId: null,
      reason: "invalid_action",
      body: null,
      candidateRelations: [],
      changeSummary: null,
      timeScope: null,
      evidenceRefs: [],
      rawAction: String(parsed?.action || ""),
    };
  }
  const body = action === "noop" ? null : parseSeedBody(parsed?.seed);
  return {
    action,
    targetSeedId: String(parsed?.target_seed_id ?? parsed?.targetSeedId ?? "").trim() || null,
    supersedesSeedId:
      String(parsed?.supersedes_seed_id ?? parsed?.supersedesSeedId ?? "").trim() || null,
    reason: String(parsed?.reason || "").trim(),
    body,
    candidateRelations: parseCandidateRelations(parsed?.candidate_relations ?? parsed?.candidateRelations),
    changeSummary: parseChangeSummary(parsed?.change_summary ?? parsed?.changeSummary),
    timeScope: parseTimeScope(parsed?.time_scope ?? parsed?.timeScope),
    evidenceRefs: coerceStringArray(parsed?.evidence_refs ?? parsed?.evidenceRefs),
    rawAction: String(parsed?.action || ""),
  };
}

export async function runPersonalitySeedDigest(
  input: PersonalitySeedDigestInput,
): Promise<PersonalitySeedDigestResult> {
  if (input.guard && !input.guard()) {
    return { action: "noop", reason: "stale", seedId: null };
  }
  const transcript = String(input.transcript || "").trim();
  if (transcript.length < 2) {
    return { action: "noop", reason: "对话过短", seedId: null };
  }
  const scope: MemoryScope = { agentId: input.agentId, userId: input.userId };
  const roleSetting = String(input.roleSetting || "").trim();
  const contextTranscript = String(input.contextTranscript || "").trim();
  const knownFacts = String(input.knownFacts ?? "").trim() || readKnownFactsText(scope);
  const constraintCandidates = input.constraintCandidates ?? readConstraintCandidates(scope);
  const rows: SeedReviewRow[] = loadSeedReviewRows(scope, input.turnIds || []);

  let writeField = emptyWriteField();
  try {
    writeField = await readDigestWriteField({
      transcript,
      roleSetting,
      contextTranscript,
      knownFacts,
      constraintCandidates,
    });
  } catch (error) {
    warn("[PERSONALITY_SEED_WRITE_FIELD_FAILED]", error);
  }

  let similarSeeds: SeedRow[] = [];
  try {
    similarSeeds = await recallSimilarSeeds(scope, writeField, transcript);
  } catch (error) {
    warn("[PERSONALITY_SEED_RECALL_FAILED]", error);
  }

  try {
    const review = await runReviewLlm({
      scope,
      transcript,
      roleSetting,
      contextTranscript,
      affectNote: String(input.affectNote || ""),
      writeField,
      similarSeeds,
    });
    const candidates = similarSeeds.map((seed) => toCandidateView(scope, seed));
    const validation = validateSeedReview({ review, candidates, rows });
    if (!validation.ok) {
      recordBackgroundTaskEvent({
        eventType: "seed_review",
        subjectType: "agent",
        subjectId: String(scope.agentId),
        status: "skipped",
        detail: `${validation.reason}:candidates=${candidates.length}`,
      });
      return { action: "noop", reason: validation.reason, seedId: null, rawAction: review.rawAction };
    }
    const result = await applySeedReview(scope, validation.decision, {
      rows,
      batchKey: input.batchKey ?? null,
      guard: input.guard,
    });
    recordBackgroundTaskEvent({
      eventType: "seed_review",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: result.action === "noop" ? "skipped" : "succeeded",
      detail:
        result.action === "noop"
          ? `${result.reason}:candidates=${candidates.length}`
          : `${validation.decision.action}:${result.seedId || ""}`,
    });
    return {
      action: result.action,
      reason: result.reason,
      seedId: result.seedId,
      rawAction: review.rawAction,
    };
  } catch (error) {
    const reason = `llm_failed:${errorName(error)}`;
    warn("[PERSONALITY_SEED_REVIEW_FAILED]", error, {
      agentId: scope.agentId,
      userId: scope.userId,
      transcriptChars: transcript.length,
      contextChars: contextTranscript.length,
    });
    recordBackgroundTaskEvent({
      eventType: "seed_review",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "failed",
      detail: reason.slice(0, 200),
    });
    return { action: "noop", reason, seedId: null };
  }
}
