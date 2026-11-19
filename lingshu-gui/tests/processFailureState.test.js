import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePlanHardFailureSummary } from '../src/utils/processFailureState.js';

test('derivePlanHardFailureSummary reads structured done metadata', () => {
  const summary = derivePlanHardFailureSummary([
    {
      type: 'done',
      metadata: {
        plan_hard_failure: true,
        plan_failure_kind: 'execution_plan_invalid',
        plan_failure_message: 'execution plan step 1 selected run_terminal_command',
      },
    },
  ]);

  assert.deepEqual(summary, {
    kind: 'execution_plan_invalid',
    message: 'execution plan step 1 selected run_terminal_command',
  });
});

test('derivePlanHardFailureSummary ignores normal failed tool runs', () => {
  const summary = derivePlanHardFailureSummary([
    {
      type: 'done',
      metadata: {
        run_status: 'failed',
        required_skills_satisfied: false,
      },
    },
  ]);

  assert.equal(summary, null);
});

test('derivePlanHardFailureSummary preserves execution loop message', () => {
  const summary = derivePlanHardFailureSummary([
    {
      type: 'done',
      metadata: {
        plan_hard_failure: true,
        plan_failure_kind: 'execution_loop_detected',
        plan_failure_message:
          '检测到同一工具步骤重复执行 4 次（run_terminal_command），已停止任务以避免死循环。 此前已完成 3 个工具步骤，将基于已有结果整理回复。',
      },
    },
  ]);

  assert.equal(summary?.kind, 'execution_loop_detected');
  assert.match(summary?.message || '', /重复执行/);
});
