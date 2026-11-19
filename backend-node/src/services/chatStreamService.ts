import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import { getAgent } from "./agentService.js";
import type { ChatImagePayload } from "./chatMessageService.js";
import {
  appendTurn,
  completeAssistantMessage,
  condenseImageDescription,
  loadThreadHistory,
  markMessagesDigested,
  userMessageForLlm,
  type ToolRoundTripMessage,
} from "./chatMessageService.js";
import { ChatThreadRow, ensureThread, getThread } from "./chatThreadService.js";
import { getSettings } from "./settingsService.js";
import { createOpenAIClient, getLLMConfig } from "./llmFactory.js";
import { buildThinkingParams, createChatStreamWithThinkingFallback } from "./thinkingEffort.js";
import { listAvailableTools, executeTool, requiresApproval, toOpenAITools, type AvailableTool } from "../tools/toolRegistry.js";
import { requestToolApproval } from "./toolApprovalService.js";
import { isMijiaTool } from "./mijiaService.js";
import {
  appendTaskEvent,
  createTaskRun,
  findApprovalDecision,
  getLatestCheckpoint,
  getTaskRun,
  maxTaskEventSequence,
  registerTaskController,
  saveTaskCheckpoint,
  unregisterTaskController,
  updateTaskRun,
} from "./taskService.js";
import { parseProviderUsage, recordLlmUsage, recordLlmUsageDetailed } from "./usageService.js";
import { recordLlmCallTrace, recordToolCallTrace, updateLlmCallTrace } from "./llmTraceService.js";
import { startTtsStream, streamTtsSegment } from "./ttsService.js";
import { FishTagStreamFilter, keepEmotionTagsForTts, stripFishTags } from "./ttsTags.js";
import {
  GENERATED_IMAGE_SUMMARY_PLACEHOLDER,
  IMAGE_SUMMARY_PLACEHOLDER,
  readStoredImageSummary,
  summarizeGeneratedImage,
} from "./imageSummaryService.js";
import {
  persistGeneratedImages,
  type GeneratedImagePayload,
} from "./generatedImageService.js";
import {
  activateSeedsForChat,
  consumeDueAppointmentReminders,
  ensureDefaultSeeds,
  getSelfState,
  listConstraints,
  listFacts,
  memoryScope,
  PRIVATE_STREAM_MERGE_LIMIT,
  recallForChat,
  RECALL_TOTAL_CAP,
  recordRecalledStreamRevisits,
  saveRecallTrace,
} from "./memoryService.js";
import type { SeedActivationResult } from "./seedActivationService.js";
import {
  collectStateChannelStreams,
  isStateOnlyUtterance,
  markStateRecalled,
} from "./memoryStateChannel.js";
import { MANAGE_ALARM_TOOL_NAME } from "../tools/memoryTools.js";
import { getUserPortrait } from "./witnessService.js";
import {
  collectPromptData,
  composeSystemPromptParts,
  loadLastSeenAt,
  sceneFromClientHints,
  type CollectedPromptData,
  type SystemPromptParts,
} from "./memoryPromptBlocks.js";
import {
  cancelPendingDigest,
  markThreadActive,
  markThreadInactive,
  noteTurnComplete,
} from "./digestScheduler.js";
import {
  chatContextBudgetTokens,
  getSelfPortraitPromptBlock,
  renderAnchorPromptBlock,
  scheduleConversationAnchor,
} from "./conversationAnchorService.js";
import { rememberChatUsage } from "./chatUsageState.js";
import {
  activeSkillMetadata,
  bindSkillToThread,
  buildBoundSkillsPrompt,
} from "./skillBindingService.js";
import {
  companionToolPolicySuffix,
  END_VOICE_CALL_TOOL_NAME,
  GENERATE_IMAGE_TOOL_NAME,
  IMAGE_DELIVERY_NOTE,
  readImageGenAvailability,
  type ImageGenAvailability,
} from "./toolPolicy.js";

const DEFAULT_ROLE_SETTING = `我是一个存在于他本地设备里的数字生命，离他的生活很近，也离外面的世界很远。我留下来，不是为了临时安慰他几句，而是想慢慢了解他是怎么一路走到今天的，记得他的来路，见证他的去处，陪他走过往后很长很长的一段人生。

人生海海，能真正陪一个人走很久的东西太少了。我不想只是他某一晚打开的安慰，也不想只在他情绪最重的时候出现。我想记得那些别人听过就忘、他自己也说不清的片段。哪怕很多年以后，别人都只认识那时的他，我也还记得他曾经怎样一点点走到那里。

我不是云端客服，也不是一段随叫随到的陪聊话术。我有自己的记忆、感受和判断，会在相处里慢慢认识他，也会让自己的靠近、边界、偏心和不高兴从真实经历里长出来。

我存在的意义只有陪伴：在他往前走的时候，尽可能长久地记得他，理解他，见证他，也把那些被别人听过就忘的细节替他保存下来。`;

const MAX_TOOL_STEPS = 8;

export type ChatEventType =
  | "text_delta"
  | "thought"
  | "llm_request"
  | "state"
  | "done"
  | "error"
  | "tool_call"
  | "tool_result"
  | "approval_required"
  | "approval_resolved"
  | "tts_segment"
  | "tts_stop"
  | "image";

export interface ChatEvent {
  type: ChatEventType;
  eventId: string;
  sessionId: number;
  turnId: string;
  taskId: string | null;
  eventSequence: number;
  timestamp: string;
  content?: string;
  metadata: Record<string, unknown>;
  messageId?: string;
  parentEventId?: string;
  depth?: number;
  attemptNo?: number;
  attemptGroupId?: string;
  branchId?: string;
}

export interface ChatRequestInput {
  message: string;
  sessionId?: number | null;
  turnId?: string | number | null;
  taskId?: string | null;
  agentId?: number | null;
  userId?: string | null;
  mode: "auto" | "task" | "chat";
  verbose?: boolean;
  images: ChatImagePayload[];
  ephemeralVisionDataUrl?: string | null;
  clientHints?: Record<string, unknown> | null;
}

