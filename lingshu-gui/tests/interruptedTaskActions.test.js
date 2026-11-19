import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldOfferResumeForInterruptedTask } from '../src/utils/interruptedTaskActions.js';

test('does not offer resume for ask_user interruption', () => {
  const events = [
    {
      type: 'state',
      metadata: {
        action_type: 'ask_user',
        needs_clarification: true,
        final_validation: { status: 'accept', reason: 'ask_user' },
      },
    },
  ];

  assert.equal(shouldOfferResumeForInterruptedTask(events, 'interrupted'), false);
});

test('offers resume for approval interruption', () => {
  const events = [
    {
      type: 'state',
      metadata: {
        retry_reason: 'approval_resumed',
      },
    },
    {
      type: 'approval_required',
      metadata: {
        tool_name: 'run_terminal_command',
      },
    },
  ];

  assert.equal(shouldOfferResumeForInterruptedTask(events, 'interrupted'), true);
});

test('does not offer resume when task is not interrupted', () => {
  assert.equal(shouldOfferResumeForInterruptedTask([], 'running'), false);
});
