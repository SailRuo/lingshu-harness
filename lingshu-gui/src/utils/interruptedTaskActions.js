function latestEventWithMetadata(events) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && typeof event === 'object' && event.metadata && typeof event.metadata === 'object') {
      return event;
    }
  }
  return null;
}

export function shouldOfferResumeForInterruptedTask(events, taskStatus) {
  if (String(taskStatus || '').toLowerCase() !== 'interrupted') {
    return false;
  }

  const latestEvent = latestEventWithMetadata(events);
  const metadata = latestEvent?.metadata || {};
  const actionType = String(metadata.action_type || '').trim().toLowerCase();
  const finalValidationReason = String(metadata.final_validation?.reason || '').trim().toLowerCase();

  if (actionType === 'ask_user') {
    return false;
  }
  if (metadata.needs_clarification === true) {
    return false;
  }
  if (finalValidationReason === 'ask_user') {
    return false;
  }

  return true;
}
