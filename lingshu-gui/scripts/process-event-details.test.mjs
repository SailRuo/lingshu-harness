import assert from 'node:assert/strict';
import { buildProcessEventSections, buildToolCallEventSections } from '../src/utils/processEventDetails.js';

const toolCallSections = buildProcessEventSections({
  type: 'tool_call',
  content: 'exa_web_search_exa',
  metadata: {
    tool_name: 'exa_web_search_exa',
    tool_args: { query: '上海明天天气' },
  },
});

assert.deepEqual(
  toolCallSections.map((section) => section.title),
  ['工具', '参数'],
);
assert.equal(toolCallSections[0].content, 'exa_web_search_exa');
assert.match(toolCallSections[1].content, /"query": "上海明天天气"/);

const toolResultSections = buildProcessEventSections({
  type: 'tool_result',
  content: '已创建笔记',
  metadata: {
    tool_name: 'obsidian.create_note',
    result_classification: 'success',
    tool_result: {
      preview: '已创建笔记',
      summary: { strategy: 'inline' },
      artifact_ref: 'inline://tool-output',
    },
  },
});

assert.deepEqual(
  toolResultSections.map((section) => section.title),
  ['工具', '结果状态', '结果'],
);
assert.equal(toolResultSections[0].content, 'obsidian.create_note');
assert.equal(toolResultSections[1].content, 'success');
assert.match(toolResultSections[2].content, /"preview": "已创建笔记"/);

const rawWebToolResult = [
  'Title: 7天天气预报（2026/05/08 20:00发布）',
  'Url: https://weather.example/shanghai',
  '时间 | 23:00 | 02:00 | 05:00 | 08:00 | 11:00 | 14:00 | 17:00 | 20:00 |',
  '08:00 | 11:00',
  '晴，东南风 3 级。',
].join('\n');

const toolCallWithRawResultSections = buildToolCallEventSections(
  {
    type: 'tool_call',
    content: 'exa_web_search_exa',
    metadata: {
      tool_name: 'exa_web_search_exa',
      tool_args: { query: '明天上海天气', numResults: 1 },
    },
  },
  {
    type: 'tool_result',
    content: rawWebToolResult,
    metadata: {
      tool_name: 'exa_web_search_exa',
      result_classification: 'success',
      tool_result: {
        preview: '晴，东南风 3 级。',
        summary: { strategy: 'inline', contentType: 'web_markdown' },
        artifact: {
          content: rawWebToolResult,
          content_type: 'web_markdown',
        },
      },
    },
  },
);

const rawResultSection = toolCallWithRawResultSections.find((section) => section.key === 'tool-result');
assert.match(rawResultSection?.content ?? '', /"preview": "晴，东南风 3 级。"/);
assert.match(rawResultSection?.content ?? '', /"content": "Title: 7天天气预报/);
assert.equal(rawResultSection?.copyText, rawResultSection?.content);

const terminalSections = buildProcessEventSections(
  {
    type: 'tool_call',
    content: 'run_terminal_command',
    metadata: {
      tool_name: 'run_terminal_command',
      tool_args: { command: 'obsidian create name="天气"' },
    },
  },
  {
    terminalCommand: 'obsidian create name="天气"',
    terminalOutput: 'Created: Inbox/天气.md',
  },
);

assert.deepEqual(
  terminalSections.map((section) => section.title),
  ['工具', '参数', '命令', '输出'],
);
assert.equal(terminalSections[2].content, 'obsidian create name="天气"');
assert.equal(terminalSections[3].content, 'Created: Inbox/天气.md');

console.log('process event details formatting ok');
