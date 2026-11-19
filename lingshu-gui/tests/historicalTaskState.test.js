import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hydrateHistoricalTaskState } from '../src/utils/historicalTaskState.js';

test('hydrateHistoricalTaskState restores task timeline metadata for assistant history messages', () => {
  const messages = [
    {
      id: 'a-1',
      type: 'text',
      senderId: 'bot',
      senderName: '灵枢 AI',
      senderAvatar: '/lingshu.png',
      timestamp: new Date('2026-05-05T00:00:00.000Z'),
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

  const taskEventsById = {
    'task-1': [
      {
        type: 'state',
        eventId: 'evt-1',
        taskId: 'task-1',
        eventSequence: 1,
        timestamp: '2026-05-05T00:00:01.000Z',
        content: 'thinking',
        metadata: {},
        depth: 0,
        attemptNo: 1,
      },
      {
        type: 'done',
        eventId: 'evt-2',
        taskId: 'task-1',
        eventSequence: 2,
        timestamp: '2026-05-05T00:00:02.000Z',
        content: null,
        metadata: {},
        depth: 0,
        attemptNo: 1,
      },
    ],
  };

  const hydrated = hydrateHistoricalTaskState(messages, taskEventsById);

  assert.notEqual(hydrated.messages, messages);
  assert.equal(hydrated.messages[0].metadata.timelineEvents.length, 2);
  assert.equal(hydrated.messages[0].metadata.taskEvents.length, 2);
  assert.equal(hydrated.messages[0].metadata.run_status, 'done');
});

test('hydrateHistoricalTaskState reconstructs terminal output for historical task messages', () => {
  const messages = [
    {
      id: 'a-2',
      type: 'text',
      senderId: 'bot',
      senderName: '灵枢 AI',
      senderAvatar: '/lingshu.png',
      timestamp: new Date('2026-05-05T00:00:00.000Z'),
      status: 'sent',
      isSelf: false,
      content: '',
      metadata: {
        taskId: 'task-2',
        timelineEvents: [],
        taskEvents: [],
      },
    },
  ];

  const taskEventsById = {
    'task-2': [
      {
        type: 'terminal_session_opened',
        eventId: 'evt-open',
        taskId: 'task-2',
        eventSequence: 1,
        timestamp: '2026-05-05T00:00:01.000Z',
        content: null,
        metadata: { session_id: 'session-2' },
        depth: 0,
        attemptNo: 1,
      },
      {
        type: 'terminal_command_started',
        eventId: 'evt-start',
        taskId: 'task-2',
        eventSequence: 2,
        timestamp: '2026-05-05T00:00:02.000Z',
        content: 'echo hi',
        metadata: { session_id: 'session-2' },
        depth: 0,
        attemptNo: 1,
      },
      {
        type: 'terminal_output',
        eventId: 'evt-output',
        taskId: 'task-2',
        eventSequence: 3,
        timestamp: '2026-05-05T00:00:03.000Z',
        content: '__COMMAND_START_deadbeef__\nhello\n__EXIT_CODE_deadbeef__:0\n',
        metadata: { session_id: 'session-2' },
        depth: 0,
        attemptNo: 1,
      },
    ],
  };

  const hydrated = hydrateHistoricalTaskState(messages, taskEventsById);

  assert.equal(hydrated.messages.length, 1);
  assert.equal(hydrated.messages[0].metadata?.taskEvents?.length, 3);
});

test('chat store hydrates historical task data in a single async pass', () => {
  const chatStoreSource = fs.readFileSync(
    path.join(process.cwd(), 'src/stores/chat.ts'),
    'utf8',
  );

  assert.doesNotMatch(chatStoreSource, /formattedMessages\.forEach\(async \(msg\)/);
  assert.match(chatStoreSource, /Promise\.all\(/);
  assert.match(chatStoreSource, /hydrateHistoricalTaskState\(/);
});
