import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptGroupKey,
  buildAttemptGroups,
  retryReasonGroupLabel,
  attemptGroupTone,
  shouldShowAttemptGroupHeader,
  shouldUseAttemptGroupLayout,
} from '../src/utils/processGrouping.js';

function event(overrides) {
  return {
    eventId: overrides.eventId ?? `evt-${overrides.eventSequence ?? 1}`,
    eventSequence: overrides.eventSequence ?? 1,
    type: overrides.type ?? 'thought',
    content: overrides.content ?? '',
    attemptNo: overrides.attemptNo,
    attemptGroupId: overrides.attemptGroupId,
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

test('attemptGroupKey prefers attemptGroupId over attemptNo', () => {
  assert.equal(
    attemptGroupKey(event({ eventSequence: 1, attemptNo: 3, attemptGroupId: 'repair-1' })),
    'group:repair-1',
  );
});

test('buildAttemptGroups merges adjacent nodes in the same attempt group', () => {
  const groups = buildAttemptGroups([
    { event: event({ eventSequence: 1, attemptNo: 1 }), children: [] },
    { event: event({ eventSequence: 2, attemptNo: 1, metadata: { retry_reason: 'arg_repair' } }), children: [] },
    { event: event({ eventSequence: 3, attemptNo: 2, metadata: { retry_reason: 'tool_fallback' } }), children: [] },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].attemptNo, 1);
  assert.equal(groups[0].nodes.length, 2);
  assert.equal(groups[0].retryReason, 'arg_repair');
  assert.equal(groups[1].attemptNo, 2);
  assert.equal(groups[1].retryReason, 'tool_fallback');
});

test('retryReasonGroupLabel and attemptGroupTone expose stable retry semantics', () => {
  assert.equal(retryReasonGroupLabel('arg_repair'), '参数修复');
  assert.equal(retryReasonGroupLabel('replan_full'), '全量重规划');
  assert.equal(attemptGroupTone({ retryReason: 'arg_repair' }), 'accent');
  assert.equal(attemptGroupTone({ retryReason: 'tool_fallback' }), 'warning');
  assert.equal(retryReasonGroupLabel('parallel_group_failed'), '并行组失败');
  assert.equal(retryReasonGroupLabel('final_validation_failed'), '最终验收未通过');
  assert.equal(attemptGroupTone({ retryReason: 'parallel_group_failed' }), 'warning');
  assert.equal(attemptGroupTone({ retryReason: null }), 'neutral');
});

test('attempt group headers stay hidden for low-signal single groups', () => {
  const neutralGroup = {
    id: 'attempt:1',
    attemptNo: 1,
    retryReason: null,
    nodes: [{ event: event({ eventSequence: 1, attemptNo: 1 }), children: [] }],
  };
  const continueGroup = {
    ...neutralGroup,
    retryReason: 'continue_after_plan',
  };
  const repairGroup = {
    ...neutralGroup,
    retryReason: 'arg_repair',
  };

  assert.equal(shouldUseAttemptGroupLayout([neutralGroup]), false);
  assert.equal(shouldShowAttemptGroupHeader([neutralGroup], neutralGroup), false);
  assert.equal(shouldUseAttemptGroupLayout([continueGroup]), false);
  assert.equal(shouldShowAttemptGroupHeader([continueGroup], continueGroup), false);
  assert.equal(shouldUseAttemptGroupLayout([repairGroup]), true);
  assert.equal(shouldShowAttemptGroupHeader([repairGroup], repairGroup), true);
});

test('attempt group headers remain visible when multiple attempts exist', () => {
  const firstGroup = {
    id: 'attempt:1',
    attemptNo: 1,
    retryReason: null,
    nodes: [{ event: event({ eventSequence: 1, attemptNo: 1 }), children: [] }],
  };
  const secondGroup = {
    id: 'attempt:2',
    attemptNo: 2,
    retryReason: null,
    nodes: [{ event: event({ eventSequence: 2, attemptNo: 2 }), children: [] }],
  };
  const groups = [firstGroup, secondGroup];

  assert.equal(shouldUseAttemptGroupLayout(groups), true);
  assert.equal(shouldShowAttemptGroupHeader(groups, firstGroup), true);
  assert.equal(shouldShowAttemptGroupHeader(groups, secondGroup), true);
});

test('fragmented groups from the same first attempt are rendered without attempt headers', () => {
  const groups = [
    {
      id: 'group:observe',
      attemptNo: 1,
      retryReason: null,
      nodes: [{ event: event({ eventSequence: 1, attemptNo: 1, attemptGroupId: 'observe' }), children: [] }],
    },
    {
      id: 'group:search',
      attemptNo: 1,
      retryReason: null,
      nodes: [{ event: event({ eventSequence: 2, attemptNo: 1, attemptGroupId: 'search' }), children: [] }],
    },
  ];

  assert.equal(shouldUseAttemptGroupLayout(groups), false);
  assert.equal(shouldShowAttemptGroupHeader(groups, groups[0]), false);
  assert.equal(shouldShowAttemptGroupHeader(groups, groups[1]), false);
});
