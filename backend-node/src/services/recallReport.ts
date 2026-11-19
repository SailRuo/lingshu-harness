/**
 * Recall observability helpers.
 *
 * Port of the Python trio that the Node backend was missing:
 * - core/memory/audit.py            → flow / decision / result / log_layer classification
 * - core/memory/echoes.py           → memory echo snapshot + per-session broadcast
 * - core/memory_v3/recall_trace_format.py → human readable report + JSON record
 *
 * This module is intentionally dependency free (no DB, no ONNX, no Fastify) so it
 * can be reused by the routes, the services and the tests without side effects.
 */

import { randomUUID } from "node:crypto";

export type RecallLogLayer = "business" | "program";
export type RecallAuditResult =
  | "success"
  | "empty"
  | "skipped"
  | "failed"
  | "timeout"
  | "running";

export interface RecallAuditClassification {
  /** Business flow the event belongs to (recall / write / ...). */
  flow: string;
  /** Human readable explanation of what the pipeline decided. */
  decision: string;
  /** Outcome of the step. */
  result: RecallAuditResult;
  /** Whether the log line is a business decision or a program milestone. */
  log_layer: RecallLogLayer;
  /** Alias kept for parity with the Python `data.memory_log_layer` field. */
  memory_log_layer: RecallLogLayer;
}

export interface RecallCandidateView {
  id: string;
  narrative: string;
  about: string;
  type: string;
  similarity: number;
  selected: boolean;
  kind: string;
  reason: string;
}

export interface RecallSummary {
  /** ANN candidate pool size. */
  candidateCount: number;
  /** Number of audited candidates (direct/akin/related). */
  auditedCount: number;
  /** Memories that made it into the prompt. */
  selectedCount: number;
  /** Audited candidates that were thrown away. */
  droppedCount: number;
  /** Dropped because the similarity was under the floor. */
  droppedByFloor: number;
  /** Dropped because the per-turn quota was already full. */
  droppedByLimit: number;
  /** Dropped for other reasons. */
  droppedByOther: number;
  topSimilarity: number;
  avgSimilarity: number;
  channels: string[];
  empty: boolean;
}

export interface RecallReportOptions {
  agentId?: number;
  userId?: string;
  sessionKey?: string;
  turnId?: number | string;
  timestamp?: string;
}

