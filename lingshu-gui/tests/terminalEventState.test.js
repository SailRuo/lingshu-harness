import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTerminalEventState,
  isTerminalStreamEventType,
} from '../src/utils/terminalEventState.js';

test('isTerminalStreamEventType recognizes legacy terminal events', () => {
  assert.equal(isTerminalStreamEventType('terminal_output'), true);
  assert.equal(isTerminalStreamEventType('tool_call'), false);
});

test('applyTerminalEventState is a no-op after PTY removal', () => {
  const state = {
    terminalSessions: {},
    rawTerminalOutputMap: {},
    terminalOutputMap: {},
  };
  const next = applyTerminalEventState(state);
  assert.equal(next, state);
});
