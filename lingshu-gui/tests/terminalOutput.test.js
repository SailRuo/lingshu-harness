import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTerminalDisplayOutput } from '../src/utils/terminalOutput.js';

test('sanitizeTerminalDisplayOutput removes terminal protocol markers and shell prompts', () => {
  const output = sanitizeTerminalDisplayOutput([
    'PS E:\\Project\\LingShu-Agent>',
    '__COMMAND_START_a97ff8bb__',
    'The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.',
    '__EXIT_CODE_a97ff8bb__:1',
    '1',
  ].join('\n'));

  assert.equal(
    output,
    'The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.',
  );
});
