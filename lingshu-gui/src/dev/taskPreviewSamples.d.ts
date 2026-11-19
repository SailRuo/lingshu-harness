import type { UnifiedChatEvent } from '../types/chat-events';

export interface TaskPreviewScenario {
  id: string;
  title: string;
  description: string;
  prompt: string;
  finalText: string;
  events: UnifiedChatEvent[];
}

export function obsidianTerminalFallbackSample(): UnifiedChatEvent[];
export function argRepairRetrySample(): UnifiedChatEvent[];
export const taskPreviewScenarios: TaskPreviewScenario[];
