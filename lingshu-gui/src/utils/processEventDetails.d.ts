export interface ProcessEventSection {
  key: string;
  title: string;
  content: string;
  copyText: string;
}

export interface ProcessEventDetailOptions {
  terminalCommand?: string;
  terminalOutput?: string;
}

export function buildProcessEventSections(
  event: Record<string, any>,
  options?: ProcessEventDetailOptions,
): ProcessEventSection[];

export function buildToolCallEventSections(
  toolCallEvent: Record<string, any>,
  toolResultEvent?: Record<string, any> | null,
  options?: ProcessEventDetailOptions,
): ProcessEventSection[];
