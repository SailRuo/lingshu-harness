import assert from 'node:assert/strict';
import {
  buildTimelineItems,
  bucketTimelineItemsByBubble,
  buildCompanionDialogueDisplayItems,
  buildCompanionLiveText,
  shouldShowCompanionWorkingHint,
  timelineItemsForBubble,
} from '../src/utils/messageTimeline.js';

const items = buildTimelineItems(
  [
    {
      type: 'tool_result',
      eventId: 'evt-1',
      eventSequence: 1,
      content: '工具已返回结果',
      metadata: { run_status: 'running' },
    },
    {
      type: 'text_delta',
      eventId: 'evt-2',
      eventSequence: 2,
      content: '我无法获取上海的天气数据。',
      metadata: {},
    },
    {
      type: 'done',
      eventId: 'evt-3',
      eventSequence: 3,
      content: null,
      metadata: { run_status: 'done' },
    },
  ],
);

assert.equal(items.length, 2);
assert.equal(items[0].kind, 'process');
assert.equal(items[0].events.length, 1);
assert.equal(items[0].events[0].type, 'tool_result');
assert.equal(items[1].kind, 'text');

const rawEvents = [
  {
    type: 'tool_call',
    eventId: 'tc-1',
    eventSequence: 1,
    content: 'mijia_list_device_capabilities',
    metadata: { tool_name: 'mijia_list_device_capabilities', route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'tool_result',
    eventId: 'tr-1',
    eventSequence: 2,
    content: 'ok',
    metadata: { result_classification: 'success', route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'text_delta',
    eventId: 'txt-1',
    eventSequence: 3,
    content: '好，我先看看这盏灯支持哪些功能。',
    metadata: { bubbleIndex: 0, route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'tool_call',
    eventId: 'tc-2',
    eventSequence: 4,
    content: 'mijia_set_device_property',
    metadata: { tool_name: 'mijia_set_device_property', route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'tool_result',
    eventId: 'tr-2',
    eventSequence: 5,
    content: 'ok',
    metadata: { result_classification: 'success', route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'text_delta',
    eventId: 'txt-2',
    eventSequence: 6,
    content: '这盏灯支持彩色模式。',
    metadata: { bubbleIndex: 1, route: 'chat-fast', companion_v3: true },
  },
];

const interleaved = buildTimelineItems(rawEvents);

assert.equal(interleaved.length, 4, 'should interleave process/text blocks instead of batching');
assert.equal(interleaved[0].kind, 'process');
assert.equal(interleaved[1].kind, 'text');
assert.equal(interleaved[1].bubbleIndex, 0);
assert.equal(interleaved[2].kind, 'process');
assert.equal(interleaved[3].kind, 'text');
assert.equal(interleaved[3].bubbleIndex, 1);

const buckets = bucketTimelineItemsByBubble(interleaved);
assert.equal(buckets.get(0).length, 2);
assert.equal(buckets.get(1).length, 2);

const bubble0 = timelineItemsForBubble(rawEvents, 0);
assert.equal(bubble0[0].kind, 'text', 'companion chat should show narration before tool steps');
assert.equal(bubble0[1].kind, 'process');

const bubble1 = timelineItemsForBubble(rawEvents, 1);
assert.equal(bubble1[0].kind, 'text');
assert.equal(bubble1[1].kind, 'process');

const processOnlyEvents = rawEvents.filter((event) => event.type !== 'text_delta');
const bubbleWithFallback = timelineItemsForBubble(processOnlyEvents, 0, '已经帮你调好了。');
assert.equal(bubbleWithFallback.some((item) => item.kind === 'text' && item.content === '已经帮你调好了。'), true);
assert.equal(bubbleWithFallback.some((item) => item.kind === 'process'), true);

const interleavedRoundEvents = [
  {
    type: 'text_delta',
    eventId: 'txt-a',
    eventSequence: 1,
    content: '你说得对，这次我直接调。',
    metadata: { bubbleIndex: 0, route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'tool_call',
    eventId: 'tc-a',
    eventSequence: 2,
    content: 'mijia_list_devices',
    metadata: { tool_name: 'mijia_list_devices', route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'tool_result',
    eventId: 'tr-a',
    eventSequence: 3,
    content: 'ok',
    metadata: { route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'text_delta',
    eventId: 'txt-b',
    eventSequence: 4,
    content: '支持彩色模式，先切 mode。',
    metadata: { bubbleIndex: 0, route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'tool_call',
    eventId: 'tc-b',
    eventSequence: 5,
    content: 'mijia_set_device_property',
    metadata: { tool_name: 'mijia_set_device_property', route: 'chat-fast', companion_v3: true },
  },
  {
    type: 'tool_result',
    eventId: 'tr-b',
    eventSequence: 6,
    content: 'ok',
    metadata: { route: 'chat-fast', companion_v3: true },
  },
];
const roundItems = timelineItemsForBubble(interleavedRoundEvents, 0);
assert.equal(roundItems.length, 4);
assert.equal(roundItems[0].kind, 'text');
assert.equal(roundItems[1].kind, 'process');
assert.equal(roundItems[2].kind, 'text');
assert.equal(roundItems[3].kind, 'process');

const dialogueItems = buildCompanionDialogueDisplayItems(interleavedRoundEvents);
assert.equal(dialogueItems.length, 2);
assert.equal(dialogueItems[0].content, '你说得对，这次我直接调。');
assert.equal(dialogueItems[1].content, '支持彩色模式，先切 mode。');
const toolsOnlyEvents = [
  {
    type: 'tool_call',
    eventId: 'tc-only',
    eventSequence: 1,
    metadata: { route: 'chat-fast', companion_v3: true, tool_name: 'demo' },
  },
];
assert.equal(
  shouldShowCompanionWorkingHint(
    interleavedRoundEvents.slice(0, 3),
    'sending',
    '你说得对，这次我直接调。',
  ),
  true,
);
assert.equal(
  shouldShowCompanionWorkingHint(toolsOnlyEvents, 'sending', ''),
  false,
);
assert.equal(
  shouldShowCompanionWorkingHint(interleavedRoundEvents, 'sent'),
  false,
);

const afterStreamCompleted = [
  ...interleavedRoundEvents.slice(0, 3),
  {
    type: 'state',
    eventId: 'st-complete',
    eventSequence: 4,
    content: 'text_stream_completed',
    metadata: { route: 'chat-fast', companion_v3: true },
  },
];
assert.equal(
  shouldShowCompanionWorkingHint(
    afterStreamCompleted,
    'sending',
    '你说得对，这次我直接调。',
  ),
  false,
);

const afterDone = [
  ...interleavedRoundEvents.slice(0, 3),
  {
    type: 'done',
    eventId: 'done-1',
    eventSequence: 4,
    metadata: { route: 'chat-fast', companion_v3: true, run_status: 'done' },
  },
];
assert.equal(
  shouldShowCompanionWorkingHint(
    afterDone,
    'sending',
    '你说得对，这次我直接调。',
  ),
  false,
);

const fallbackDialogue = buildCompanionDialogueDisplayItems(toolsOnlyEvents, '中间文本已到达');
assert.equal(fallbackDialogue.length, 1);
assert.equal(fallbackDialogue[0].content, '中间文本已到达');

const joinedLive = buildCompanionLiveText([
  { type: 'text_delta', eventId: 't1', eventSequence: 1, content: '好，先查设备。', metadata: { route: 'chat-fast' } },
  { type: 'tool_call', eventId: 'tc1', eventSequence: 2, metadata: { route: 'chat-fast', tool_name: 'demo' } },
  { type: 'text_delta', eventId: 't2', eventSequence: 3, content: '帮你关灯。', metadata: { route: 'chat-fast' } },
]);
assert.equal(joinedLive, '好，先查设备。\n\n帮你关灯。');

const joinedMidSentence = buildCompanionLiveText([
  { type: 'text_delta', eventId: 't1', eventSequence: 1, content: '明白，我现在重新', metadata: { route: 'chat-fast' } },
  { type: 'tool_call', eventId: 'tc1', eventSequence: 2, metadata: { route: 'chat-fast' } },
  { type: 'text_delta', eventId: 't2', eventSequence: 3, content: '执行一次关灯。', metadata: { route: 'chat-fast' } },
]);
assert.equal(joinedMidSentence, '明白，我现在重新执行一次关灯。');

console.log('message timeline regression ok');
