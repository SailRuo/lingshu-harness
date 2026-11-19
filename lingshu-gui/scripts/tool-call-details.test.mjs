import assert from 'node:assert/strict';
import { buildToolCallDetailLines } from '../src/utils/toolCallDetails.js';

const emptyArgsLines = buildToolCallDetailLines({
  type: 'tool_call',
  content: 'skills_explorer.list_skills',
  metadata: {
    tool_name: 'skills_explorer.list_skills',
    tool_args: {},
  },
});

assert.deepEqual(emptyArgsLines, [
  'tool: skills_explorer.list_skills',
  'args: (none)',
]);

const populatedArgsLines = buildToolCallDetailLines({
  type: 'tool_call',
  content: 'obsidian.read',
  metadata: {
    tool_name: 'obsidian.read',
    tool_args: { file: 'Inbox/Test.md' },
  },
});

assert.equal(populatedArgsLines[0], 'tool: obsidian.read');
assert.ok(populatedArgsLines[1].includes('"file": "Inbox/Test.md"'));

const missingNameLines = buildToolCallDetailLines({
  type: 'tool_call',
  metadata: {
    tool_args: {},
  },
});

assert.deepEqual(missingNameLines, ['args: (none)']);

console.log('tool call detail formatting ok');
