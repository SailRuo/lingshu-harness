import test from 'node:test';
import assert from 'node:assert/strict';

import { hasAssistantStreamProgress } from '../src/utils/chatStreamProgress.js';

test('hasAssistantStreamProgress is true when assistant already has text', () => {
  assert.equal(
    hasAssistantStreamProgress({ content: '可以', metadata: {} }),
    true,
  );
});

test('hasAssistantStreamProgress is true when assistant has timeline events only', () => {
  assert.equal(
    hasAssistantStreamProgress({
      content: '',
      metadata: { timelineEvents: [{ type: 'tool_call' }] },
    }),
    true,
  );
});

test('hasAssistantStreamProgress is false for empty streaming placeholder', () => {
  assert.equal(
    hasAssistantStreamProgress({ content: '', metadata: {} }),
    false,
  );
});
