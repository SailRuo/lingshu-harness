<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { UnifiedChatEvent } from '../../types/chat-events';
import { sanitizeTerminalDisplayOutput } from '../../utils/terminalOutput.js';
import { buildProcessEventSections, buildToolCallEventSections } from '../../utils/processEventDetails.js';
import {
  buildAttemptGroups,
  retryReasonGroupLabel,
  attemptGroupTone,
  shouldShowAttemptGroupHeader,
  shouldUseAttemptGroupLayout,
} from '../../utils/processGrouping.js';
import { buildPlanStepTree } from '../../utils/processPlanTree.js';
import { derivePlanHardFailureSummary } from '../../utils/processFailureState.js';
import { shouldOfferResumeForInterruptedTask } from '../../utils/interruptedTaskActions.js';

defineOptions({ name: 'ThoughtProcess' });

const props = defineProps<{
  events: UnifiedChatEvent[];
  taskStatus: string;
  errorClass?: string | null;
  taskId?: string | null;
  nested?: boolean;
}>();

const emit = defineEmits<{
  resume: [taskId: string];
  cancel: [taskId: string];
}>();

const panelExpanded = ref(false);
const technicalDetailsExpanded = ref(false);
const expandedIds = ref<Set<string>>(new Set());
const expandedStepIds = ref<Set<string>>(new Set());
const expandedDecisionIds = ref<Set<string>>(new Set());
const lowSignalRetryReasons = new Set(['continue_after_tool', 'continue_after_plan', 'tool_fallback']);

watch(
  () => props.events,
  (events) => {
    if (props.nested) return;
    const hasToolActivity = events.some((event) => event.type === 'tool_call' || event.type === 'tool_result');
    if (hasToolActivity) {
      panelExpanded.value = true;
    }
  },
  { deep: true, immediate: true },
);

interface EventNode {
  event: UnifiedChatEvent;
  children: EventNode[];
}

interface TimelineActivity {
  id: string;
  type: string;
  label: string;
  node: EventNode;
  stepId?: string | null;
  stepIndex?: number | null;
}

const normalizedEvents = computed(() => mergeTerminalOutputEvents(props.events.filter((event) => event.type !== 'done')));
const nodes = computed(() => buildTree(normalizedEvents.value));
const visibleNodes = computed(() => nodes.value.filter((node) => !shouldHideNode(node)));
const attemptGroups = computed(() => buildAttemptGroups(visibleNodes.value) as {
  id: string;
  attemptNo: number;
  retryReason: string | null;
  nodes: EventNode[];
}[]);
const useAttemptGroupLayout = computed(() => shouldUseAttemptGroupLayout(attemptGroups.value));
const timelineActivities = computed<TimelineActivity[]>(() =>
  visibleNodes.value
    .map((node) => buildTimelineActivity(node))
    .filter((activity): activity is TimelineActivity => Boolean(activity)),
);
const planStepTree = computed(() =>
  executionPlanSummary.value?.steps?.length
    ? buildPlanStepTree(executionPlanSummary.value, timelineActivities.value)
    : [],
);
const latestEvent = computed(
  () =>
    [...normalizedEvents.value].reverse().find((event) => !['state', 'done'].includes(event.type)) ||
    normalizedEvents.value[normalizedEvents.value.length - 1],
);
const decisionContextSummary = computed(() => {
  if (planHardFailureSummary.value) {
    return null;
  }

  const eventWithSummary = [...props.events]
    .reverse()
    .find((event) => event.metadata?.decision_context && typeof event.metadata.decision_context === 'object');

  if (!eventWithSummary) {
    return null;
  }

  const context = eventWithSummary.metadata?.decision_context as Record<string, unknown>;
  const consumed = Array.isArray(context.required_skills_consumed)
    ? context.required_skills_consumed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const missingSkills = Array.isArray(context.missing_skills)
    ? context.missing_skills.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const missingRequirements = Array.isArray(context.missing_requirements)
    ? context.missing_requirements.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const satisfied = typeof context.required_skills_satisfied === 'boolean'
    ? context.required_skills_satisfied
    : null;
  const canFinalize = typeof context.can_finalize === 'boolean'
    ? context.can_finalize
    : null;

  if (consumed.length === 0 && missingSkills.length === 0 && missingRequirements.length === 0 && satisfied === null && canFinalize === null) {
    return null;
  }

  return { consumed, satisfied, canFinalize, missingSkills, missingRequirements };
});
const requiredSkillSummary = computed(() => decisionContextSummary.value);
const planHardFailureSummary = computed(() => derivePlanHardFailureSummary(props.events));
const activeSkillSummary = computed(() => {
  const eventWithSkills = [...props.events]
    .reverse()
    .find((event) => Array.isArray(event.metadata?.active_skills) || Array.isArray(event.metadata?.loaded_skills));
  if (!eventWithSkills) {
    return null;
  }

  const active = Array.isArray(eventWithSkills.metadata?.active_skills)
    ? eventWithSkills.metadata.active_skills.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const loaded = Array.isArray(eventWithSkills.metadata?.loaded_skills)
    ? eventWithSkills.metadata.loaded_skills
      .map((value) => {
        if (typeof value === 'string') return value.trim();
        if (value && typeof value === 'object') {
          const candidate = (value as Record<string, unknown>).name;
          return typeof candidate === 'string' ? candidate.trim() : '';
        }
        return '';
      })
      .filter((value): value is string => Boolean(value))
    : [];
  const merged = [...new Set([...active, ...loaded])];
  if (merged.length === 0) {
    return null;
  }
  return { active, loaded, merged };
});
const executionPlanSummary = computed(() => {
  const eventWithSummary = [...props.events]
    .reverse()
    .find((event) => event.metadata?.execution_plan_summary && typeof event.metadata.execution_plan_summary === 'object');

  if (!eventWithSummary || !eventWithSummary.metadata?.execution_plan_summary || typeof eventWithSummary.metadata.execution_plan_summary !== 'object') {
    return null;
  }

  const summary = eventWithSummary.metadata.execution_plan_summary as Record<string, unknown>;
  const stepCount = typeof summary.step_count === 'number' ? summary.step_count : 0;
  const completedStepCount = typeof summary.completed_step_count === 'number' ? summary.completed_step_count : 0;
  const rawSteps = Array.isArray(summary.steps) ? summary.steps : [];
  const steps = rawSteps
    .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object')
    .map((step, index) => ({
      id: typeof step.id === 'string' ? step.id : `step-${index + 1}`,
      label: typeof step.label === 'string' && step.label.trim() ? step.label.trim() : `步骤 ${index + 1}`,
      actionType: typeof step.action_type === 'string' ? step.action_type : '',
      status: typeof step.status === 'string' ? step.status : '',
      parallelGroup: typeof step.parallel_group === 'string' ? step.parallel_group : '',
      dependsOn: Array.isArray(step.depends_on)
        ? step.depends_on.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [],
      requiredSkillsUsed: Array.isArray(step.required_skills_used)
        ? step.required_skills_used.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [],
    }));

  return {
    goal: typeof summary.goal === 'string' ? summary.goal : '',
    status: typeof summary.status === 'string' ? summary.status : '',
    stepCount,
    completedStepCount,
    currentStepIndex: typeof summary.current_step_index === 'number' ? summary.current_step_index : 0,
    currentStepLabel: typeof summary.current_step_label === 'string' ? summary.current_step_label : '',
    currentStepStatus: typeof summary.current_step_status === 'string' ? summary.current_step_status : '',
    steps,
  };
});
const reflectSummary = computed(() => {
  const eventWithSummary = [...props.events]
    .reverse()
    .find((event) => event.metadata?.reflect_summary && typeof event.metadata.reflect_summary === 'object');

  if (!eventWithSummary || !eventWithSummary.metadata?.reflect_summary || typeof eventWithSummary.metadata.reflect_summary !== 'object') {
    return null;
  }

  const summary = eventWithSummary.metadata.reflect_summary as Record<string, unknown>;
  const rawSteps = Array.isArray(summary.steps) ? summary.steps : [];
  const steps = rawSteps
    .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object')
    .map((step, index) => ({
      id: typeof step.step_id === 'string' ? step.step_id : `reflect-step-${index + 1}`,
      stepIndex: typeof step.step_index === 'number' ? step.step_index : index,
      status: typeof step.status === 'string' ? step.status : '',
      requiredSkillsUsed: Array.isArray(step.required_skills_used)
        ? step.required_skills_used.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [],
    }));

  return {
    completedSteps: typeof summary.completed_steps === 'number' ? summary.completed_steps : 0,
    failedSteps: typeof summary.failed_steps === 'number' ? summary.failed_steps : 0,
    steps,
  };
});
function reflectStepForPlanStep(step: { id?: string; index?: number }) {
  const summary = reflectSummary.value;
  if (!summary?.steps?.length) return null;

  const stepId = typeof step.id === 'string' && step.id.trim() ? step.id.trim() : null;
  if (stepId) {
    const exactMatch = summary.steps.find((item) => item.id === stepId);
    if (exactMatch) return exactMatch;
  }

  const stepIndex = typeof step.index === 'number' ? step.index : null;
  if (stepIndex === null) return null;
  return summary.steps.find((item) => item.stepIndex === stepIndex) || null;
}