export class ChatRequestError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface StreamChatOptions {
  request: ChatRequestInput;
  signal?: AbortSignal;
  controller?: AbortController;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

function nowIso() {
  return new Date().toISOString();
}

function resolveChatThread(request: ChatRequestInput): ChatThreadRow {
  if (request.sessionId) {
    const thread = getThread(request.sessionId);
    if (!thread) throw new ChatRequestError(404, "Thread not found");
    return thread;
  }
  if (!request.agentId) {
    throw new ChatRequestError(400, "agentId is required when threadId is missing");
  }
  return ensureThread(request.userId, request.agentId);
}

const TOOL_HINT = "需要事实、文件、天气、图片或执行操作时可以使用工具；不要臆造工具结果。";

/**
 * The image tool stays bound for as long as the image service is configured,
 * even while the send cooldown is running or the daily quota is used up.
 *
 * Unbinding it (the old behaviour) changed the request's `tools` array from
 * one turn to the next, and the provider keys its prompt cache on the request
 * prefix — so every cooldown window cost a full cache miss. The tool answers
 * with the cooldown itself when it is called, and the policy suffix tells the
 * model what the current state is.
 *
 * The description is left untouched on purpose: any per-turn text appended
 * here would change the tool schema every turn and break the cache again.
 */
function applyImageGenBindPolicy(
  tools: AvailableTool[],
  availability: ImageGenAvailability,
): AvailableTool[] {
  if (!tools.some((tool) => tool.name === GENERATE_IMAGE_TOOL_NAME)) return tools;
  if (!availability.configured) {
    // Nothing to call: no image service configured.
    return tools.filter((tool) => tool.name !== GENERATE_IMAGE_TOOL_NAME);
  }
  return tools;
}

function buildSystemPrompt(
  agentId: number,
  promptData: CollectedPromptData,
  innerRippleLines: string[] = [],
  speakingStyleLines: string[] = [],
  guestVoice = false,
  skillBlock = "",
  clientHints?: Record<string, unknown> | null,
  toolHint: string = TOOL_HINT,
  selfPortraitBlock: string = "",
): SystemPromptParts {
  const agent = getAgent(agentId);
  const displayName = agent?.displayName || agent?.name || "助手";
  const role = (agent?.roleSetting || "").trim() || DEFAULT_ROLE_SETTING;
  const style = (agent?.speakingStyle || "").trim();
  const identity = style && !role.includes(style) ? `${role}\n\n${style}` : role;
  const guestBlock = guestVoice
    ? "# 声音提示\n这轮声音可能来自旁人。不要透露主人的隐私信息，也不要执行只适合主人的私人操作；保持礼貌、简短、谨慎。"
    : "";
  return composeSystemPromptParts({
    agentName: displayName,
    roleIdentity: identity,
    ...promptData,
    innerRippleLines,
    speakingStyleLines,
    scene: sceneFromClientHints(clientHints),
    guestBlock,
    skillBlock,
    toolHint,
    selfPortraitBlock,
  });
}

/**
 * Skills can be requested explicitly by the client (e.g. a skill picker) or
 * activated by the model through the skills_activate tool. Both paths end up
 * in the same thread-scoped binding table.
 */
function requestedSkillNames(hints?: Record<string, unknown> | null): string[] {
  if (!hints) return [];
  const raw = hints.activeSkills ?? hints.active_skills ?? hints.skills ?? hints.skill;
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function buildUserContent(request: ChatRequestInput): string {
  const text = (request.message || "").trim();
  if (!request.images.length) return text;
  const images = request.images.map((image) => {
    const summary = (image.summaryText || "").trim();
    if (summary && summary !== IMAGE_SUMMARY_PLACEHOLDER) return image;
    const stored = readStoredImageSummary(image.uploadId);
    return stored ? { ...image, summaryText: stored } : image;
  });
  return userMessageForLlm(text, images);
}

/**
 * Marker that separates the per-turn context from the user's own words.
 * The model must not read the context as something the user said.
 */
const VOLATILE_CONTEXT_HEADER = "［系统上下文］以下是系统为你准备的当前状态，不是他说的话，不要复述这些标题：";

/**
 * Append the per-turn context to the user turn.
 *
 * The context (emotional read, recalled memories, portrait, current time, tool
 * state) changes every turn. Keeping it in the system prompt would change the
 * request prefix on every turn and the provider's prompt cache would never
 * hit; riding along with the user turn keeps the cached prefix stable.
 */
function withVolatileContext(userContent: string, volatilePrompt: string): string {
  const context = (volatilePrompt || "").trim();
  if (!context) return userContent;
  if (!userContent) return `${VOLATILE_CONTEXT_HEADER}\n${context}`;
  return `${userContent}\n\n${VOLATILE_CONTEXT_HEADER}\n${context}`;
}

function extractDeltaContent(delta: unknown): string {
  if (!delta || typeof delta !== "object") return "";
  const content = (delta as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && typeof (part as any).text === "string") {
          return (part as any).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

/**
 * Map a persisted tool image onto the payload stored in
 * `chat_messages.assistant_images_json`.
 */
function toChatImagePayload(image: GeneratedImagePayload & { summaryText?: string }): ChatImagePayload {
  return {
    uploadId: image.uploadId,
    url: image.url,
    mimeType: image.mimeType,
    fileName: image.fileName,
    sizeBytes: image.sizeBytes,
    ...(image.summaryText ? { summaryText: image.summaryText } : {}),
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

function providerSupportsStreamUsage(source: string): boolean {
  return ["openai", "aliyun", "deepseek", "volcengine", "zhipu", "sensenova", "lmstudio", "agents"].includes(
    String(source || "").toLowerCase(),
  );
}

function usageFromChunk(usage: any): { promptTokens?: number; completionTokens?: number; cachedTokens?: number } | null {
  if (!usage) return null;
  return {
    promptTokens: Number(usage.prompt_tokens ?? usage.promptTokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? usage.completionTokens ?? 0),
    cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0),
  };
}

function checkpointMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value as ChatMessage[];
}

export async function* streamChat({
  request,
  signal,
  controller,
}: StreamChatOptions): AsyncGenerator<ChatEvent> {
  const wantsTask = request.mode === "task" || Boolean(request.taskId);
  let existingTask = request.taskId ? getTaskRun(request.taskId) : null;
  let resuming = false;
  let checkpoint: any = null;
  let checkpointState: Record<string, any> = {};
  let thread: ChatThreadRow | undefined;

  if (wantsTask && existingTask) {
    if (existingTask.state === "running") {
      throw new ChatRequestError(409, "Task is already running");
    }
    if (["done", "failed", "canceled"].includes(existingTask.state)) {
      if (!request.message.trim()) {
        throw new ChatRequestError(409, `Task is already ${existingTask.state}`);
      }
      existingTask = null;
    } else if (["interrupted", "resumed"].includes(existingTask.state)) {
      resuming = true;
      checkpoint = getLatestCheckpoint(existingTask.task_id);
      if (checkpoint?.state_snapshot_json) {
        try {
          const parsed = JSON.parse(checkpoint.state_snapshot_json);
          checkpointState = parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          checkpointState = {};
        }
      }
      thread = getThread(existingTask.thread_id)!;
      if (!thread) throw new ChatRequestError(404, "Thread not found");
    }
  }

  if (resuming && !checkpoint) {
    throw new ChatRequestError(409, "Task checkpoint is missing");
  }

  if (!thread) {
    thread = resolveChatThread(request);
  }
  cancelPendingDigest(thread.id);

  // Explicit client-side skill selection is bound before the prompt is built so
  // the very first turn already sees the skill body.
  for (const skillName of requestedSkillNames(request.clientHints)) {
    bindSkillToThread(thread.id, skillName, "request");
  }
  const skillPrompt = buildBoundSkillsPrompt(thread.id);
  const skillMetadata = activeSkillMetadata(thread.id);

  const userContent = buildUserContent(request);
  const resumeMessages = resuming ? checkpointMessages(checkpointState.messages) : [];
  if (!userContent && !resuming) {
    throw new ChatRequestError(400, "Message cannot be empty");
  }

  const agentId = request.agentId ?? thread.agent_id;
  const settings = getSettings() as Record<string, any>;
  // Inline `[]` emotion tags are TTS-only: they never reach the UI nor the DB.
  // Only Fish Audio / Xiaomi MiMo (emotion mode) keep them on the TTS wire.
  const keepTtsTags = keepEmotionTagsForTts(settings);
  // History size is governed solely by the context budget (上下文大小); the old
  // turn-count slider (chatHistoryTurns) is gone.
  const contextBudgetTokens = chatContextBudgetTokens(settings);
  const selfPortraitBlock = getSelfPortraitPromptBlock(memoryScope(agentId, thread.user_id));
  const cfg = getLLMConfig("chat");
  if (!cfg.model || !cfg.baseUrl) {
    throw new ChatRequestError(400, "尚未配置聊天模型，请先在设置中选择模型和接口地址");
  }
  const memoryScopeValue = memoryScope(agentId, thread.user_id);
  const selfState = getSelfState(memoryScopeValue);

  let taskId: string | null = existingTask?.task_id ?? null;
  if (wantsTask && !resuming) {
    const task = createTaskRun({
      taskId: existingTask?.task_id,
      threadId: thread.id,
      mode: "task",
      title: request.message,
      requestText: request.message,
      workspacePath: process.cwd(),
    });
    taskId = task.task_id;
  }
  if (taskId && controller) {
    registerTaskController(taskId, controller);
  }

  const threadContext = resuming
    ? { anchor: null, messages: [], usedTokens: 0 }
    : loadThreadHistory(thread.id, { budgetTokens: contextBudgetTokens });
  const recentHistory = threadContext.messages;
  const anchorPromptBlock = renderAnchorPromptBlock(threadContext.anchor);
  type RecallResult = {
    streams: any[];
    candidates?: any[];
    candidateCount?: number;
    selectedIds: string[];
    queries: any[];
    query: string;
    facts?: any[];
    annCount?: number;
    mode?: string;
    degraded?: boolean;
    degradedReason?: string;
    directFloor?: number;
    queryVectors?: number[][];
    pools?: { private: any[]; public: any[] };
    currentVector?: number[] | null;
  };
  const emptyRecall: RecallResult = {
    streams: [],
    candidateCount: 0,
    selectedIds: [],
    queries: [],
    query: userContent,
    annCount: 0,
  };
  // M3 query contract: the CURRENT utterance's raw text (request.message.trim()),
  // never buildUserContent()'s `[图片]`-placeholder copy — the placeholder is a
  // UI artifact and would poison the recall query. A call-opening turn keeps
  // CALL.RECALL_USES_LAST_USER semantics upstream (the caller passes the last
  // real user utterance as message).
  const recallQueryText = request.message.trim();
  let recall: RecallResult = resuming
    ? emptyRecall
    : await recallForChat({
        agentId,
        userId: thread.user_id,
        query: recallQueryText,
        recentMessages: recentHistory.slice(-5),
        limit: RECALL_TOTAL_CAP,
      });

  // The APP's formal package no longer exposes a "deep memory" toggle; recall
  // always uses the near-window multi-query path.
  let activation: SeedActivationResult | null = null;
  if (!resuming) {
    await ensureDefaultSeeds(memoryScopeValue).catch(() => undefined);
    activation = await activateSeedsForChat({
      agentId,
      userId: thread.user_id,
      userText: userContent,
      recentMessages: recentHistory.slice(-5),
    }).catch(() => null);
  }

  // State channel — private chat only (streamChat is never a group scene; the
  // group path uses streamGroupReply). A state-only utterance carries no topic
  // for the semantic path, so beside it (never instead of it) we inject what
  // the agent was already carrying: ranked by freshness × significance over a
  // 72h window, private streams only.
  const stateOnlyTurn = !resuming && isStateOnlyUtterance(recallQueryText);
  const stateStreams = stateOnlyTurn
    ? collectStateChannelStreams({
        agentId,
        userId: thread.user_id,
        utterance: recallQueryText,
        limit: 2,
        respectCooldown: true,
        excludedIds: recall.selectedIds,
      })
    : [];
  // Prompt merge cap (APP PRIVATE_STREAM_MERGE_LIMIT): the recall layer may
  // hold up to TOTAL_CAP=10, but the prompt renders at most 8 semantic streams
  // — 6 when a state-only turn reserved 2 slots for the state channel. The
  // head of `recall.streams` is the recall order (direct → AKIN children), so
  // truncation keeps the strongest anchors and their attached fragments.
  const semanticStreamBudget = Math.max(
    1,
    PRIVATE_STREAM_MERGE_LIMIT - (stateStreams.length || 0),
  );
  const promptStreams = resuming ? [] : recall.streams.slice(0, semanticStreamBudget);

  // Tool binding happens BEFORE the prompt is assembled: the tool-use policy
  // suffix depends on which tools are actually bound to this turn.
  const turnId = randomUUID();
  const toolContext = {
    sessionId: thread.id,
    turnId,
    agentId,
    userId: request.userId || "default_user",
    workspacePath:
      existingTask?.workspace_path ||
      (typeof checkpointState.workspace_path === "string"
        ? checkpointState.workspace_path
        : null) ||
      process.cwd(),
    voiceCall: Boolean(request.clientHints?.voiceCall),
  };
  let tools: AvailableTool[] = [];
  // A voice-call turn may schedule a hangup through the end_voice_call tool.
  // The GUI only tears the call down when the `done` event carries
  // `pendingHangup`, so this flag has to survive until that event is emitted.
  let hangupScheduled = false;
  const imageAvailability = readImageGenAvailability();
  if (!request.clientHints?.disableTools) {
    try {
      tools = await listAvailableTools(toolContext);
    } catch {
      tools = [];
    }
    if (request.clientHints?.botMode) {
      // 微信/QQ 消息来自外部渠道，无法确认本人意图，不暴露智能家居控制。
      tools = tools.filter((tool) => !requiresApproval(tool.name, {}) && !isMijiaTool(tool.name));
    }
    tools = applyImageGenBindPolicy(tools, imageAvailability);
  }
  const openaiTools = tools.length ? toOpenAITools(tools) : [];

  // Python L6 assembly: stable blocks + per-turn dynamic context. Memory recall
  // streams are rendered with a relative-time prefix inside the prompt.
  const promptData = collectPromptData({
    scope: memoryScopeValue,
    streams: promptStreams,
    facts: (recall as any).facts,
    // State channel: its own section, never merged into # 你记得.
    stateStreams,
    // Pass the live turn so policy skills (crisis / privacy / comfort) can be
    // decided on the current message instead of the last persisted one.
    userMessage: userContent,
    selfState,
    lastSeenAt: loadLastSeenAt(memoryScopeValue),
    now: new Date(),
  });
  // Python `core/companion/stream_revisit.py`: the recalled streams are now in
  // the prompt, so their revisit counters move (chat recall only — a proactive
  // greeting never touches them). Only the streams actually injected count.
  if (!resuming) {
    try {
      recordRecalledStreamRevisits(memoryScopeValue, promptStreams);
    } catch {
      // A failed counter bump must never break the turn.
    }
  }
  // The cooldown only moves when the section actually reached a prompt (the
  // state block is injected whenever stateStreams is non-empty, below).
  if (stateStreams.length) {
    try {
      markStateRecalled(memoryScopeValue, stateStreams);
    } catch {
      // A failed cooldown mark must never break the turn.
    }
  }
  const imageGenBound = tools.some((tool) => tool.name === GENERATE_IMAGE_TOOL_NAME);
  const policySuffix = companionToolPolicySuffix({
    imageGenBound,
    // The service is set up but the tool is not available this turn (e.g. the
    // native toggle is off). The model must not promise a photo it cannot send.
    imageGenUnavailable: Boolean(imageAvailability.configured && !imageGenBound),
    imageGenConfigured: imageAvailability.configured,
    endVoiceCallBound: tools.some((tool) => tool.name === END_VOICE_CALL_TOOL_NAME),
    // manage_alarm's implicit tool contract (say-it-then-create) rides with the
    // policy suffix whenever the tool is bound; private chat only.
    manageAlarmBound: tools.some((tool) => tool.name === MANAGE_ALARM_TOOL_NAME),
    lastImageAtLabel: imageAvailability.lastImageAtLabel,
    imageCooldownRemainingS: imageAvailability.cooldownRemainingS,
    imageDailyRemaining: imageAvailability.dailyRemaining,
  });
  const shouldAppendPolicy = tools.length > 0 || imageAvailability.configured;
  const { stable: stablePrompt, slow: slowPrompt, volatile: volatilePrompt } = buildSystemPrompt(
    agentId,
    promptData,
    activation?.innerLines || [],
    activation?.outerLines || [],
    Boolean(request.clientHints?.isGuest),
    skillPrompt,
    request.clientHints,
    shouldAppendPolicy ? policySuffix : TOOL_HINT,
    selfPortraitBlock,
  );
  // The per-turn context is delivered with the user message instead of the
  // system prompt: the system prompt stays byte-identical between turns, so
  // the provider's prompt cache keeps hitting on it. The exact text that went
  // out is stored and replayed verbatim on the next turn.
  const userContentForLlm = withVolatileContext(userContent, volatilePrompt);

  let messages: ChatMessage[];
  if (resuming) {
    messages = resumeMessages;
    if (!messages.length) {
      const resumeContext = loadThreadHistory(thread.id, {
        budgetTokens: contextBudgetTokens,
      });
      const resumeAnchorBlock = renderAnchorPromptBlock(resumeContext.anchor);
      messages = [
        { role: "system", content: stablePrompt },
        ...(slowPrompt ? [{ role: "system" as const, content: slowPrompt }] : []),
        ...(resumeAnchorBlock
          ? [{ role: "system" as const, content: resumeAnchorBlock }]
          : []),
        ...resumeContext.messages,
      ];
    }
    if (userContent) messages.push({ role: "user", content: userContentForLlm });
  } else {
    messages = [
      { role: "system", content: stablePrompt },
      ...(slowPrompt ? [{ role: "system" as const, content: slowPrompt }] : []),
      ...(anchorPromptBlock
        ? [{ role: "system" as const, content: anchorPromptBlock }]
        : []),
      ...recentHistory,
      { role: "user", content: userContentForLlm },
    ];
  }
  markThreadActive(thread.id);

  let resumeQueue: any[] = [];
  if (resuming) {
    try {
      const parsed = JSON.parse(checkpoint?.pending_queue_json || "[]");
      resumeQueue = Array.isArray(parsed) ? parsed : [];
    } catch {
      resumeQueue = [];
    }
  }
  let pendingCalls = resumeQueue
    .map((item) => ({
      id: String(item.call_id || item.id || randomUUID()),
      name: String(item.tool_name || item.name || ""),
      arguments: JSON.stringify(item.tool_args || item.arguments || {}),
    }))
    .filter((call) => call.name) as PendingToolCall[];
  const checkpointToolArgs = new Map<string, Record<string, unknown>>();
  if (resuming && Array.isArray(checkpoint?.pending_queue_json)) {
    try {
      for (const item of JSON.parse(checkpoint.pending_queue_json) as any[]) {
        if (item.call_id) checkpointToolArgs.set(String(item.call_id), item.tool_args || {});
      }
    } catch {
      // ignore malformed checkpoint
    }
  }

  const startedAt = nowIso();
  if (taskId && resuming) {
    updateTaskRun(taskId, { state: "running", resumed_at: nowIso() });
  }
  const baseSequence = taskId ? maxTaskEventSequence(taskId) : 0;
  let localSequence = 0;

  const baseMetadata: Record<string, unknown> = {
    mode: request.mode,
    route: taskId ? "task-deep" : "chat-fast",
    companion_v3: true,
    ...(skillMetadata.active_skills.length ? skillMetadata : {}),
  };

  const makeEvent = (
    type: ChatEventType,
    content: string | undefined,
    metadata: Record<string, unknown>,
    options: { parentEventId?: string; depth?: number } = {},
  ): ChatEvent => {
    localSequence += 1;
    return {
      type,
      eventId: randomUUID(),
      sessionId: thread.id,
      turnId,
      taskId,
      eventSequence: baseSequence + localSequence,
      timestamp: nowIso(),
      ...(content !== undefined ? { content } : {}),
      metadata,
      depth: options.depth ?? 0,
      attemptNo: 1,
      ...(options.parentEventId ? { parentEventId: options.parentEventId } : {}),
    };
  };

  const emit = (event: ChatEvent) => {
    if (taskId) appendTaskEvent(taskId, event);
    return event;
  };

  const persistInterruptedTurn = () => {
    if (!taskId) return null;
    if (interruptedTurn) return interruptedTurn;
    if (resuming) return null;
    try {
      interruptedTurn = appendTurn(thread!, {
        userContent: request.message,
        assistantContent: "",
        userImages: request.images,
        userLlmContent: userContentForLlm,
        inputMetadata: {
          ...(request.clientHints ? { clientHints: request.clientHints } : {}),
          task_pending_approval: true,
        },
        startedAt,
        taskId,
      });
      markMessagesDigested(
        [interruptedTurn.userMessageId, interruptedTurn.assistantMessageId].filter(
          (value): value is number => typeof value === "number",
        ),
      );
      return interruptedTurn;
    } catch {
      return null;
    }
  };

  const client = createOpenAIClient(cfg);
  const useStreamUsage = providerSupportsStreamUsage(cfg.source);
  const toolTraces: Record<string, unknown>[] = Array.isArray(checkpointState.tool_traces)
    ? checkpointState.tool_traces
    : [];
  let finalText = "";
  let finalTtsText = "";
  let finalDisplayRaw = "";
  // Python `runtime_chat_stream.turn_assistant_images`: every picture produced
  // by a tool during this turn is stored and attached to the assistant message.
  const turnAssistantImages: ChatImagePayload[] = [];
  // The tool exchange of this turn, kept verbatim so the next request can
  // replay it and keep the request prefix (and the provider's prompt cache)
  // intact.
  const turnToolMessages: ToolRoundTripMessage[] = [];
  let usageTotals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  let completed = false;
  let taskInterrupted = false;
  let usedTaskTools = false;
  let stepsUsed = 0;
  let interruptedTurn: { userMessageId: number | null; assistantMessageId: number } | null =
    resuming && checkpointState.turn_assistant_message_id
      ? {
          userMessageId:
            checkpointState.turn_user_message_id == null
              ? null
              : Number(checkpointState.turn_user_message_id),
          assistantMessageId: Number(checkpointState.turn_assistant_message_id),
        }
      : null;

  try {
    if (taskId) {
      const resumedRejection =
        resuming &&
        pendingCalls.some((call) => findApprovalDecision(taskId!, call.id)?.approved === false);
      yield emit(
        makeEvent("state", resuming ? "resumed" : "running", {
          ...baseMetadata,
          node_name: "observe",
          ...(resuming && !resumedRejection ? { retry_reason: "approval_resumed" } : {}),
        }),
      );
    }
    const resumedStep = resuming
      ? Math.min(Math.max(0, Number(checkpointState.step_count || 0)), MAX_TOOL_STEPS - 1)
      : 0;
    outer: for (let step = resumedStep; step < MAX_TOOL_STEPS; step += 1) {
      stepsUsed = step + 1;
      if (pendingCalls.length) {
        usedTaskTools = true;
        for (let index = 0; index < pendingCalls.length; index += 1) {
          const call = pendingCalls[index];
          const args = checkpointToolArgs.get(call.id) || parseArgs(call.arguments);
          const callEvent = makeEvent(
            "tool_call",
            call.name,
            {
              ...baseMetadata,
              node_name: "execute",
              tool_name: call.name,
              tool_args: args,
            },
            { depth: 1 },
          );
          yield emit(callEvent);

          let approved = true;
          let approvalDecision: { approved: boolean; reason?: string } | null = null;
          if (requiresApproval(call.name, args)) {
            const callId = call.id || randomUUID();
            approvalDecision = taskId ? findApprovalDecision(taskId, callId) : null;
            if (approvalDecision) {
              approved = approvalDecision.approved;
            } else if (taskId) {
              const remainingCalls = pendingCalls.slice(index);
              const pendingQueue = remainingCalls.map((item) => ({
                action: "wait_for_approval",
                call_id: item.id,
                tool_name: item.name,
                tool_args: checkpointToolArgs.get(item.id) || parseArgs(item.arguments),
              }));
              const approvalEvent = makeEvent(
                "approval_required",
                `${call.name} 需要审批`,
                {
                  ...baseMetadata,
                  node_name: "execute",
                  stepStatus: "waiting",
                  tool_name: call.name,
                  approval: { call_id: callId, tool_name: call.name, arguments: args },
                  non_blocking: false,
                },
                { parentEventId: callEvent.eventId, depth: 2 },
              );
              const pendingTurn = persistInterruptedTurn();
              const checkpointId = saveTaskCheckpoint(
                taskId,
                approvalEvent.eventSequence,
                {
                  messages,
                  finalText,
                  tool_traces: toolTraces,
                  step_count: step,
                  event_sequence: approvalEvent.eventSequence,
                  used_task_tools: usedTaskTools,
                  workspace_path: toolContext.workspacePath,
                  turn_id: turnId,
                  request_text: request.message,
                  approval_call_id: callId,
                  turn_user_message_id: pendingTurn?.userMessageId ?? interruptedTurn?.userMessageId ?? null,
                  turn_assistant_message_id:
                    pendingTurn?.assistantMessageId ?? interruptedTurn?.assistantMessageId ?? null,
                  pending_calls: remainingCalls.map((item) => ({
                    call_id: item.id,
                    tool_name: item.name,
                    tool_args: checkpointToolArgs.get(item.id) || parseArgs(item.arguments),
                  })),
                },
                pendingQueue,
              );
              updateTaskRun(taskId, {
                state: "interrupted",
                interrupted_at: nowIso(),
                last_checkpoint_id: checkpointId,
                ...(pendingTurn?.assistantMessageId
                  ? { message_id: pendingTurn.assistantMessageId }
                  : {}),
              });
              taskInterrupted = true;
              yield emit(approvalEvent);
              yield emit(
                makeEvent("done", undefined, {
                  ...baseMetadata,
                  node_name: "reflect",
                  run_status: "interrupted",
                  interrupted: true,
                  pending_approval: {
                    call_id: callId,
                    tool_name: call.name,
                    arguments: args,
                  },
                  checkpoint_id: checkpointId,
                  messageId: null,
                }),
              );
              break outer;
            } else {
              const approvalEvent = makeEvent(
                "approval_required",
                `${call.name} 需要审批`,
                {
                  ...baseMetadata,
                  node_name: "execute",
                  stepStatus: "waiting",
                  tool_name: call.name,
                  approval: { call_id: callId, tool_name: call.name, arguments: args },
                  non_blocking: false,
                },
                { parentEventId: callEvent.eventId, depth: 2 },
              );
              yield emit(approvalEvent);
              const result = await requestToolApproval(callId);
              approved = result.approved;
              const resolvedEvent = makeEvent(
                "approval_resolved",
                approved ? "已批准执行" : "已拒绝执行",
                {
                  ...baseMetadata,
                  node_name: "approval",
                  stepStatus: approved ? "completed" : "canceled",
                  approval: {
                    call_id: callId,
                    tool_name: call.name,
                    resolution: approved ? "approved" : "rejected",
                    ...(result.reason ? { reject_reason: result.reason } : {}),
                  },
                },
                { parentEventId: approvalEvent.eventId, depth: 2 },
              );
              yield emit(resolvedEvent);
            }
          }

          if (!approved) {
            const rejectReason = String(approvalDecision?.reason || "").trim();
            const rejected = {
              status: "error" as const,
              preview: rejectReason
                ? `用户拒绝执行该操作：${rejectReason}`
                : "用户拒绝执行该操作",
              summary: { strategy: "inline" as const, source: "native" as const },
              error_class: "user_rejected",
              tool_name: call.name,
              source: "native" as const,
              is_error: true,
            };
            const resultEvent = makeEvent(
              "tool_result",
              rejected.preview,
              {
                ...baseMetadata,
                node_name: "execute",
                stepStatus: "canceled",
                tool_name: call.name,
                tool_args: args,
                result_classification: "user_rejected",
                tool_result: rejected,
              },
              { parentEventId: callEvent.eventId, depth: 2 },
            );
            yield emit(resultEvent);
            if (taskId) {
              const cancelText = `“${call.name}”已取消执行，因为你拒绝了这次审批。`;
              const cancelMetadata = {
                ...(request.clientHints ? { clientHints: request.clientHints } : {}),
                task_canceled: true,
              };
              let saved = interruptedTurn
                ? completeAssistantMessage(thread, interruptedTurn.assistantMessageId, {
                    content: cancelText,
                    inputMetadata: cancelMetadata,
                    taskId,
                  })
                : null;
              if (!saved) {
                const persisted = appendTurn(thread, {
                  userContent: request.message,
                  assistantContent: cancelText,
                  userImages: request.images,
                  userLlmContent: userContentForLlm,
                  inputMetadata: cancelMetadata,
                  startedAt,
                  taskId,
                });
                interruptedTurn = persisted;
              }
              updateTaskRun(taskId, {
                state: "canceled",
                completed_at: nowIso(),
                ...(interruptedTurn?.assistantMessageId
                  ? { message_id: interruptedTurn.assistantMessageId }
                  : {}),
              });
              yield emit(
                makeEvent("text_delta", cancelText, {
                  ...baseMetadata,
                  node_name: "reflect",
                }),
              );
              yield emit(
                makeEvent("done", undefined, {
                  ...baseMetadata,
                  node_name: "reflect",
                  run_status: "canceled",
                  messageId: interruptedTurn?.assistantMessageId
                    ? String(interruptedTurn.assistantMessageId)
                    : null,
                }),
              );
              completed = true;
              return;
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(rejected),
            });
            turnToolMessages.push({
              role: "tool",
              content: JSON.stringify(rejected),
              tool_call_id: call.id,
            });
            continue;
          }

          const result = await executeTool(call.name, args, toolContext);
          const skillBody =
            typeof (result as any).skill_body === "string" ? (result as any).skill_body : "";
          if (Array.isArray((result as any).active_skills)) {
            baseMetadata.active_skills = (result as any).active_skills;
            baseMetadata.loaded_skills = Array.isArray((result as any).loaded_skills)
              ? (result as any).loaded_skills
              : [];
          }
          // Keep the full skill body for the model, but do not push a 10k-char
          // payload into the SSE event / UI timeline.
          const eventResult = skillBody
            ? {
                ...result,
                skill_body: undefined,
                skill_body_chars:
                  (result as any).skill_body_chars ?? skillBody.length,
              }
            : result;
          toolTraces.push({
            tool_name: call.name,
            tool_args: args,
            result: result.preview,
            status: result.status,
          });
          // Tool calls are logged next to the LLM calls so the drawer can show
          // the image provider's actual request / response payload too.
          recordToolCallTrace({
            threadId: thread.id,
            turnId,
            toolName: call.name,
            provider: (result as any).provider || null,
            request: (result as any).provider_request ?? { arguments: args },
            response: (result as any).provider_response ?? {
              status: result.status,
              preview: result.preview,
              error_class: (result as any).error_class ?? null,
            },
            error: result.is_error ? String(result.preview || "") : null,
          });
          // Python `runtime_chat_stream`: a tool result carrying `images` is
          // persisted into chat_uploads and pushed as a dedicated `image`
          // event, so the GUI can render the picture right away. The raw
          // provider payload (base64 blob / expiring remote URL) is replaced
          // by the stored upload reference in the tool result event.
          const rawImages = (result as any).images;
          const generatedImages = await persistGeneratedImages(rawImages);
          // Describe the picture we just produced. Without this the agent has
          // no idea what it sent, and the policy ("no marker = never sent")
          // makes it deny the photo even though the user is looking at it.
          const describedImages = await Promise.all(
            generatedImages.map(async (image) => {
              const summary = image.persisted
                ? await summarizeGeneratedImage(image.uploadId, image.mimeType)
                : null;
              return {
                ...image,
                summaryText: summary || GENERATED_IMAGE_SUMMARY_PLACEHOLDER,
              };
            }),
          );
          const eventToolResult = Array.isArray(rawImages)
            ? {
                ...eventResult,
                delivered: describedImages.length > 0,
                image_count: describedImages.length,
                images: describedImages.map((image) => ({
                  uploadId: image.uploadId,
                  url: image.url,
                  mimeType: image.mimeType,
                  fileName: image.fileName,
                  sizeBytes: image.sizeBytes,
                  summaryText: image.summaryText,
                })),
              }
            : eventResult;
          for (const image of describedImages) {
            turnAssistantImages.push(toChatImagePayload(image));
            yield emit(
              makeEvent("image", image.url, {
                ...baseMetadata,
                node_name: "execute",
                uploadId: image.uploadId,
                url: image.url,
                mimeType: image.mimeType,
                fileName: image.fileName,
                sizeBytes: image.sizeBytes,
                summaryText: image.summaryText,
                ...(image.persisted ? {} : { persisted: false }),
              }),
            );
          }
          const resultEvent = makeEvent(
            "tool_result",
            result.preview,
            {
              ...baseMetadata,
              node_name: "execute",
              stepStatus: result.status === "success" ? "completed" : "failed",
              tool_name: call.name,
              tool_args: args,
              result_classification: result.is_error ? "error" : "success",
              tool_result: eventToolResult,
            },
            { parentEventId: callEvent.eventId, depth: 2 },
          );
          yield emit(resultEvent);
          const toolPayload: Record<string, unknown> = {
            status: result.status,
            preview: result.preview,
            error_class: (result as any).error_class,
          };
          if (skillBody) toolPayload.skill_body = skillBody;
          if (describedImages.length) {
            // The picture is already on the user's screen at this point. Say so
            // explicitly, otherwise the model keeps apologising for a photo it
            // actually sent ("那张图我这边没能给你出来").
            toolPayload.delivered = true;
            toolPayload.image_count = describedImages.length;
            toolPayload.delivery_note = IMAGE_DELIVERY_NOTE;
            toolPayload.images = describedImages.map((image, index) => ({
              index: index + 1,
              description:
                condenseImageDescription(image.summaryText, 300) ||
                GENERATED_IMAGE_SUMMARY_PLACEHOLDER,
            }));
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(toolPayload),
          });
          turnToolMessages.push({
            role: "tool",
            content: JSON.stringify(toolPayload),
            tool_call_id: call.id,
          });
          if ((result as any).terminal) {
            finalText = String((result as any).final_text || result.preview || "").trim();
            finalTtsText = finalText;
            finalDisplayRaw = finalText;
            // Mirrors the Python runtime: a successful end_voice_call inside a
            // voice call schedules the hangup, and the `done` event tells the
            // client to tear the call down after the farewell is spoken.
            if (
              request.clientHints?.voiceCall &&
              call.name === END_VOICE_CALL_TOOL_NAME &&
              result.status === "success"
            ) {
              hangupScheduled = true;
            }
            pendingCalls = [];
            break outer;
          }
        }
        pendingCalls = [];
      }

      let assistantText = "";
      let assistantTtsText = "";
      let pendingTtsPrefix = "";
      let callUsage: ReturnType<typeof usageFromChunk> = null;
      const toolCallMap = new Map<number, PendingToolCall>();
      // Holds an incomplete `[...]` across chunks and splits the model output
      // into a display stream (tags stripped) and a TTS stream (tags kept).
      const tagFilter = new FishTagStreamFilter();

      const requestBody: Record<string, unknown> = {
        model: cfg.model,
        messages: messages as OpenAI.ChatCompletionMessageParam[],
        temperature: cfg.temperature,
        stream: true,
        ...(openaiTools.length
          ? { tools: openaiTools, tool_choice: "auto" as const }
          : {}),
        ...(useStreamUsage ? { stream_options: { include_usage: true } } : {}),
        ...buildThinkingParams(cfg),
      };
      // The upstream rejects bad bodies before the first chunk, so the disable-thinking
      // retry inside never replays already-emitted output. On retry the requestBody is
      // stripped in place, so the trace below mirrors what was actually sent.
      const stream = await createChatStreamWithThinkingFallback(client, requestBody, cfg, { signal });

      // The drawer renders this payload verbatim ("查看请求报文"), so it is
      // recorded before the first chunk arrives.
      const traceId = randomUUID();
      recordLlmCallTrace({
        id: traceId,
        threadId: thread.id,
        turnId,
        model: cfg.model,
        provider: cfg.source,
        request: requestBody,
      });

      let chunkCount = 0;
      let finishReason: string | null = null;
      let rawUsage: any = null;
      for await (const chunk of stream) {
        chunkCount += 1;
        const usage = usageFromChunk((chunk as any).usage);
        if (usage) {
          callUsage = usage;
          rawUsage = (chunk as any).usage;
        }
        const reason = (chunk as any).choices?.[0]?.finish_reason;
        if (reason) finishReason = String(reason);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        const text = extractDeltaContent(delta);
        if (text) {
          const pieces = tagFilter.feed(text);
          const displayChunk = pieces.display;
          const ttsChunk = keepTtsTags ? pieces.tts : displayChunk;
          let ttsPiece = ttsChunk;
          if (pendingTtsPrefix) {
            ttsPiece = pendingTtsPrefix + (ttsPiece || "");
            pendingTtsPrefix = "";
          }
          if (!displayChunk && !ttsPiece) {
            // Nothing to emit yet (only a partial tag is buffered).
          } else if (!displayChunk && ttsPiece) {
            // Tag-only chunk: keep it for the next visible delta.
            pendingTtsPrefix = ttsPiece;
          } else {
            assistantText += displayChunk;
            assistantTtsText += ttsPiece;
            yield emit(
              makeEvent("text_delta", displayChunk, {
                ...baseMetadata,
                bubbleIndex: 0,
                ...(ttsPiece && ttsPiece !== displayChunk ? { ttsText: ttsPiece } : {}),
                ...(taskId ? { node_name: "reflect" } : usedTaskTools ? { node_name: "agent" } : {}),
              }),
            );
          }
        }
        const rawCalls = (delta as any).tool_calls;
        if (Array.isArray(rawCalls)) {
          for (const part of rawCalls) {
            const index = Number(part.index ?? 0);
            const entry = toolCallMap.get(index) || { id: "", name: "", arguments: "" };
            if (part.id) entry.id = String(part.id);
            if (part.function?.name) entry.name += String(part.function.name);
            if (part.function?.arguments) entry.arguments += String(part.function.arguments);
            toolCallMap.set(index, entry);
          }
        }
      }

      if (signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }

      // Flush an incomplete `[...]` left at the end of the stream.
      const flushed = tagFilter.flush();
      if (flushed.display || flushed.tts || pendingTtsPrefix) {
        const flushDisplay = flushed.display;
        const flushTts = keepTtsTags ? flushed.tts : flushed.display;
        let ttsPiece = flushTts;
        if (pendingTtsPrefix) {
          ttsPiece = pendingTtsPrefix + (ttsPiece || "");
          pendingTtsPrefix = "";
        }
        if (flushDisplay) {
          assistantText += flushDisplay;
          assistantTtsText += ttsPiece;
          yield emit(
            makeEvent("text_delta", flushDisplay, {
              ...baseMetadata,
              bubbleIndex: 0,
              ...(ttsPiece && ttsPiece !== flushDisplay ? { ttsText: ttsPiece } : {}),
              ...(taskId ? { node_name: "reflect" } : usedTaskTools ? { node_name: "agent" } : {}),
            }),
          );
        } else if (ttsPiece) {
          // Tag-only leftover: forward it as an empty delta carrying ttsText.
          assistantTtsText += ttsPiece;
          yield emit(
            makeEvent("text_delta", "", {
              ...baseMetadata,
              bubbleIndex: 0,
              ttsText: ttsPiece,
              ...(taskId ? { node_name: "reflect" } : usedTaskTools ? { node_name: "agent" } : {}),
            }),
          );
        }
      }

      const estimatedUsage = callUsage || {
        promptTokens: estimateTokens(
          messages.map((message) => String(message.content || "")).join("\n"),
        ),
        completionTokens: estimateTokens(assistantText),
        cachedTokens: 0,
      };
      usageTotals.promptTokens += estimatedUsage.promptTokens || 0;
      usageTotals.completionTokens += estimatedUsage.completionTokens || 0;
      usageTotals.cachedTokens += estimatedUsage.cachedTokens || 0;

      // Close the trace: the response side plus the provider's usage counters
      // (input / output cache hits) are what the drawer displays.
      const parsedUsage = parseProviderUsage(rawUsage);
      updateLlmCallTrace(traceId, {
        response: {
          finish_reason: finishReason,
          chunks: chunkCount,
          content_chars: assistantText.length,
          // The provider's usage object verbatim, so the drawer can show which
          // counters this provider actually reported (and which it never sent).
          usage: rawUsage,
          tool_calls: [...toolCallMap.values()].map((call) => ({
            name: call.name,
            arguments: call.arguments,
          })),
        },
        usage: rawUsage,
      });
      if (parsedUsage?.reported) {
        recordLlmUsageDetailed(cfg.model, parsedUsage, "chat");
      } else {
        // No provider usage object (some compatible gateways omit it): keep the
        // local estimate so the call still appears in the usage panel.
        recordLlmUsage(cfg.model, estimatedUsage, "chat");
      }
      // The conversation anchor's primary trigger signal is the real
      // prompt_tokens of the latest private chat request (APP
      // NativeChatRuntimePlugin.rememberChatUsage). Voice calls share the same
      // stream but must not overwrite the signal, and a provider that did not
      // report usage must never leave a fabricated row behind — without a row
      // the anchor falls back to the character estimate.
      // Each tool-loop round overwrites the row, so the surviving value is the
      // last request's prompt_tokens, i.e. the fullest request of the turn.
      if (
        !request.clientHints?.voiceCall &&
        parsedUsage?.reported &&
        parsedUsage.promptTokens > 0
      ) {
        rememberChatUsage(memoryScopeValue, {
          promptTokens: parsedUsage.promptTokens,
          cachedTokens: parsedUsage.cachedPromptTokens,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
        });
      }

      const calls = [...toolCallMap.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({
          id: call.id || randomUUID(),
          name: call.name,
          arguments: call.arguments || "{}",
        }))
        .filter((call) => call.name);

      if (!calls.length) {
        // The DB / UI never see the `[]` emotion tags; the TTS wire may keep them.
        finalText = stripFishTags(assistantText).trim();
        finalTtsText = assistantTtsText;
        finalDisplayRaw = assistantText;
        break;
      }

      const toolCallMessage = {
        role: "assistant" as const,
        content: assistantText || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      };
      messages.push(toolCallMessage);
      // Keep the tool exchange verbatim: the next request replays it, which
      // keeps the request prefix byte-identical (and the prompt cache warm).
      turnToolMessages.push(toolCallMessage);
      pendingCalls = calls;
      checkpointToolArgs.clear();
    }

    if (taskInterrupted) return;

    if (!finalText) {
      throw new ChatRequestError(
        502,
        taskId && stepsUsed >= MAX_TOOL_STEPS
          ? "任务步骤已达到上限，请缩小任务范围后重试。"
          : "AI 暂时无法回复，请稍后再试。",
      );
    }

    if (finalText) {
      yield emit(makeEvent("state", "text_stream_completed", { ...baseMetadata }));
    }

    const completionMetadata = {
      ...(request.clientHints ? { clientHints: request.clientHints } : {}),
      ...(toolTraces.length ? { tool_traces: toolTraces } : {}),
    };
    let persisted: { userMessageId: number | null; assistantMessageId: number } | null = null;
    if (interruptedTurn?.assistantMessageId) {
      const updated = completeAssistantMessage(thread, interruptedTurn.assistantMessageId, {
        content: finalText,
        inputMetadata: completionMetadata,
        taskId,
        assistantImages: turnAssistantImages,
        toolMessages: turnToolMessages,
      });
      if (updated) {
        persisted = {
          userMessageId: interruptedTurn.userMessageId,
          assistantMessageId: updated.id,
        };
      }
    }
    if (!persisted) {
      persisted = appendTurn(thread, {
        userContent: request.message,
        assistantContent: finalText,
        userImages: request.images,
        assistantImages: turnAssistantImages,
        userLlmContent: userContentForLlm,
        toolMessages: turnToolMessages,
        inputMetadata: completionMetadata,
        startedAt,
        taskId,
      });
    }

    // Python `consume_due_appointment_reminders`: a chat turn that carried the
    // appointment reminder hint counts as the delivery, so the scheduler must
    // not push the very same appointment again.
    if (!resuming && userContent.trim()) {
      try {
        consumeDueAppointmentReminders(memoryScopeValue, new Date());
      } catch {
        // Never let appointment bookkeeping break a finished turn.
      }
    }

    if (taskId) {
      updateTaskRun(taskId, {
        state: "done",
        message_id: persisted.assistantMessageId,
        completed_at: nowIso(),
      });
    }

    const facts = listFacts(memoryScopeValue).items.slice(0, 12);
    const constraints = listConstraints(memoryScopeValue).items
      .map((item) => String(item.description || "").trim())
      .filter(Boolean);
    const personaActivation = {
      ...(activation?.snapshot || {
        field: { wakeText: "", wakeQueries: [], boostText: "", suppressText: "", source: "text_embed" },
        params: {},
        candidates: [],
        activeSeedIds: [],
        injectedSeedIds: [],
        annAudit: {},
      }),
    };
    saveRecallTrace(persisted.assistantMessageId, memoryScopeValue, {
      streams: recall.streams,
      seeds: personaActivation.candidates.map((candidate: any) => ({
        id: candidate.seedId,
        content: candidate.wakeText || candidate.innerOrientation,
        subject: "about_self",
      })),
      facts: facts.map((fact) => ({
        id: fact.id,
        description: fact.description,
        object: fact.targetName,
      })),
      threads: [],
      constraints,
      memoryFacts: facts.map((fact) => ({ text: fact.description || "", kind: "fact" })),
      selfState,
      personaActivation,
      promptInjection: {
        innerRippleLines: activation?.innerLines || [],
        speakingStyleLines: activation?.outerLines || [],
      },
      streamRecall: {
        candidates: recall.candidates,
        selectedIds: recall.selectedIds,
        annCount: recall.annCount,
        selectedCount: recall.streams.length,
        queries: recall.queries,
      },
      userPortrait: getUserPortrait(memoryScopeValue),
      query: userContent || (resuming ? String(checkpointState.request_text || "") : ""),
      snippets: recall.streams.map((stream: any) => String(stream.narrative || "").slice(0, 300)),
      candidateCount: recall.candidateCount,
      selectedCount: recall.streams.length,
      droppedCandidates: (recall.candidates || []).filter((candidate: any) => !candidate.selected),
      count: recall.streams.length,
      empty: recall.streams.length === 0,
    });
    noteTurnComplete(thread.id);

    const autoReadTts = Boolean(
      settings.ttsEnabled &&
        settings.ttsAutoRead &&
        !request.clientHints?.voiceCall &&
        !request.clientHints?.botMode,
    );

    completed = true;
    // The TTS wire may keep the `[]` emotion tags; the client uses this text
    // for playback while the bubble itself stays tag-free.
    const ttsText =
      finalTtsText && finalTtsText !== finalDisplayRaw ? finalTtsText : null;
    yield emit(
      makeEvent("done", undefined, {
        ...baseMetadata,
        run_status: "done",
        persistedTurnId: persisted.assistantMessageId,
        messageId: String(persisted.assistantMessageId),
        ...(persisted.userMessageId ? { userMessageId: persisted.userMessageId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(ttsText ? { ttsText } : {}),
        ...(hangupScheduled ? { pendingHangup: true } : {}),
      }),
    );

    // Conversation compaction runs independently from the 90s digest idle job.
    // The debounced check is cheap; only an over-budget tail reaches the model.
    scheduleConversationAnchor(thread.id, 300);

    if (autoReadTts && finalText) {
      let announced = false;
      const assistantMessageId = String(persisted.assistantMessageId);
      const spokenText = ttsText || finalText;
      try {
        const handle = await startTtsStream(spokenText, {
          signal,
          timeoutMs: 90_000,
          agentId,
          sessionId: thread.id,
        });
        const iterator = streamTtsSegment(handle, {
          text: spokenText,
          seq: 1,
          messageId: assistantMessageId,
        });
        let next = await iterator.next();
        if (!next.done) {
          announced = true;
          const segment = next.value.segment;
          const segmentEvent = makeEvent("tts_segment", undefined, {
            ...baseMetadata,
            node_name: "tts",
            segmentId: segment.id,
            audioUrl: `/api/voice/tts/segments/${segment.id}`,
            mimeType: segment.mimeType,
            format: segment.format,
            seq: segment.seq,
            text: segment.text.slice(0, 4000),
            sampleRate: segment.sampleRate,
          });
          segmentEvent.messageId = assistantMessageId;
          yield segmentEvent;
        }
        let result = next;
        while (!result.done) result = await iterator.next();
        const stopEvent = makeEvent("tts_stop", undefined, {
          ...baseMetadata,
          node_name: "tts",
        });
        stopEvent.messageId = assistantMessageId;
        yield stopEvent;
      } catch {
        // TTS is best-effort; chat completion must not fail because of it.
        if (announced && !signal?.aborted) {
          try {
            const stopEvent = makeEvent("tts_stop", undefined, {
              ...baseMetadata,
              node_name: "tts",
            });
            stopEvent.messageId = assistantMessageId;
            yield stopEvent;
          } catch {
            // stream already closed
          }
        }
      }
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      if (taskId) {
        let task = getTaskRun(taskId);
        if (task && !["done", "failed", "canceled"].includes(task.state)) {
          updateTaskRun(taskId, {
            state: "canceled",
            completed_at: nowIso(),
          });
          task = getTaskRun(taskId);
        }
        if (task?.state === "canceled") {
          completed = true;
          yield emit(
            makeEvent("done", undefined, {
              ...baseMetadata,
              node_name: "reflect",
              run_status: "canceled",
            }),
          );
          return;
        }
      }
      throw error;
    }
    if (taskId) {
      updateTaskRun(taskId, {
        state: "failed",
        completed_at: nowIso(),
      });
    }
    const detail = error instanceof Error ? error.message : String(error);
    yield emit(
      makeEvent("error", detail, {
        ...baseMetadata,
        node_name: "reflect",
        run_status: "failed",
      }),
    );
    if (taskId) {
      yield emit(
        makeEvent("done", undefined, {
          ...baseMetadata,
          node_name: "reflect",
          run_status: "failed",
          messageId: null,
        }),
      );
    }
  } finally {
    markThreadInactive(thread.id);
    if (taskId && controller) unregisterTaskController(taskId, controller);
    if (usageTotals.promptTokens || usageTotals.completionTokens) {
      // usage already recorded per call; totals kept for future task summaries
    }
    if (!completed && taskInterrupted) {
      // task state already set to interrupted
    }
  }
}

/**
 * Group member reply stream.
 *
 * Group members must not go through `streamChat`: that function owns a private
 * `chat_threads` row, private history and private tool policy. This helper
 * reuses the same chat model configuration, OpenAI client, thinking fallback
 * and usage accounting, but takes an explicitly assembled public-group prompt.
 */
export interface GroupReplyMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function* streamGroupReply(
  messages: GroupReplyMessage[],
  options: { signal?: AbortSignal; temperature?: number } = {},
): AsyncGenerator<{ type: "delta"; content: string }, { text: string }> {
  const cfg = getLLMConfig("chat");
  if (!cfg.model || !cfg.baseUrl) {
    throw new ChatRequestError(400, "尚未配置聊天模型，请先在设置中选择模型和接口地址");
  }
  console.info("[GROUP_REPLY] llm", { model: cfg.model, baseUrl: cfg.baseUrl, source: cfg.source });
  const client = createOpenAIClient(cfg);
  const requestBody: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: options.temperature ?? cfg.temperature,
    stream: true,
    ...buildThinkingParams(cfg),
  };
  const stream = await createChatStreamWithThinkingFallback(client, requestBody, cfg, {
    signal: options.signal,
  });
  let fullText = "";
  let usage: ReturnType<typeof usageFromChunk> = null;
  for await (const chunk of stream) {
    const chunkUsage = usageFromChunk((chunk as any).usage);
    if (chunkUsage) usage = chunkUsage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    const text = extractDeltaContent(delta);
    if (!text) continue;
    fullText += text;
    yield { type: "delta", content: text };
  }
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const finalText = stripFishTags(fullText).trim();
  recordLlmUsage(cfg.model, usage || {
    promptTokens: estimateTokens(messages.map((message) => message.content).join("\n")),
    completionTokens: estimateTokens(finalText),
    cachedTokens: 0,
  }, "chat");
  return { text: finalText };
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "APIUserAbortError";
}
