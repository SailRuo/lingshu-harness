import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimelineItems } from '../src/utils/messageTimeline.js';

function event(overrides) {
  return {
    eventId: overrides.eventId ?? `evt-${overrides.eventSequence}`,
    eventSequence: overrides.eventSequence ?? 1,
    type: overrides.type ?? 'text_delta',
    content: overrides.content ?? '',
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

test('buildTimelineItems separates process digest from final assistant text', () => {
  const items = buildTimelineItems([
    event({ eventSequence: 2, type: 'text_delta', content: '笔记已' }),
    event({ eventSequence: 1, type: 'thought', content: '正在创建笔记' }),
    event({ eventSequence: 3, type: 'text_delta', content: '创建成功' }),
    event({ eventSequence: 4, type: 'done', metadata: { run_status: 'completed' } }),
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'process');
  assert.equal(items[0].events.length, 2);
  assert.deepEqual(items[0].events.map(event => event.type), ['thought', 'done']);
  assert.equal(items[0].finalText, undefined);
  assert.deepEqual(items[1], {
    kind: 'text',
    id: 'assistant-text-2',
    content: '笔记已创建成功',
  });
});

test('buildTimelineItems does not synthesize assistant text from fallback content when process events exist', () => {
  const items = buildTimelineItems([
    event({ eventSequence: 1, type: 'tool_call', content: 'obsidian_markdown.create_note' }),
    event({ eventSequence: 2, type: 'tool_result', content: 'success', metadata: { result_classification: 'success' } }),
  ], '已创建笔记');

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'process');
});

test('buildTimelineItems keeps pure text conversations as text items', () => {
  const items = buildTimelineItems([
    event({ eventSequence: 1, type: 'text_delta', content: '你好，' }),
    event({ eventSequence: 2, type: 'text_delta', content: '世界' }),
  ]);

  assert.deepEqual(items, [
    {
      kind: 'text',
      id: 'text-1',
      content: '你好，世界',
    },
  ]);
});