function stepDecisionPayloadForPlanStep(step: { id?: string; index?: number }) {
  const stepId = typeof step.id === 'string' && step.id.trim() ? step.id.trim() : null;
  const stepIndex = typeof step.index === 'number' ? step.index : null;
  const matchingEvent = [...props.events]
    .reverse()
    .find((event) => {
      if (event.type !== 'thought') return false;
      const nodeName = typeof event.metadata?.node_name === 'string' ? event.metadata.node_name.trim().toLowerCase() : '';
      if (!['decide', 'plan'].includes(nodeName)) return false;
      const payload = event.metadata?.step_decision_result;
      if (!payload || typeof payload !== 'object') return false;
      const payloadRecord = payload as Record<string, unknown>;
      const payloadStepId = typeof payloadRecord.step_id === 'string' ? payloadRecord.step_id.trim() : '';
      const payloadStepIndex = typeof payloadRecord.step_index === 'number' ? payloadRecord.step_index : null;
      if (stepId && payloadStepId && payloadStepId === stepId) return true;
      if (stepIndex !== null && payloadStepIndex === stepIndex) return true;
      return false;
    });

  if (!matchingEvent || !matchingEvent.metadata || typeof matchingEvent.metadata.step_decision_result !== 'object') {
    return null;
  }
  return matchingEvent.metadata.step_decision_result as Record<string, unknown>;
}

function stepDecisionResultLabel(step: { id?: string; index?: number }): string {
  const payload = stepDecisionPayloadForPlanStep(step);
  if (payload) {
    const summary = typeof payload.outcome_summary === 'string' ? payload.outcome_summary.trim() : '';
    if (summary) return summary;
    const status = typeof payload.status === 'string' ? payload.status.trim() : '';
    if (status) return `步骤结果: ${status === 'success' ? '成功' : status === 'failed' ? '失败' : status}`;
  }

  const reflectStep = reflectStepForPlanStep(step);
  if (!reflectStep) return '';

  const status = reflectStep.status === 'failed'
    ? '失败'
    : reflectStep.status === 'success'
      ? '成功'
      : (reflectStep.status || '未知');
  const skills = reflectStep.requiredSkillsUsed.length > 0
    ? ` | 技能: ${reflectStep.requiredSkillsUsed.join(', ')}`
    : '';
  return `步骤结果: ${status}${skills}`;
}

function stepDecisionResultTone(step: { id?: string; index?: number }): string {
  const payload = stepDecisionPayloadForPlanStep(step);
  if (payload) {
    const status = typeof payload.status === 'string' ? payload.status.trim() : '';
    if (status === 'failed') return 'failed';
    if (status === 'success') return 'success';
  }
  const reflectStep = reflectStepForPlanStep(step);
  if (!reflectStep) return 'unknown';
  if (reflectStep.status === 'failed') return 'failed';
  if (reflectStep.status === 'success') return 'success';
  return 'unknown';
}

function stepDecisionResultDetail(step: { id?: string; index?: number }): string {
  const payload = stepDecisionPayloadForPlanStep(step);
  if (payload) {
    const lines: string[] = [];
    const status = typeof payload.status === 'string' ? payload.status.trim() : '';
    if (status) {
      lines.push(`状态: ${status === 'success' ? '成功' : status === 'failed' ? '失败' : status}`);
    }
    const decision = typeof payload.decision === 'string' ? payload.decision.trim() : '';
    if (decision) {
      lines.push(`决策: ${postExecuteDecisionLabel(decision)}`);
    }
    const nextStep = typeof payload.next_step === 'string' ? payload.next_step.trim() : '';
    if (nextStep) {
      lines.push(`下一步: ${nextStep}`);
    }
    const nextToolName = typeof payload.next_tool_name === 'string' ? payload.next_tool_name.trim() : '';
    if (nextToolName) {
      lines.push(`下一步工具: ${nextToolName}`);
    }
    const evidence = typeof payload.evidence_text === 'string' ? payload.evidence_text.trim() : '';
    if (evidence) {
      lines.push(`结果摘要: ${evidence}`);
    }
    const note = typeof payload.note === 'string' ? payload.note.trim() : '';
    if (note) {
      lines.push(`备注: ${note}`);
    }
    const requiredSkillsUsed = Array.isArray(payload.required_skills_used)
      ? payload.required_skills_used.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    if (requiredSkillsUsed.length > 0) {
      lines.push(`已使用必需技能: ${requiredSkillsUsed.join(', ')}`);
    }
    const completedCriteria = Array.isArray(payload.completed_criteria)
      ? payload.completed_criteria.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    if (completedCriteria.length > 0) {
      lines.push(`已完成条件: ${completedCriteria.join('；')}`);
    }
    const unsatisfiedCriteria = Array.isArray(payload.unsatisfied_criteria)
      ? payload.unsatisfied_criteria.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    if (unsatisfiedCriteria.length > 0) {
      lines.push(`未满足条件: ${unsatisfiedCriteria.join('；')}`);
    }
    if (lines.length > 0) return lines.join('\n');
  }

  const reflectStep = reflectStepForPlanStep(step);
  if (!reflectStep) return '';

  const parts: string[] = [];
  const status = reflectStep.status === 'failed'
    ? '失败'
    : reflectStep.status === 'success'
      ? '成功'
      : (reflectStep.status || '未知');
  parts.push(`状态: ${status}`);
  if (reflectStep.requiredSkillsUsed.length > 0) {
    parts.push(`已使用必需技能: ${reflectStep.requiredSkillsUsed.join(', ')}`);
  }
  return parts.join('\n');
}

