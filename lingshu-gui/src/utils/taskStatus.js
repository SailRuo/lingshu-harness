export function deriveTaskStatusFromEvents(events) {
  const planStatusEvent = [...events].reverse().find((event) => {
    const summary = event?.metadata?.execution_plan_summary;
    return summary && typeof summary === 'object' && typeof summary.status === 'string' && summary.status.trim();
  });
  const planStatus = typeof planStatusEvent?.metadata?.execution_plan_summary?.status === 'string'
    ? String(planStatusEvent.metadata.execution_plan_summary.status).toLowerCase()
    : '';
  if (planStatus === 'completed') {
    return 'done';
  }
  if (planStatus === 'failed') {
    return 'failed';
  }

  const statusEvent = [...events].reverse().find((event) => event.metadata?.run_status);
  if (statusEvent?.metadata?.run_status) {
    return String(statusEvent.metadata.run_status);
  }

  if (events.some((event) => event.type === 'done')) {
    return 'done';
  }

  return 'running';
}
