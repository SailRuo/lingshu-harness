import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const messageList = fs.readFileSync(
  path.join(process.cwd(), 'src/components/chat/MessageList.vue'),
  'utf8',
);
const thoughtProcess = fs.readFileSync(
  path.join(process.cwd(), 'src/components/chat/ThoughtProcess.vue'),
  'utf8',
);
const chatWindow = fs.readFileSync(
  path.join(process.cwd(), 'src/components/chat/ChatWindow.vue'),
  'utf8',
);

test('assistant timeline text renders through the streaming/final markdown surface', () => {
  assert.match(messageList, /class="bubble-text-inner"/);
  assert.match(
    messageList,
    /msg\.status === 'sending' \? renderStreamingText\(textContentFor\(item, msg\)\) : renderMarkdown\(msg\.id, textContentFor\(item, msg\)\)/,
  );
  assert.doesNotMatch(messageList, /line-height:\s*2\s*!important/);
});

test('assistant task bubbles do not mount the terminal panel beneath process details', () => {
  assert.doesNotMatch(messageList, /import TerminalPanel from '\.\/TerminalPanel\.vue';/);
  assert.doesNotMatch(messageList, /<TerminalPanel/);
  assert.doesNotMatch(messageList, /class="embedded-terminal-panel"/);
});

test('assistant timeline branches process fragments separately from text fragments', () => {
  assert.match(
    messageList,
    /<template v-if="item\.kind === 'process' && !isCompanionDialogueMessage\(msg, timelineEventsFor\(msg\)\)">[\s\S]*?<ThoughtProcess[\s\S]*?<\/template>\s*<template v-else-if="item\.kind === 'text'">/,
  );
  assert.doesNotMatch(
    messageList,
    /<TerminalPanel[\s\S]*<div\s+v-else/,
  );
});

test('message list watchers defer until post-render and stop touching DOM after unmount', () => {
  assert.match(messageList, /const isActive = ref\(false\);/);
  assert.match(messageList, /onMounted\(\(\) => \{\s*isActive\.value = true;/);
  assert.match(messageList, /onUnmounted\(\(\) => \{\s*isActive\.value = false;/);
  assert.match(messageList, /\{\s*deep: true,\s*flush: 'post'\s*\}/);
  assert.match(messageList, /if \(!isActive\.value\) return;/);
});

test('message list uses render signatures and remounts per conversation to avoid patching incompatible trees', () => {
  assert.match(messageList, /function messageRenderKey\(msg: AnyMessage\): string/);
  assert.match(messageList, /:key="messageRenderKey\(msg\)"/);
  assert.match(chatWindow, /<MessageList\s+:key="chatStore\.currentConversationId \|\| 'no-conversation'"/);
  const renderKeyBlock = messageList.match(/function messageRenderKey\(msg: AnyMessage\): string \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(renderKeyBlock.length > 0);
  assert.doesNotMatch(renderKeyBlock, /events\.length/);
});

test('thought process suppresses low-signal retry chatter instead of rendering fallback boilerplate', () => {
  assert.match(thoughtProcess, /const lowSignalRetryReasons = new Set\(\['continue_after_tool', 'continue_after_plan', 'tool_fallback'\]\);/);
  assert.match(thoughtProcess, /if \(retryReason && lowSignalRetryReasons\.has\(retryReason\)\) \{\s*return true;\s*\}/);
  assert.doesNotMatch(thoughtProcess, /检测到工具不可用，已切换备用工具继续执行/);
  assert.doesNotMatch(thoughtProcess, /当前步骤已完成，正在推进执行计划的下一步/);
});

test('thought process avoids implying a fixed total-step count for the whole task', () => {
  assert.doesNotMatch(thoughtProcess, /共 \$\{executionPlanSummary\.value\.stepCount\} 步/);
  assert.doesNotMatch(thoughtProcess, /已完成 \$\{executionPlanSummary\.value\.completedStepCount \|\| executionPlanSummary\.value\.stepCount\} 个步骤/);
  assert.match(thoughtProcess, /return '当前规划已完成';/);
  assert.match(thoughtProcess, /return '当前规划已完成，正在继续规划';/);
  assert.match(thoughtProcess, /return '当前规划已完成，正在补齐剩余条件';/);
  assert.match(thoughtProcess, /return '当前处理';/);
});

test('thought process reads missing skills and requirements from decide output instead of plan summary', () => {
  assert.match(thoughtProcess, /const decisionContextSummary = computed/);
  assert.match(thoughtProcess, /event\.metadata\?\.decision_context/);
  assert.match(thoughtProcess, /missing_requirements/);
  assert.match(thoughtProcess, /missing_skills/);
  assert.match(thoughtProcess, /还有任务条件待完成/);
});

test('thought process surfaces decide step results back onto each execution-plan step', () => {
  assert.match(thoughtProcess, /function stepDecisionPayloadForPlanStep\(step:/);
  assert.match(thoughtProcess, /!\['decide', 'plan'\]\.includes\(nodeName\)/);
  assert.match(thoughtProcess, /function toggleStepDecision\(step:/);
  assert.match(thoughtProcess, /function isStepDecisionExpanded\(step:/);
  assert.match(thoughtProcess, /function reflectStepForPlanStep\(step:/);
  assert.match(thoughtProcess, /function stepDecisionResultLabel\(step:/);
  assert.match(thoughtProcess, /function stepDecisionResultDetail\(step:/);
  assert.match(thoughtProcess, /step_decision_result/);
  assert.match(thoughtProcess, /<span class="node-label">步骤结果<\/span>/);
  assert.match(thoughtProcess, /class="tree-node activity-node step-decision-node"/);
  assert.match(thoughtProcess, /状态: \$\{status\}/);
  assert.match(thoughtProcess, /下一步: \$\{nextStep\}/);
});

test('thought process only offers resume for resumable interruptions and hints direct input for ask-user pauses', () => {
  assert.match(thoughtProcess, /shouldOfferResumeForInterruptedTask/);
  assert.match(thoughtProcess, /const shouldShowResumeAction = computed/);
  assert.match(thoughtProcess, /const shouldShowDirectInputHint = computed/);
  assert.match(thoughtProcess, /直接在下方输入补充信息继续/);
});
