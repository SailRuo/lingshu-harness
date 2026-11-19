import { randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { embedText, vectorToBuffer } from "./embeddingService.js";

export type ThreadOwner = "him" | "her" | "us";

export interface ExtractedThread {
  action?: "open" | "continue";
  threadId?: string | null;
  title: string;
  owner: ThreadOwner | string;
  grip: number;
  stanceNote: string;
  episodeRef?: string | number | null;
}

export interface ThreadLifecycleResult {
  threadsCreated: number;
  threadsUpdated: number;
  touchpointsWritten: number;
}

interface ThreadRow {
  id: string;
  agent_id: number;
  user_id: string;
  title: string;
  status: string;
  owner: string;
  current_grip: number;
  last_note: string;
  origin_note: string | null;
  created_at: string;
  updated_at: string;
}

const TRIVIAL_THREAD_RE =
  /(吃什么|吃啥|外卖|点餐|午饭|晚饭|早饭|早餐|午餐|晚餐|天气|几点|在吗|你好|寒暄|今天吃|今日吃|吃什么好)/;
const TITLE_NOISE_RE = /[^\w\u4e00-\u9fff]+/g;
const GENERIC_SUFFIXES = [
  "情绪困扰",
  "情绪状态",
  "情绪问题",
  "心理困扰",
  "心理状态",
  "心理问题",
  "状态问题",
  "状态困扰",
  "这个问题",
  "这个状态",
  "这件事情",
  "这件事",
  "这回事",
  "情况",
  "问题",
  "困扰",
  "状态",
  "情绪",
];
const GRIP_CLOSE_THRESHOLD = 0.15;

function nowIso() {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeThreadTitle(title: string): string {
  let text = String(title || "").trim().toLowerCase().replace(TITLE_NOISE_RE, "");
  if (!text) return "";
  for (const suffix of GENERIC_SUFFIXES) {
    if (text.endsWith(suffix)) {
      text = text.slice(0, -suffix.length);
      break;
    }
  }
  return text.trim();
}

function titlesLookSame(left: string, right: string): boolean {
  const a = normalizeThreadTitle(left);
  const b = normalizeThreadTitle(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 2 && longer.includes(shorter)) return true;
  const overlap = [...new Set(shorter)].filter((char) => longer.includes(char)).length;
  const union = new Set([...shorter, ...longer]).size;
  return union > 0 && overlap / union >= 0.75 && shorter.slice(0, 2) === longer.slice(0, 2);
}

function isTrivialThread(item: ExtractedThread): boolean {
  const combined = `${String(item.title || "")} ${String(item.stanceNote || "")}`;
  return TRIVIAL_THREAD_RE.test(combined);
}

function applySalienceGate(item: ExtractedThread, existing: ThreadRow | null): boolean {
  if (existing) return true;
  const grip = Number(item.grip || 0);
  if (isTrivialThread(item)) return grip >= 0.65;
  return grip >= 0.5;
}

function pushGrip(previous: number, reading: number, alpha = 0.2): number {
  return clamp(previous * (1 - alpha) + reading * alpha, 0, 1);
}

function normalizeOwner(value: unknown): ThreadOwner {
  const owner = String(value || "him").trim().toLowerCase();
  return owner === "her" || owner === "us" ? owner : "him";
}

function recentThreads(agentId: number, userId: string, limit = 80): ThreadRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM hippocampus_threads
       WHERE agent_id = ? AND user_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(agentId, userId, Math.max(1, limit)) as ThreadRow[];
}

function findExistingThread(
  agentId: number,
  userId: string,
  item: ExtractedThread,
  threads: ThreadRow[],
): ThreadRow | null {
  const explicit = String(item.threadId || "").trim();
  if (explicit) {
    const row = threads.find((thread) => thread.id === explicit);
    if (row) return row;
  }
  return threads.find((thread) => titlesLookSame(item.title, thread.title)) || null;
}

export async function applyThreadExtractions(
  scope: { agentId: number; userId: string },
  items: ExtractedThread[],
  options: {
    episodeRef?: string | number | null;
    affect?: { valence: number; arousal: number; dominance: number; note?: string } | null;
    /** Test/offline injection: defaults to the shared embedding service. */
    embed?: (text: string) => Promise<number[]>;
    /** Return false after memory clear/delete: stop before writing this item. */
    guard?: () => boolean;
  } = {},
): Promise<ThreadLifecycleResult> {
  const result: ThreadLifecycleResult = {
    threadsCreated: 0,
    threadsUpdated: 0,
    touchpointsWritten: 0,
  };
  if (!Array.isArray(items) || !items.length) return result;

  const db = getDb();
  const threads = recentThreads(scope.agentId, scope.userId);
  const now = nowIso();
  const embed =
    options.embed ??
    (async (text: string) => (await embedText(text, { wait: true })).vector);

  for (const raw of items) {
    if (options.guard && !options.guard()) break;
    const title = String(raw?.title || "").trim();
    if (!title) continue;
    const item: ExtractedThread = {
      action: raw.action === "continue" ? "continue" : "open",
      threadId: raw.threadId ?? null,
      title: title.slice(0, 160),
      owner: normalizeOwner(raw.owner),
      grip: clamp(Number(raw.grip ?? 0.5), 0, 1),
      stanceNote: String(raw.stanceNote || "").trim().slice(0, 1200),
      episodeRef: raw.episodeRef ?? options.episodeRef ?? null,
    };
    const existing = findExistingThread(scope.agentId, scope.userId, item, threads);
    if (!applySalienceGate(item, existing)) continue;

    let thread = existing;
    if (!thread) {
      const embedding = await embed(`${item.title}\n${item.stanceNote}`);
      if (options.guard && !options.guard()) break;
      const id = `thread-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      db.prepare(
        `INSERT INTO hippocampus_threads
          (id, agent_id, user_id, title, status, owner, current_grip, last_note,
           origin_note, embedding, embedding_dim, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        scope.agentId,
        scope.userId,
        item.title,
        item.grip <= GRIP_CLOSE_THRESHOLD ? "closed" : "open",
        normalizeOwner(item.owner),
        item.grip,
        item.stanceNote,
        item.stanceNote,
        vectorToBuffer(embedding),
        embedding.length,
        now,
        now,
      );
      thread = {
        id,
        agent_id: scope.agentId,
        user_id: scope.userId,
        title: item.title,
        status: item.grip <= GRIP_CLOSE_THRESHOLD ? "closed" : "open",
        owner: normalizeOwner(item.owner),
        current_grip: item.grip,
        last_note: item.stanceNote,
        origin_note: item.stanceNote,
        created_at: now,
        updated_at: now,
      };
      threads.unshift(thread);
      result.threadsCreated += 1;
    } else {
      const reading = Number(item.grip ?? thread.current_grip ?? 0.5);
      const grip = pushGrip(Number(thread.current_grip || 0), reading);
      const status = grip <= GRIP_CLOSE_THRESHOLD ? "closed" : "open";
      const embedding = await embed(`${item.title || thread.title}\n${item.stanceNote || thread.last_note}`);
      if (options.guard && !options.guard()) break;
      db.prepare(
        `UPDATE hippocampus_threads SET
           title = ?, status = ?, owner = ?, current_grip = ?, last_note = ?,
           embedding = ?, embedding_dim = ?, updated_at = ?
         WHERE id = ? AND agent_id = ? AND user_id = ?`,
      ).run(
        item.title || thread.title,
        status,
        normalizeOwner(item.owner || thread.owner),
        grip,
        item.stanceNote || thread.last_note,
        vectorToBuffer(embedding),
        embedding.length,
        now,
        thread.id,
        scope.agentId,
        scope.userId,
      );
      thread.status = status;
      thread.current_grip = grip;
      thread.last_note = item.stanceNote || thread.last_note;
      thread.updated_at = now;
      result.threadsUpdated += 1;
    }

    const episodeRef = String(item.episodeRef ?? options.episodeRef ?? "").trim();
    if (episodeRef && (!options.guard || options.guard())) {
      const duplicate = db
        .prepare(
          `SELECT id FROM hippocampus_touchpoints
           WHERE thread_id = ? AND episode_ref = ? LIMIT 1`,
        )
        .get(thread.id, episodeRef);
      if (!duplicate) {
        db.prepare(
          `INSERT INTO hippocampus_touchpoints
            (id, agent_id, user_id, thread_id, episode_ref, grip, stance_note, affect_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `touchpoint-${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          scope.agentId,
          scope.userId,
          thread.id,
          episodeRef,
          Number(item.grip ?? thread.current_grip ?? 0.5),
          item.stanceNote || thread.last_note,
          options.affect ? JSON.stringify(options.affect) : null,
          now,
        );
        result.touchpointsWritten += 1;
      }
    }
  }

  return result;
}

export interface MirrorGap {
  thenGrip: number;
  nowGrip: number;
  thenNote: string;
  nowNote: string;
  isRebound: boolean;
  episodeRef: string | null;
}

export function detectThreadMirrorGap(touchpoints: {
  grip: number;
  stance_note?: string | null;
  episode_ref?: string | null;
  created_at: string;
}[]): MirrorGap | null {
  if (touchpoints.length < 2) return null;
  const sorted = [...touchpoints].sort((left, right) => left.created_at.localeCompare(right.created_at));
  const now = sorted[sorted.length - 1];
  const prior = sorted.slice(0, -1);
  const nowGrip = Number(now.grip || 0);

  if (nowGrip >= 0.5) {
    const trough = prior.reduce((min, item) => (Number(item.grip) < Number(min.grip) ? item : min), prior[0]);
    if (Number(trough.grip) <= 0.3 && nowGrip - Number(trough.grip) >= 0.35) {
      const wasHeavy = prior
        .filter((item) => item.created_at < trough.created_at)
        .some((item) => Number(item.grip) >= 0.5);
      if (wasHeavy) {
        return {
          thenGrip: Number(trough.grip),
          nowGrip,
          thenNote: String(trough.stance_note || ""),
          nowNote: String(now.stance_note || ""),
          isRebound: true,
          episodeRef: now.episode_ref ?? null,
        };
      }
    }
  }

  const peak = prior.reduce((max, item) => (Number(item.grip) > Number(max.grip) ? item : max), prior[0]);
  if (Number(peak.grip) >= 0.5 && Number(peak.grip) - nowGrip >= 0.35) {
    return {
      thenGrip: Number(peak.grip),
      nowGrip,
      thenNote: String(peak.stance_note || ""),
      nowNote: String(now.stance_note || ""),
      isRebound: false,
      episodeRef: now.episode_ref ?? null,
    };
  }
  return null;
}
