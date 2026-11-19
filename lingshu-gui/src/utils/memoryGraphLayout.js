export function isDetailPanelVisible(selectedNodeId) {
  return Boolean(selectedNodeId);
}

export function shouldShowFloatingRefresh(selectedNodeId) {
  return !isDetailPanelVisible(selectedNodeId);
}

export function formatGraphSummary(source, nodesCount, linksCount) {
  const sourceLabel = source === 'kuzu' ? 'Kuzu' : 'Runtime';
  return `${sourceLabel} · ${nodesCount} 节点 · ${linksCount} 关系`;
}