export interface RecallJsonRecord extends Record<string, unknown> {
  ts: string;
  schemaVersion: string;
  event: string;
  flow: string;
  decision: string;
  result: string;
  log_layer: string;
  sessionId: string;
  turnId: string;
  summary: RecallSummary;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function clampText(value: unknown, max = 220): string {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** Session key used by the recall event stream (agent + user scope). */
export function recallSessionKey(agentId: number, userId?: string | null): string {
  return `${asNumber(agentId)}:${String(userId ?? "default_user")}`;
}

// ─── Audit classification (core/memory/audit.py) ─────────────────────────────

const GENERIC_AUDIT_DECISIONS = new Set([
  "执行记忆召回步骤",
  "执行记忆写入步骤",
  "记录链路状态",
  "根据反思结果决定是否写入长期记忆",
  "完成本轮写入汇总",
  "幂等检查决定跳过",
]);

export function auditFlowForPhase(phase: string, data: Record<string, any> = {}): string {
  const explicit = String(data.flow || "").trim();
  if (explicit) return explicit;
  const normalized = String(phase || "").trim().toLowerCase();
  if (["retrieve", "embedding", "recall"].includes(normalized)) return "recall";
  if (["capture", "persist", "write"].includes(normalized)) return "write";
  return normalized || "unknown";
}

export function auditDecisionForEvent(
  phase: string,
  step: string,
  data: Record<string, any> = {},
): string {
  const explicit = String(data.decision || "").trim();
  if (explicit) return explicit;
  const normalized = String(step || "").trim().toLowerCase();
  if (normalized.includes("rerank_done")) return "按相关性和记忆需求重排并选择上下文";
  if (normalized.includes("understanding_done")) return "根据查询理解选择记忆类型和过滤策略";
  if (normalized.includes("persistent_store_missing")) return "跳过持久化召回，使用图谱结果";
  if (normalized.includes("reflect_done")) return "根据反思结果决定是否写入长期记忆";
  if (normalized.includes("upsert_candidate")) return "候选通过治理后写入持久存储";
  if (normalized.includes("persist_done")) return "完成本轮写入汇总";
  if (normalized.includes("skip")) return "幂等检查决定跳过";
  const normalizedPhase = String(phase || "").trim().toLowerCase();
  if (normalizedPhase === "retrieve" || normalizedPhase === "recall") {
    return "按相关性和记忆需求重排并选择上下文";
  }
  if (normalizedPhase === "capture" || normalizedPhase === "write") return "执行记忆写入步骤";
  return "记录链路状态";
}

export function auditResultForEvent(
  level: string,
  step: string,
  data: Record<string, any> = {},
): RecallAuditResult {
  const explicit = String(data.result || "").trim();
  if (explicit) return explicit as RecallAuditResult;
  const normalized = String(step || "").trim().toLowerCase();
  if (String(level || "").toLowerCase() === "error" || normalized.includes("failed")) return "failed";
  if (normalized.includes("timeout")) return "timeout";
  if (data.empty === true) return "empty";
  if (
    normalized.endsWith("done") ||
    normalized.endsWith("complete") ||
    normalized.endsWith("completed") ||
    ["queued", "persist_done", "mark_processed"].includes(normalized)
  ) {
    return "success";
  }
  if (normalized.startsWith("skip") || normalized.startsWith("background_skip")) return "skipped";
  return "running";
}

export function auditLogLayer(
  phase: string,
  step: string,
  data: Record<string, any> = {},
): RecallLogLayer {
  const explicit = String(data.memory_log_layer || data.log_layer || "").trim().toLowerCase();
  if (explicit === "business" || explicit === "program") return explicit;
  const normalized = String(step || "").trim().toLowerCase();
  if (
    normalized.endsWith("_start") ||
    ["mark_processed", "queued", "graph_channel_start", "understanding_start", "capture_accepted"].includes(
      normalized,
    )
  ) {
    return "program";
  }
  const explicitDecision = String(data.decision || "").trim();
  const genericDecision = auditDecisionForEvent(phase, step, data);
  const decision = explicitDecision || genericDecision;
  if (GENERIC_AUDIT_DECISIONS.has(decision)) return "program";
  if (explicitDecision && explicitDecision !== genericDecision) return "business";
  if (hasCjk(decision)) return "business";
  return "program";
}

/**
 * Classify a recall payload into the four audit dimensions used by the Python
 * memory audit broker.
 */
export function classifyRecallAudit(
  payload: Record<string, any> = {},
  context: { phase?: string; step?: string; level?: string } = {},
): RecallAuditClassification {
  const data = asRecord(payload);
  const phase = context.phase || "retrieve";
  const step = context.step || "recall_done";
  const level = context.level || "info";
  const flow = auditFlowForPhase(phase, data);
  const decision = auditDecisionForEvent(phase, step, data);
  const selectedCount = asNumber(
    data.selectedCount ?? data.count ?? asRecord(data.streamRecall).selectedCount,
    0,
  );
  const effectiveEmpty = data.empty === true || selectedCount === 0;
  const result = auditResultForEvent(level, step, { ...data, empty: effectiveEmpty });
  const logLayer = auditLogLayer(phase, step, data);
  return {
    flow,
    decision,
    result,
    log_layer: logLayer,
    memory_log_layer: logLayer,
  };
}

// ─── Payload readers ─────────────────────────────────────────────────────────

export function recallCandidates(payload: Record<string, any> = {}): RecallCandidateView[] {
  const source = asRecord(payload.streamRecall).candidates ?? payload.candidates ?? [];
  if (!Array.isArray(source)) return [];
  return source
    .map((item: any) => {
      const entry = asRecord(item);
      return {
        id: String(entry.id ?? ""),
        narrative: String(entry.narrative ?? ""),
        about: String(entry.about ?? ""),
        type: String(entry.type ?? "external"),
        similarity: asNumber(entry.similarity, 0),
        selected: Boolean(entry.selected),
        kind: String(entry.kind ?? ""),
        reason: String(entry.reason ?? ""),
      };
    })
    .filter((item) => item.id || item.narrative);
}

export function recallSelectedCandidates(
  payload: Record<string, any> = {},
): RecallCandidateView[] {
  const candidates = recallCandidates(payload);
  if (candidates.length) return candidates.filter((item) => item.selected);
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  return streams.map((item: any) => {
    const entry = asRecord(item);
    return {
      id: String(entry.id ?? ""),
      narrative: String(entry.narrative ?? ""),
      about: String(entry.about ?? ""),
      type: String(entry.type ?? "external"),
      similarity: asNumber(entry.similarity, 0),
      selected: true,
      kind: String(entry.recallKind ?? ""),
      reason: "",
    };
  });
}

export function recallDroppedCandidates(
  payload: Record<string, any> = {},
): RecallCandidateView[] {
  const dropped = Array.isArray(payload.droppedCandidates)
    ? payload.droppedCandidates
    : recallCandidates(payload).filter((item) => !item.selected);
  return dropped.map((item: any) => {
    const entry = asRecord(item);
    return {
      id: String(entry.id ?? ""),
      narrative: String(entry.narrative ?? ""),
      about: String(entry.about ?? ""),
      type: String(entry.type ?? "external"),
      similarity: asNumber(entry.similarity, 0),
      selected: false,
      kind: String(entry.kind ?? ""),
      reason: String(entry.reason ?? ""),
    };
  });
}

export function recallDropReasonText(reason: string): string {
  switch (reason) {
    case "below_floor":
      return "相似度低于阈值";
    case "limit":
      return "超出本轮名额";
    case "not_selected":
      return "未通过本轮筛选";
    case "deduped":
      return "与已选记忆重复";
    default:
      return reason ? clampText(reason, 40) : "其它原因";
  }
}

export function buildRecallSummary(payload: Record<string, any> = {}): RecallSummary {
  const selected = recallSelectedCandidates(payload);
  const dropped = recallDroppedCandidates(payload);
  const candidates = recallCandidates(payload);
  const similarities = selected.map((item) => item.similarity).filter((value) => value > 0);
  const top = similarities.length ? Math.max(...similarities) : 0;
  const average = similarities.length
    ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length
    : 0;
  const channels = [...new Set(candidates.map((item) => item.kind).filter(Boolean))];
  const selectedCount = asNumber(
    payload.selectedCount ?? payload.count ?? asRecord(payload.streamRecall).selectedCount,
    selected.length,
  );
  return {
    candidateCount: asNumber(
      payload.candidateCount ?? asRecord(payload.streamRecall).annCount,
      candidates.length,
    ),
    auditedCount: candidates.length,
    selectedCount,
    droppedCount: dropped.length,
    droppedByFloor: dropped.filter((item) => item.reason === "below_floor").length,
    droppedByLimit: dropped.filter((item) => item.reason === "limit").length,
    droppedByOther: dropped.filter(
      (item) => item.reason !== "below_floor" && item.reason !== "limit",
    ).length,
    topSimilarity: Number(top.toFixed(4)),
    avgSimilarity: Number(average.toFixed(4)),
    channels,
    empty: selectedCount === 0,
  };
}

function recallQueries(payload: Record<string, any> = {}): { role: string; text: string }[] {
  const source = asRecord(payload.streamRecall).queries ?? payload.queries ?? [];
  if (!Array.isArray(source)) return [];
  return source
    .map((item: any) => {
      const entry = asRecord(item);
      return { role: String(entry.role ?? "user"), text: String(entry.text ?? "") };
    })
    .filter((item) => item.text.trim().length > 0);
}

function dropSummaryText(summary: RecallSummary): string {
  if (!summary.droppedCount) return "";
  const parts: string[] = [];
  if (summary.droppedByFloor) parts.push(`${summary.droppedByFloor} 件因为相似度低于阈值`);
  if (summary.droppedByLimit) parts.push(`${summary.droppedByLimit} 件因为超出本轮名额`);
  const other = summary.droppedByOther;
  if (other) parts.push(`${other} 件因为其它原因`);
  return `（${parts.join("，")}）`;
}

// ─── Human readable report (core/memory_v3/recall_trace_format.py) ───────────

export function buildHumanReport(
  payload: Record<string, any> = {},
  options: RecallReportOptions = {},
): string {
  const data = asRecord(payload);
  const summary = buildRecallSummary(data);
  const selected = recallSelectedCandidates(data);
  const dropped = recallDroppedCandidates(data);
  const queries = recallQueries(data);
  const audit = classifyRecallAudit(data);
  const timestamp = options.timestamp || data.createdAt || new Date().toISOString();
  const sessionKey =
    options.sessionKey || data.sessionKey || recallSessionKey(options.agentId ?? data.agentId ?? 0, options.userId ?? data.userId);
  const turnId = String(options.turnId ?? data.turnId ?? "");
  const query = String(data.query ?? "").trim();
  const seeds = Array.isArray(data.seeds) ? data.seeds : [];
  const facts = Array.isArray(data.facts) ? data.facts : [];
  const constraints = Array.isArray(data.constraints) ? data.constraints : [];

  const lines: string[] = [];
  lines.push("=".repeat(68));
  lines.push(
    `【记忆召回审计】${timestamp} · turn=${turnId || "（未知）"} · session=${sessionKey}`,
  );
  lines.push("-".repeat(68));
  lines.push("【本轮问题】");
  lines.push(query ? clampText(query, 400) : "（空）");
  lines.push("-".repeat(68));
  lines.push("【召回结论】");
  if (summary.empty) {
    lines.push("这轮没有想起任何事；记忆库里没有与刚才这个问题相关的记录。");
  } else {
    const dropped = summary.droppedCount
      ? `；另有 ${summary.droppedCount} 件候选被丢掉${dropSummaryText(summary)}`
      : "；没有候选被丢掉";
    lines.push(
      `这轮从 ${summary.candidateCount} 条候选里想起了 ${summary.selectedCount} 件事，` +
        `其中 ${summary.selectedCount} 件与刚才的问题相关${dropped}。`,
    );
    lines.push(
      `最高相似度 ${summary.topSimilarity.toFixed(2)}，平均 ${summary.avgSimilarity.toFixed(2)}` +
        `${summary.channels.length ? `；召回通道：${summary.channels.join("、")}` : ""}。`,
    );
  }
  if (!summary.empty) {
    lines.push("-".repeat(68));
    lines.push(`【想起的 ${summary.selectedCount} 件事】`);
    selected.forEach((item, index) => {
      lines.push(
        `${index + 1}. [${item.kind || "direct"}] 相似度 ${item.similarity.toFixed(2)}` +
          `${item.about ? ` · 关于「${clampText(item.about, 40)}」` : ""}`,
      );
      if (item.narrative) lines.push(`   ${clampText(item.narrative, 160)}`);
    });
  }
  if (dropped.length) {
    lines.push("-".repeat(68));
    lines.push(`【被丢掉的候选（显示前 ${Math.min(5, dropped.length)} / ${dropped.length} 条）】`);
    dropped.slice(0, 5).forEach((item, index) => {
      lines.push(
        `${index + 1}. [${item.kind || "direct"}] 相似度 ${item.similarity.toFixed(2)}` +
          ` · 原因：${recallDropReasonText(item.reason)}` +
          `${item.about ? ` · 关于「${clampText(item.about, 40)}」` : ""}`,
      );
    });
  }
  lines.push("-".repeat(68));
  lines.push("【用了哪些问题去匹配】");
  if (queries.length) {
    for (const item of queries) {
      lines.push(`- ${item.role === "assistant" ? "助手" : "用户"}：${clampText(item.text, 120)}`);
    }
  } else {
    lines.push("- （只有当前这一句）");
  }
  lines.push("-".repeat(68));
  lines.push("【其它上下文】");
  lines.push(
    `人格种子 ${seeds.length} 个 · 事实 ${facts.length} 条 · 约束 ${constraints.length} 条`,
  );
  lines.push("-".repeat(68));
  lines.push("【审计分类】");
  lines.push(
    `flow=${audit.flow} · decision=${audit.decision} · result=${audit.result} · log_layer=${audit.log_layer}`,
  );
  lines.push("=".repeat(68));
  return lines.join("\n");
}

// ─── Structured JSON record (core/memory_v3/recall_trace_format.py) ──────────

export function buildJsonRecord(
  payload: Record<string, any> = {},
  options: RecallReportOptions = {},
): RecallJsonRecord {
  const data = asRecord(payload);
  const summary = buildRecallSummary(data);
  const audit = classifyRecallAudit(data);
  const timestamp = options.timestamp || data.createdAt || new Date().toISOString();
  const sessionKey =
    options.sessionKey ||
    data.sessionKey ||
    recallSessionKey(options.agentId ?? data.agentId ?? 0, options.userId ?? data.userId);
  const turnId = String(options.turnId ?? data.turnId ?? "");
  const selected = recallSelectedCandidates(data);
  const dropped = recallDroppedCandidates(data);

  return {
    ts: timestamp,
    schemaVersion: "node-memory-recall-v1",
    event: "memory_recall",
    traceId: turnId ? `turn-${turnId}` : "",
    sessionId: sessionKey,
    turnId,
    agentId: asNumber(options.agentId ?? data.agentId, 0),
    userId: String(options.userId ?? data.userId ?? "default_user"),
    route: "memory-recall",
    flow: audit.flow,
    decision: audit.decision,
    result: audit.result,
    log_layer: audit.log_layer,
    memory_log_layer: audit.memory_log_layer,
    query: String(data.query ?? ""),
    queries: recallQueries(data),
    summary,
    selected: selected.map((item) => ({
      id: item.id,
      about: item.about,
      type: item.type,
      narrative: item.narrative,
      similarity: item.similarity,
      kind: item.kind,
      reason: item.reason,
    })),
    dropped: dropped.map((item) => ({
      id: item.id,
      about: item.about,
      type: item.type,
      narrative: item.narrative,
      similarity: item.similarity,
      kind: item.kind,
      reason: item.reason,
      reasonText: recallDropReasonText(item.reason),
    })),
    seeds: Array.isArray(data.seeds) ? data.seeds : [],
    facts: Array.isArray(data.facts) ? data.facts : [],
    constraints: Array.isArray(data.constraints) ? data.constraints : [],
    memoryFacts: Array.isArray(data.memoryFacts) ? data.memoryFacts : [],
    snippets: Array.isArray(data.snippets) ? data.snippets : [],
    personaActivation: asRecord(data.personaActivation),
    promptInjection: asRecord(data.promptInjection),
    selfState: asRecord(data.selfState),
    empty: summary.empty,
  };
}

// ─── Memory echo snapshot (core/memory/echoes.py) ────────────────────────────

export interface MemoryEchoSnapshot extends Record<string, unknown> {
  event: "memory_echo";
  sessionId: string;
  turnId: string;
  query: string;
  count: number;
  empty: boolean;
  candidateCount: number;
  selectedCount: number;
  droppedCandidates: unknown[];
  channels: string[];
  snippets: Record<string, unknown>[];
  intent: Record<string, unknown>;
  relationshipGuidance: Record<string, unknown>;
  timestamp: string;
}

export function buildMemoryEchoSnapshot(
  payload: Record<string, any> = {},
  options: RecallReportOptions = {},
): MemoryEchoSnapshot {
  const data = asRecord(payload);
  const summary = buildRecallSummary(data);
  const selected = recallSelectedCandidates(data);
  const dropped = recallDroppedCandidates(data);
  const queries = recallQueries(data);
  const timestamp = options.timestamp || data.createdAt || new Date().toISOString();
  const sessionKey =
    options.sessionKey ||
    data.sessionKey ||
    recallSessionKey(options.agentId ?? data.agentId ?? 0, options.userId ?? data.userId);
  const turnId = String(options.turnId ?? data.turnId ?? "");
  const intent = asRecord(data.intent);
  const relationshipGuidance = asRecord(data.relationshipGuidance);
  return {
    event: "memory_echo",
    userId: String(options.userId ?? data.userId ?? "default_user"),
    sessionId: sessionKey,
    turnId,
    query: String(data.query ?? ""),
    mode: String(data.mode ?? "chat"),
    route: String(data.route ?? "memory-recall"),
    source: String(data.source ?? "vector"),
    traceId: turnId ? `turn-${turnId}` : "",
    confidence: asNumber(data.confidence, 0),
    latencyMs: asNumber(data.latencyMs, 0),
    needsClarification: Boolean(data.needsClarification),
    intent: {
      preferredMemoryTypes: intent.preferredMemoryTypes ?? [],
      allowedMemoryTypes: intent.allowedMemoryTypes ?? [],
      strictMemoryFilter: Boolean(intent.strictMemoryFilter),
      includeArchived: Boolean(intent.includeArchived),
      needsHistoryBias: Boolean(intent.needsHistoryBias),
      needsQuoteBias: Boolean(intent.needsQuoteBias),
      needsContradictionBias: Boolean(intent.needsContradictionBias),
    },
    memoryNeed: asRecord(data.memoryNeed),
    preReplyAnalysis: asRecord(data.preReplyAnalysis),
    queryUnderstandingMode: data.queryUnderstandingMode ?? null,
    queryUnderstandingFallbackUsed: Boolean(data.queryUnderstandingFallbackUsed),
    rerankMode: data.rerankMode ?? null,
    channels: summary.channels,
    candidateCount: summary.candidateCount,
    selectedCount: summary.selectedCount,
    droppedCandidates: dropped,
    snippets: selected.map((item) => ({
      id: item.id,
      text: item.narrative,
      source: item.type,
      confidence: item.similarity,
      importance: 0,
      memoryType: item.type,
      score: item.similarity,
      rank: selected.indexOf(item) + 1,
      channel: item.kind,
      scoreBreakdown: {},
      matchedKeywords: [],
      matchedEntities: [],
      selectionReason: item.reason || "selected",
    })),
    count: selected.length,
    empty: summary.empty,
    relationshipGuidance: {
      phase: relationshipGuidance.phase ?? null,
      phaseName: relationshipGuidance.phaseName ?? null,
      applied: Boolean(relationshipGuidance.applied),
      reason: relationshipGuidance.reason ?? null,
      prompt: relationshipGuidance.prompt ?? null,
      state: relationshipGuidance.state ?? null,
    },
    queries,
    timestamp,
  };
}

// ─── Recall event broker (core/memory/audit.py + echoes.py) ──────────────────

export interface RecallEvent {
  id: string;
  event: "memory_recall";
  sessionId: string;
  agentId: number;
  userId: string;
  turnId: string;
  ts: string;
  flow: string;
  decision: string;
  result: string;
  log_layer: string;
  query: string;
  summary: RecallSummary;
  humanReport: string;
  jsonRecord: RecallJsonRecord;
  echo: MemoryEchoSnapshot;
}

type RecallEventListener = (event: RecallEvent) => void;

class RecallEventBroker {
  private readonly subscribers = new Map<string, Set<RecallEventListener>>();
  private readonly history = new Map<string, RecallEvent[]>();
  private readonly maxHistory = 200;

  publish(event: RecallEvent): void {
    const key = event.sessionId;
    const items = this.history.get(key) ?? [];
    items.push(event);
    while (items.length > this.maxHistory) items.shift();
    this.history.set(key, items);
    for (const listener of this.subscribers.get(key) ?? []) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must never break the recall path
      }
    }
  }

