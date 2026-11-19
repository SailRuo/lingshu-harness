import { getDb } from "../db/sqlite.js";
import { DIGEST_CONSTANTS } from "../contracts/native/index.js";
import { recordBackgroundTaskEvent } from "./backgroundTaskEvents.js";
import { memoryTaskGeneration, onMemoryTaskInvalidated } from "./memoryTaskToken.js";
import { memoryScope, type MemoryScope } from "./memoryScope.js";
import { runAgentDigest, type AgentDigestResult } from "./memoryService.js";
import { maybeRefreshConversationAnchor } from "./conversationAnchorService.js";
import { isVoiceCallActive } from "./voiceCallPresence.js";

/**
 * Private digest scheduling is agent+user scoped, not thread scoped. The
 * desktop schema has one private thread per (user, agent) today, but imported
 * or historical databases may still carry several; all of them are one memory
 * owner and therefore share one 90s idle window and one digest_state cursor.
 */
export const DIGEST_IDLE_MS = DIGEST_CONSTANTS.IDLE_MS;
const CONTINUE_DELAY_MS = 1_500;
const STARTUP_RECOVERY_WINDOW_MS = DIGEST_CONSTANTS.STARTUP_RECOVERY_WINDOW_MS;

const timers = new Map<string, NodeJS.Timeout>();
const activeScopes = new Set<string>();
const digestingScopes = new Set<string>();

// A pending idle timer is an old task too: clearing memory must cancel it so
// chat history cannot silently repopulate memory right after the clear.
onMemoryTaskInvalidated((agentId, userId) => {
  cancelTimer(memoryScope(agentId, userId));
});

/** Test hook: replaces the real digest executor (no LLM/DB writes). */
let testExecutor:
  | ((agentId: number, userId: string, source: string) => Promise<AgentDigestResult>)
  | null = null;

function scopeKey(scope: MemoryScope): string {
  return `${scope.agentId}:${scope.userId}`;
}

function idleMs(): number {
  const raw = Number(process.env.LINGSHU_DIGEST_DELAY_MS || DIGEST_IDLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DIGEST_IDLE_MS;
}

function threadScope(threadId: number): MemoryScope | null {
  const thread = getDb()
    .prepare("SELECT agent_id, user_id FROM chat_threads WHERE id = ?")
    .get(threadId) as { agent_id: number; user_id: string } | undefined;
  return thread ? memoryScope(thread.agent_id, thread.user_id) : null;
}

function cancelTimer(scope: MemoryScope) {
  const key = scopeKey(scope);
  const timer = timers.get(key);
  if (timer) {
    clearTimeout(timer);
    timers.delete(key);
  }
}

function scheduleScope(scope: MemoryScope, delayMs = idleMs()) {
  const key = scopeKey(scope);
  const previous = timers.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    timers.delete(key);
    void drainDigestBacklog(scope, "layer1_silent");
  }, Math.max(0, delayMs));
  timer.unref?.();
  timers.set(key, timer);
}

export function cancelPendingDigest(threadId: number) {
  const scope = threadScope(Number(threadId));
  if (scope) cancelTimer(scope);
}

export function markThreadActive(threadId: number) {
  const scope = threadScope(Number(threadId));
  if (!scope) return;
  activeScopes.add(scopeKey(scope));
  cancelTimer(scope);
}

export function markThreadInactive(threadId: number) {
  const scope = threadScope(Number(threadId));
  if (!scope) return;
  activeScopes.delete(scopeKey(scope));
}

export function noteTurnComplete(threadId: number) {
  const id = Number(threadId);
  if (!Number.isInteger(id) || id <= 0) return;
  const scope = threadScope(id);
  if (!scope) return;
  activeScopes.delete(scopeKey(scope));
  scheduleScope(scope);
}

async function drainDigestBacklog(scope: MemoryScope, source: string) {
  const key = scopeKey(scope);
  if (activeScopes.has(key) || digestingScopes.has(key)) return;
  if (isVoiceCallActive(scope.agentId)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "skipped",
      detail: "voice_call_active",
    });
    // Re-check after another idle window; the call may still be running.
    scheduleScope(scope);
    return;
  }
  const generationBefore = memoryTaskGeneration(scope.agentId, scope.userId);
  digestingScopes.add(key);
  try {
    // APP runs the anchor check before the ordinary digest batch. The anchor
    // is optional: it records its own failure and never blocks the digest.
    await maybeRefreshConversationAnchor(scope);
    const result = testExecutor
      ? await testExecutor(scope.agentId, scope.userId, source)
      : await runAgentDigest(scope.agentId, scope.userId, { source });
    // A clear during the run invalidates the whole scope; never queue the
    // remaining old backlog as a fresh task.
    if (memoryTaskGeneration(scope.agentId, scope.userId) !== generationBefore) return;
    if (!("skipped" in result) && result.hasMore) {
      // The APP runs at most 8 chunks per trigger; continue shortly after.
      scheduleScope(scope, CONTINUE_DELAY_MS);
    }
  } catch (error) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "failed",
      detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    });
  } finally {
    digestingScopes.delete(key);
  }
}

/**
 * Startup recovery only re-schedules owners whose newest pending message is
 * inside the last 24h. A conversation interrupted before its 90s timer fired
 * (app killed, service stopped) would otherwise never be digested.
 */
export function recoverPendingDigests(now = Date.now()) {
  const cutoff = new Date(now - STARTUP_RECOVERY_WINDOW_MS).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT agent_id, user_id FROM chat_messages
       WHERE role = 'assistant' AND status = 'completed' AND digested_at IS NULL
         AND TRIM(content) <> '' AND created_at >= ?`,
    )
    .all(cutoff) as { agent_id: number; user_id: string }[];
  for (const row of rows) {
    scheduleScope(memoryScope(row.agent_id, row.user_id));
  }
  return rows.length;
}

export async function runDigestNow(threadId: number, source = "layer1_manual") {
  const scope = threadScope(Number(threadId));
  if (!scope) return;
  cancelTimer(scope);
  await drainDigestBacklog(scope, source);
}

export function digestSchedulerState() {
  return {
    delaySeconds: Math.round(idleMs() / 1000),
    maxChunksPerRun: DIGEST_CONSTANTS.DIGEST_MAX_CHUNKS_PER_RUN,
    pending: timers.size,
    active: activeScopes.size,
    digesting: digestingScopes.size,
  };
}

export function shutdownDigestScheduler() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  activeScopes.clear();
  digestingScopes.clear();
  testExecutor = null;
}

export function __setDigestExecutorForTests(
  executor: ((agentId: number, userId: string, source: string) => Promise<AgentDigestResult>) | null,
) {
  testExecutor = executor;
}
