export function derivePlanHardFailureSummary(events) {
  const eventWithFailure = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => event?.metadata?.plan_hard_failure === true);

  if (!eventWithFailure) {
    return null;
  }

  const metadata = eventWithFailure.metadata || {};
  const kind = typeof metadata.plan_failure_kind === 'string' && metadata.plan_failure_kind.trim()
    ? metadata.plan_failure_kind.trim()
    : 'execution_plan_invalid';
  const message = typeof metadata.plan_failure_message === 'string' && metadata.plan_failure_message.trim()
    ? metadata.plan_failure_message.trim()
    : '执行计划无效，已停止。';

  if (kind === 'planner_model_unsupported') {
    return {
      kind,
      message: '当前模型不支持结构化 Planner 输出，请切换模型。',
    };
  }

  if (kind === 'planner_model_invalid_output') {
    return {
      kind,
      message: '当前模型无法稳定生成结构化执行计划，请切换模型。',
    };
  }

  if (kind === 'execution_loop_detected') {
    return { kind, message };
  }

  return { kind, message };
}
