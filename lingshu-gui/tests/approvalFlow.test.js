import test from 'node:test';
import assert from 'node:assert/strict';

import { resumeApprovedTask, runApprovalFlow } from '../src/utils/approvalFlow.js';

test('resumeApprovedTask returns success when no task id is provided', async () => {
  const result = await resumeApprovedTask({
    resume: async () => {
      throw new Error('should not run');
    },
    taskId: '',
  });

  assert.equal(result.approved, true);
  assert.equal(result.resumeAttempted, false);
  assert.equal(result.resumeSucceeded, false);
});

test('returns approved result even when auto resume fails', async () => {
  const result = await runApprovalFlow({
    approve: async () => ({ ok: true }),
    resume: async () => {
      throw new Error('Task resume failed');
    },
    taskId: 'task-1',
  });

  assert.equal(result.approved, true);
  assert.equal(result.resumeAttempted, true);
  assert.equal(result.resumeSucceeded, false);
  assert.equal(result.resumeNotRequired, false);
  assert.match(result.resumeErrorMessage || '', /Task resume failed/);
});

test('treats already-non-interrupted resume as non-fatal', async () => {
  const result = await runApprovalFlow({
    approve: async () => ({ ok: true }),
    resume: async () => {
      throw new Error('Only interrupted tasks can be resumed');
    },
    taskId: 'task-1',
  });

  assert.equal(result.approved, true);
  assert.equal(result.resumeAttempted, true);
  assert.equal(result.resumeSucceeded, false);
  assert.equal(result.resumeNotRequired, true);
  assert.equal(result.resumeErrorMessage, null);
});

test('returns failure when approval request fails', async () => {
  const result = await runApprovalFlow({
    approve: async () => ({ ok: false, errorMessage: 'Approval request not found or expired' }),
    resume: async () => {
      throw new Error('should not run');
    },
    taskId: 'task-1',
  });

  assert.equal(result.approved, false);
  assert.equal(result.resumeAttempted, false);
  assert.equal(result.resumeNotRequired, false);
  assert.equal(result.errorMessage, 'Approval request not found or expired');
});
