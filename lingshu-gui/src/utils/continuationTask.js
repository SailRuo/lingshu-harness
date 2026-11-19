import { deriveTaskStatusFromEvents } from './taskStatus.js';

function resolveMessageTaskStatus(message) {
  const timelineEvents = Array.isArray(message?.metadata?.timelineEvents)
    ? message.metadata.timelineEvents
    : [];
  if (timelineEvents.length > 0) {
    return String(deriveTaskStatusFromEvents(timelineEvents) || '').trim().toLowerCase();
  }
  return String(message?.metadata?.run_status || '').trim().toLowerCase();
}

export function resolveContinuationTaskId(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.isSelf || message.type !== 'text') {
      continue;
    }

    const taskId = message.metadata?.taskId;
    const runStatus = resolveMessageTaskStatus(message);
    if (taskId && runStatus === 'interrupted') {
      return String(taskId);
    }
  }

  return undefined;
}
