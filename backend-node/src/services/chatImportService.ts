import { randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { ChatThreadRow, ensureThread, normalizeUserId, updateThreadSummary } from "./chatThreadService.js";
import { getAgent } from "./agentService.js";
import { runThreadDigest } from "./memoryService.js";
import {
  consolidateArc,
  consolidatePeriodPortrait,
  consolidateUserPortrait,
  listImportRetrospectTargets,
} from "./witnessService.js";

export interface ParsedImportMessage {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}

const ROLE_MARKER_RE = /^\s*(用户|user|human|ai|assistant|助手)\s*[:：]\s*(.*)$/i;

function roleOf(raw: string): "user" | "assistant" {
  const lower = raw.trim().toLowerCase();
  return ["用户", "user", "human"].includes(lower) ? "user" : "assistant";
}

function parseTimestamp(item: Record<string, any>): string | undefined {
  const rawTimestamp = item.timestamp;
  if (typeof rawTimestamp === "number") {
    const ms = rawTimestamp > 10_000_000_000 ? rawTimestamp : rawTimestamp * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const rawText = String(item.timeStr || item.createdAt || "").trim();
  if (!rawText) return undefined;
  const normalized = rawText.includes(" ") && !rawText.includes("T") ? rawText.replace(" ", "T") : rawText;
  const parsed = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function jsonRole(item: Record<string, any>): "user" | "assistant" | null {
  const userType = item.userType;
  if (userType === 1 || userType === "1" || userType === "user") return "user";
  if (userType === 2 || userType === "2" || userType === "assistant" || userType === "ai") {
    return "assistant";
  }
  const sender = String(item.sender || "").trim().toLowerCase();
  if (["用户", "user", "human"].includes(sender)) return "user";
  if (["ai", "assistant", "助手", "豆包ai", "豆包"].includes(sender)) return "assistant";
  return null;
}

export function parseImportContent(content: string): ParsedImportMessage[] {
  const trimmed = (content || "").trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let data: any;
    try {
      data = JSON.parse(content);
    } catch {
      return [];
    }
    const rawItems = Array.isArray(data)
      ? data
      : Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.items)
            ? data.items
            : [];
    const sorted = rawItems
      .map((item: any, index: number) => ({ item, index }))
      .filter(({ item }: any) => item && typeof item === "object")
      .sort((left: any, right: any) => {
        const leftTs = Number(left.item.timestamp || 0);
        const rightTs = Number(right.item.timestamp || 0);
        if (leftTs !== rightTs) return leftTs - rightTs;
        return left.index - right.index;
      });
    const result: ParsedImportMessage[] = [];
    for (const { item } of sorted) {
      const role = jsonRole(item);
      const text = String(item.content || "").trim();
      if (!role || !text) continue;
      result.push({ role, content: text, createdAt: parseTimestamp(item) });
    }
    return result;
  }

  const messages: ParsedImportMessage[] = [];
  let currentRole: "user" | "assistant" | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (!currentRole) {
      currentLines = [];
      return;
    }
    const text = currentLines.join("\n").trim();
    if (text) messages.push({ role: currentRole, content: text });
    currentLines = [];
  };
  for (const line of content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const match = line.match(ROLE_MARKER_RE);
    if (match) {
      flush();
      currentRole = roleOf(match[1]);
      const first = match[2].trim();
      currentLines = first ? [first] : [];
      continue;
    }
    if (currentRole) currentLines.push(line);
  }
  flush();
  return messages;
}

const RANGE_DAYS: Record<string, number> = {
  recent_1_week: 7,
  recent_1_month: 30,
  recent_3_months: 90,
  recent_6_months: 180,
};

export interface ImportResult {
  thread: ChatThreadRow;
  messageCount: number;
  turnCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  skippedOutOfRange: number;
  lastAssistantMessageId: number | null;
}

