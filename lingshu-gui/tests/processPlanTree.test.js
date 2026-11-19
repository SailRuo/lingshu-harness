import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanStepTree } from '../src/utils/processPlanTree.js';

test('buildPlanStepTree maps tool activities onto call_tool steps in order', () => {
  const steps = buildPlanStepTree(
    {
      currentStepIndex: 1,
      steps: [
        { id: 'step-1', label: '查询天气', actionType: 'call_tool', status: 'completed' },
        { id: 'step-2', label: '创建笔记', actionType: 'call_tool', status: 'failed' },
        { id: 'step-3', label: '整理结果', actionType: 'finish', status: 'pending' },
      ],
    },
    [
      { id: 'activity-1', type: 'tool', label: '调用工具 exa_web_search_exa' },
      { id: 'activity-2', type: 'tool', label: '调用工具 run_terminal_command' },
    ],
  );

  assert.equal(steps[0].children.length, 1);
  assert.equal(steps[0].children[0].id, 'activity-1');
  assert.equal(steps[1].children.length, 1);
  assert.equal(steps[1].children[0].id, 'activity-2');
  assert.equal(steps[2].children.length, 0);
});

test('buildPlanStepTree maps tool activities by explicit step identity before event order', () => {
  const steps = buildPlanStepTree(
    {
      currentStepIndex: 1,
      steps: [
        { id: 'step-1', label: '提取网页内容', actionType: 'call_tool', status: 'completed' },
        { id: 'step-2', label: '写入笔记', actionType: 'call_tool', status: 'completed' },
      ],
    },
    [
      {
        id: 'activity-note',
        type: 'tool',
        label: '调用工具 obsidian.create_note',
        stepId: 'step-2',
        stepIndex: 1,
      },
      {
        id: 'activity-extract',
        type: 'tool',
        label: '调用工具 run_terminal_command',
        stepId: 'step-1',
        stepIndex: 0,
      },
    ],
  );

  assert.deepEqual(
    steps.map((step) => step.children.map((child) => child.id)),
    [['activity-extract'], ['activity-note']],
  );
});

test('buildPlanStepTree sends unmatched diagnostics to the active step', () => {
  const steps = buildPlanStepTree(
    {
      currentStepIndex: 1,
      steps: [
        { id: 'step-1', label: '查询天气', actionType: 'call_tool', status: 'completed' },
        { id: 'step-2', label: '创建笔记', actionType: 'call_tool', status: 'running' },
      ],
    },
    [
      { id: 'activity-1', type: 'tool', label: '调用工具 exa_web_search_exa' },
      { id: 'activity-2', type: 'diagnostic', label: '审批已通过，继续执行' },
      { id: 'activity-3', type: 'tool', label: '调用工具 run_terminal_command' },
    ],
  );

  assert.equal(steps[0].children.length, 1);
  assert.equal(steps[0].children[0].id, 'activity-1');
  assert.deepEqual(
    steps[1].children.map((child) => child.id),
    ['activity-2', 'activity-3'],
  );
});

test('buildPlanStepTree keeps extra tool activity on the active step when tool steps run out', () => {
  const steps = buildPlanStepTree(
    {
      currentStepIndex: 0,
      steps: [
        { id: 'step-1', label: '创建笔记', actionType: 'call_tool', status: 'running' },
      ],
    },
    [
      { id: 'activity-1', type: 'tool', label: '调用工具 obsidian.create_note' },
      { id: 'activity-2', type: 'tool', label: '调用工具 run_terminal_command' },
    ],
  );

  assert.deepEqual(
    steps[0].children.map((child) => child.id),
    ['activity-1', 'activity-2'],
  );
});
