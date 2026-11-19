import test from 'node:test';
import assert from 'node:assert/strict';

import { isTerminalTaskStatus, syncTerminalTaskStatusAcrossMessages } from '../src/utils/taskMessageStatus.js';

function assistantMessage({ id, taskId, runStatus, timelineEvents = [] }) {
  return {
    id,
    type: 'text',
    isSelf: false,
    status: 'sending',
    metadata: {
      taskId,
      run_status: runStatus,
      timelineEvents,
      taskEvents: timelineEvents,
      seenEventIds: [],
    },
  };
}

test('isTerminalTaskStatus recognizes terminal task states', () => {
  assert.equal(isTerminalTaskStatus('done'), true);
  assert.equal(isTerminalTaskStatus('failed'), true);
  assert.equal(isTerminalTaskStatus('interrupted'), false);
});

test('syncTerminalTaskStatusAcrossMessages closes older interrupted bubbles for same task', () => {
  const messages = [
    assistantMessage({
      id: 'msg-1',
      taskId: 'task-1',
      runStatus: 'interrupted',
      timelineEvents: [
        { eventId: 'evt-1', eventSequence: 1, type: 'state', metadata: { run_status: 'interrupted' } },
      ],
    }),
    assistantMessage({
      id: 'msg-2',
      taskId: 'task-1',
      runStatus: 'failed',
      timelineEvents: [],
    }),
  ];

  syncTerminalTaskStatusAcrossMessages(messages, {
    taskId: 'task-1',
    normalizedStatus: 'failed',
    eventType: 'done',
    eventData: {
      eventId: 'evt-2',
      eventSequence: 2,
      taskId: 'task-1',
      metadata: { run_status: 'failed' },
      content: '',
    },
  });

  assert.equal(messages[0].metadata.run_status, 'failed');
  assert.equal(messages[1].metadata.run_status, 'failed');
  assert.equal(messages[0].metadata.timelineEvents.at(-1).eventSequence, 2);
  assert.equal(messages[0].status, 'sent');
});
