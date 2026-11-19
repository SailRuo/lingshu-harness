import { createHash } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import type { MemoryScope } from "./memoryScope.js";
import { onMemoryTaskInvalidated } from "./memoryTaskToken.js";

/**
 * The last real usage a private chat request reported (APP
 * `NativeCoreMessages.ChatUsage` / `rememberChatUsage`).
 *
 * The conversation anchor's primary trigger signal is this measured
 * `prompt_tokens` — it includes the system blocks, recall payload, history and
 * the current input, none of which the character estimate can see. The row is
 * keyed by `agent_id + user_id` (one per private scope), overwritten on every
 * reported request, and deliberately carries no time-based expiry: the anchor
 * commit deletes it (APP `forgetChatUsage`) so the stale pre-compaction shape
 * cannot re-trigger the next check.
 */

export interface ChatUsageState {
  agentId: number;
  userId: string;
  promptTokens: number;
  cachedTokens: number;
  model: string;
  /** sha256(baseUrl) prefix — the APP's provider identity stand-in. */
  providerIdentity: string;
  measuredAt: string;
}

export interface RememberChatUsageInput {
  promptTokens: number;
  cachedTokens: number;
  model?: string;
  baseUrl?: string;
  measuredAt?: string;
}

function hashBaseUrl(baseUrl: string): string {
  return createHash("sha256").update(String(baseUrl || "")).digest("hex").slice(0, 16);
}

/** Overwrite the scope's last reported usage. No-op without real tokens. */
export function rememberChatUsage(
  scope: MemoryScope,
  input: RememberChatUsageInput,
): void {
  const promptTokens = Number(input?.promptTokens);
  const cachedTokens = Number(input?.cachedTokens || 0);
  if (!scope || !Number.isFinite(promptTokens) || promptTokens <= 0) return;
  if (!Number.isFinite(cachedTokens) || cachedTokens < 0) return;
  getDb()
    .prepare(
      `INSERT INTO chat_usage_state
        (agent_id, user_id, prompt_tokens, cached_tokens, model, base_url_hash, measured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, user_id) DO UPDATE SET
         prompt_tokens = excluded.prompt_tokens,
         cached_tokens = excluded.cached_tokens,
         model = excluded.model,
         base_url_hash = excluded.base_url_hash,
         measured_at = excluded.measured_at`,
    )
    .run(
      scope.agentId,
      scope.userId,
      Math.floor(promptTokens),
      Math.floor(Math.min(cachedTokens, promptTokens)),
      String(input.model || "").trim(),
      hashBaseUrl(String(input.baseUrl || "")),
      input.measuredAt || new Date().toISOString(),
    );
}

/** The scope's last reported usage, or null before the first reported request. */
export function lastChatUsage(scope: MemoryScope): ChatUsageState | null {
  const row = getDb()
    .prepare(
      `SELECT agent_id, user_id, prompt_tokens, cached_tokens, model, base_url_hash, measured_at
       FROM chat_usage_state WHERE agent_id = ? AND user_id = ?`,
    )
    .get(scope.agentId, scope.userId) as
    | {
        agent_id: number;
        user_id: string;
        prompt_tokens: number;
        cached_tokens: number;
        model: string;
        base_url_hash: string;
        measured_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    agentId: Number(row.agent_id),
    userId: String(row.user_id),
    promptTokens: Number(row.prompt_tokens || 0),
    cachedTokens: Number(row.cached_tokens || 0),
    model: String(row.model || ""),
    providerIdentity: String(row.base_url_hash || ""),
    measuredAt: String(row.measured_at || ""),
  };
}

/**
 * APP `forgetChatUsage`: called right after an anchor commit. The recorded
 * usage describes the pre-compaction request shape — keeping it would make the
 * next idle check fire again off the old value.
 */
export function forgetChatUsage(scope: MemoryScope): void {
  getDb()
    .prepare("DELETE FROM chat_usage_state WHERE agent_id = ? AND user_id = ?")
    .run(scope.agentId, scope.userId);
}

/** Clearing memory / a thread bumps the generation; the stale usage must not survive it. */
onMemoryTaskInvalidated((agentId, userId) => {
  try {
    forgetChatUsage({ agentId, userId });
  } catch {
    // A listener must never make clearing fail.
  }
});