export function importChatHistory(input: {
  agentId: number;
  userId: string;
  content: string;
  importRange?: string;
}): ImportResult {
  const parsed = parseImportContent(input.content);
  const sinceDays = RANGE_DAYS[input.importRange || "recent_3_months"];
  const since = sinceDays ? Date.now() - sinceDays * 24 * 3600 * 1000 : null;
  let skipped = 0;
  const messages = parsed.filter((message) => {
    if (!since || !message.createdAt) return true;
    if (new Date(message.createdAt).getTime() < since) {
      skipped += 1;
      return false;
    }
    return true;
  });
  if (!messages.length) {
    throw new Error(skipped ? "no_messages_in_range" : "no_importable_messages");
  }

  const thread = ensureThread(input.userId, input.agentId);
  const db = getDb();
  const userId = normalizeUserId(input.userId);
  const base = Date.now();
  let pendingUserId: number | null = null;
  let pendingTurnPairId: number | null = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let turnCount = 0;
  let lastAssistantMessageId: number | null = null;
  let lastContent = "";
  let lastKind = "reply";
  let lastAt = new Date().toISOString();

  const tx = db.transaction(() => {
    messages.forEach((message, index) => {
      const createdAt = message.createdAt || new Date(base + index * 100).toISOString();
      if (message.role === "user") {
        const info = db
          .prepare(
            `INSERT INTO chat_messages
              (thread_id, user_id, agent_id, role, message_kind, content, created_at, completed_at)
             VALUES (?, ?, ?, 'user', 'user_text', ?, ?, ?)`,
          )
          .run(thread.id, userId, input.agentId, message.content, createdAt, createdAt);
        pendingUserId = Number(info.lastInsertRowid);
        db.prepare("UPDATE chat_messages SET turn_pair_id = ? WHERE id = ?").run(
          pendingUserId,
          pendingUserId,
        );
        pendingTurnPairId = pendingUserId;
        userCount += 1;
        lastContent = message.content;
        lastKind = "user_text";
        lastAt = createdAt;
      } else {
        const info = db
          .prepare(
            `INSERT INTO chat_messages
              (thread_id, user_id, agent_id, role, message_kind, content, reply_to_message_id,
               turn_pair_id, status, assistant_read_at, created_at, completed_at)
             VALUES (?, ?, ?, 'assistant', 'reply', ?, ?, ?, 'completed', ?, ?, ?)`,
          )
          .run(
            thread.id,
            userId,
            input.agentId,
            message.content,
            pendingUserId,
            pendingTurnPairId,
            createdAt,
            createdAt,
            createdAt,
          );
        const assistantId = Number(info.lastInsertRowid);
        if (pendingTurnPairId === null) {
          db.prepare("UPDATE chat_messages SET turn_pair_id = ? WHERE id = ?").run(
            assistantId,
            assistantId,
          );
        }
        assistantCount += 1;
        turnCount += 1;
        pendingUserId = null;
        pendingTurnPairId = null;
        lastAssistantMessageId = assistantId;
        lastContent = message.content;
        lastKind = "reply";
        lastAt = createdAt;
      }
      messageCount += 1;
    });
    updateThreadSummary(thread.id, lastContent, lastKind, lastAt);
  });
  tx();

  return {
    thread,
    messageCount,
    turnCount,
    userMessageCount: userCount,
    assistantMessageCount: assistantCount,
    skippedOutOfRange: skipped,
    lastAssistantMessageId,
  };
}

export type ImportDigestStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "limited";

export interface ImportDigestJob {
  jobId: string;
  agentId: number;
  threadId: number;
  userId: string;
  status: ImportDigestStatus;
  totalTurns: number;
  maxTurns: number;
  targetTurns: number;
  processedTurns: number;
  pendingTurns: number;
  batches: number;
  phase: "digest" | "portrait" | "retrospect" | "completed";
  totalWork: number;
  processedWork: number;
  retrospectTotal: number;
  retrospectProcessed: number;
  message: string;
  error: string | null;
  since: string | null;
  createdAt: string;
  updatedAt: string;
}

const digestJobs = new Map<string, ImportDigestJob>();
const runningJobs = new Set<string>();
const TERMINAL: ImportDigestStatus[] = ["completed", "failed", "skipped", "limited"];

function updateJob(jobId: string, updates: Partial<ImportDigestJob>) {
  const job = digestJobs.get(jobId);
  if (!job) return;
  Object.assign(job, updates);
  job.pendingTurns = Math.max(0, Number(job.totalTurns) - Number(job.processedTurns));
  job.totalWork = Math.max(
    Number(job.totalWork || 0),
    Number(job.totalTurns) + Number(job.retrospectTotal || 0),
  );
  job.processedWork = Math.min(
    job.totalWork,
    Number(job.processedTurns) + Number(job.retrospectProcessed || 0),
  );
  job.updatedAt = new Date().toISOString();
}

