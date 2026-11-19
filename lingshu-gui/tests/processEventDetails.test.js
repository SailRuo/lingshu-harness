import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProcessEventSections,
  buildToolCallEventSections,
} from '../src/utils/processEventDetails.js';

function toolCall(overrides = {}) {
  return {
    eventId: 'call-1',
    eventSequence: 1,
    type: 'tool_call',
    content: 'exa_web_search_exa',
    metadata: {
      tool_name: 'exa_web_search_exa',
      tool_args: { query: 'github trending', numResults: 10 },
    },
    ...overrides,
  };
}

function toolResult(overrides = {}) {
  return {
    eventId: 'result-1',
    parentEventId: 'call-1',
    eventSequence: 2,
    type: 'tool_result',
    content: '',
    metadata: {
      tool_name: 'exa_web_search_exa',
      result_classification: 'success',
      tool_result: {
        items: [
          { title: 'Result A', url: 'https://example.test/a' },
          { title: 'Result B', url: 'https://example.test/b' },
        ],
      },
    },
    ...overrides,
  };
}

test('buildProcessEventSections renders tool result content directly', () => {
  const sections = buildProcessEventSections(toolResult());

  assert.deepEqual(
    sections.map((section) => section.key),
    ['tool', 'classification', 'result'],
  );
  assert.match(sections.find((section) => section.key === 'result')?.content ?? '', /Result A/);
});

test('buildToolCallEventSections appends a non-terminal tool result to the tool call details', () => {
  const sections = buildToolCallEventSections(toolCall(), toolResult());

  assert.deepEqual(
    sections.map((section) => section.key),
    ['tool', 'args', 'tool-result-classification', 'tool-result'],
  );
  assert.equal(sections.find((section) => section.key === 'tool-result-classification')?.title, '返回状态');
  assert.equal(sections.find((section) => section.key === 'tool-result')?.title, '返回结果');
  assert.match(sections.find((section) => section.key === 'tool-result')?.content ?? '', /Result B/);
});

test('buildToolCallEventSections keeps terminal output handling separate', () => {
  const sections = buildToolCallEventSections(
    toolCall({ metadata: { tool_name: 'run_terminal_command', tool_args: { command: 'pwd' } } }),
    toolResult(),
    { terminalCommand: 'pwd', terminalOutput: 'E:\\Project\\LingShu-Agent' },
  );

  assert.deepEqual(
    sections.map((section) => section.key),
    ['tool', 'args', 'terminal-command', 'terminal-output', 'tool-result-classification', 'tool-result'],
  );
});

test('buildProcessEventSections exposes structured terminal result streams', () => {
  const sections = buildProcessEventSections({
    type: 'tool_result',
    content: '',
    metadata: {
      tool_name: 'run_terminal_command',
      result_classification: 'success',
      tool_result: {
        preview: 'Created: Inbox/天气.md',
        executed_command: 'defuddle parse https://example.test --md',
        execution_descriptor: {
          command: 'defuddle parse https://example.test --md',
          argv: ['defuddle', 'parse', 'https://example.test', '--md'],
          stdin_text: null,
          temp_files: [],
          script_body: null,
          workdir: 'E:\\Project\\LingShu-Agent',
          env: {},
          transport: 'argv',
        },
        stdout: 'Created: Inbox/天气.md',
        stderr: 'warning: sample',
        exit_code: 0,
      },
    },
  });

  assert.deepEqual(
    sections.map((section) => section.key),
    ['tool', 'classification', 'result'],
  );
  const resultContent = sections.find((section) => section.key === 'result')?.content ?? '';
  assert.match(resultContent, /"executed_command": "defuddle parse https:\/\/example\.test --md"/);
  assert.match(resultContent, /"stdout": "Created: Inbox\/天气\.md"/);
  assert.match(resultContent, /"stderr": "warning: sample"/);
  assert.match(resultContent, /"exit_code": 0/);
});

test('buildProcessEventSections keeps raw tool results intact', () => {
  const sections = buildProcessEventSections({
    type: 'tool_result',
    content: '',
    metadata: {
      tool_name: 'exa_web_search_exa',
      result_classification: 'success',
      tool_result: {
        preview: [
          'Title: 上海 - 中国气象局-天气预报-城市预报',
          'URL: https://weather.cma.cn/web/weather/58367.html',
          'Published: N/A',
          'Author: N/A',
          'Highlights:',
          '[...]',
          '星期五 05/08',
          '[...]',
          '22℃',
          '[...]',
          '14℃',
          '[...]',
          '明天上海的天气情况如下：气温在20℃到27℃之间，天气较为舒适。',
        ].join('\n'),
        summary: {
          strategy: 'inline',
          source: 'tool:exa_web_search_exa',
          contentType: 'web_markdown',
          recommendedViews: ['raw', 'sections', 'links', 'summary_transform'],
        },
        artifact: {
          content_type: 'web_markdown',
        },
      },
    },
  });

  assert.deepEqual(
    sections.map((section) => section.key),
    ['tool', 'classification', 'result'],
  );
  const resultContent = sections.find((section) => section.key === 'result')?.content ?? '';
  assert.match(resultContent, /Title: 上海 - 中国气象局-天气预报-城市预报/);
  assert.match(resultContent, /URL: https:\/\/weather\.cma\.cn\/web\/weather\/58367\.html/);
  assert.match(resultContent, /明天上海的天气情况如下：气温在20℃到27℃之间，天气较为舒适。/);
  assert.match(resultContent, /Highlights:/);
  assert.match(resultContent, /\[\.\.\.\]/);
});

test('buildProcessEventSections renders llm request method url and payload', () => {
  const sections = buildProcessEventSections({
    type: 'llm_request',
    content: '',
    metadata: {
      method: 'POST',
      url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      payload: {
        model: 'doubao-seed-1-6-thinking',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      },
    },
  });

  assert.deepEqual(
    sections.map((section) => section.key),
    ['method', 'url', 'payload'],
  );
  assert.equal(sections.find((section) => section.key === 'method')?.content, 'POST');
  assert.equal(
    sections.find((section) => section.key === 'url')?.content,
    'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  );
  assert.match(sections.find((section) => section.key === 'payload')?.content ?? '', /"model": "doubao-seed-1-6-thinking"/);
});
