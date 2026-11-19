import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatGraphSummary,
  isDetailPanelVisible,
  shouldShowFloatingRefresh,
} from '../src/utils/memoryGraphLayout.js';

test('detail panel stays hidden until a node is selected', () => {
  assert.equal(isDetailPanelVisible(null), false);
  assert.equal(isDetailPanelVisible('node-1'), true);
});

test('floating refresh only shows when no node is selected', () => {
  assert.equal(shouldShowFloatingRefresh(null), true);
  assert.equal(shouldShowFloatingRefresh('node-1'), false);
});

test('graph summary keeps source and counts together', () => {
  assert.equal(formatGraphSummary('runtime', 3, 2), 'Runtime · 3 节点 · 2 关系');
  assert.equal(formatGraphSummary('kuzu', 5, 4), 'Kuzu · 5 节点 · 4 关系');
});
