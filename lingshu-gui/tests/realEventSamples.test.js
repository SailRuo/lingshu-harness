import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimelineItems } from '../src/utils/messageTimeline.js';
import { deriveTaskStatusFromEvents } from '../src/utils/taskStatus.js';
import { buildAttemptGroups, retryReasonGroupLabel, attemptGroupTone } from '../src/utils/processGrouping.js';
import { obsidianTerminalFallbackSample, argRepairRetrySample } from '../src/dev/taskPreviewSamples.js';

test('obsidian terminal fallback sample renders process digest plus final text', () => {
  const events = obsidianTerminalFallbackSample();
  const items = buildTimelineItems(events);

  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'process');
  assert.equal(items[1].kind, 'text');
  assert.equal(items[1].content, '已创建 Obsidian 笔记，并确认存在测试笔记.md');
  assert.equal(deriveTaskStatusFromEvents(events), 'done');
});

test('arg repair sample preserves repair semantics even when lifecycle events form a leading standalone group', () => {
  const events = argRepairRetrySample();
  const groups = buildAttemptGroups(events.map((event) => ({ event, children: [] })));

  assert.equal(groups.length, 3);
  assert.equal(groups[0].attemptNo, 1);
  assert.equal(groups[1].attemptNo, 1);
  assert.equal(groups[2].attemptNo, 2);
  assert.equal(groups[2].retryReason, 'arg_repair');
  assert.equal(retryReasonGroupLabel(groups[2].retryReason), '参数修复');
  assert.equal(attemptGroupTone(groups[2]), 'accent');
  assert.equal(deriveTaskStatusFromEvents(events), 'done');
});

test('arg repair sample timeline separates final assistant text from process digest', () => {
  const events = argRepairRetrySample();
  const items = buildTimelineItems(events);

  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'process');
  assert.equal(items[1].kind, 'text');
  assert.equal(items[1].content, '笔记已创建成功');
});
