import { onMemoryTaskInvalidated } from "./memoryTaskToken.js";

/**
 * In-process snapshot of the rendered `# 你正在成为的样子` block.
 *
 * The block only changes when a conversation anchor is committed, memory is
 * cleared, or the companion is deleted. Reading the anchor row on every turn
 * would be cheap but pointless: the block lives in the fixed slow prompt, so a
 * stable string is what keeps the provider prefix cache warm.
 */
const blocks = new Map<string, string>();

function key(agentId: number, userId: string): string {
  return `${agentId}:${userId}`;
}

export function readSelfPortraitBlockCache(agentId: number, userId: string): string | null {
  return blocks.get(key(agentId, userId)) ?? null;
}

export function writeSelfPortraitBlockCache(
  agentId: number,
  userId: string,
  block: string,
): void {
  blocks.set(key(agentId, userId), block);
}

export function invalidateSelfPortraitBlockCache(agentId: number, userId: string): void {
  blocks.delete(key(agentId, userId));
}

export function invalidateSelfPortraitBlockCacheForAgent(agentId: number): void {
  const prefix = `${agentId}:`;
  for (const existing of blocks.keys()) {
    if (existing.startsWith(prefix)) blocks.delete(existing);
  }
}

/** Clearing memory bumps the generation; the snapshot must not survive it. */
onMemoryTaskInvalidated((agentId, userId) => {
  invalidateSelfPortraitBlockCache(agentId, userId);
});
