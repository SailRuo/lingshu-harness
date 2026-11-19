import { randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { normalizeUserId } from "./chatThreadService.js";

export interface MemoryScope {
  agentId: number;
  userId: string;
}

/**
 * P9: 审计分类（对齐 Python core/memory/audit.py）。
 *
 * Python 的 memory audit 事件带四个分类字段：
 *   flow / decision / result / memory_log_layer
 * Node 的 tick log 只有 tickType / outcome 两级，所以这里按 tickType 折算出
 * 同样的四个字段，随 payload 一起落库（不改表结构、不改调用方签名）。
 */
export interface TickLogClassification {
  /** 链路分类：recall / write / witness / proactive / self_state … */
  flow: string;
  /** 这一步「为什么这么做」的人话说明。 */
  decision: string;
  /** 结果分类：success / failed / skipped / timeout / empty / running。 */
  result: string;
  /** 日志层级：business（业务语义） / program（程序状态）。 */
  logLayer: "business" | "program";
}

export interface TickLogItem {
  id: string;
  agentId: number;
  userId: string;
  tickType: string;
  outcome: string;
  triggeredAt: string;
  payload: Record<string, unknown>;
  error: string | null;
  /** P9: 审计分类（追加字段，旧调用方不受影响）。 */
  flow?: string;
  decision?: string;
  result?: string;
  logLayer?: "business" | "program";
}

export function memoryScope(agentId: number, userId?: string | null): MemoryScope {
  return { agentId, userId: normalizeUserId(userId) };
}

export function nowIso() {
  return new Date().toISOString();
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * 审计分类
 * ------------------------------------------------------------------ */

/** Python audit.py::_audit_flow_for_phase —— phase → flow。 */
const TICK_FLOWS: Record<string, string> = {
  stream_proactive: "proactive",
  appointment_reminder: "proactive",
  witness_portrait: "witness",
  period_portrait: "witness",
  witness_arc: "witness",
  self_state_daily: "self_state",
  layer1_silent: "write",
  layer1_digest: "write",
};

/** Python audit.py::_audit_decision_for_event —— step → decision（人话）。 */
const TICK_DECISIONS: Record<string, string> = {
  stream_proactive: "根据记忆流判断是否需要主动发起对话",
  appointment_reminder: "到达约定日期时提醒用户",
  witness_portrait: "根据见证证据更新用户画像",
  period_portrait: "根据周期证据更新阶段画像",
  witness_arc: "根据见证记录更新关系弧线",
  self_state_daily: "每日汇总关系状态并滚动落库",
  layer1_silent: "执行记忆写入步骤",
};

/**
 * Python audit.py::_GENERIC_AUDIT_DECISIONS —— 这些是程序状态描述，
 * 归到 program 层；其余带业务语义的归到 business 层。
 */
const GENERIC_TICK_DECISIONS = new Set([
  "执行记忆召回步骤",
  "执行记忆写入步骤",
  "记录链路状态",
  "根据反思结果决定是否写入长期记忆",
  "完成本轮写入汇总",
  "幂等检查决定跳过",
]);

/** Python audit.py::_audit_result_for_event —— outcome → result。 */
function auditResultForOutcome(outcome: string): string {
  const normalized = String(outcome || "").trim().toLowerCase();
  if (!normalized) return "running";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "timeout") return "timeout";
  if (normalized === "nothing" || normalized === "skipped" || normalized === "skip") {
    return "skipped";
  }
  if (normalized === "empty") return "empty";
  if (
    ["delivered", "updated", "rolled", "digested", "done", "success", "sent", "created"].includes(
      normalized,
    )
  ) {
    return "success";
  }
  return "running";
}

/** Python audit.py::_audit_log_layer —— decision 含中文业务语义 → business。 */
function auditLogLayer(decision: string): "business" | "program" {
  if (GENERIC_TICK_DECISIONS.has(decision)) return "program";
  for (const char of decision) {
    if (char >= "\u4e00" && char <= "\u9fff") return "business";
  }
  return "program";
}

/**
 * 给一条 tick 事件补齐审计分类。
 * 显式写在 payload 里的分类优先（调用方可以覆盖）。
 */
export function classifyTick(
  tickType: string,
  outcome: string,
  payload: Record<string, unknown> = {},
): TickLogClassification {
  const type = String(tickType || "").trim();
  const explicitFlow = String(payload.flow || "").trim();
  const explicitDecision = String(payload.decision || "").trim();
  const explicitResult = String(payload.result || "").trim();
  const explicitLayer = String(payload.memory_log_layer || payload.log_layer || "").trim().toLowerCase();

  const flow = explicitFlow || TICK_FLOWS[type] || type || "unknown";
  const decision = explicitDecision || TICK_DECISIONS[type] || "记录链路状态";
  const result = explicitResult || auditResultForOutcome(outcome);
  const logLayer =
    explicitLayer === "business" || explicitLayer === "program"
      ? explicitLayer
      : auditLogLayer(decision);

  return { flow, decision, result, logLayer };
}

type TickListener = (item: TickLogItem) => void;
const tickListeners = new Set<TickListener>();

export function logTick(
  scope: MemoryScope,
  tickType: string,
  outcome: string,
  payload: Record<string, unknown> = {},
  error?: string,
) {
  // P9: 追加审计分类字段（不改动现有表结构与调用签名）。
  const classification = classifyTick(tickType, outcome, payload);
  const storedPayload: Record<string, unknown> = {
    ...payload,
    flow: classification.flow,
    decision: classification.decision,
    result: classification.result,
    memory_log_layer: classification.logLayer,
  };

  const item: TickLogItem = {
    id: randomUUID(),
    agentId: scope.agentId,
    userId: scope.userId,
    tickType,
    outcome,
    triggeredAt: nowIso(),
    payload: storedPayload,
    error: error ?? null,
    flow: classification.flow,
    decision: classification.decision,
    result: classification.result,
    logLayer: classification.logLayer,
  };
  getDb()
    .prepare(
      `INSERT INTO hippocampus_tick_log (id, agent_id, user_id, tick_type, outcome, triggered_at, payload_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.id,
      item.agentId,
      item.userId,
      item.tickType,
      item.outcome,
      item.triggeredAt,
      JSON.stringify(storedPayload),
      item.error,
    );
  for (const listener of tickListeners) {
    try {
      listener(item);
    } catch {
      // listener failures must not break ingestion
    }
  }
}

export function subscribeTickLog(listener: TickListener): () => void {
  tickListeners.add(listener);
  return () => tickListeners.delete(listener);
}