const postExecuteDecisionSummary = computed(() => {
  const eventWithDecision = [...props.events]
    .reverse()
    .find((event) => typeof event.metadata?.post_execute_decision === 'string');
  if (!eventWithDecision) {
    return null;
  }
  const decision = String(eventWithDecision.metadata.post_execute_decision || '').trim().toLowerCase();
  if (!decision) {
    return null;
  }
  const retryReason = metadataString(eventWithDecision, 'retry_reason');
  const replanKind = replanReasonKind(eventWithDecision);
  return {
    decision,
    retryReason,
    replanKind,
  };
});
const finalValidationSummary = computed(() => {
  const eventWithValidation = [...props.events]
    .reverse()
    .find((event) => event.metadata?.final_validation && typeof event.metadata.final_validation === 'object');
  if (!eventWithValidation || !eventWithValidation.metadata?.final_validation || typeof eventWithValidation.metadata.final_validation !== 'object') {
    return null;
  }
  const validation = eventWithValidation.metadata.final_validation as Record<string, unknown>;
  const status = typeof validation.status === 'string' ? validation.status : '';
  const reason = typeof validation.reason === 'string' ? validation.reason : '';
  if (!status && !reason) {
    return null;
  }
  return { status, reason };
});
const technicalDetailsAvailable = computed(() =>
  Boolean(
    requiredSkillSummary.value
    || activeSkillSummary.value
    || reflectSummary.value
    || postExecuteDecisionSummary.value
    || finalValidationSummary.value
    || timelineActivities.value.length > 0,
  ),
);
const processHeadline = computed(() => {
  if (planHardFailureSummary.value) return planHardFailureSummary.value.message;
  if (
    effectiveTaskStatus.value === 'running'
    && executionPlanSummary.value?.status === 'completed'
    && (decisionContextSummary.value?.missingRequirements?.length || decisionContextSummary.value?.missingSkills?.length)
  ) {
    return '当前规划已完成，正在补齐剩余条件';
  }
  if (effectiveTaskStatus.value === 'failed' && executionPlanSummary.value?.currentStepLabel) {
    return `${executionPlanSummary.value.currentStepLabel} 未完成`;
  }
  if (effectiveTaskStatus.value === 'done' && executionPlanSummary.value?.currentStepLabel) {
    return `${executionPlanSummary.value.currentStepLabel} 已完成`;
  }
  if (effectiveTaskStatus.value === 'done' && executionPlanSummary.value?.goal) {
    return '当前规划已完成';
  }
  if (executionPlanSummary.value?.currentStepLabel) {
    return `正在处理: ${executionPlanSummary.value.currentStepLabel}`;
  }
  return summaryLabel.value;
});
const processMetaChips = computed(() => {
  const chips: Array<{ label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }> = [];
  if (decisionContextSummary.value?.missingRequirements?.length) {
    chips.push({
      label: '还有任务条件待完成',
      tone: 'warning',
    });
  }
  if (decisionContextSummary.value?.missingSkills?.length) {
    chips.push({
      label: '需要补足技能条件',
      tone: 'warning',
    });
  }
  if (finalValidationSummary.value?.status === 'replan') {
    chips.push({
      label: '最终验收未通过',
      tone: 'danger',
    });
  }
  return chips;
});
const effectiveTaskStatus = computed(() => {
  const planStatus = String(executionPlanSummary.value?.status || '').toLowerCase();
  const currentStepStatus = String(executionPlanSummary.value?.currentStepStatus || '').toLowerCase();
  const hasMissingDecisionRequirements = Boolean(
    decisionContextSummary.value?.missingRequirements?.length
      || decisionContextSummary.value?.missingSkills?.length
      || decisionContextSummary.value?.canFinalize === false,
  );

  if (planStatus === 'completed' && !hasMissingDecisionRequirements) return 'done';
  if (planStatus === 'failed') return 'failed';
  if (currentStepStatus === 'failed') return 'failed';
  if (props.taskStatus === 'done' || props.taskStatus === 'failed') return props.taskStatus;
  if (props.taskStatus === 'canceled') return 'canceled';
  if (props.taskStatus === 'interrupted') return 'interrupted';
  if (props.taskStatus === 'resumed') return 'resumed';
  if (props.taskStatus === 'budget_exhausted') return 'budget_exhausted';
  return 'running';
});
const shouldShowResumeAction = computed(() =>
  shouldOfferResumeForInterruptedTask(props.events, effectiveTaskStatus.value),
);
const shouldShowDirectInputHint = computed(() =>
  effectiveTaskStatus.value === 'interrupted' && !shouldShowResumeAction.value,
);
const statusLabel = computed(() => {
  if (effectiveTaskStatus.value === 'done') return '已完成';
  if (effectiveTaskStatus.value === 'failed') return '执行失败';
  if (effectiveTaskStatus.value === 'canceled') return '已取消';
  if (effectiveTaskStatus.value === 'interrupted') return '等待处理';
  if (effectiveTaskStatus.value === 'resumed') return '已恢复';
  if (effectiveTaskStatus.value === 'budget_exhausted') return '预算耗尽';
  return '执行中';
});
const summaryLabel = computed(() => {
  if (planHardFailureSummary.value) {
    if (planHardFailureSummary.value.kind === 'planner_model_unsupported') {
      return '当前模型不支持 Planner';
    }
    if (planHardFailureSummary.value.kind === 'planner_model_invalid_output') {
      return '当前模型不适合作为 Planner';
    }
    if (planHardFailureSummary.value.kind === 'execution_loop_detected') {
      return '执行循环已停止';
    }
    return '规划失败，未进入执行';
  }

  if (effectiveTaskStatus.value === 'done') {
    if (executionPlanSummary.value?.goal) return '计划已完成';
    return '处理完成';
  }
  if (
    executionPlanSummary.value?.status === 'completed'
    && (decisionContextSummary.value?.missingRequirements?.length || decisionContextSummary.value?.missingSkills?.length)
  ) {
    return '当前规划已完成，正在继续规划';
  }
  if (effectiveTaskStatus.value === 'failed') {
    if (executionPlanSummary.value?.currentStepLabel) {
      return `${executionPlanSummary.value.currentStepLabel} 失败`;
    }
    return '处理失败';
  }
  if (effectiveTaskStatus.value === 'canceled') return '已取消';
  if (effectiveTaskStatus.value === 'interrupted') return '等待处理';
  if (effectiveTaskStatus.value === 'resumed') return '已恢复';
  if (effectiveTaskStatus.value === 'budget_exhausted') return '预算耗尽';

  if (finalValidationSummary.value?.status === 'replan') {
    return `最终验收未通过: ${finalValidationSummary.value.reason || '需要重规划'}`;
  }

  if (executionPlanSummary.value?.currentStepLabel) {
    return `当前步骤: ${executionPlanSummary.value.currentStepLabel}`;
  }

  const event = latestEvent.value;
  if (!event) return '处理中';
  const retryReason = metadataString(event, 'retry_reason');
  const resultClassification = metadataString(event, 'result_classification');
  if (retryReason === 'arg_repair') return '正在修正参数后重试';
  if (retryReason === 'approval_resumed') return '审批已通过，继续执行';
  if (retryReason === 'tool_fallback') return '正在重试';
  if (resultClassification === 'permission_error') return '等待授权后继续';
  if (resultClassification === 'tool_unavailable') {
    return event.metadata?.fallback_scheduled ? '正在切换备用工具' : '当前工具不可用';
  }
  if (resultClassification === 'environment_error') return '正在处理环境问题';
  if (event.type === 'terminal_command_started') return '正在执行终端命令';
  if (event.type === 'terminal_output') return '终端输出更新中';
  if (event.type === 'terminal_command_finished') return '终端命令已完成';
  if (event.type === 'tool_call') {
    const toolName = typeof event.metadata?.tool_name === 'string' ? event.metadata.tool_name : event.content;
    return `调用工具 ${toolName || ''}`.trim();
  }
  if (event.type === 'tool_result' && typeof event.content === 'string' && event.content.trim()) {
    return summarizeToolResult(event);
  }
  if (event.type === 'done') return '处理完成';
  return semanticLabel(event);
});

function buildTree(events: UnifiedChatEvent[]): EventNode[] {
  const lookup = new Map<string, EventNode>();
  const roots: EventNode[] = [];

  events.forEach((event) => {
    lookup.set(event.eventId, { event, children: [] });
  });

  events.forEach((event) => {
    const node = lookup.get(event.eventId);
    if (!node) return;

    if (event.parentEventId && lookup.has(event.parentEventId)) {
      lookup.get(event.parentEventId)?.children.push(node);
      return;
    }

    roots.push(node);
  });

  return roots;
}

function mergeTerminalOutputEvents(events: UnifiedChatEvent[]): UnifiedChatEvent[] {
  const merged: UnifiedChatEvent[] = [];

  for (const event of events) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.type === 'terminal_output' &&
      event.type === 'terminal_output' &&
      previous.parentEventId === event.parentEventId
    ) {
      merged[merged.length - 1] = {
        ...previous,
        content: `${previous.content || ''}${event.content || ''}`,
      };
      continue;
    }

    if (shouldMergeReflectStreamingEvent(previous, event)) {
      const nextContent = String(event.content || '').trim();
      const prevContent = String(previous.content || '').trim();
      merged[merged.length - 1] = {
        ...previous,
        // Reflect 阶段常以 thought/state 连续流式输出，保留最新片段避免出现多个“正在整理结果”块。
        content: nextContent || prevContent,
        eventSequence: event.eventSequence,
        timestamp: event.timestamp,
        metadata: {
          ...(previous.metadata || {}),
          ...(event.metadata || {}),
        },
      };
      continue;
    }

    merged.push(event);
  }

  return merged;
}

function shouldMergeReflectStreamingEvent(previous: UnifiedChatEvent | undefined, next: UnifiedChatEvent): boolean {
  if (!previous) return false;
  const mergeableTypes = new Set(['thought', 'state']);
  if (!mergeableTypes.has(previous.type) || !mergeableTypes.has(next.type)) return false;

  const previousNode = String(previous.metadata?.node_name || '').toLowerCase();
  const nextNode = String(next.metadata?.node_name || '').toLowerCase();
  if (previousNode !== 'reflect' || nextNode !== 'reflect') return false;

  // 仅合并同一父节点的连续 reflect 流式事件，避免误伤真实多步骤节点。
  return String(previous.parentEventId || '') === String(next.parentEventId || '');
}

function flattenNodes(nodes: EventNode[]): UnifiedChatEvent[] {
  return nodes.flatMap((node) => [node.event, ...flattenNodes(node.children)]);
}

function eventKey(event: UnifiedChatEvent): string {
  return event.eventId || `${event.type}-${event.eventSequence}`;
}

function togglePanel() {
  panelExpanded.value = !panelExpanded.value;
}

function toggleTechnicalDetails() {
  technicalDetailsExpanded.value = !technicalDetailsExpanded.value;
}

