export interface TerminalEventState {
  terminalSessions: Record<string, unknown>;
  rawTerminalOutputMap: Record<string, string>;
  terminalOutputMap: Record<string, string>;
}

export function isTerminalStreamEventType(eventType: string): boolean;

export function applyTerminalEventState(state: TerminalEventState): TerminalEventState;
