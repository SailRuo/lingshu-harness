/** Legacy terminal stream events (historical messages only). PTY UI removed; keep types for replay. */

const TERMINAL_STREAM_EVENT_TYPES = new Set([
  'terminal_session_opened',
  'terminal_session_reused',
  'terminal_command_started',
  'terminal_output',
  'terminal_command_finished',
  'terminal_session_closed',
]);

export function isTerminalStreamEventType(eventType) {
  return TERMINAL_STREAM_EVENT_TYPES.has(eventType);
}

export function applyTerminalEventState(state) {
  return state;
}