function toggleNode(event: UnifiedChatEvent) {
  const key = eventKey(event);
  const next = new Set(expandedIds.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedIds.value = next;
}

function isExpanded(event: UnifiedChatEvent): boolean {
  return expandedIds.value.has(eventKey(event));
}

function toggleStep(stepId: string) {
  const next = new Set(expandedStepIds.value);
  if (next.has(stepId)) next.delete(stepId);
  else next.add(stepId);
  expandedStepIds.value = next;
}

function stepDecisionNodeId(step: { id?: string; index?: number }): string {
  const stepId = typeof step.id === 'string' && step.id.trim() ? step.id.trim() : `step-${typeof step.index === 'number' ? step.index + 1 : 'unknown'}`;
  return `step-decision:${stepId}`;
}

function toggleStepDecision(step: { id?: string; index?: number }) {
  const next = new Set(expandedDecisionIds.value);
  const id = stepDecisionNodeId(step);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedDecisionIds.value = next;
}

function isStepDecisionExpanded(step: { id?: string; index?: number }): boolean {
  return expandedDecisionIds.value.has(stepDecisionNodeId(step));
}

function isStepExpanded(step: { id: string; status: string; children: unknown[] }): boolean {
  if (!step.children.length) {
    return false;
  }
  if (expandedStepIds.value.has(step.id)) {
    return true;
  }
  if (step.status === 'running' || step.status === 'failed') {
    return true;
  }
  return step.children.length > 0 && step.status !== 'completed';
}

function semanticLabel(event: UnifiedChatEvent): string {
  const nodeName = typeof event.metadata?.node_name === 'string' ? event.metadata.node_name : null;
  const retryReason = metadataString(event, 'retry_reason');
  const resultClassification = metadataString(event, 'result_classification');
  const replanKind = replanReasonKind(event);
  if (event.type === 'tool_call') {
    if (retryReason === 'tool_fallback') return '正在切换到备用工具';
    const toolName = typeof event.metadata?.tool_name === 'string' ? event.metadata.tool_name : event.content;
    return toolName ? `调用工具 ${toolName}` : '正在调用工具';
  }
  if (event.type === 'llm_request') {
    return humanizeLlmRequest(event, nodeName);
  }
  if (event.type === 'tool_result') return humanizeToolResult(event, resultClassification);
  if (event.type === 'terminal_command_started') return '正在执行终端命令';
  if (event.type === 'terminal_output') return '终端输出更新中';
  if (event.type === 'terminal_command_finished') return '终端命令已完成';
  if (event.type === 'terminal_session_opened' || event.type === 'terminal_session_reused') return '终端会话已就绪';
  if (event.type === 'terminal_session_closed') return '终端会话已关闭';
  if (event.type === 'state') return humanizeState(event.content, nodeName);
  if (event.type === 'approval_required') {
    const toolName = typeof event.metadata?.tool_name === 'string' ? event.metadata.tool_name : '';
    return `等待审批: ${toolName}`;
  }
  if (event.type === 'approval_resolved') {
    const resolution = metadataString(event, 'resolution');
    if (resolution === 'approved') return '审批已通过';
    if (resolution === 'rejected') return '审批已拒绝';
    return '审批已完成';
  }
  if (event.type === 'done') return '处理完成';
  if (event.type === 'thought') return humanizeThought(event.content, nodeName, retryReason, replanKind);
  if (replanKind === 'parallel_group_failed') return '并行组失败，正在重规划';
  if (replanKind === 'final_validation_failed') return '最终验收未通过，正在重规划';
  if (nodeName) return humanizeNodeName(nodeName);
  return event.content || event.type;
}

function buildTimelineActivity(node: EventNode): TimelineActivity | null {
  const stepId = metadataString(node.event, 'step_id');
  const rawStepIndex = node.event.metadata?.step_index;
  const stepIndex = typeof rawStepIndex === 'number' && Number.isInteger(rawStepIndex) ? rawStepIndex : null;
  const nodeName = typeof node.event.metadata?.node_name === 'string' ? node.event.metadata.node_name.trim().toLowerCase() : '';

  if (node.event.type === 'tool_call') {
    return {
      id: eventKey(node.event),
      type: 'tool',
      label: semanticLabel(node.event),
      node,
      stepId,
      stepIndex,
    };
  }

  if (node.event.type === 'llm_request') {
    return {
      id: eventKey(node.event),
      type: 'diagnostic',
      label: semanticLabel(node.event),
      node,
      stepId,
      stepIndex,
    };
  }

  if (node.event.type === 'thought' && nodeName === 'decide') {
    return {
      id: eventKey(node.event),
      type: 'decision',
      label: semanticLabel(node.event),
      node,
      stepId,
      stepIndex,
    };
  }

  if (node.event.type === 'approval_resolved' || node.event.type === 'approval_required') {
    return {
      id: eventKey(node.event),
      type: 'diagnostic',
      label: semanticLabel(node.event),
      node,
      stepId,
      stepIndex,
    };
  }

  if (node.event.type === 'thought' && metadataString(node.event, 'retry_reason')) {
    return {
      id: eventKey(node.event),
      type: 'diagnostic',
      label: semanticLabel(node.event),
      node,
      stepId,
      stepIndex,
    };
  }

  if (node.event.type === 'tool_result' && eventTone(node.event) === 'error') {
    return {
      id: eventKey(node.event),
      type: 'diagnostic',
      label: semanticLabel(node.event),
      node,
      stepId,
      stepIndex,
    };
  }

  return null;
}

function metadataString(event: UnifiedChatEvent, key: string): string | null {
  const value = event.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function replanReasonKind(event: UnifiedChatEvent): string | null {
  const replanReason = event.metadata?.replan_reason;
  if (!replanReason || typeof replanReason !== 'object') return null;
  const kind = (replanReason as Record<string, unknown>).kind;
  return typeof kind === 'string' && kind.trim() ? kind.trim() : null;
}

function requiredSkillSummaryLabel(): string {
  const summary = requiredSkillSummary.value;
  if (!summary) return '';
  if (summary.missingSkills.length > 0) return `需补技能条件: ${summary.missingSkills.join(', ')}`;
  if (summary.missingRequirements.length > 0) return `待完成条件: ${summary.missingRequirements.join('、')}`;
  if (summary.consumed.length === 0) return '决策检查';
  return `已满足必需技能: ${summary.consumed.join(', ')}`;
}

function executionPlanProgressLabel(): string {
  const summary = executionPlanSummary.value;
  if (!summary) return '';
  if (summary.status === 'completed') return '当前规划';
  if (summary.status === 'failed') return '当前规划';
  if (summary.currentStepLabel) return '当前处理';
  return '处理中';
}

function executionPlanStatusLabel(): string {
  if (planHardFailureSummary.value) return '规划校验失败';
  const summary = executionPlanSummary.value;
  if (!summary) return '';
  if (summary.status === 'completed') return '已完成';
  if (summary.status === 'failed') return '执行失败';
  if (summary.currentStepLabel) return `当前: ${summary.currentStepLabel}`;
  return '执行中';
}

function executionPlanStepTone(status: string): string {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  return 'pending';
}

function executionStepStatusLabel(status: string): string {
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'running') return '执行中';
  return '待执行';
}

function executionStepHint(step: { parallelGroup?: string; dependsOn?: string[]; actionType?: string }): string {
  const hints: string[] = [];
  if (step.parallelGroup) {
    hints.push(`并行组 ${step.parallelGroup}`);
  }
  if (Array.isArray(step.dependsOn) && step.dependsOn.length > 0) {
    hints.push(`依赖 ${step.dependsOn.join(', ')}`);
  }
  return hints.join(' | ');
}

function reflectSummaryLabel(): string {
  const summary = reflectSummary.value;
  if (!summary) return '';
  if (summary.failedSteps > 0) return `步骤复盘: ${summary.completedSteps} 成功, ${summary.failedSteps} 失败`;
  return '步骤复盘: 已完成';
}

function reflectStepStatusLabel(status: string): string {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  return status || '未知';
}

function postExecuteDecisionLabel(decision: string): string {
  if (decision === 'continue_plan') return '继续计划';
  if (decision === 'finalize') return '进入最终复盘';
  return decision || '未知决策';
}

function postExecuteDecisionReasonLabel(summary: { retryReason: string | null; replanKind: string | null }): string {
  if (summary.replanKind === 'parallel_group_failed') return '并行组失败';
  if (summary.replanKind === 'final_validation_failed') return '最终验收未通过';
  if (summary.retryReason) {
    return retryReasonGroupLabel(summary.retryReason) || summary.retryReason;
  }
  return '按当前状态推进';
}

function eventRequiredSkills(event: UnifiedChatEvent): string[] {
  const direct = event.metadata?.required_skills_used;
  if (Array.isArray(direct)) {
    return direct.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  const consumed = event.metadata?.required_skills_consumed;
  if (Array.isArray(consumed)) {
    return consumed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  return [];
}

function detailLines(event: UnifiedChatEvent): string[] {
  const lines: string[] = [];
  if (event.type === 'llm_request') return lines;
  if (event.type === 'tool_call' || event.type === 'tool_result') return lines;
  if (typeof event.content === 'string' && !['thought', 'tool_call'].includes(event.type)) {
    lines.push(event.type === 'terminal_output' ? sanitizeTerminalDisplayOutput(event.content) : event.content);
  }
  if (typeof event.metadata?.preview === 'string') {
    lines.push(event.metadata.preview);
  }
  if (typeof event.metadata?.error_class === 'string') {
    lines.push(`error: ${event.metadata.error_class}`);
  }
  return lines.filter(Boolean);
}

function statusClass(status: string): string {
  return `status-${status}`;
}

function eventTone(event: UnifiedChatEvent): string {
  if (event.type === 'llm_request') return 'diagnostic';
  if (event.type === 'tool_result' && typeof event.content === 'string' && event.content.startsWith('Error:')) {
    return 'error';
  }
  if (event.type === 'tool_call') return 'action';
  if (event.type === 'thought') return 'thought';
  return 'neutral';
}

function isTerminalEvent(event: UnifiedChatEvent): boolean {
  return [
    'terminal_session_opened',
    'terminal_session_reused',
    'terminal_command_started',
    'terminal_output',
    'terminal_command_finished',
    'terminal_session_closed',
  ].includes(event.type);
}

function isRunTerminalToolCall(event: UnifiedChatEvent): boolean {
  const toolName = typeof event.metadata?.tool_name === 'string' ? event.metadata.tool_name : event.content;
  return event.type === 'tool_call' && toolName === 'run_terminal_command';
}

function terminalCommandText(node: EventNode): string | null {
  if (!isRunTerminalToolCall(node.event)) return null;
  const resultNode = directToolResultChild(node);
  const toolResult = resultNode?.event?.metadata?.tool_result as Record<string, unknown> | undefined;
  const executedCommand = toolResult?.executed_command;
  if (typeof executedCommand === 'string' && executedCommand.trim()) {
    return executedCommand.trim();
  }
  const started = node.children.find((child) => child.event.type === 'terminal_command_started');
  if (typeof started?.event.content === 'string' && started.event.content.trim()) {
    return started.event.content.trim();
  }
  const args = node.event.metadata?.tool_args ?? node.event.metadata?.arguments;
  if (args && typeof args === 'object' && typeof (args as Record<string, unknown>).command === 'string') {
    return ((args as Record<string, unknown>).command as string).trim();
  }
  return null;
}

function terminalOutputText(node: EventNode): string {
  if (!isRunTerminalToolCall(node.event)) return '';
  const combined = node.children
    .filter((child) => child.event.type === 'terminal_output' && typeof child.event.content === 'string')
    .map((child) => child.event.content || '')
    .join('');
  return sanitizeTerminalDisplayOutput(combined);
}

function processSections(node: EventNode): { key: string; title: string; content: string; copyText: string }[] {
  const detailOptions = {
    terminalCommand: terminalCommandText(node) || '',
    terminalOutput: terminalOutputText(node),
  };
  const resultNode = directToolResultChild(node);
  const sections = node.event.type === 'tool_call'
    ? buildToolCallEventSections(node.event, resultNode?.event || null, detailOptions)
    : buildProcessEventSections(node.event, detailOptions);

  return sections;
}

function nodeHasExpandableContent(node: EventNode): boolean {
  if (eventRequiredSkills(node.event).length > 0) return true;
  if (processSections(node).length > 0) return true;
  if (detailLines(node.event).length > 0) return true;
  if (visibleChildren(node).length > 0) return true;
  return false;
}

function stepHasExpandableContent(step: { children: unknown[] }): boolean {
  return Array.isArray(step.children) && step.children.length > 0;
}

function showAttemptGroupHeader(group: { id: string; attemptNo: number; retryReason: string | null; nodes: EventNode[] }): boolean {
  return shouldShowAttemptGroupHeader(attemptGroups.value, group);
}

function visibleChildren(node: EventNode): EventNode[] {
  return node.children.filter((child) => !shouldHideChildEvent(node, child) && !shouldHideNode(child));
}

function directToolResultChild(node: EventNode): EventNode | null {
  return node.children.find((child) => child.event.type === 'tool_result') || null;
}

function toolResultCanCollapse(parent: EventNode, child: EventNode): boolean {
  if (parent.event.type !== 'tool_call' || child.event.type !== 'tool_result') {
    return false;
  }

  const classification = metadataString(child.event, 'result_classification');
  if (classification && classification !== 'success') {
    return false;
  }

  if (typeof child.event.metadata?.error_class === 'string' && child.event.metadata.error_class.trim()) {
    return false;
  }

  const content = typeof child.event.content === 'string' ? child.event.content.trim() : '';
  if (content.startsWith('Error:')) {
    return false;
  }

  if (eventRequiredSkills(child.event).length > 0) {
    return false;
  }

  if (visibleChildren(child).length > 0) {
    return false;
  }

  return true;
}

function isLowSignalLifecycleNode(node: EventNode): boolean {
  if (!executionPlanSummary.value?.steps?.length) {
    return false;
  }

  if (visibleChildren(node).length > 0) {
    return false;
  }

  if (eventRequiredSkills(node.event).length > 0) {
    return false;
  }

  const retryReason = metadataString(node.event, 'retry_reason');
  if (retryReason && lowSignalRetryReasons.has(retryReason)) {
    return true;
  }
  if (retryReason) {
    return false;
  }

  if (node.event.type === 'state') {
    return true;
  }

  if (node.event.type !== 'thought') {
    return false;
  }

  const nodeName = typeof node.event.metadata?.node_name === 'string' ? node.event.metadata.node_name.trim().toLowerCase() : '';
  if (nodeName === 'plan') {
    return false;
  }
  if (!['observe', 'plan', 'reflect', 'bind_skill'].includes(nodeName)) {
    return false;
  }

  const content = typeof node.event.content === 'string' ? node.event.content.trim() : '';
  if (!content) {
    return true;
  }

  return content.length <= 18;
}

function shouldHideNode(node: EventNode): boolean {
  return isLowSignalLifecycleNode(node);
}

function shouldHideChildEvent(parent: EventNode, child: EventNode): boolean {
  if (isTerminalEvent(child.event)) {
    return true;
  }

  if (toolResultCanCollapse(parent, child)) {
    return true;
  }

  if (isRunTerminalToolCall(parent.event) && child.event.type === 'tool_result') {
    const terminalOutput = terminalOutputText(parent).trim();
    const toolResult = typeof child.event.content === 'string' ? child.event.content.trim() : '';
    if (terminalOutput && toolResult && terminalOutput === toolResult) {
      return true;
    }
  }

  return false;
}

function nodeOutcomeLabel(node: EventNode): string | null {
  const resultNode = directToolResultChild(node);
  if (!resultNode || !toolResultCanCollapse(node, resultNode)) {
    return null;
  }

  const classification = metadataString(resultNode.event, 'result_classification');
  if (classification === 'success') {
    return '已返回结果';
  }

  const content = typeof resultNode.event.content === 'string' ? resultNode.event.content.trim() : '';
  if (!content) {
    return '已返回结果';
  }

  return content.length > 20 ? `${content.slice(0, 20)}...` : content;
}

function humanizeToolResult(event: UnifiedChatEvent, classification: string | null): string {
  if (classification === 'permission_error') return '需要授权才能继续';
  if (classification === 'tool_unavailable') {
    return event.metadata?.fallback_scheduled ? '工具不可用，已切换备用工具' : '当前工具不可用';
  }
  if (classification === 'environment_error') return '运行环境暂时不可用';
  if (classification === 'arg_error') return '参数不兼容，准备重试';
  if (classification === 'cooldown_active') return '发送间隔未满，暂不可用';
  if (classification === 'daily_quota_exhausted') return '今日额度已用尽，暂不可用';
  if (classification === 'failure') return '工具执行失败';
  if (typeof event.content === 'string' && event.content.startsWith('Error:')) {
    return '工具返回错误';
  }
  return '工具已返回结果';
}

function humanizeState(content: string | null | undefined, nodeName: string | null): string {
  const normalized = String(content || nodeName || '').toLowerCase();
  if (normalized.includes('running')) return '正在处理';
  if (normalized.includes('done')) return '处理完成';
  if (normalized.includes('failed')) return '处理失败';
  if (normalized.includes('interrupted')) return '等待你的确认';
  if (normalized.includes('budget_exhausted')) return '已达预算上限';
  if (normalized.includes('resumed')) return '已从恢复点继续';
  return '状态已更新';
}

function humanizeThought(
  content: string | null | undefined,
  nodeName: string | null,
  retryReason: string | null,
  replanKind: string | null,
): string {
  if (replanKind === 'parallel_group_failed') return '并行组失败，正在重规划';
  if (replanKind === 'final_validation_failed') return '最终验收未通过，正在重规划';
  if (retryReason === 'arg_repair') return '正在修正参数后重试';
  if (retryReason === 'approval_resumed') return '审批已通过，继续执行';
  if (retryReason && lowSignalRetryReasons.has(retryReason)) return content?.trim() || humanizeNodeName(nodeName);
  if (content && content.trim()) return content.trim();
  return humanizeNodeName(nodeName);
}

function summarizeToolResult(event: UnifiedChatEvent): string {
  const classification = metadataString(event, 'result_classification');
  if (classification) return humanizeToolResult(event, classification);
  if (typeof event.content !== 'string') return '工具已返回结果';
  const content = event.content.trim();
  if (!content) return '工具已返回结果';
  return content.length > 48 ? `${content.slice(0, 48)}...` : content;
}

function humanizeNodeName(nodeName: string | null): string {
  const normalized = String(nodeName || '').toLowerCase();
  if (normalized === 'observe') return '正在判断下一步';
  if (normalized === 'plan') return '正在规划处理方式';
  if (normalized === 'bind_skill') return '正在加载技能';
  if (normalized === 'execute') return '正在执行操作';
  if (normalized === 'decide' || normalized === 'step_reflect') return '正在判断下一步';
  if (normalized === 'reflect') {
    if (planHardFailureSummary.value?.kind === 'planner_model_unsupported') return '模型不支持 Planner';
    if (planHardFailureSummary.value?.kind === 'planner_model_invalid_output') return '模型不适合作为 Planner';
    if (planHardFailureSummary.value?.kind === 'execution_loop_detected') return '执行循环已停止';
    return planHardFailureSummary.value ? '规划失败' : '正在整理结果';
  }
  if (normalized === 'vm') return '计划执行';
  return '处理中';
}

function humanizeLlmRequest(event: UnifiedChatEvent, nodeName: string | null): string {
  const source = typeof event.metadata?.llm_source === 'string' ? event.metadata.llm_source.trim() : '';
  const model = typeof event.metadata?.llm_model === 'string' ? event.metadata.llm_model.trim() : '';
  const label = nodeName === 'plan'
    ? 'Planner LLM 请求'
    : nodeName === 'observe'
      ? 'Triage LLM 请求'
      : nodeName
        ? `${humanizeNodeName(nodeName)}的 LLM 请求`
        : 'LLM 请求';
  return model ? `${label} · ${model}` : (source ? `${label} · ${source}` : label);
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    // 这里可以加一个简单的反馈，比如 Arco 的 Message
    import('@arco-design/web-vue').then(({ Message }) => {
      Message.success('已复制到剪贴板');
    });
  } catch (err) {
    console.error('Failed to copy:', err);
  }
}
</script>

<template>
  <section class="thought-process" :class="{ nested: nested, expanded: panelExpanded && !nested }">
    <button
      v-if="!nested"
      type="button"
      class="process-summary"
      :class="statusClass(effectiveTaskStatus)"
      @click="togglePanel"
    >
      <span class="summary-left">
        <span class="node-toggle" :class="{ expanded: panelExpanded }" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="status-chip">{{ statusLabel }}</span>
        <span class="summary-text">{{ summaryLabel }}</span>
      </span>
    </button>

    <div v-if="nested || panelExpanded" class="tree-list">
      <div v-if="!nested" class="debug-panel-header">
        <div class="process-overview">
          <span class="debug-panel-title">执行过程</span>
          <p class="process-headline">{{ processHeadline }}</p>
        </div>
        <button
          v-if="technicalDetailsAvailable"
          type="button"
          class="detail-toggle-button"
          @click="toggleTechnicalDetails"
        >
          {{ technicalDetailsExpanded ? '隐藏细节' : '查看细节' }}
        </button>
      </div>
      <div v-if="!nested && effectiveTaskStatus === 'interrupted'" class="task-actions">
        <button v-if="taskId && shouldShowResumeAction" type="button" class="ghost-button" @click.stop="emit('resume', taskId)">恢复</button>
        <button v-if="taskId" type="button" class="ghost-button" @click.stop="emit('cancel', taskId)">取消</button>
        <span v-if="shouldShowDirectInputHint" class="task-hint-chip">直接在下方输入补充信息继续</span>
      </div>
      <div v-if="executionPlanSummary || processMetaChips.length" class="execution-plan-summary">
        <span class="execution-plan-chip">
          {{ executionPlanProgressLabel() }}
        </span>
        <span class="execution-plan-text">
          {{ executionPlanStatusLabel() }}
        </span>
        <span
          v-for="chip in processMetaChips"
          :key="chip.label"
          class="meta-chip"
          :class="chip.tone || 'neutral'"
        >
          {{ chip.label }}
        </span>
      </div>
      <div v-if="technicalDetailsExpanded && requiredSkillSummary" class="required-skill-summary">
        <span
          class="required-skill-chip"
          :class="{ satisfied: requiredSkillSummary.satisfied, unsatisfied: requiredSkillSummary.satisfied === false }"
        >
          {{ requiredSkillSummaryLabel() }}
        </span>
        <span
          class="required-skill-state"
          :class="{ satisfied: requiredSkillSummary.canFinalize !== false && requiredSkillSummary.satisfied !== false, unsatisfied: requiredSkillSummary.canFinalize === false || requiredSkillSummary.satisfied === false }"
        >
          {{ requiredSkillSummary.canFinalize === false || requiredSkillSummary.satisfied === false ? '待继续' : '已满足' }}
        </span>
      </div>
      <div v-if="technicalDetailsExpanded && activeSkillSummary" class="active-skill-summary">
        <span class="active-skill-summary-label">已激活技能</span>
        <span
          v-for="skill in activeSkillSummary.merged"
          :key="skill"
          class="active-skill-chip"
        >
          {{ skill }}
        </span>
      </div>

      <div v-if="executionPlanSummary?.steps?.length" class="plan-tree">
        <article
          v-for="step in planStepTree"
          :key="step.id"
          class="plan-tree-step"
          :class="executionPlanStepTone(step.status)"
        >
          <button type="button" class="plan-tree-step-summary" @click="toggleStep(step.id)">
            <span class="plan-tree-step-main">
              <span v-if="stepHasExpandableContent(step)" class="node-toggle" :class="{ expanded: isStepExpanded(step) }" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none">
                  <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              <span v-else class="node-toggle-spacer" aria-hidden="true"></span>
              <span class="execution-plan-step-label">{{ step.label }}</span>
            </span>
            <span class="plan-tree-step-meta">
              <span class="execution-plan-step-status" :class="step.status || 'pending'">
                {{ executionStepStatusLabel(step.status) }}
              </span>
              <span v-if="technicalDetailsExpanded && executionStepHint(step)" class="execution-plan-step-hint">
                {{ executionStepHint(step) }}
              </span>
            </span>
          </button>

          <div v-if="isStepExpanded(step) && (step.children.length > 0 || stepDecisionResultLabel(step))" class="plan-tree-step-body">
            <article v-for="activity in step.children" :key="activity.id" class="tree-node activity-node">
              <button type="button" class="node-summary" :class="activity.type" @click="nodeHasExpandableContent(activity.node) ? toggleNode(activity.node.event) : undefined">
                <span v-if="nodeHasExpandableContent(activity.node)" class="node-toggle" :class="{ expanded: isExpanded(activity.node.event) }" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
                <span v-else class="node-toggle-spacer" aria-hidden="true"></span>
                <span class="node-label">{{ activity.label }}</span>
                <span class="node-summary-meta">
                  <span v-if="nodeOutcomeLabel(activity.node)" class="node-outcome">
                    {{ nodeOutcomeLabel(activity.node) }}
                  </span>
                </span>
              </button>

              <div v-if="nodeHasExpandableContent(activity.node) && isExpanded(activity.node.event)" class="node-body">
                <div v-if="technicalDetailsExpanded && eventRequiredSkills(activity.node.event).length > 0" class="event-required-skills">
                  <span class="event-required-skills-label">必需技能</span>
                  <span
                    v-for="skill in eventRequiredSkills(activity.node.event)"
                    :key="skill"
                    class="event-required-skill-chip"
                  >
                    {{ skill }}
                  </span>
                </div>
                <div
                  v-for="section in processSections(activity.node)"
                  :key="`${eventKey(activity.node.event)}-${section.key}`"
                  class="detail-section"
                >
                  <div class="detail-section-label">{{ section.title }}</div>
                  <div class="code-wrapper detail-section-body">
                    <pre class="node-detail">{{ section.content }}</pre>
                    <button type="button" class="copy-button" @click.stop="copyToClipboard(section.copyText)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                  </div>
                </div>
                <div v-for="line in detailLines(activity.node.event)" :key="line" class="code-wrapper">
                  <pre class="node-detail">{{ line }}</pre>
                  <button type="button" class="copy-button" @click.stop="copyToClipboard(line)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  </button>
                </div>
              </div>
            </article>
            <article
              v-if="stepDecisionResultLabel(step)"
              class="tree-node activity-node step-decision-node"
            >
              <button
                type="button"
                class="node-summary decision"
                @click="stepDecisionResultDetail(step) ? toggleStepDecision(step) : undefined"
              >
                <span v-if="stepDecisionResultDetail(step)" class="node-toggle" :class="{ expanded: isStepDecisionExpanded(step) }" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
                <span v-else class="node-toggle-spacer" aria-hidden="true"></span>
                <span class="node-label">步骤结果</span>
                <span class="node-summary-meta">
                  <span class="node-outcome" :class="stepDecisionResultTone(step)">
                    {{ stepDecisionResultLabel(step) }}
                  </span>
                </span>
              </button>
              <div v-if="stepDecisionResultDetail(step) && isStepDecisionExpanded(step)" class="node-body step-decision-body">
                <div class="code-wrapper">
                  <pre class="node-detail">{{ stepDecisionResultDetail(step) }}</pre>
                  <button type="button" class="copy-button" @click.stop="copyToClipboard(stepDecisionResultDetail(step))">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2 2h9a2 2 0 0 1 2 2v1"></path></svg>
                  </button>
                </div>
              </div>
            </article>
          </div>
        </article>
      </div>

      <div v-if="technicalDetailsExpanded && reflectSummary" class="reflect-summary">
        <span class="reflect-summary-chip" :class="{ failed: reflectSummary.failedSteps > 0 }">
          {{ reflectSummaryLabel() }}
        </span>
        <div v-if="reflectSummary.steps.length > 0" class="reflect-summary-steps">
          <div
            v-for="step in reflectSummary.steps"
            :key="step.id"
            class="reflect-summary-step"
            :class="step.status || 'unknown'"
          >
            <span class="reflect-summary-step-label">步骤 {{ step.stepIndex + 1 }}</span>
            <span class="reflect-summary-step-status" :class="step.status || 'unknown'">
              {{ reflectStepStatusLabel(step.status) }}
            </span>
            <span v-if="step.requiredSkillsUsed.length > 0" class="reflect-summary-step-skills">
              {{ step.requiredSkillsUsed.join(', ') }}
            </span>
          </div>
        </div>
      </div>
      <div v-if="technicalDetailsExpanded && postExecuteDecisionSummary" class="post-execute-decision-summary">
        <span class="post-execute-decision-chip">
          执行后决策: {{ postExecuteDecisionLabel(postExecuteDecisionSummary.decision) }}
        </span>
        <span class="post-execute-decision-reason">
          {{ postExecuteDecisionReasonLabel(postExecuteDecisionSummary) }}
        </span>
      </div>
      <div v-if="technicalDetailsExpanded && finalValidationSummary" class="final-validation-summary">
        <span class="final-validation-chip" :class="{ failed: finalValidationSummary.status === 'replan' }">
          {{ planHardFailureSummary?.kind === 'planner_model_unsupported'
            ? '模型不支持 Planner'
            : planHardFailureSummary?.kind === 'planner_model_invalid_output'
              ? '模型不适合作为 Planner'
              : (planHardFailureSummary ? '规划失败' : (finalValidationSummary.status === 'replan' ? '最终验收未通过' : '最终验收通过')) }}
        </span>
        <span v-if="finalValidationSummary.reason" class="final-validation-reason">
          {{ planHardFailureSummary?.message || finalValidationSummary.reason }}
        </span>
      </div>
      <section
        v-if="!executionPlanSummary?.steps?.length"
        v-for="group in attemptGroups"
        :key="group.id"
        class="attempt-group"
        :class="[attemptGroupTone(group), { unframed: !useAttemptGroupLayout }]"
      >
        <header v-if="showAttemptGroupHeader(group)" class="attempt-group-header">
          <span class="attempt-group-title">尝试 {{ group.attemptNo }}</span>
          <span v-if="retryReasonGroupLabel(group.retryReason)" class="attempt-group-reason">
            {{ retryReasonGroupLabel(group.retryReason) }}
          </span>
        </header>

        <article v-for="node in group.nodes" :key="eventKey(node.event)" class="tree-node">
          <button type="button" class="node-summary" :class="eventTone(node.event)" @click="nodeHasExpandableContent(node) ? toggleNode(node.event) : undefined">
            <span v-if="nodeHasExpandableContent(node)" class="node-toggle" :class="{ expanded: isExpanded(node.event) }" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none">
                <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <span v-else class="node-toggle-spacer" aria-hidden="true"></span>
            <span class="node-label">{{ semanticLabel(node.event) }}</span>
            <span class="node-summary-meta">
              <span v-if="nodeOutcomeLabel(node)" class="node-outcome">
                {{ nodeOutcomeLabel(node) }}
              </span>
            </span>
          </button>

          <div v-if="nodeHasExpandableContent(node) && isExpanded(node.event)" class="node-body">
            <div v-if="technicalDetailsExpanded && eventRequiredSkills(node.event).length > 0" class="event-required-skills">
              <span class="event-required-skills-label">必需技能</span>
              <span v-for="skill in eventRequiredSkills(node.event)" :key="skill" class="event-required-skill-chip">
                {{ skill }}
              </span>
            </div>
            <div
              v-for="section in processSections(node)"
              :key="`${eventKey(node.event)}-${section.key}`"
              class="detail-section"
            >
              <div class="detail-section-label">{{ section.title }}</div>
              <div class="code-wrapper detail-section-body">
                <pre class="node-detail">{{ section.content }}</pre>
                <button type="button" class="copy-button" @click.stop="copyToClipboard(section.copyText)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
              </div>
            </div>
            <div v-for="line in detailLines(node.event)" :key="line" class="code-wrapper">
              <pre class="node-detail">{{ line }}</pre>
              <button type="button" class="copy-button" @click.stop="copyToClipboard(line)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
            </div>
            <ThoughtProcess
              v-if="visibleChildren(node).length > 0"
              :events="flattenNodes(visibleChildren(node))"
              :task-status="effectiveTaskStatus"
              :nested="true"
              @resume="emit('resume', $event)"
              @cancel="emit('cancel', $event)"
            />
          </div>
        </article>
      </section>
    </div>
  </section>
</template>

<style scoped>
.thought-process {
  --process-surface: var(--bg-hover);
  --process-surface-strong: var(--bg-selected);
  --process-surface-soft: color-mix(in srgb, var(--bg-message-other) 82%, var(--bg-chat-window) 18%);
  --process-border: var(--border-color);
  --process-border-strong: var(--border-color-dark, var(--border-color));
  --process-accent-soft: color-mix(in srgb, var(--color-primary) 14%, transparent);
  --process-accent: var(--color-primary);
  --process-success-bg: color-mix(in srgb, var(--color-primary) 16%, transparent);
  --process-success-text: var(--color-primary);
  --process-warning-bg: color-mix(in srgb, #ffa940 18%, transparent);
  --process-warning-text: #d9822b;
  --process-danger-bg: color-mix(in srgb, #fa5151 16%, transparent);
  --process-danger-text: #d14343;
  --process-code-bg: var(--bg-code, #f6f8fa);
  --process-code-text: var(--text-code, var(--text-primary));
  width: min(720px, 100%);
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.thought-process.nested {
  width: 100%;
  margin-top: 10px;
}

.process-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
}

.thought-process.expanded .process-summary {
  border-radius: 16px;
}

.summary-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.summary-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--text-secondary);
}

.task-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.status-chip,
.error-chip {
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
}

.status-chip {
  background: var(--process-success-bg);
  color: var(--process-success-text);
  flex-shrink: 0;
}

.error-chip {
  background: var(--process-danger-bg);
  color: var(--process-danger-text);
}

.process-summary.status-done .status-chip {
  background: var(--bg-selected);
  color: var(--text-secondary);
}

.process-summary.status-failed .status-chip,
.process-summary.status-canceled .status-chip {
  background: var(--process-danger-bg);
  color: var(--process-danger-text);
}

.process-summary.status-interrupted .status-chip {
  background: var(--process-warning-bg);
  color: var(--process-warning-text);
}

.process-summary.status-resumed .status-chip {
  background: var(--process-accent-soft);
  color: var(--process-accent);
  animation: pulse-soft 2s infinite;
}

@keyframes pulse-soft {
  0% { opacity: 1; }
  50% { opacity: 0.7; }
  100% { opacity: 1; }
}

.required-skill-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 4px;
}

.required-skill-chip,
.required-skill-state {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  max-width: 100%;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  word-break: break-word;
}

.required-skill-chip {
  background: var(--process-surface-soft);
  color: var(--text-secondary);
  border: 1px solid var(--process-border);
}

.required-skill-chip.satisfied {
  background: var(--process-success-bg);
  color: var(--process-success-text);
  border-color: color-mix(in srgb, var(--process-success-text) 18%, transparent);
}

.required-skill-chip.unsatisfied {
  background: var(--process-warning-bg);
  color: var(--process-warning-text);
  border-color: color-mix(in srgb, var(--process-warning-text) 18%, transparent);
}

.required-skill-state {
  font-weight: 500;
  border: 1px solid transparent;
}

.required-skill-state.satisfied {
  background: var(--process-success-bg);
  color: var(--process-success-text);
}

.required-skill-state.unsatisfied {
  background: var(--process-danger-bg);
  color: var(--process-danger-text);
}

.execution-plan-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 4px;
}

.active-skill-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 4px;
}

