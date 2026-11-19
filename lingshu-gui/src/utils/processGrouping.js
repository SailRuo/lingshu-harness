function metadataString(event, key) {
  const value = event?.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function eventKey(event) {
  return event?.eventId || `${event?.type || 'event'}-${event?.eventSequence || 0}`;
}

export function attemptGroupKey(event) {
  if (typeof event?.attemptGroupId === 'string' && event.attemptGroupId.trim()) {
    return `group:${event.attemptGroupId.trim()}`;
  }
  if (typeof event?.attemptNo === 'number' && Number.isFinite(event.attemptNo)) {
    return `attempt:${event.attemptNo}`;
  }
  return `event:${eventKey(event)}`;
}

export function buildAttemptGroups(nodes) {
  const groups = [];

  for (const node of nodes) {
    const key = attemptGroupKey(node.event);
    const retryReason = metadataString(node.event, 'retry_reason');
    const attemptNo = typeof node.event?.attemptNo === 'number' && Number.isFinite(node.event.attemptNo)
      ? node.event.attemptNo
      : groups.length + 1;
    const previous = groups[groups.length - 1];

    if (previous && previous.id === key) {
      previous.nodes.push(node);
      if (!previous.retryReason && retryReason) {
        previous.retryReason = retryReason;
      }
      continue;
    }

    groups.push({
      id: key,
      attemptNo,
      retryReason,
      nodes: [node],
    });
  }

  return groups;
}

export function retryReasonGroupLabel(retryReason) {
  if (retryReason === 'arg_repair') return '参数修复';
  if (retryReason === 'approval_resumed') return '审批恢复';
  if (retryReason === 'tool_fallback') return '工具切换';
  if (retryReason === 'continue_after_tool') return '继续后续步骤';
  if (retryReason === 'continue_after_plan') return '推进下一步';
  if (retryReason === 'skill_activated') return '技能激活';
  if (retryReason === 'replan_tail') return '尾部重规划';
  if (retryReason === 'replan_full') return '全量重规划';
  if (retryReason === 'skill_load_failed') return '技能加载失败';
  if (retryReason === 'parallel_group_failed') return '并行组失败';
  if (retryReason === 'parallel_group_completed') return '并行组完成';
  if (retryReason === 'final_validation_failed') return '最终验收未通过';
  return null;
}

export function isMeaningfulAttemptReason(retryReason) {
  if (!retryReasonGroupLabel(retryReason)) {
    return false;
  }
  return retryReason !== 'continue_after_tool' && retryReason !== 'continue_after_plan';
}

function hasMultipleAttemptNumbers(groups) {
  const attemptNumbers = (Array.isArray(groups) ? groups : [])
    .map((group) => group?.attemptNo)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (attemptNumbers.some((value) => value > 1)) {
    return true;
  }
  return new Set(attemptNumbers).size > 1;
}

export function shouldUseAttemptGroupLayout(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return false;
  }
  if (groups.some((group) => isMeaningfulAttemptReason(group?.retryReason))) {
    return true;
  }
  return hasMultipleAttemptNumbers(groups);
}

export function shouldShowAttemptGroupHeader(groups, group) {
  if (!group) {
    return false;
  }
  return isMeaningfulAttemptReason(group.retryReason) || hasMultipleAttemptNumbers(groups);
}

export function attemptGroupTone(group) {
  if (group?.retryReason === 'arg_repair' || group?.retryReason === 'approval_resumed' || group?.retryReason === 'skill_activated') {
    return 'accent';
  }
  if (
    group?.retryReason === 'tool_fallback'
    || group?.retryReason === 'replan_tail'
    || group?.retryReason === 'replan_full'
    || group?.retryReason === 'skill_load_failed'
    || group?.retryReason === 'parallel_group_failed'
    || group?.retryReason === 'final_validation_failed'
  ) {
    return 'warning';
  }
  return 'neutral';
}
