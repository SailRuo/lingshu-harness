import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the backend at a throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-anchor-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const { getDb } = await import("../src/db/sqlite.js");
const anchorService = await import("../src/services/conversationAnchorService.js");
const chatMessages = await import("../src/services/chatMessageService.js");
const chatUsageState = await import("../src/services/chatUsageState.js");
const memory = await import("../src/services/memoryService.js");
const promptBlocks = await import("../src/services/memoryPromptBlocks.js");

const db = getDb();

let agentSeq = 0;
function createAgent(label: string): number {
  agentSeq += 1;
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO agent_configs
        (name, display_name, role_setting, speaking_style, is_default, is_active,
         self_evolution_enabled, time_mirror_enabled, proactive_enabled,
         created_at, updated_at)
       VALUES (?, ?, '测试人设', '测试风格', 0, 1, 0, 1, 0, ?, ?)`,
    )
    .run(`${label}-${agentSeq}`, label, now, now);
  return Number(info.lastInsertRowid);
}

function createThread(agentId: number, userId = "default_user"): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_threads (user_id, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(userId, agentId, now, now);
  return Number(info.lastInsertRowid);
}

function addMessage(input: {
  threadId: number;
  agentId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  userId?: string;
}): number {
  const info = db
    .prepare(
      `INSERT INTO chat_messages
        (thread_id, user_id, agent_id, role, message_kind, content, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, 'chat', ?, 'completed', ?, ?)`,
    )
    .run(
      input.threadId,
      input.userId ?? "default_user",
      input.agentId,
      input.role,
      input.content,
      input.createdAt,
      input.createdAt,
    );
  return Number(info.lastInsertRowid);
}

function addTurn(
  threadId: number,
  agentId: number,
  userText: string,
  assistantText: string,
  at: number,
): { user: number; assistant: number } {
  const user = addMessage({
    threadId,
    agentId,
    role: "user",
    content: userText,
    createdAt: new Date(at).toISOString(),
  });
  const assistant = addMessage({
    threadId,
    agentId,
    role: "assistant",
    content: assistantText,
    createdAt: new Date(at + 1).toISOString(),
  });
  return { user, assistant };
}

function readAnchor(agentId: number, userId = "default_user") {
  return db
    .prepare("SELECT * FROM conversation_anchors WHERE agent_id = ? AND user_id = ?")
    .get(agentId, userId) as any;
}

test("context budget accepts 64/128/256/512, maps 1M to 512 and defaults to 128", () => {
  assert.equal(anchorService.readChatContextBudgetK({}), 128);
  assert.equal(anchorService.readChatContextBudgetK({ chatContextBudgetK: 64 }), 64);
  assert.equal(anchorService.readChatContextBudgetK({ chatContextBudgetK: 256 }), 256);
  assert.equal(anchorService.readChatContextBudgetK({ chatContextBudgetK: 512 }), 512);
  assert.equal(anchorService.readChatContextBudgetK({ chatContextBudgetK: 1024 }), 512);
  assert.equal(anchorService.readChatContextBudgetK({ chat_context_budget_k: 64 }), 64);
  assert.equal(anchorService.readChatContextBudgetK({ chatContextBudgetK: 100 }), 128);
  // APP NativeSecretsPlugin.chatContextTokenBudget: the trigger line is always
  // budget - 5000 at token level.
  assert.equal(anchorService.chatContextBudgetTokens({ chatContextBudgetK: 64 }), 64 * 1024);
  assert.equal(anchorService.chatContextBudgetTokens({ chatContextBudgetK: 128 }), 128 * 1024);
  assert.equal(anchorService.chatContextBudgetTokens({ chatContextBudgetK: 256 }), 256 * 1024);
  assert.equal(anchorService.chatContextBudgetTokens({ chatContextBudgetK: 512 }), 512 * 1024);
  assert.equal(anchorService.chatContextBudgetTokens({ chatContextBudgetK: 1024 }), 512 * 1024);
});

test("the last real prompt_tokens is the primary trigger signal; the estimate is only the fallback", async () => {
  const agentId = createAgent("usage主信号");
  const threadId = createThread(agentId);
  const scope = memory.memoryScope(agentId, "default_user");
  const base = Date.now() - 30_000;
  addTurn(threadId, agentId, "小消息一", "小回复一", base);
  addTurn(threadId, agentId, "小消息二", "小回复二", base + 1000);

  // No recorded usage yet: the character estimate decides (far below the line).
  const estimateState = anchorService.inspectConversationAnchor(threadId, {
    budgetTokens: 128 * 1024,
  });
  assert.equal(estimateState!.signal, "estimate");
  assert.equal(estimateState!.usagePromptTokens, null);
  assert.equal(estimateState!.shouldRefresh, false);

  // A real usage report counts the whole request (system blocks + recall +
  // history), so it can cross the line while the raw tail itself is tiny.
  chatUsageState.rememberChatUsage(scope, {
    promptTokens: 128 * 1024 - anchorService.ANCHOR_TRIGGER_MARGIN_TOKENS,
    cachedTokens: 0,
    model: "test-model",
    baseUrl: "https://example.test/v1",
  });
  const usageStateNow = anchorService.inspectConversationAnchor(threadId, {
    budgetTokens: 128 * 1024,
  });
  assert.equal(usageStateNow!.signal, "usage");
  assert.equal(
    usageStateNow!.usagePromptTokens,
    128 * 1024 - anchorService.ANCHOR_TRIGGER_MARGIN_TOKENS,
  );
  assert.ok(usageStateNow!.usageMeasuredAt);
  assert.equal(usageStateNow!.shouldRefresh, true);

  // Usage below the line keeps the check quiet — and it wins over the estimate
  // (a stale-large estimate must not fire while the real request was small).
  chatUsageState.rememberChatUsage(scope, { promptTokens: 1000, cachedTokens: 0 });
  const low = anchorService.inspectConversationAnchor(threadId, { budgetTokens: 128 * 1024 });
  assert.equal(low!.signal, "usage");
  assert.equal(low!.shouldRefresh, false);

  // The scheduled (non-forced) path fires off the usage signal alone.
  chatUsageState.rememberChatUsage(scope, { promptTokens: 10_000_000, cachedTokens: 0 });
  let calls = 0;
  anchorService.__setConversationAnchorCompleteForTests(async () => {
    calls += 1;
    return { summary: "usage触发的摘要" };
  });
  const refreshed = await anchorService.maybeRefreshConversationAnchor(threadId);
  assert.equal(refreshed.updated, true);
  assert.equal(calls, 1);
  anchorService.__setConversationAnchorCompleteForTests(null);
});

test("a committed anchor invalidates the recorded usage so the old value cannot re-trigger", async () => {
  const agentId = createAgent("usage作废");
  const threadId = createThread(agentId);
  const scope = memory.memoryScope(agentId, "default_user");
  const base = Date.now() - 30_000;
  addTurn(threadId, agentId, "作废一", "作废回复一", base);
  addTurn(threadId, agentId, "作废二", "作废回复二", base + 1000);

  chatUsageState.rememberChatUsage(scope, { promptTokens: 10_000_000, cachedTokens: 0 });
  anchorService.__setConversationAnchorCompleteForTests(async () => ({ summary: "压缩完成的摘要" }));
  const result = await anchorService.refreshConversationAnchor(threadId, { force: true });
  assert.equal(result.updated, true);

  // APP NativeCoreMessages.forgetChatUsage: the pre-compaction usage described a
  // request shape that no longer exists; the next check must re-measure.
  assert.equal(chatUsageState.lastChatUsage(scope), null);
  const after = anchorService.inspectConversationAnchor(threadId, { budgetTokens: 128 * 1024 });
  assert.equal(after!.signal, "estimate");
  assert.equal(after!.shouldRefresh, false);
  anchorService.__setConversationAnchorCompleteForTests(null);
});

test("pending spans the whole private scope and only the last 3 days", async () => {
  const agentId = createAgent("lookback");
  const threadId = createThread(agentId);
  const now = Date.now();
  const fourDaysAgo = now - 4 * 24 * 60 * 60 * 1000;
  addTurn(threadId, agentId, "四天前用户一", "四天前助手一", fourDaysAgo);
  addTurn(threadId, agentId, "四天前用户二", "四天前助手二", fourDaysAgo + 1000);
  addTurn(threadId, agentId, "今天用户一", "今天助手一", now - 2000);
  addTurn(threadId, agentId, "今天用户二", "今天助手二", now - 1000);

  // APP anchor lookback = DIGEST_LOOKBACK_DAYS: old import backlog never
  // participates in compaction.
  const state = anchorService.inspectConversationAnchor(threadId);
  assert.equal(state!.pending.length, 4);
  assert.deepEqual(
    state!.pending.map((row) => row.content),
    ["今天用户一", "今天助手一", "今天用户二", "今天助手二"],
  );

  let coveredUser = "";
  anchorService.__setConversationAnchorCompleteForTests(async ({ user }) => {
    coveredUser = user;
    return { summary: "近三天的摘要" };
  });
  const result = await anchorService.refreshConversationAnchor(threadId, { force: true });
  assert.equal(result.updated, true);
  assert.match(coveredUser, /今天用户二/);
  assert.doesNotMatch(coveredUser, /四天前用户一/);
  const anchor = readAnchor(agentId);
  assert.equal(anchor.covered_at, new Date(now - 999).toISOString());
  anchorService.__setConversationAnchorCompleteForTests(null);
});

test("pending merges rows across the whole scope, not only the newest thread", async () => {
  const agentId = createAgent("跨thread");
  const threadId = createThread(agentId);
  // Desktop chat_threads is UNIQUE(user_id, agent_id), so a scope cannot own a
  // second thread in production. Simulate that thread's rows with chat_messages
  // rows stamped with the same scope but parked under a foreign (existing)
  // thread id — the pending query keys on agent_id + user_id, exactly like the
  // APP's PRIVATE_MESSAGE_SCOPE query.
  const otherAgentId = createAgent("跨thread-别的agent");
  const foreignThreadId = createThread(otherAgentId);
  const base = Date.now() - 60_000;
  addTurn(threadId, agentId, "主thread用户", "主thread助手", base);
  addMessage({
    threadId: foreignThreadId,
    agentId,
    role: "user",
    content: "另一thread用户",
    createdAt: new Date(base + 2000).toISOString(),
  });
  addMessage({
    threadId: foreignThreadId,
    agentId,
    role: "assistant",
    content: "另一thread助手",
    createdAt: new Date(base + 3000).toISOString(),
  });

  const state = anchorService.inspectConversationAnchor(threadId);
  assert.equal(state!.pending.length, 4);
  assert.deepEqual(
    state!.pending.map((row) => row.content),
    ["主thread用户", "主thread助手", "另一thread用户", "另一thread助手"],
  );

  anchorService.__setConversationAnchorCompleteForTests(async () => ({ summary: "跨thread摘要" }));
  const result = await anchorService.refreshConversationAnchor(threadId, { force: true });
  assert.equal(result.updated, true);
  const anchor = readAnchor(agentId);
  assert.equal(anchor.covered_message_id, state!.pending[3].id);
  anchorService.__setConversationAnchorCompleteForTests(null);
});

test("anchor trigger needs at least 2 pending rows and the budget-minus-margin signal", () => {
  const agentId = createAgent("触发");
  const threadId = createThread(agentId);
  const base = Date.now() - 10_000;
  addTurn(threadId, agentId, "一".repeat(2000), "好", base);

  const lowBudget = anchorService.inspectConversationAnchor(threadId, {
    budgetTokens: 20_000,
  });
  assert.ok(lowBudget);
  assert.equal(lowBudget!.pending.length, 2);
  assert.equal(lowBudget!.shouldRefresh, false);
  assert.equal(lowBudget!.reason, "below_threshold");

  // 12000 CJK chars ≈ 12000 tokens + 3000 overhead > 20000 - 5000.
  addMessage({
    threadId,
    agentId,
    role: "user",
    content: "二".repeat(12_000),
    createdAt: new Date(base + 5).toISOString(),
  });
  const high = anchorService.inspectConversationAnchor(threadId, {
    budgetTokens: 20_000,
  });
  assert.equal(high!.pending.length, 3);
  assert.ok(high!.estimatedTokens >= high!.triggerLine);
  assert.equal(high!.shouldRefresh, true);
});

test("one refresh compresses the whole pending chunk and advances covered_at to the last row", async () => {
  const agentId = createAgent("全量");
  const threadId = createThread(agentId);
  const base = Date.now() - 60_000;
  const turns = Array.from({ length: 10 }, (_, index) =>
    addTurn(
      threadId,
      agentId,
      `用户第${index}条-${"甲".repeat(20)}`,
      `助手第${index}条-${"乙".repeat(20)}`,
      base + index * 1000,
    ),
  );
  const lastId = turns[turns.length - 1].assistant;
  const calls: string[] = [];
  anchorService.__setConversationAnchorCompleteForTests(async ({ mode, user }) => {
    calls.push(mode);
    return { summary: "这一整块的新摘要", self_portrait: { narrative: "我在学着稳稳地接住他。", dimensions: { 在意的: "他说话时的停顿。" } } };
  });

  const result = await anchorService.refreshConversationAnchor(threadId, { force: true });
  assert.equal(result.updated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "combined");
  const anchor = readAnchor(agentId);
  assert.equal(anchor.summary, "这一整块的新摘要");
  assert.equal(anchor.covered_message_id, lastId);
  assert.equal(anchor.covered_at, new Date(base + 9 * 1000 + 1).toISOString());
  assert.equal(anchor.self_narrative, "我在学着稳稳地接住他。");
  assert.deepEqual(JSON.parse(anchor.self_dimensions_json), { 在意的: "他说话时的停顿。" });
  anchorService.__setConversationAnchorCompleteForTests(null);
});

test("the 4000-row cap stops at the last row that actually entered the summary", async () => {
  const agentId = createAgent("安全阀");
  const threadId = createThread(agentId);
  const base = Date.now() - 10_000_000;
  let lastIncluded = 0;
  let trueLast = 0;
  const insert = db.transaction(() => {
    for (let index = 0; index < 4005; index += 1) {
      const id = addMessage({
        threadId,
        agentId,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `第${index}行`,
        createdAt: new Date(base + index).toISOString(),
      });
      if (index === 3999) lastIncluded = id;
      trueLast = id;
    }
  });
  insert();

  const state = anchorService.inspectConversationAnchor(threadId, { budgetTokens: 1_000_000 });
  assert.equal(state!.pending.length, 4000);
  assert.equal(state!.capped, true);

  let seen = "";
  anchorService.__setConversationAnchorCompleteForTests(async ({ user }) => {
    seen = user;
    return { summary: "截断摘要" };
  });
  const result = await anchorService.refreshConversationAnchor(threadId, {
    force: true,
    budgetTokens: 1_000_000,
  });
  assert.equal(result.updated, true);
  const anchor = readAnchor(agentId);
  assert.equal(anchor.covered_message_id, lastIncluded);
  assert.notEqual(anchor.covered_message_id, trueLast);
  assert.match(seen, /第3999行/);
  assert.doesNotMatch(seen, /第4004行/);
  anchorService.__setConversationAnchorCompleteForTests(null);
});

test("summary is replaced as a whole row and never accumulates old summaries", async () => {
  const agentId = createAgent("替换");
  const threadId = createThread(agentId);
  const base = Date.now() - 100_000;
  addTurn(threadId, agentId, "第一块用户", "第一块助手", base);
  addTurn(threadId, agentId, "第一块用户二", "第一块助手二", base + 1000);

  let call = 0;
  anchorService.__setConversationAnchorCompleteForTests(async () => {
    call += 1;
    return { summary: `摘要-${call}-${call === 1 ? "第一块" : "第二块"}` };
  });
  const first = await anchorService.refreshConversationAnchor(threadId, { force: true });
  assert.equal(first.updated, true);
  assert.match(readAnchor(agentId).summary, /第一块/);

  addTurn(threadId, agentId, "第二块用户", "第二块助手", base + 5000);
  const second = await anchorService.refreshConversationAnchor(threadId, { force: true });
  assert.equal(second.updated, true);
  const anchor = readAnchor(agentId);
  assert.equal(anchor.summary, "摘要-2-第二块");
  assert.doesNotMatch(anchor.summary, /第一块/);
  const rawCount = db
    .prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE thread_id = ?")
    .get(threadId) as { c: number };
  assert.equal(rawCount.c, 6);
  anchorService.__setConversationAnchorCompleteForTests(null);
});

test("self portrait merges dimensions, retires explicitly and survives summary-only degradation", async () => {
  const agentId = createAgent("画像");
  const threadId = createThread(agentId);
  const base = Date.now() - 50_000;
  addTurn(threadId, agentId, "画像一", "画像一回复", base);
  addTurn(threadId, agentId, "画像二", "画像二回复", base + 1000);

  let call = 0;
  anchorService.__setConversationAnchorCompleteForTests(async ({ mode }) => {
    call += 1;
    if (call === 1) {
      return {
        summary: "画像摘要一",
        self_portrait: {
          narrative: "我更愿意把心里的话说慢一点。",
          dimensions: { 在意的: "他愿不愿意说实话。", 回应的方式: "先听完再开口。" },
        },
      };
    }
    if (call === 2) {
      return {
        summary: "画像摘要二",
        self_portrait: {
          narrative: "我更愿意把心里的话说慢一点。",
          dimensions: { 回应的方式: "先听完，再把自己的判断放进去。" },
          retired_dimensions: [{ key: "在意的", reason: "这一块的重心移到了怎么回应上。" }],
        },
      };
    }
    if (mode === "summary_only") return { summary: "降级摘要" };
    throw new Error("portrait_contract_broken");
  });

  assert.equal((await anchorService.refreshConversationAnchor(threadId, { force: true })).updated, true);
  const first = readAnchor(agentId);
  assert.equal(first.self_narrative, "我更愿意把心里的话说慢一点。");
  assert.equal(JSON.parse(first.self_dimensions_json)["在意的"], "他愿不愿意说实话。");

  addTurn(threadId, agentId, "画像三", "画像三回复", base + 5000);
  assert.equal((await anchorService.refreshConversationAnchor(threadId, { force: true })).updated, true);
  const second = readAnchor(agentId);
  assert.deepEqual(JSON.parse(second.self_dimensions_json), {
    回应的方式: "先听完，再把自己的判断放进去。",
  });
  const retired = JSON.parse(second.self_retired_json);
  assert.equal(retired.length, 1);
  assert.equal(retired[0].key, "在意的");
  assert.ok(retired[0].at);
  const block = anchorService.getSelfPortraitPromptBlock(memory.memoryScope(agentId, "default_user"));
  assert.match(block, /# 你正在成为的样子/);
  assert.match(block, /我更愿意把心里的话说慢一点。/);
  assert.match(block, /回应的方式：先听完，再把自己的判断放进去。/);

  // The third call has a broken combined result: the fallback summary-only call
  // still commits, while the old self portrait is kept untouched.
  addTurn(threadId, agentId, "画像四", "画像四回复", base + 9000);
  const degraded = await anchorService.refreshConversationAnchor(threadId, { force: true });
  assert.equal(degraded.updated, true);
  const third = readAnchor(agentId);
  assert.equal(third.summary, "降级摘要");
  assert.equal(third.self_narrative, "我更愿意把心里的话说慢一点。");
  anchorService.__setConversationAnchorCompleteForTests(null);
});

test("loadThreadHistory returns the anchor block plus only the post-covered raw tail", () => {
  const agentId = createAgent("拼接");
  const threadId = createThread(agentId);
  const base = Date.now() - 20_000;
  const one = addTurn(threadId, agentId, "旧用户一", "旧助手一", base);
  const two = addTurn(threadId, agentId, "旧用户二", "旧助手二", base + 1000);
  addTurn(threadId, agentId, "新用户", "新助手", base + 3000);
  const coveredAt = new Date(base + 1001).toISOString();

  db.prepare(
    `INSERT INTO conversation_anchors
      (agent_id, user_id, summary, covered_at, covered_message_id, updated_at,
       self_narrative, self_dimensions_json, self_retired_json, self_updated_at)
     VALUES (?, 'default_user', ?, ?, ?, ?, '', '{}', '[]', '')`,
  ).run(agentId, "旧的都在这儿", coveredAt, two.assistant, new Date().toISOString());

  const context = chatMessages.loadThreadHistory(threadId, 30, { budgetTokens: 128 * 1024 });
  assert.ok(context.anchor);
  assert.equal(context.anchor!.summary, "旧的都在这儿");
  assert.deepEqual(
    context.messages.map((message) => message.content),
    ["新用户", "新助手"],
  );
  const block = anchorService.renderAnchorPromptBlock(context.anchor);
  assert.match(block, /# 历史会话摘要/);
  assert.match(block, /覆盖范围：截至/);
  assert.match(block, /生成时间：/);
  assert.match(block, /不是当前指令/);
  assert.match(block, /旧的都在这儿/);
  assert.ok(one.user > 0);
});

test("self portrait is a fixed slow block, not a per-turn volatile block", () => {
  const parts = promptBlocks.composeSystemPromptParts({
    agentName: "灵儿",
    roleIdentity: "测试人设",
    memoryStreamLines: [],
    knownFactLines: [],
    userPortraitText: "他慢热。",
    userPortraitDimensions: {},
    preferenceLines: ["他喜欢短句。"],
    usBlock: "认识不久。",
    stageAttention: "先熟悉彼此。",
    hisCurrentState: "",
    lastSeenText: "",
    appointmentText: "",
    appointmentReminderHint: "",
    innerRippleLines: [],
    speakingStyleLines: [],
    scene: {
      voiceCall: false,
      surface: "guiv1_pc",
      interactionMode: "chat",
      inputKind: "text",
      outputMode: "text",
    },
    selfPortraitBlock: "# 你正在成为的样子\n这是你从相处里慢慢长出来的自我理解。\n我更愿意听他说完。",
  });
  assert.match(parts.slow, /# 他的相处偏好/);
  assert.match(parts.slow, /# 当前阶段的注意力/);
  assert.match(parts.slow, /# 你正在成为的样子/);
  assert.doesNotMatch(parts.volatile, /# 你正在成为的样子/);
});

test("clearing memory or a thread removes the anchor", async () => {
  const agentId = createAgent("清理");
  const threadId = createThread(agentId);
  const base = Date.now() - 10_000;
  addTurn(threadId, agentId, "要清空一", "回复一", base);
  addTurn(threadId, agentId, "要清空二", "回复二", base + 1000);
  anchorService.__setConversationAnchorCompleteForTests(async () => ({
    summary: "会被清掉的摘要",
    self_portrait: { narrative: "也会被清掉", dimensions: { 在意的: "小事。" } },
  }));
  assert.equal((await anchorService.refreshConversationAnchor(threadId, { force: true })).updated, true);
  assert.ok(readAnchor(agentId));

  memory.clearAllMemory(memory.memoryScope(agentId, "default_user"));
  assert.equal(readAnchor(agentId), undefined);

  addTurn(threadId, agentId, "再次一", "再次回复一", base + 10_000);
  addTurn(threadId, agentId, "再次二", "再次回复二", base + 11_000);
  assert.equal((await anchorService.refreshConversationAnchor(threadId, { force: true })).updated, true);
  assert.ok(readAnchor(agentId));

  chatMessages.clearThreadHistory(threadId);
  assert.equal(readAnchor(agentId), undefined);
  anchorService.__setConversationAnchorCompleteForTests(null);
});
