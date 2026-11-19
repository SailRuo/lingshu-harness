function isAssistantTextMessage(message) {
  return Boolean(message && message.type === 'text' && !message.isSelf);
}

function appendMirroredTimelineEvent(message, eventType, eventData) {
  const existing = Array.isArray(message?.metadata?.timelineEvents)
    ? message.metadata.timelineEvents
    : [];
  const eventSequence = Number((eventData && eventData.eventSequence) || 0);
  const eventId = typeof eventData?.eventId === 'string' ? eventData.eventId : '';

  if (
    (eventSequence > 0 && existing.some((event) => event?.eventSequence === eventSequence))
    || (eventId && existing.some((event) => event?.eventId === eventId))
  ) {
    return existing;
  }

  return [
    ...existing,
    {
      type: eventType,
      eventId: eventId || `${eventType}-${existing.length + 1}`,
      sessionId: null,
      turnId: null,
      taskId: eventData?.taskId || message?.metadata?.taskId || null,
      eventSequence,
      timestamp: null,
      content: eventData?.content || '',
      metadata: eventData?.metadata || {},
    },
  ];
}

export function isTerminalTaskStatus(status) {
  return new Set(['done', 'failed', 'canceled', 'budget_exhausted']).has(String(status || '').trim().toLowerCase());
}

export function syncTerminalTaskStatusAcrossMessages(messages, { taskId, normalizedStatus, eventType, eventData }) {
  if (!Array.isArray(messages) || !taskId || !isTerminalTaskStatus(normalizedStatus)) {
    return messages;
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isAssistantTextMessage(message) || message.metadata?.taskId !== taskId) {
      continue;
    }

    const seenEventIds = Array.isArray(message.metadata?.seenEventIds)
      ? message.metadata.seenEventIds
      : [];
    const nextSeenEventIds = eventData?.eventId && !seenEventIds.includes(eventData.eventId)
      ? [...seenEventIds, eventData.eventId]
      : seenEventIds;
    const timelineEvents = appendMirroredTimelineEvent(message, eventType, eventData);

    messages[index] = {
      ...message,
      status: 'sent',
      metadata: {
        ...message.metadata,
        run_status: normalizedStatus,
        seenEventIds: nextSeenEventIds,
        taskEvents: timelineEvents.filter((event) => event.type !== 'text_delta' && event.type !== 'error'),
        timelineEvents,
      },
    };
  }

  return messages;
}