.active-skill-summary-label {
  font-size: 11px;
  color: var(--text-tertiary);
}

.active-skill-chip {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  line-height: 1.35;
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  color: var(--color-primary);
  border: 1px solid color-mix(in srgb, var(--color-primary) 22%, transparent);
}

.execution-plan-chip,
.execution-plan-text {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  max-width: 100%;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  word-break: break-word;
}

.execution-plan-chip {
  background: var(--process-accent-soft);
  color: var(--process-accent);
  border: 1px solid color-mix(in srgb, var(--process-accent) 16%, transparent);
}

.execution-plan-text {
  background: var(--process-surface-soft);
  color: var(--text-secondary);
  border: 1px solid var(--process-border);
}

.meta-chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  border: 1px solid var(--process-border);
  background: var(--process-surface-soft);
  color: var(--text-secondary);
}

.meta-chip.success {
  background: var(--process-success-bg);
  color: var(--process-success-text);
  border-color: color-mix(in srgb, var(--process-success-text) 16%, transparent);
}

.meta-chip.warning {
  background: var(--process-warning-bg);
  color: var(--process-warning-text);
  border-color: color-mix(in srgb, var(--process-warning-text) 18%, transparent);
}

.meta-chip.danger {
  background: var(--process-danger-bg);
  color: var(--process-danger-text);
  border-color: color-mix(in srgb, var(--process-danger-text) 18%, transparent);
}

