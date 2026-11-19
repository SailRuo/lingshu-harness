export function isTerminalTaskStatus(status: unknown): boolean;

export function syncTerminalTaskStatusAcrossMessages<T>(
  messages: T[],
  options: {
    taskId?: string | null;
    normalizedStatus?: string | null;
    eventType?: string | null;
    eventData?: Record<string, unknown> | null;
  }
): T[];
