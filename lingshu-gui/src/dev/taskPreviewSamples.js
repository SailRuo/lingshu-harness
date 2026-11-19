function baseEvent({
  eventId,
  eventSequence,
  type,
  content = '',
  metadata = {},
  parentEventId = null,
  depth = 0,
  attemptNo = 1,
  attemptGroupId = null,
  taskId = 'task-sample',
  timestamp,
}) {
  return {
    type,
    eventId,
    sessionId: 'session-sample',
    turnId: 'turn-sample',
    taskId,
    eventSequence,
    timestamp: timestamp ?? `2026-05-04T11:43:${String(30 + eventSequence).padStart(2, '0')}.000Z`,
    content,
    metadata,
    parentEventId,
    depth,
    attemptNo,
    attemptGroupId,
    branchId: null,
  };
}

export function obsidianTerminalFallbackSample() {
  return [
    baseEvent({
      eventId: 'evt-1',
      eventSequence: 1,
      type: 'state',
      content: 'running',
      metadata: {
        execution_plan_summary: {
          goal: '创建 Obsidian 笔记',
          status: 'running',
          step_count: 2,
          completed_step_count: 0,
          current_step_index: 0,
          current_step_label: '激活 Obsidian 技能',
          current_step_status: 'running',
          steps: [
            { id: 'step-1', label: '激活 Obsidian 技能', action_type: 'load_skill', status: 'completed', required_skills_used: ['obsidian-cli'] },
            { id: 'step-2', label: '创建并验证笔记', action_type: 'call_tool', status: 'running', required_skills_used: ['obsidian-cli'] },
          ],
        },
        required_skills_consumed: ['obsidian-cli'],
        required_skills_satisfied: true,
      },
    }),
    baseEvent({
      eventId: 'evt-2',
      eventSequence: 2,
      type: 'thought',
      content: 'I will verify the note by listing files again.',
      metadata: {
        node_name: 'plan',
      },
    }),
    baseEvent({
      eventId: 'evt-3',
      eventSequence: 3,
      type: 'tool_call',
      content: 'run_terminal_command',
      metadata: {
        node_name: 'execute',
        tool_name: 'run_terminal_command',
        tool_args: {
          command: 'dir 测试笔记.md',
        },
        required_skills_used: ['obsidian-cli'],
      },
    }),
    baseEvent({
      eventId: 'evt-4',
      eventSequence: 4,
      type: 'tool_result',
      content: '测试笔记.md',
      metadata: {
        node_name: 'execute',
        result_classification: 'success',
        preview: '测试笔记.md',
        required_skills_consumed: ['obsidian-cli'],
        required_skills_satisfied: true,
      },
      parentEventId: 'evt-3',
      depth: 1,
    }),
    baseEvent({
      eventId: 'evt-5',
      eventSequence: 5,
      type: 'text_delta',
      content: '已创建 Obsidian 笔记，并确认存在测试笔记.md',
      metadata: {
        node_name: 'reflect',
      },
    }),
    baseEvent({
      eventId: 'evt-6',
      eventSequence: 6,
      type: 'done',
      metadata: {
        run_status: 'completed',
        execution_plan_summary: {
          goal: '创建 Obsidian 笔记',
          status: 'completed',
          step_count: 2,
          completed_step_count: 2,
          current_step_index: 1,
          current_step_label: '创建并验证笔记',
          current_step_status: 'completed',
          steps: [
            { id: 'step-1', label: '激活 Obsidian 技能', action_type: 'load_skill', status: 'completed', required_skills_used: ['obsidian-cli'] },
            { id: 'step-2', label: '创建并验证笔记', action_type: 'call_tool', status: 'completed', required_skills_used: ['obsidian-cli'] },
          ],
        },
        required_skills_consumed: ['obsidian-cli'],
        required_skills_satisfied: true,
      },
    }),
  ];
}

