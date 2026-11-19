import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const memoryEchoPanel = fs.readFileSync(
  path.join(process.cwd(), 'src/components/chat/MemoryEchoPanel.vue'),
  'utf8',
);

test('memory echo panel renders dropped candidate diagnostics from backend payload', () => {
  assert.match(memoryEchoPanel, /droppedCandidates\?: MemoryEchoSnippet\[\]/);
  assert.match(memoryEchoPanel, /selectedEntry\.snapshot\.droppedCandidates\?\.length/);
  assert.match(memoryEchoPanel, /未入选候选/);
  assert.match(memoryEchoPanel, /snippet\.dropReason/);
});

test('memory echo panel shows channel score breakdown for selected and dropped items', () => {
  const breakdownUses = memoryEchoPanel.match(/snippet\.scoreBreakdown/g) || [];
  assert.ok(breakdownUses.length >= 4);
  assert.match(memoryEchoPanel, /candidateCount/);
  assert.match(memoryEchoPanel, /selectedCount/);
});

test('memory echo panel no longer submits v2 usage feedback', () => {
  assert.doesNotMatch(memoryEchoPanel, /usage-feedback/);
  assert.doesNotMatch(memoryEchoPanel, /sendMemoryFeedback/);
});
