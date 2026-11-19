import assert from 'node:assert/strict';
import { sanitizeTerminalDisplayOutput } from '../src/utils/terminalOutput.js';

const raw = [
  '\x1b[1t',
  '\x1b[c\x1b[?1004h\x1b[?9001h',
  'Windows PowerShell\r\n',
  'Copyright (C) Microsoft Corporation. All rights reserved.\r\n',
  'Try the new cross-platform PowerShell https://aka.ms/pscore6\r\n',
  '\x1b]0;管理员: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x1b\\',
  'Loading personal and system profiles took 662ms.\r\n',
  'PS E:\\Project\\LingShu-Agent> \r\n',
  "\x1b[7;30Hobsidian help; echo '__EXIT_CODE_deadbeef__:'+$LASTEXITCODE\x1b[0m\r\n",
  'Obsidian CLI\r\n',
  '\r\nUsage: obsidian <command> [options]\r\n',
  '__EXIT_CODE_deadbeef__:\r\n+0\r\n',
  'PS E:\\Project\\LingShu-Agent> ',
].join('');

const sanitized = sanitizeTerminalDisplayOutput(raw);

assert.equal(
  sanitized,
  ['Obsidian CLI', 'Usage: obsidian <command> [options]'].join('\n'),
  'terminal display output should keep command results while dropping PTY noise',
);

console.log('terminal-output-sanitization regression passed');
