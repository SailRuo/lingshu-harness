/** 助手气泡是否已有流式输出（文本或时间线事件）。 */
export function hasAssistantStreamProgress(message) {
  if (!message) return false;
  if (String(message.content || '').trim()) return true;
  const timeline = Array.isArray(message.metadata?.timelineEvents)
    ? message.metadata.timelineEvents
    : [];
  return timeline.length > 0;
}