.plan-tree {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 4px;
}

.plan-tree::before {
  content: "";
  position: absolute;
  left: 18px;
  top: 4px;
  bottom: 4px;
  width: 1.5px;
  background: var(--process-border);
}

.plan-tree-step {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 24px;
}

.plan-tree-step::before {
  content: "";
  position: absolute;
  left: 18px;
  top: 18px;
  width: 12px;
  height: 1.5px;
  background: var(--process-border);
}

.plan-tree-step-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  color: var(--text-primary);
}

.plan-tree-step-main,
.plan-tree-step-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.plan-tree-step-meta {
  justify-content: flex-end;
  flex-wrap: wrap;
}

.plan-tree-step-body {
  margin-left: 14px;
  padding-left: 16px;
  border-left: 1.5px solid color-mix(in srgb, var(--process-border-strong) 88%, transparent);
}

.execution-plan-step-label {
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-primary);
  word-break: break-word;
  text-wrap: pretty;
}

.step-decision-node {
  margin-bottom: 8px;
}

.step-decision-node .node-summary {
  cursor: default;
}

.step-decision-body {
  padding-top: 6px;
}

.execution-plan-step-status,
.execution-plan-step-skills,
.execution-plan-step-hint {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  line-height: 1.4;
}

.execution-plan-step-status {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.execution-plan-step-status.completed {
  background: var(--process-success-bg);
  color: var(--process-success-text);
}

.execution-plan-step-status.failed {
  background: var(--process-danger-bg);
  color: var(--process-danger-text);
}

.execution-plan-step-status.running {
  background: var(--process-accent-soft);
  color: var(--process-accent);
}

.execution-plan-step-skills {
  background: var(--process-surface);
  color: var(--text-secondary);
  border: 1px solid var(--process-border);
  word-break: break-word;
}

.execution-plan-step-hint {
  background: var(--process-surface-soft);
  color: var(--text-secondary);
  border: 1px solid var(--process-border);
  word-break: break-word;
}

.plan-tree-step.completed .execution-plan-step-label {
  color: var(--text-secondary);
}

.plan-tree-step.failed .execution-plan-step-label {
  color: var(--process-danger-text);
}

.plan-tree-step.running .execution-plan-step-label {
  color: var(--text-primary);
}

.reflect-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 4px;
}