export function createImportDigestJob(input: {
  agentId: number;
  threadId: number;
  userId: string;
  totalTurns: number;
  maxTurns: number;
  since?: string | null;
}): ImportDigestJob {
  const now = new Date().toISOString();
  const total = Math.max(0, Number(input.totalTurns || 0));
  const job: ImportDigestJob = {
    jobId: `digest_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    agentId: input.agentId,
    threadId: input.threadId,
    userId: input.userId,
    status: "pending",
    totalTurns: total,
    maxTurns: Math.max(1, Number(input.maxTurns || 100)),
    targetTurns: total,
    processedTurns: 0,
    pendingTurns: total,
    batches: 0,
    phase: "digest",
    totalWork: total,
    processedWork: 0,
    retrospectTotal: 0,
    retrospectProcessed: 0,
    message: "等待开始处理",
    error: null,
    since: input.since ?? null,
    createdAt: now,
    updatedAt: now,
  };
  digestJobs.set(job.jobId, job);
  setImmediate(() => {
    void runImportDigestJob(job.jobId);
  });
  return job;
}

export function getImportDigestJob(jobId: string): ImportDigestJob | null {
  return digestJobs.get(jobId) ?? null;
}

export function prepareImportDigestRetry(jobId: string): ImportDigestJob | null {
  const job = digestJobs.get(jobId);
  if (!job) return null;
  if (job.status === "pending" || job.status === "running") return job;
  updateJob(jobId, {
    status: "pending",
    targetTurns: job.totalTurns,
    phase: "digest",
    retrospectProcessed: 0,
    message: "等待重新处理",
    error: null,
  });
  setImmediate(() => {
    void runImportDigestJob(jobId);
  });
  return job;
}

export function retryImportDigestJob(jobId: string): ImportDigestJob | null {
  return prepareImportDigestRetry(jobId);
}

function isTerminal(status: ImportDigestStatus) {
  return TERMINAL.includes(status);
}

export function importDigestTerminalStatuses() {
  return [...TERMINAL];
}

function messageTimeBounds(threadId: number, since: string | null) {
  const row = getDb()
    .prepare(
      `SELECT MIN(created_at) AS start, MAX(created_at) AS end FROM chat_messages
       WHERE thread_id = ? ${since ? "AND created_at >= ?" : ""}`,
    )
    .get(...(since ? [threadId, since] : [threadId])) as
    | { start: string | null; end: string | null }
    | undefined;
  if (!row?.start || !row.end) return null;
  return { start: new Date(row.start), end: new Date(row.end) };
}

async function runImportDigestJob(jobId: string) {
  if (runningJobs.has(jobId)) return;
  const job = digestJobs.get(jobId);
  if (!job) return;
  runningJobs.add(jobId);
  try {
    updateJob(jobId, {
      status: "running",
      phase: "digest",
      message: "正在处理导入记录",
      error: null,
    });
    let batches = Number(job.batches || 0);
    let processedTurns = Number(job.processedTurns || 0);
    let guard = 0;
    while (guard < 500) {
      guard += 1;
      const result = await runThreadDigest(job.threadId, {
        maxPairs: job.maxTurns,
        source: "chat_import",
        forceStreamFallback: true,
        since: job.since,
      });
      if ("skipped" in result) break;
      batches += 1;
      processedTurns += Number(result.turnCount || 0);
      updateJob(jobId, {
        status: "running",
        phase: "digest",
        processedTurns,
        batches,
        message: "正在处理导入记录",
      });
    }

    const agent = getAgent(job.agentId);
    if (agent?.timeMirrorEnabled) {
      updateJob(jobId, {
        phase: "portrait",
        message: "导入记录已处理完，正在生成用户画像",
      });
      const scope = { agentId: job.agentId, userId: job.userId };
      await consolidateUserPortrait(scope);

      const bounds = messageTimeBounds(job.threadId, job.since);
      if (bounds) {
        const targets = listImportRetrospectTargets(bounds.start, bounds.end);
        for (const target of targets) {
          await consolidatePeriodPortrait(scope, target.granularity, target.bucketKey, {
            force: true,
          });
        }
        updateJob(jobId, {
          phase: "retrospect",
          retrospectTotal: targets.length,
          retrospectProcessed: 0,
          message: "导入记录已处理完，正在生成时间镜像",
        });
        let completed = 0;
        for (const target of targets) {
          await consolidateArc(scope, target.granularity, target.bucketKey, { force: true });
          completed += 1;
          updateJob(jobId, {
            phase: "retrospect",
            retrospectProcessed: completed,
            message: `正在生成时间镜像：${target.granularity} ${target.bucketKey}`,
          });
        }
      }
    }

    updateJob(jobId, {
      status: "completed",
      phase: "completed",
      processedTurns,
      batches,
      retrospectProcessed: job.retrospectTotal,
      message: agent?.timeMirrorEnabled ? "历史记忆与时间镜像消化完成" : "历史记忆消化完成",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    updateJob(jobId, {
      status: "failed",
      phase: "digest",
      message: "后台处理失败",
      error: detail,
    });
  } finally {
    runningJobs.delete(jobId);
  }
}

export function importDigestJobSnapshot(job: ImportDigestJob) {
  return {
    ...job,
    pendingTurns: Math.max(0, job.totalTurns - job.processedTurns),
  };
}

export { isTerminal };
