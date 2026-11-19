import assert from 'node:assert/strict';

import { buildHistoricalMessages } from '../src/stores/chat-history.ts';

const turns = [
  {
    id: 239,
    userMessage: '执行 obsidian read 命令',
    userImages: [
      {
        uploadId: 'img-1',
        url: '/api/v1/chat/uploads/img-1.png',
        mimeType: 'image/png',
        fileName: 'img-1.png',
        width: 512,
        height: 512,
      },
    ],
    assistantMessage: '',
    status: 'completed',
    errorMessage: null,
    taskId: 'd532dc82-3c9e-4365-9a00-3abb48c69787',
    timestamp: '2026-05-03T11:30:28.654963Z',
  },
  {
    id: 240,
    userMessage: '',
    assistantMessage: '执行 `obsidian read` 命令失败，返回码为 5。',
    status: 'completed',
    errorMessage: null,
    taskId: 'd532dc82-3c9e-4365-9a00-3abb48c69787',
    timestamp: '2026-05-03T11:30:29.359745Z',
  },
];

const messages = buildHistoricalMessages(turns, {
  displayName: '灵枢 AI',
  avatar: '/lingshu.png',
});

assert.equal(messages.length, 3, 'paired historical turns should keep image + user text + assistant reply');
assert.equal(messages[0].type, 'image', 'first message should preserve the uploaded user image');
assert.equal(messages[0].isSelf, true, 'image bubble should belong to the user');
assert.equal(messages[0].url, 'http://localhost:8600/api/v1/chat/uploads/img-1.png');
assert.equal(messages[1].isSelf, true, 'second message should be the user text');
assert.equal(messages[2].isSelf, false, 'third message should be the assistant message');
assert.equal(messages[2].metadata.taskId, 'd532dc82-3c9e-4365-9a00-3abb48c69787');
assert.equal(messages[2].content, '执行 `obsidian read` 命令失败，返回码为 5。');

console.log('chat-history turn merging regression passed');
