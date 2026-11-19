import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTaskStatusFromEvents } from '../src/utils/taskStatus.js';

function event(overrides) {
  return {
    eventId: overrides.eventId ?? `evt-${overrides.eventSequence ?? 1}`,
    eventSequence: overrides.eventSequence ?? 1,
    type: overrides.type ?? 'thought',
    content: overrides.content ?? '',
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

test('deriveTaskStatusFromEvents prefers execution plan completed status over run_status', () => {
  const status = deriveTaskStatusFromEvents([
    event({ eventSequence: 1, type: 'done', metadata: { run_status: 'running' } }),
    event({
      eventSequence: 2,
      type: 'thought',
      metadata: {
        execution_plan_summary: {
          status: 'completed',
        },
      },
    }),
  ]);

  assert.equal(status, 'done');
});

test('deriveTaskStatusFromEvents prefers execution plan failed status over done event fallback', () => {
  const status = deriveTaskStatusFromEvents([
    event({ eventSequence: 1, type: 'done' }),
    event({
      eventSequence: 2,
      type: 'tool_result',
      metadata: {
        execution_plan_summary: {
          status: 'failed',
        },
        run_status: 'completed',
      },
    }),
  ]);

  assert.equal(status, 'failed');
});

test('deriveTaskStatusFromEvents falls back to running when no completion signal exists', () => {
  const status = deriveTaskStatusFromEvents([
    event({ eventSequence: 1, type: 'thought', content: '继续执行' }),
  ]);

  assert.equal(status, 'running');
});
