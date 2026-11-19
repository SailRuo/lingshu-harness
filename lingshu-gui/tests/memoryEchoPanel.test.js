import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const memoryEchoPanel = fs.readFileSync(
  path.join(process.cwd(), 'src/components/chat/MemoryEchoPanel.vue'),
  'utf8',
);

test('memory echo panel renders dropped candidate diagnostics from backend payload', () => {
  assert.match(memoryEchoPanel, /streamRecall\?: \{/);
  assert.match(memoryEchoPanel, /candidates\?: StreamRecallCandidate\[\]/);
  assert.match(memoryEchoPanel, /候选（未入选）/);
  assert.match(memoryEchoPanel, /item\.reason/);
  assert.match(memoryEchoPanel, /class="drop-reason"/);
});

test('memory echo panel shows similarity score for selected and dropped items', () => {
  const simUses = memoryEchoPanel.match(/sim \{\{ formatScore\(item\.similarity\) \}\}/g) || [];
  assert.ok(simUses.length >= 2);
  assert.match(memoryEchoPanel, /候选 \{\{ streamRecallCandidates\.length \}\}/);
  assert.match(memoryEchoPanel, /入选 \{\{ selectedStreams\.length \}\}/);
});

test('memory echo panel no longer submits v2 usage feedback', () => {
  assert.doesNotMatch(memoryEchoPanel, /usage-feedback/);
  assert.doesNotMatch(memoryEchoPanel, /sendMemoryFeedback/);
});