.reflect-summary-chip {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  min-height: 24px;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  background: var(--process-success-bg);
  color: var(--process-success-text);
  border: 1px solid color-mix(in srgb, var(--process-success-text) 16%, transparent);
}

.reflect-summary-chip.failed {
  background: var(--process-warning-bg);
  color: var(--process-warning-text);
  border-color: color-mix(in srgb, var(--process-warning-text) 16%, transparent);
}

.reflect-summary-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.reflect-summary-step {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  max-width: 100%;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  background: var(--process-surface-soft);
  border: 1px solid var(--process-border);
  color: var(--text-secondary);
  flex-wrap: wrap;
}

.reflect-summary-step.success {
  border-color: color-mix(in srgb, var(--process-success-text) 16%, var(--process-border));
}

.reflect-summary-step.failed {
  border-color: color-mix(in srgb, var(--process-danger-text) 16%, var(--process-border));
}

.reflect-summary-step-label {
  color: var(--text-primary);
}

.reflect-summary-step-status,
.reflect-summary-step-skills {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.4;
}

.reflect-summary-step-status {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.reflect-summary-step-status.success {
  background: var(--process-success-bg);
  color: var(--process-success-text);
}

.reflect-summary-step-status.failed {
  background: var(--process-danger-bg);
  color: var(--process-danger-text);
}

.reflect-summary-step-skills {
  background: var(--process-surface);
  border: 1px solid var(--process-border);
  color: var(--text-secondary);
}

.post-execute-decision-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 4px;
}

