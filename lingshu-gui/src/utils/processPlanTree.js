function normalizeStep(step, index) {
  return {
    id: typeof step?.id === 'string' && step.id.trim() ? step.id : `step-${index + 1}`,
    index,
    label: typeof step?.label === 'string' && step.label.trim() ? step.label.trim() : `步骤 ${index + 1}`,
    actionType: typeof step?.actionType === 'string' ? step.actionType : '',
    status: typeof step?.status === 'string' ? step.status : 'pending',
    children: [],
  };
}

function resolveActiveStepIndex(steps, currentStepIndex) {
  if (Number.isInteger(currentStepIndex) && currentStepIndex >= 0 && currentStepIndex < steps.length) {
    return currentStepIndex;
  }

  const runningIndex = steps.findIndex((step) => step.status === 'running' || step.status === 'failed');
  if (runningIndex >= 0) {
    return runningIndex;
  }

  return Math.max(steps.length - 1, 0);
}

export function buildPlanStepTree(summary, activities) {
  const rawSteps = Array.isArray(summary?.steps) ? summary.steps : [];
  const steps = rawSteps.map(normalizeStep);
  if (steps.length === 0) {
    return [];
  }

  const activeStepIndex = resolveActiveStepIndex(steps, summary?.currentStepIndex);
  const toolStepIndices = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.actionType === 'call_tool')
    .map(({ index }) => index);
  const stepIndexById = new Map(steps.map((step, index) => [step.id, index]));

  let toolCursor = 0;

  for (const activity of Array.isArray(activities) ? activities : []) {
    if (!activity || typeof activity !== 'object') {
      continue;
    }

    const explicitStepId = typeof activity.stepId === 'string' && activity.stepId.trim()
      ? activity.stepId.trim()
      : null;
    const explicitStepIndex = Number.isInteger(activity.stepIndex) ? activity.stepIndex : null;
    let explicitTargetIndex = explicitStepId && stepIndexById.has(explicitStepId)
      ? stepIndexById.get(explicitStepId)
      : null;
    if (
      explicitTargetIndex === null
      && explicitStepIndex !== null
      && explicitStepIndex >= 0
      && explicitStepIndex < steps.length
    ) {
      explicitTargetIndex = explicitStepIndex;
    }

    if (activity.type === 'tool') {
      let targetIndex = explicitTargetIndex;
      if (targetIndex === null && explicitStepIndex !== null && explicitStepIndex >= 0 && explicitStepIndex < steps.length) {
        targetIndex = explicitStepIndex;
      }
      if (targetIndex === null || targetIndex === undefined) {
        targetIndex = toolStepIndices[toolCursor] ?? activeStepIndex;
        if (toolCursor < toolStepIndices.length) {
          toolCursor += 1;
        }
      }
      steps[targetIndex].children.push(activity);
      continue;
    }

    if (explicitTargetIndex !== null && explicitTargetIndex !== undefined) {
      steps[explicitTargetIndex].children.push(activity);
      continue;
    }

    steps[activeStepIndex].children.push(activity);
  }

  return steps;
}
