function normalizeToolName(event) {
  if (!event || typeof event !== 'object') return '';
  const metadata = event.metadata || {};
  if (typeof metadata.tool_name === 'string' && metadata.tool_name.trim()) {
    return metadata.tool_name.trim();
  }
  if (typeof event.content === 'string' && event.type === 'tool_call' && event.content.trim()) {
    return event.content.trim();
  }
  return '';
}

function extractToolArgs(event) {
  if (!event || typeof event !== 'object') return undefined;
  const metadata = event.metadata || {};
  return metadata.tool_args ?? metadata.arguments;
}

function formatStructuredValue(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function formatToolResultContent(toolResult, fallbackContent = '') {
  const formatted = formatStructuredValue(toolResult);
  return formatted || fallbackContent;
}

function isEmptyPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

export function buildProcessEventSections(event, options = {}) {
  const sections = [];
  const toolName = normalizeToolName(event);
  const args = extractToolArgs(event);
  const terminalCommand = typeof options.terminalCommand === 'string' ? options.terminalCommand.trim() : '';
  const terminalOutput = typeof options.terminalOutput === 'string' ? options.terminalOutput : '';

  if (event?.type === 'tool_call') {
    if (toolName) {
      sections.push({ key: 'tool', title: '工具', content: toolName, copyText: toolName });
    }
    sections.push({
      key: 'args',
      title: '参数',
      content: args === undefined || isEmptyPlainObject(args) ? '无' : formatStructuredValue(args),
      copyText: args === undefined || isEmptyPlainObject(args) ? '无' : formatStructuredValue(args),
    });
  }

  if (event?.type === 'tool_result') {
    const classification = typeof event.metadata?.result_classification === 'string'
      ? event.metadata.result_classification.trim()
      : '';
    const toolResult = event.metadata?.tool_result;
    const resultContent = formatToolResultContent(toolResult, String(event.content || '').trim());

    if (toolName) {
      sections.push({ key: 'tool', title: '工具', content: toolName, copyText: toolName });
    }
    if (classification) {
      sections.push({ key: 'classification', title: '结果状态', content: classification, copyText: classification });
    }
    if (resultContent) {
      sections.push({ key: 'result', title: '结果', content: resultContent, copyText: resultContent });
    }
  }

  if (event?.type === 'llm_request') {
    const method = typeof event.metadata?.method === 'string' && event.metadata.method.trim()
      ? event.metadata.method.trim()
      : 'POST';
    const url = typeof event.metadata?.url === 'string' ? event.metadata.url.trim() : '';
    const payload = event.metadata?.payload;
    const payloadContent = formatStructuredValue(payload);

    sections.push({ key: 'method', title: 'Method', content: method, copyText: method });
    if (url) {
      sections.push({ key: 'url', title: 'URL', content: url, copyText: url });
    }
    sections.push({
      key: 'payload',
      title: 'Payload',
      content: payloadContent || '无',
      copyText: payloadContent || '无',
    });
  }

  if (terminalCommand) {
    sections.push({ key: 'terminal-command', title: '命令', content: terminalCommand, copyText: terminalCommand });
  }

  if (terminalOutput) {
    sections.push({ key: 'terminal-output', title: '输出', content: terminalOutput, copyText: terminalOutput });
  }

  return sections;
}

export function buildToolCallEventSections(toolCallEvent, toolResultEvent = null, options = {}) {
  const sections = buildProcessEventSections(toolCallEvent, options);

  if (!toolResultEvent || toolResultEvent.type !== 'tool_result') {
    return sections;
  }

  const resultSections = buildProcessEventSections(toolResultEvent)
    .filter((section) => section.key !== 'tool')
    .map((section) => {
      if (section.key === 'classification') {
        return { ...section, key: 'tool-result-classification', title: '返回状态' };
      }
      if (section.key === 'result') {
        return { ...section, key: 'tool-result', title: '返回结果' };
      }
      return { ...section, key: `tool-result-${section.key}` };
    });

  return [...sections, ...resultSections];
}
