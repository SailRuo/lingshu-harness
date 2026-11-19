function normalizeToolName(event) {
  if (!event || typeof event !== 'object') return '';
  const metadata = event.metadata || {};
  if (typeof metadata.tool_name === 'string' && metadata.tool_name.trim()) {
    return metadata.tool_name.trim();
  }
  if (typeof event.content === 'string' && event.content.trim()) {
    return event.content.trim();
  }
  return '';
}

function extractToolArgs(event) {
  if (!event || typeof event !== 'object') return undefined;
  const metadata = event.metadata || {};
  return metadata.tool_args ?? metadata.arguments;
}

function isPlainEmptyObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

export function buildToolCallDetailLines(event) {
  const toolName = normalizeToolName(event);
  const args = extractToolArgs(event);

  if (args === undefined || isPlainEmptyObject(args)) {
    return toolName ? [`tool: ${toolName}`, 'args: (none)'] : ['args: (none)'];
  }

  return toolName
    ? [`tool: ${toolName}`, JSON.stringify(args, null, 2)]
    : [JSON.stringify(args, null, 2)];
}
