import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveContinuationTaskId } from '../src/utils/continuationTask.js';

function assistantMessage({ taskId, runStatus }) {
  return {
    id: `msg-${taskId || 'none'}`,
    type: 'text',
    isSelf: false,
    metadata: {
      ...(taskId ? { taskId } : {}),
      ...(runStatus ? { run_status: runStatus } : {}),
    },
  };
}

test('resolveContinuationTaskId returns latest interrupted assistant task', () => {
  const taskId = resolveContinuationTaskId([
    assistantMessage({ taskId: 'task-old', runStatus: 'done' }),
    { id: 'user-1', type: 'text', isSelf: true, metadata: {} },
    assistantMessage({ taskId: 'task-active', runStatus: 'interrupted' }),
  ]);

  assert.equal(taskId, 'task-active');
});

test('resolveContinuationTaskId ignores non-interrupted assistant messages', () => {
  const taskId = resolveContinuationTaskId([
    assistantMessage({ taskId: 'task-1', runStatus: 'running' }),
    assistantMessage({ taskId: 'task-2', runStatus: 'done' }),
  ]);

  assert.equal(taskId, undefined);
});

test('resolveContinuationTaskId uses timeline events when top-level run_status is stale', () => {
  const taskId = resolveContinuationTaskId([
    {
      id: 'msg-task-3',
      type: 'text',
      isSelf: false,
      metadata: {
        taskId: 'task-3',
        run_status: 'running',
        timelineEvents: [
          {
            eventId: 'evt-1',
            eventSequence: 1,
            type: 'state',
            metadata: { run_status: 'interrupted' },
          },
        ],
      },
    },
  ]);

  assert.equal(taskId, 'task-3');
});
