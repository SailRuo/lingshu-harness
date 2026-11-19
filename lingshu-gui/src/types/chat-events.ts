export const CHAT_EVENT_TYPES = [
  'text_delta',
  'thought',
  'llm_request',
  'tool_call',
  'approval_required',
  'approval_resolved',
  'tool_result',
  'image',
  'state',
  'done',
  'error',
  'terminal_session_opened',
  'terminal_command_started',
  'terminal_output',
  'terminal_command_finished',
  'terminal_session_reused',
  'terminal_session_closed',
  'tts_segment',
  'tts_stop',
] as const;

export type UnifiedChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export type ChatEventRenderTarget =
  | 'message_text'
  | 'message_image'
  | 'task_workbench'
  | 'stream_lifecycle'
  | 'message_error'
  | 'tool_approval'
  | 'terminal_panel';

export interface UnifiedChatEvent {
  type: UnifiedChatEventType;
  eventId: string;
  sessionId?: string | null;
  turnId?: string | null;
  taskId?: string | null;
  eventSequence: number;
  timestamp: string;
  content?: string | null;
  metadata: Record<string, unknown>;
  parentEventId?: string | null;
  depth: number;
  attemptNo: number;
  attemptGroupId?: string | null;
  branchId?: string | null;
}

export const CHAT_EVENT_RENDER_TARGET: Record<UnifiedChatEventType, ChatEventRenderTarget> = {
  text_delta: 'message_text',
  thought: 'task_workbench',
  llm_request: 'task_workbench',
  tool_call: 'task_workbench',
  approval_required: 'tool_approval',
  approval_resolved: 'task_workbench',
  tool_result: 'task_workbench',
  image: 'message_image',
  state: 'task_workbench',
  done: 'stream_lifecycle',
  error: 'message_error',
  terminal_session_opened: 'task_workbench',
  terminal_command_started: 'task_workbench',
  terminal_output: 'task_workbench',
  terminal_command_finished: 'task_workbench',
  terminal_session_reused: 'task_workbench',
  terminal_session_closed: 'task_workbench',
  tts_segment: 'stream_lifecycle',
  tts_stop: 'stream_lifecycle',
};

export function getChatEventRenderTarget(type: UnifiedChatEventType): ChatEventRenderTarget {
  return CHAT_EVENT_RENDER_TARGET[type];
}

export function isUnifiedChatEventType(type: string): type is UnifiedChatEventType {
  return CHAT_EVENT_TYPES.includes(type as UnifiedChatEventType);
}