.post-execute-decision-chip,
.post-execute-decision-reason {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
}

.post-execute-decision-chip {
  background: var(--process-accent-soft);
  color: var(--process-accent);
  border: 1px solid color-mix(in srgb, var(--process-accent) 16%, transparent);
}

.post-execute-decision-reason {
  background: var(--process-surface-soft);
  color: var(--text-secondary);
  border: 1px solid var(--process-border);
}

.final-validation-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 4px;
}

.final-validation-chip,
.final-validation-reason {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
}

.final-validation-chip {
  background: var(--process-success-bg);
  color: var(--process-success-text);
  border: 1px solid color-mix(in srgb, var(--process-success-text) 16%, transparent);
}

.final-validation-chip.failed {
  background: var(--process-danger-bg);
  color: var(--process-danger-text);
  border-color: color-mix(in srgb, var(--process-danger-text) 16%, transparent);
}

.final-validation-reason {
  background: var(--process-surface-soft);
  color: var(--text-secondary);
  border: 1px solid var(--process-border);
}

.tree-list {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 4px 0 20px;
}

.tree-list::before {
  content: "";
  position: absolute;
  left: 8px;
  top: 2px;
  bottom: 2px;
  width: 1.5px;
  background: var(--process-border);
}

.debug-panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 2px 4px;
}

.process-overview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.debug-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.process-headline {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  text-wrap: pretty;
}

.detail-toggle-button {
  min-height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--process-border);
  background: var(--process-surface-soft);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1;
  flex-shrink: 0;
  transition-property: background-color, border-color, color, transform;
  transition-duration: var(--transition-fast);
}

.detail-toggle-button:hover {
  background: var(--process-surface);
  color: var(--text-primary);
}

.detail-toggle-button:active {
  transform: scale(0.96);
}

.attempt-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 10px;
  border-radius: 12px;
  border: 1px solid var(--process-border);
  background: color-mix(in srgb, var(--process-surface-soft) 84%, transparent);
}

.attempt-group.unframed {
  padding: 0;
  border-color: transparent;
  background: transparent;
}

.attempt-group + .attempt-group {
  margin-top: 2px;
}

.attempt-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.attempt-group-title,
.attempt-group-reason {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  line-height: 1.4;
}

.attempt-group-title {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.attempt-group-reason {
  border: 1px solid transparent;
}

.attempt-group.accent {
  border-color: color-mix(in srgb, var(--process-accent) 20%, var(--process-border));
  background: color-mix(in srgb, var(--process-accent-soft) 55%, var(--process-surface-soft));
}

.attempt-group.accent .attempt-group-reason {
  background: var(--process-accent-soft);
  color: var(--process-accent);
  border-color: color-mix(in srgb, var(--process-accent) 18%, transparent);
}

.attempt-group.warning {
  border-color: color-mix(in srgb, var(--process-warning-text) 18%, var(--process-border));
  background: color-mix(in srgb, var(--process-warning-bg) 45%, var(--process-surface-soft));
}

.attempt-group.warning .attempt-group-reason {
  background: var(--process-warning-bg);
  color: var(--process-warning-text);
  border-color: color-mix(in srgb, var(--process-warning-text) 18%, transparent);
}

.attempt-group.neutral .attempt-group-reason {
  background: var(--process-surface);
  color: var(--text-secondary);
  border-color: var(--process-border);
}

.tree-node {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 14px;
}

.tree-node::before {
  content: "";
  position: absolute;
  left: -12px;
  top: 17px;
  width: 12px;
  height: 1.5px;
  background: var(--process-border);
}

.node-summary {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 4px 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
}

.node-summary.action {
  color: var(--text-primary);
}

.node-summary.tool {
  color: var(--text-primary);
}

.node-summary.decision {
  color: var(--text-primary);
}

.node-summary.diagnostic {
  color: var(--text-secondary);
}

.node-summary.error {
  color: var(--process-danger-text);
}

.node-label {
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
  text-wrap: pretty;
}

.node-summary.decision .node-label {
  color: var(--text-primary);
}

.node-summary.decision .node-toggle {
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
}

.node-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  flex-shrink: 0;
  transition: transform var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}

.node-toggle-spacer {
  display: inline-block;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.node-toggle svg {
  width: 12px;
  height: 12px;
}

.node-toggle.expanded {
  transform: rotate(90deg);
  color: var(--color-primary);
  background: var(--process-accent-soft);
}

.plan-tree-step-summary:hover .node-toggle,
.node-summary:hover .node-toggle,
.process-summary:hover .node-toggle {
  color: var(--color-primary);
}

.node-summary-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.node-outcome {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  max-width: 180px;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--process-surface-soft);
  border: 1px solid var(--process-border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.node-body {
  margin-left: 4px;
  padding: 8px 0 0 16px;
  border-left: 1.5px solid var(--process-border-strong);
}

.event-required-skills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.event-required-skills-label {
  font-size: 11px;
  color: var(--text-tertiary);
}

.detail-section {
  margin-bottom: 10px;
}

.detail-section-label {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.event-required-skill-chip {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  line-height: 1.4;
  background: var(--process-accent-soft);
  color: var(--process-accent);
  border: 1px solid color-mix(in srgb, var(--process-accent) 16%, transparent);
}

.inline-terminal-block {
  margin-bottom: 8px;
}

.inline-terminal-command {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  font-family: "Fira Code", "Source Code Pro", Menlo, Monaco, Consolas, "Courier New", monospace;
}

.terminal-output-wrapper {
  margin-bottom: 10px;
}

.terminal-output-detail {
  background: var(--bg-code, #0f1117);
  color: var(--text-code, var(--text-primary));
  max-height: 200px;
  overflow: auto;
}

.terminal-output-detail::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.terminal-output-detail::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb, rgba(255, 255, 255, 0.18));
  border-radius: 999px;
}

.terminal-output-detail::-webkit-scrollbar-track {
  background: transparent;
}

.node-detail {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--process-code-bg);
  color: var(--process-code-text);
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  border: 1px solid var(--process-border);
}

.node-detail::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.node-detail::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb, rgba(255, 255, 255, 0.18));
  border-radius: 999px;
}

.node-detail::-webkit-scrollbar-track {
  background: transparent;
}

.code-wrapper {
  position: relative;
  margin-bottom: 8px;
}

.copy-button {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 4px;
  border-radius: 6px;
  background: var(--bg-selected);
  border: 1px solid var(--border-color);
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition-property: opacity, background-color, color;
  transition-duration: var(--transition-fast);
  display: flex;
  align-items: center;
  justify-content: center;
}

.code-wrapper:hover .copy-button {
  opacity: 1;
}

.copy-button:hover {
  background: var(--bg-hover);
  color: var(--color-primary);
}

.copy-icon {
  width: 14px;
  height: 14px;
}

.ghost-button {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.task-hint-chip {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--process-warning-bg);
  color: var(--process-warning-text);
  border: 1px solid color-mix(in srgb, var(--process-warning-text) 16%, transparent);
  font-size: 12px;
}

@media (max-width: 640px) {
  .process-summary {
    align-items: flex-start;
    flex-direction: column;
  }

  .debug-panel-header {
    flex-direction: column;
    align-items: stretch;
  }

  .detail-toggle-button {
    align-self: flex-start;
  }

  .node-summary {
    grid-template-columns: 1fr;
  }

  .node-summary-meta {
    justify-content: space-between;
  }

  .attempt-group {
    padding: 8px;
  }

  .attempt-group-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .plan-tree-step-summary {
    align-items: flex-start;
    flex-direction: column;
  }

  .plan-tree-step-meta {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