  subscribe(sessionId: string, listener: RecallEventListener): () => void {
    const key = String(sessionId);
    const listeners = this.subscribers.get(key) ?? new Set<RecallEventListener>();
    listeners.add(listener);
    this.subscribers.set(key, listeners);
    return () => {
      const current = this.subscribers.get(key);
      if (!current) return;
      current.delete(listener);
      if (!current.size) this.subscribers.delete(key);
    };
  }

  historyFor(sessionId: string, limit = 50): RecallEvent[] {
    const items = this.history.get(String(sessionId)) ?? [];
    if (limit <= 0) return items;
    return items.slice(-limit);
  }
}

export const recallEventBroker = new RecallEventBroker();

export function publishRecallEvent(input: {
  agentId: number;
  userId: string;
  turnId?: number | string | null;
  payload: Record<string, any>;
  sessionKey?: string;
}): RecallEvent {
  const payload = asRecord(input.payload);
  const sessionId =
    input.sessionKey ||
    String(payload.sessionKey || recallSessionKey(input.agentId, input.userId));
  const turnId = String(input.turnId ?? payload.turnId ?? "");
  const timestamp = new Date().toISOString();
  const audit = classifyRecallAudit(payload);
  const event: RecallEvent = {
    id: randomUUID(),
    event: "memory_recall",
    sessionId,
    agentId: asNumber(input.agentId, 0),
    userId: String(input.userId ?? "default_user"),
    turnId,
    ts: timestamp,
    flow: audit.flow,
    decision: audit.decision,
    result: audit.result,
    log_layer: audit.log_layer,
    query: String(payload.query ?? ""),
    summary: buildRecallSummary(payload),
    humanReport: buildHumanReport(payload, {
      agentId: input.agentId,
      userId: input.userId,
      sessionKey: sessionId,
      turnId,
      timestamp,
    }),
    jsonRecord: buildJsonRecord(payload, {
      agentId: input.agentId,
      userId: input.userId,
      sessionKey: sessionId,
      turnId,
      timestamp,
    }),
    echo: buildMemoryEchoSnapshot(payload, {
      agentId: input.agentId,
      userId: input.userId,
      sessionKey: sessionId,
      turnId,
      timestamp,
    }),
  };
  recallEventBroker.publish(event);
  return event;
}

export function subscribeRecallEvents(
  sessionId: string,
  listener: RecallEventListener,
): () => void {
  return recallEventBroker.subscribe(sessionId, listener);
}

export function listRecallEvents(sessionId: string, limit = 50): RecallEvent[] {
  return recallEventBroker.historyFor(sessionId, limit);
}
