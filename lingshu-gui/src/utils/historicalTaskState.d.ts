import type { AnyMessage } from '../types/message';
import type { UnifiedChatEvent } from '../types/chat-events';

export interface HistoricalTaskState {
  messages: AnyMessage[];
}

export function hydrateHistoricalTaskState(
  messages: AnyMessage[],
  taskEventsById: Record<string, UnifiedChatEvent[]>,
): HistoricalTaskState;
