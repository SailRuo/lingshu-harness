export function deriveTaskStatusFromEvents(events: unknown[]): string {
  const planStatusEvent = [...events].reverse().find((event) => {
    if (!event || typeof event !== 'object') return false;
    const metadata = (event as { metadata?: { execution_plan_summary?: unknown } }).metadata;
    const summary = metadata?.execution_plan_summary;
    return Boolean(
      summary &&
      typeof summary === 'object' &&
      typeof (summary as { status?: unknown }).status === 'string' &&
      String((summary as { status?: unknown }).status).trim(),
    );
  });

  if (planStatusEvent && typeof planStatusEvent === 'object') {
    const metadata = (planStatusEvent as { metadata?: { execution_plan_summary?: unknown } }).metadata;
    const summary = metadata?.execution_plan_summary;
    const planStatus = summary && typeof summary === 'object' && typeof (summary as { status?: unknown }).status === 'string'
      ? String((summary as { status?: unknown }).status).toLowerCase()
      : '';
    if (planStatus === 'completed') return 'done';
    if (planStatus === 'failed') return 'failed';
  }

  const statusEvent = [...events].reverse().find((event) => {
    if (!event || typeof event !== 'object') return false;
    const metadata = (event as { metadata?: { run_status?: unknown } }).metadata;
    return Boolean(metadata?.run_status);
  });

  if (statusEvent && typeof statusEvent === 'object') {
    const metadata = (statusEvent as { metadata?: { run_status?: unknown } }).metadata;
    if (metadata?.run_status) {
      return String(metadata.run_status);
    }
  }

  if (
    events.some((event) => {
      if (!event || typeof event !== 'object') return false;
      return (event as { type?: unknown }).type === 'done';
    })
  ) {
    return 'done';
  }

  return 'running';
}
