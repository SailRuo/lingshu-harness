interface PendingApproval {
  resolve: (approved: boolean, reason?: string) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingApproval>();

export function requestToolApproval(callId: string, timeoutMs = 120_000): Promise<{ approved: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(callId);
      resolve({ approved: false, reason: "approval_timeout" });
    }, timeoutMs);
    pending.set(callId, {
      timer,
      resolve: (approved, reason) => {
        clearTimeout(timer);
        pending.delete(callId);
        resolve({ approved, reason });
      },
    });
  });
}

export function resolveToolApproval(callId: string, approved: boolean, reason?: string): boolean {
  const entry = pending.get(callId);
  if (!entry) return false;
  entry.resolve(approved, reason);
  return true;
}

export function hasPendingApproval(callId: string): boolean {
  return pending.has(callId);
}
