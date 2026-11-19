import assert from 'node:assert/strict';

import { hydrateHistoricalAssistantMessage } from '../src/stores/chat-history.ts';

const originalMessages = [
  {
    id: 'u-1',
    type: 'text',
    senderId: 'user',
    senderName: '我',
    timestamp: new Date('2026-05-03T15:00:00+08:00'),
    status: 'sent',
    isSelf: true,
    content: '执行 obsidian read 命令',
  },
  {
    id: 'a-1',
    type: 'text',
    senderId: 'bot',
    senderName: '灵枢 AI',
    timestamp: new Date('2026-05-03T15:00:01+08:00'),
    status: 'sent',
    isSelf: false,
    content: '',
    metadata: {
      taskId: 'task-1',
      timelineEvents: [],
      taskEvents: [],
    },
  },
];

const events = [
  {
    type: 'tool_result',
    eventId: 'evt-1',
    sessionId: null,
    turnId: null,
    taskId: 'task-1',
    eventSequence: 1,
    timestamp: '2026-05-03T07:00:00Z',
    content: '工具已返回结果',
    metadata: {
      run_status: 'running',
      result_classification: 'success',
    },
    parentEventId: null,
    depth: 0,
    attemptNo: 1,
    attemptGroupId: null,
    branchId: null,
  },
  {
    type: 'done',
    eventId: 'evt-2',
    sessionId: null,
    turnId: null,
    taskId: 'task-1',
    eventSequence: 2,
    timestamp: '2026-05-03T07:00:01Z',
    content: null,
    metadata: {
      run_status: 'done',
    },
    parentEventId: null,
    depth: 0,
    attemptNo: 1,
    attemptGroupId: null,
    branchId: null,
  },
];

const nextMessages = hydrateHistoricalAssistantMessage(originalMessages, 'task-1', events);

assert.notStrictEqual(nextMessages, originalMessages, 'history hydration should return a new messages array');
assert.notStrictEqual(nextMessages[1], originalMessages[1], 'target assistant message should be replaced');
assert.equal(nextMessages[1].metadata.timelineEvents.length, 2, 'timeline events should be attached to the assistant message');
assert.equal(nextMessages[1].metadata.taskEvents.length, 2, 'task events should be attached to the assistant message');
assert.equal(nextMessages[1].metadata.run_status, 'done', 'run status should be derived from the latest event');
assert.equal(originalMessages[1].metadata.timelineEvents.length, 0, 'original message object should stay untouched');

console.log('chat-history-rehydration regression passed');
