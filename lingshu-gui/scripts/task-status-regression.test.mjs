import assert from 'node:assert/strict';
import { deriveTaskStatusFromEvents } from '../src/utils/taskStatus.js';

const runningEvents = [
  {
    type: 'state',
    metadata: {
      run_status: 'running',
    },
  },
];

assert.equal(deriveTaskStatusFromEvents(runningEvents), 'running');

const completedEvents = [
  {
    type: 'state',
    metadata: {
      run_status: 'running',
    },
  },
  {
    type: 'done',
    metadata: {
      run_status: 'done',
    },
  },
];

assert.equal(deriveTaskStatusFromEvents(completedEvents), 'done');

const historicalDoneEvents = [
  {
    type: 'thought',
    metadata: {},
  },
  {
    type: 'done',
    metadata: {},
  },
];

assert.equal(deriveTaskStatusFromEvents(historicalDoneEvents), 'done');

console.log('task status regression ok');