export function argRepairRetrySample() {
  return [
    baseEvent({
      eventId: 'retry-1',
      eventSequence: 1,
      type: 'state',
      content: 'running',
      metadata: {
        execution_plan_summary: {
          goal: '创建 Obsidian 笔记',
          status: 'running',
          step_count: 1,
          completed_step_count: 0,
          current_step_index: 0,
          current_step_label: '创建笔记',
          current_step_status: 'running',
          steps: [
            { id: 'step-1', label: '创建笔记', action_type: 'call_tool', status: 'running', required_skills_used: ['obsidian-cli'] },
          ],
        },
      },
    }),
    baseEvent({
      eventId: 'retry-2',
      eventSequence: 2,
      type: 'tool_call',
      content: 'obsidian_markdown.create_note',
      metadata: {
        node_name: 'execute',
        tool_name: 'obsidian_markdown.create_note',
      },
      attemptNo: 1,
      attemptGroupId: 'attempt-1',
    }),
    baseEvent({
      eventId: 'retry-3',
      eventSequence: 3,
      type: 'tool_result',
      content: 'Error: maxCharacters must be >= 10',
      metadata: {
        node_name: 'execute',
        result_classification: 'validation_error',
        error_class: 'McpValidationError',
      },
      parentEventId: 'retry-2',
      depth: 1,
      attemptNo: 1,
      attemptGroupId: 'attempt-1',
    }),
    baseEvent({
      eventId: 'retry-4',
      eventSequence: 4,
      type: 'thought',
      content: '正在修正参数后重试',
      metadata: {
        node_name: 'plan',
        retry_reason: 'arg_repair',
      },
      attemptNo: 2,
      attemptGroupId: 'attempt-2',
    }),
    baseEvent({
      eventId: 'retry-5',
      eventSequence: 5,
      type: 'tool_call',
      content: 'obsidian_markdown.create_note',
      metadata: {
        node_name: 'execute',
        tool_name: 'obsidian_markdown.create_note',
        retry_reason: 'arg_repair',
        tool_args: {
          title: '测试笔记',
          maxCharacters: 100,
        },
      },
      attemptNo: 2,
      attemptGroupId: 'attempt-2',
    }),
    baseEvent({
      eventId: 'retry-6',
      eventSequence: 6,
      type: 'tool_result',
      content: '创建成功',
      metadata: {
        node_name: 'execute',
        result_classification: 'success',
        required_skills_consumed: ['obsidian-cli'],
        required_skills_satisfied: true,
      },
      parentEventId: 'retry-5',
      depth: 1,
      attemptNo: 2,
      attemptGroupId: 'attempt-2',
    }),
    baseEvent({
      eventId: 'retry-7',
      eventSequence: 7,
      type: 'text_delta',
      content: '笔记已创建成功',
      metadata: {
        node_name: 'reflect',
      },
      attemptNo: 2,
      attemptGroupId: 'attempt-2',
    }),
    baseEvent({
      eventId: 'retry-8',
      eventSequence: 8,
      type: 'done',
      metadata: {
        run_status: 'completed',
        execution_plan_summary: {
          goal: '创建 Obsidian 笔记',
          status: 'completed',
          step_count: 1,
          completed_step_count: 1,
          current_step_index: 0,
          current_step_label: '创建笔记',
          current_step_status: 'completed',
          steps: [
            { id: 'step-1', label: '创建笔记', action_type: 'call_tool', status: 'completed', required_skills_used: ['obsidian-cli'] },
          ],
        },
        required_skills_consumed: ['obsidian-cli'],
        required_skills_satisfied: true,
      },
      attemptNo: 2,
      attemptGroupId: 'attempt-2',
    }),
  ];
}

export const taskPreviewScenarios = [
  {
    id: 'obsidian-terminal-fallback',
    title: 'Obsidian 预激活但走终端验证',
    description: '用于观察单主块、必需技能消费、计划摘要与低信号成功折叠是否同时成立。',
    prompt: '创建 Obsidian 笔记',
    finalText: '已创建 Obsidian 笔记，并确认存在测试笔记.md',
    events: obsidianTerminalFallbackSample(),
  },
  {
    id: 'arg-repair-retry',
    title: '参数修复后二次成功',
    description: '用于观察参数错误是否只重试当前步骤，以及尝试分组是否清晰呈现。',
    prompt: '创建一个测试笔记，并在失败时自动修正参数',
    finalText: '笔记已创建成功',
    events: argRepairRetrySample(),
  },
];
