function deriveRunStatus(events) {
  const lastStateEvent = [...events].reverse().find((event) => event.metadata?.run_status);
  if (lastStateEvent?.metadata?.run_status) {
    return String(lastStateEvent.metadata.run_status);
  }
  if (events.some((event) => event.type === 'done')) {
    return 'done';
  }
  return undefined;
}

function hydrateAssistantMessage(messages, taskId, events) {
  const targetIndex = messages.findIndex(
    (message) => message.type === 'text' && !message.isSelf && message.metadata?.taskId === taskId,
  );
  if (targetIndex === -1) {
    return messages;
  }

  const targetMessage = messages[targetIndex];
  const nextRunStatus = deriveRunStatus(events);
  const nextMessage = {
    ...targetMessage,
    metadata: {
      ...targetMessage.metadata,
      timelineEvents: events,
      taskEvents: events.filter((event) => event.type !== 'text_delta' && event.type !== 'error'),
      ...(nextRunStatus ? { run_status: nextRunStatus } : {}),
    },
  };

  return messages.map((message, index) => (index === targetIndex ? nextMessage : message));
}

export function hydrateHistoricalTaskState(messages, taskEventsById) {
  let nextMessages = [...messages];

  for (const [taskId, events] of Object.entries(taskEventsById)) {
    nextMessages = hydrateAssistantMessage(nextMessages, taskId, events);
  }

  return {
    messages: nextMessages,
  };
}
