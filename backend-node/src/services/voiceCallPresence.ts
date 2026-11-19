/**
 * Process-local voice-call presence.
 *
 * The digest worker must not run a background LLM memory pass while a live
 * voice call is in progress. The voice duplex route owns the socket lifecycle;
 * this module only exposes an agent-scoped "is a call socket bound" signal.
 */
const activeConnections = new Map<string, number>();

export function beginVoiceCall(connectionId: string, agentId: number): void {
  const id = String(connectionId || "").trim();
  if (!id || !Number.isInteger(agentId) || agentId <= 0) return;
  activeConnections.set(id, agentId);
}

export function endVoiceCall(connectionId: string): void {
  const id = String(connectionId || "").trim();
  if (!id) return;
  activeConnections.delete(id);
}

export function isVoiceCallActive(agentId: number): boolean {
  for (const value of activeConnections.values()) {
    if (value === agentId) return true;
  }
  return false;
}

export function clearVoiceCallPresence(): void {
  activeConnections.clear();
}
