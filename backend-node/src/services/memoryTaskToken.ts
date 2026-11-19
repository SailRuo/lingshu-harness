import { getDb } from "../db/sqlite.js";

/**
 * Memory task generation token.
 *
 * Clearing a companion's memory bumps the generation for that agent+user. A
 * digest task captures the generation when it starts and must re-check it
 * before applying / advancing its cursor; a token from before the clear can
 * never write back into the fresh memory.
 *
 * The generation lives in `hippocampus_meta` (not deleted by clear), so the
 * guard survives process restarts. `clearAllMemory` deliberately clears the
 * memory tables but never this key.
 */
export interface MemoryTaskToken {
  agentId: number;
  userId: string;
  generation: number;
  taskId: string;
}

const invalidationListeners = new Set<(agentId: number, userId: string) => void>();

export function onMemoryTaskInvalidated(
  listener: (agentId: number, userId: string) => void,
): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

function generationKey(agentId: number, userId: string): string {
  return `memory_generation:${agentId}:${userId}`;
}

function readGeneration(agentId: number, userId: string): number {
  const row = getDb()
    .prepare("SELECT value FROM hippocampus_meta WHERE key = ?")
    .get(generationKey(agentId, userId)) as { value?: string } | undefined;
  const value = Number(row?.value ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function memoryTaskGeneration(agentId: number, userId: string): number {
  return readGeneration(agentId, userId);
}

export function beginMemoryTask(agentId: number, userId: string): MemoryTaskToken {
  return {
    agentId,
    userId,
    generation: readGeneration(agentId, userId),
    taskId: `memory-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

export function isMemoryTaskValid(token: MemoryTaskToken): boolean {
  return readGeneration(token.agentId, token.userId) === token.generation;
}

/** Bump the generation so every in-flight task for this scope becomes stale. */
export function invalidateMemoryTasks(agentId: number, userId: string): number {
  const db = getDb();
  const key = generationKey(agentId, userId);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_meta (key, value, updated_at)
     VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(hippocampus_meta.value AS INTEGER) + 1 AS TEXT),
       updated_at = excluded.updated_at`,
  ).run(key, now);
  for (const listener of invalidationListeners) {
    try {
      listener(agentId, userId);
    } catch {
      // A listener must never make clearing fail.
    }
  }
  return readGeneration(agentId, userId);
}

/**
 * Run a synchronous write phase only if the token is still current. The caller
 * must not perform model calls or embedding work inside `fn`.
 */
export function runIfMemoryTaskValid<T>(token: MemoryTaskToken, fn: () => T): T | null {
  if (!isMemoryTaskValid(token)) return null;
  return fn();
}
