import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the backend at a throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-memory-digest-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
// Sidecar has its own dedicated test; keep every other digest deterministic.
process.env.LINGSHU_DIGEST_AFFECT_SIDECAR = "0";

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const memory = await import("../src/services/memoryService.js");
const digestBatch = await import("../src/services/digestBatch.js");
const scheduler = await import("../src/services/digestScheduler.js");
const { beginVoiceCall, endVoiceCall } = await import("../src/services/voiceCallPresence.js");
const { listBackgroundTaskEvents } = await import("../src/services/backgroundTaskEvents.js");
const { storeStreamEmbedding } = await import("../src/services/embeddingService.js");
const {
  DIGEST_CONSTANTS,
  DIGEST_RESPONSE_SCHEMAS,
  DIGEST_TEMPLATES,
} = await import("../src/contracts/native/index.js");

let db = getDb();

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

function createThread(agentId: number, userId = "default_user", threadUserId = userId): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_threads (user_id, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(threadUserId, agentId, now, now);
  return Number(info.lastInsertRowid);
}

function addMessage(input: {
  threadId: number;
  agentId: number;
  userId?: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  digestedAt?: string | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO chat_messages
        (thread_id, user_id, agent_id, role, message_kind, content, status, created_at, digested_at)
       VALUES (?, ?, ?, ?, 'chat', ?, 'completed', ?, ?)`,
    )
    .run(
      input.threadId,
      input.userId ?? "default_user",
      input.agentId,
      input.role,
      input.content,
      input.createdAt,
      input.digestedAt ?? null,
    );
  return Number(info.lastInsertRowid);
}

function turn(
  threadId: number,
  agentId: number,
  userText: string,
  assistantText: string,
  at: number,
  userId = "default_user",
) {
  const user = addMessage({
    threadId,
    agentId,
    userId,
    role: "user",
    content: userText,
    createdAt: new Date(at).toISOString(),
  });
  const assistant = addMessage({
    threadId,
    agentId,
    userId,
    role: "assistant",
    content: assistantText,
    createdAt: new Date(at + 1).toISOString(),
  });
  return { user, assistant };
}

function emptyExtraction() {
  return {
    should_write: false,
    constraints: [],
    facts: [],
    streams: [],
    corrections: [],
    continuity: [],
  };
}

function embedStub(text: string): number[] {
  const vector = new Array(768).fill(0);
  vector[0] = 1;
  vector[1] = Math.max(0.01, Math.min(0.99, text.length / 1000));
  return vector;
}

function captureComplete(response: any) {
  const calls: { system: string | string[]; human: string; schema?: Record<string, unknown> }[] = [];
  const complete = async (
    system: string | string[],
    human: string,
    schema?: Record<string, unknown>,
  ) => {
    calls.push({ system, human, schema });
    return typeof response === "function" ? response(calls.length, human) : response;
  };
  return { calls, complete };
}

test("v19-v22 schema adds digest, relationship and usage tables/columns idempotently", () => {
  const version = db.pragma("user_version", { simple: true }) as number;
  assert.equal(version, 22);
  for (const table of [
    "digest_state",
    "background_task_events",
    "agent_state_changes",
    "conversation_anchors",
    "relationship_threads",
    "relationship_thread_nodes",
    "chat_usage_state",
  ]) {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name?: string } | undefined;
    assert.equal(row?.name, table);
  }
  const seedColumns = db.pragma("table_info(hippocampus_seeds)") as { name: string }[];
  for (const column of ["revision", "status", "applicability_json"]) {
    assert.ok(seedColumns.some((item) => item.name === column), column);
  }
  const streamColumns = db.pragma("table_info(hippocampus_streams)") as { name: string }[];
  assert.ok(streamColumns.some((column) => column.name === "origin_theater_id"));
  closeDb();
  db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 22);
});

test("digest constants match the APP contract", () => {
  assert.equal(DIGEST_CONSTANTS.IDLE_MS, 90_000);
  assert.equal(DIGEST_CONSTANTS.DIGEST_LOOKBACK_DAYS, 3);
  assert.equal(DIGEST_CONSTANTS.DIGEST_MAX_INPUT_TOKENS, 128 * 1024);
  assert.equal(DIGEST_CONSTANTS.DIGEST_MAX_CHUNKS_PER_RUN, 8);
  assert.equal(DIGEST_CONSTANTS.DIGEST_BATCH_ROW_CAP, 4000);
  assert.equal(DIGEST_CONSTANTS.AKIN_LINK_MAX_L2, 1.1);
  assert.equal(DIGEST_CONSTANTS.AKIN_LINK_TOPK, 5);
  assert.equal(DIGEST_CONSTANTS.AKIN_TEMPORAL_NEIGHBOR_LIMIT, 5);
  assert.equal(DIGEST_CONSTANTS.AKIN_CANDIDATE_TOTAL_CAP, 12);
});

test("digest only reads the 3-day lookback window", async () => {
  const agentId = createAgent("回溯");
  const threadId = createThread(agentId);
  const old = turn(threadId, agentId, "四天前的旧消息", "四天前的回复", Date.now() - 4 * 86_400_000);
  const recent = turn(threadId, agentId, "一小时前的近消息", "一小时前的回复", Date.now() - 3_600_000);
  const { calls, complete } = captureComplete(emptyExtraction());
  const result = await memory.runAgentDigest(agentId, "default_user", {
    complete,
    embed: async (text) => embedStub(text),
  });
  assert.ok(!("skipped" in result));
  assert.equal(calls.length, 1);
  assert.match(calls[0].human, /一小时前的近消息/);
  assert.doesNotMatch(calls[0].human, /四天前的旧消息/);
  const oldRow = db.prepare("SELECT digested_at FROM chat_messages WHERE id = ?").get(old.assistant) as any;
  const recentRow = db
    .prepare("SELECT digested_at FROM chat_messages WHERE id = ?")
    .get(recent.assistant) as any;
  assert.equal(oldRow.digested_at, null);
  assert.ok(recentRow.digested_at);
  const state = memory.readDigestState(agentId, "default_user");
  assert.equal(state?.lastMessageId, recent.assistant);
});

test("token chunk planner splits oldest-first and estimates CJK/ASCII", () => {
  assert.equal(digestBatch.estimateDigestTokens("你好ab"), 2 + 1);
  const messages = Array.from({ length: 4 }, (_, index) => ({
    id: index + 1,
    thread_id: 1,
    agent_id: 1,
    user_id: "default_user",
    role: "user" as const,
    content: "一".repeat(100),
    created_at: new Date(index).toISOString(),
  }));
  const chunks = digestBatch.planDigestChunks(messages, "ta", "我", 120);
  assert.equal(chunks.length, 4);
  for (const chunk of chunks) {
    assert.ok(chunk.tokenEstimate <= 120, String(chunk.tokenEstimate));
  }
});

test("digest honors the 4000-row cap and the max-chunks-per-run limit", async () => {
  const agentId = createAgent("批次");
  const threadId = createThread(agentId);
  const base = Date.now() - 60_000;
  const insert = db.prepare(
    `INSERT INTO chat_messages
      (thread_id, user_id, agent_id, role, message_kind, content, status, created_at)
     VALUES (?, 'default_user', ?, ?, 'chat', ?, 'completed', ?)`,
  );
  const tx = db.transaction(() => {
    for (let index = 0; index < 4005; index += 1) {
      insert.run(
        threadId,
        agentId,
        index % 2 === 0 ? "user" : "assistant",
        `m${index}`,
        new Date(base + index).toISOString(),
      );
    }
  });
  tx();
  const { calls, complete } = captureComplete(emptyExtraction());
  const result = await memory.runAgentDigest(agentId, "default_user", {
    complete,
    embed: async (text) => embedStub(text),
    maxChunks: 2,
  });
  assert.ok(!("skipped" in result));
  assert.equal(calls.length, 2);
  const firstLines = calls[0].human.split("\n[").length - 1;
  assert.ok(firstLines <= 4000, `first chunk lines=${firstLines}`);
  assert.equal(result.batchesRun, 2);

  // A third forced chunk proves maxChunks stops the run with backlog left.
  const longAgent = createAgent("长文");
  const longThread = createThread(longAgent);
  for (let index = 0; index < 3; index += 1) {
    addMessage({
      threadId: longThread,
      agentId: longAgent,
      role: index % 2 === 0 ? "user" : "assistant",
      content: "很".repeat(5000),
      createdAt: new Date(Date.now() - 30_000 + index).toISOString(),
    });
  }
  const capped = captureComplete(emptyExtraction());
  const cappedResult = await memory.runAgentDigest(longAgent, "default_user", {
    complete: capped.complete,
    embed: async (text) => embedStub(text),
    maxChunks: 2,
    maxInputTokens: 4096,
  });
  assert.ok(!("skipped" in cappedResult));
  assert.equal(capped.calls.length, 2);
  assert.equal(cappedResult.batchesRun, 2);
  assert.equal(cappedResult.hasMore, true);
});

test("digest merges messages from every thread owned by the same agent+user", async () => {
  const agentId = createAgent("跨线程");
  const mainThread = createThread(agentId);
  const legacyThread = createThread(agentId, "default_user", "legacy_thread_owner");
  turn(mainThread, agentId, "主线程里的内容", "主线程回复", Date.now() - 30_000);
  turn(legacyThread, agentId, "旧线程里的内容", "旧线程回复", Date.now() - 20_000, "default_user");
  const { calls, complete } = captureComplete(emptyExtraction());
  await memory.runThreadDigest(mainThread, {
    complete,
    embed: async (text) => embedStub(text),
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].human, /主线程里的内容/);
  assert.match(calls[0].human, /旧线程里的内容/);
});

test("digest_state high-water mark uses created_at + id and never advances on failure", async () => {
  const agentId = createAgent("水位");
  const threadId = createThread(agentId);
  const at = Date.now() - 10_000;
  const first = turn(threadId, agentId, "第一句", "第一回复", at);
  const { calls, complete } = captureComplete(emptyExtraction());
  await memory.runAgentDigest(agentId, "default_user", {
    complete,
    embed: async (text) => embedStub(text),
  });
  const state = memory.readDigestState(agentId, "default_user");
  assert.equal(state?.lastMessageId, first.assistant);
  assert.equal(state?.lastMessageCreatedAt, new Date(at + 1).toISOString());

  const secondCalls = captureComplete(emptyExtraction());
  const skipped = await memory.runAgentDigest(agentId, "default_user", {
    complete: secondCalls.complete,
    embed: async (text) => embedStub(text),
  });
  assert.ok("skipped" in skipped);
  assert.equal(secondCalls.calls.length, 0);

  const failedAgent = createAgent("失败水位");
  const failedThread = createThread(failedAgent);
  turn(failedThread, failedAgent, "会失败的消息", "会失败的回复", at);
  await assert.rejects(
    memory.runAgentDigest(failedAgent, "default_user", {
      complete: async () => {
        throw new Error("llm_down");
      },
      embed: async (text) => embedStub(text),
    }),
  );
  assert.equal(memory.readDigestState(failedAgent, "default_user"), null);
  const failedMessage = db
    .prepare("SELECT digested_at FROM chat_messages WHERE agent_id = ? AND role = 'assistant'")
    .get(failedAgent) as any;
  assert.equal(failedMessage.digested_at, null);
  const failedEvents = listBackgroundTaskEvents({
    eventType: "digest",
    subjectId: String(failedAgent),
    limit: 20,
  });
  assert.ok(failedEvents.some((event) => event.status === "failed"));
});

test("extractor uses the APP contract and drops evidence that is not user-verbatim", async () => {
  const agentId = createAgent("契约");
  const threadId = createThread(agentId);
  turn(
    threadId,
    agentId,
    "我喜欢喝乌龙茶，别叫我宝贝。",
    "好，我记住了，以后不叫宝贝。",
    Date.now() - 5_000,
  );

  const { calls, complete } = captureComplete({
    should_write: true,
    constraints: [
      {
        action: "new",
        rule_type: "dont",
        description: "他不喜欢被叫宝贝",
        evidence: "别叫我宝贝",
      },
      {
        action: "new",
        rule_type: "do",
        description: "他要我每天提醒他喝水",
        evidence: "你每天提醒我喝水", // not in the user transcript
      },
    ],
    facts: [
      {
        subject: "Me",
        relation: "LIKES",
        object: "乌龙茶",
        description: "用户喜欢乌龙茶",
        confidence: 0.9,
        importance: 0.6,
        evidence: "我喜欢喝乌龙茶",
      },
      {
        subject: "Me",
        relation: "HAS_BODY_REACTION",
        object: "紧张时胃疼",
        evidence: "我喜欢喝乌龙茶", // valid evidence but relation is outside APP closed set
      },
      {
        subject: "Me",
        relation: "LIVES_IN",
        object: "杭州",
        evidence: "我住在杭州", // not in transcript
      },
    ],
    streams: [
      {
        narrative: "我记得他说喜欢乌龙茶，也不喜欢被叫宝贝。",
        about: "他·爱好",
        stream_type: "external",
        significance: 0.6,
      },
    ],
    corrections: [],
    continuity: [],
    // Desktop-only legacy fields: the M1 extractor must ignore them.
    affect: { text_valence: 0.4, text_arousal: 0.6, text_dominance: 0.5, note: "legacy" },
    appointments: [{ action: "new", title: "旧约定", due_at: "2030-01-01T00:00:00Z", evidence: "我喜欢喝乌龙茶" }],
    threads: [{ action: "open", title: "旧心事线", owner: "him", grip: 0.8 }],
  });
  const result = await memory.runAgentDigest(agentId, "default_user", {
    complete,
    embed: async (text) => embedStub(text),
  });
  assert.ok(!("skipped" in result));
  assert.deepEqual(calls[0].schema, DIGEST_RESPONSE_SCHEMAS.EXTRACTOR.schema);
  assert.ok(Array.isArray(calls[0].system));
  assert.equal((calls[0].system as string[])[0], DIGEST_TEMPLATES.DIGEST_EXTRACTOR_RULES);

  const constraints = db
    .prepare("SELECT * FROM hippocampus_constraints WHERE agent_id = ?")
    .all(agentId) as any[];
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0].description, "他不喜欢被叫宝贝");
  const facts = db.prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ?").all(agentId) as any[];
  assert.equal(facts.length, 1);
  assert.equal(facts[0].relation, "LIKES");
  const streams = db
    .prepare("SELECT * FROM hippocampus_streams WHERE agent_id = ? AND type <> 'group_presence'")
    .all(agentId) as any[];
  assert.equal(streams.length, 1);
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_appointments WHERE agent_id = ?").get(agentId) as any).c),
    0,
  );
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_threads WHERE agent_id = ?").get(agentId) as any).c),
    0,
  );
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_affect_points WHERE agent_id = ?").get(agentId) as any).c),
    0,
  );
  assert.equal(streams[0].origin_scope, "private_dyadic");
  assert.equal(streams[0].perspective, "ta");

  // streams do not participate in should_write: gates off facts/constraints only.
  const agentId2 = createAgent("结晶闸");
  const threadId2 = createThread(agentId2);
  turn(threadId2, agentId2, "随便聊聊天气。", "今天确实有点热。", Date.now() - 5_000);
  const gate = captureComplete({
    should_write: false,
    constraints: [
      { action: "new", rule_type: "dont", description: "他不喜欢被叫宝贝", evidence: "随便聊聊天气。" },
    ],
    facts: [
      {
        subject: "Me",
        relation: "LIKES",
        object: "晴天",
        description: "用户喜欢晴天",
        evidence: "随便聊聊天气。",
      },
    ],
    streams: [
      {
        narrative: "今天和他闲聊了天气，他好像只是随口一说。",
        about: "他·日常",
        stream_type: "external",
        significance: 0.3,
      },
    ],
    corrections: [],
    continuity: [],
  });
  await memory.runAgentDigest(agentId2, "default_user", {
    complete: gate.complete,
    embed: async (text) => embedStub(text),
  });
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_facts WHERE agent_id = ?").get(agentId2) as any).c),
    0,
  );
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_constraints WHERE agent_id = ?").get(agentId2) as any).c),
    0,
  );
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_streams WHERE agent_id = ?").get(agentId2) as any).c),
    1,
  );
});

test("digest_state tie-breaks equal timestamps by message id and retries are idempotent", async () => {
  const agentId = createAgent("同毫秒");
  const threadId = createThread(agentId);
  const at = Date.now() - 10_000;
  const same = new Date(at).toISOString();
  const user1 = addMessage({ threadId, agentId, role: "user", content: "同一毫秒第一句", createdAt: same });
  const assistant1 = addMessage({ threadId, agentId, role: "assistant", content: "同一毫秒第一回复", createdAt: same });
  const response = {
    should_write: true,
    constraints: [],
    facts: [
      {
        subject: "Me",
        relation: "LIKES",
        object: "乌龙茶",
        description: "用户喜欢乌龙茶",
        evidence: "同一毫秒第一句",
      },
    ],
    streams: [
      {
        narrative: "同一毫秒里留下的一条记忆。",
        about: "他·日常",
        stream_type: "external",
        significance: 0.4,
      },
    ],
    corrections: [],
    continuity: [],
  };
  const first = captureComplete(response);
  const result1 = await memory.runAgentDigest(agentId, "default_user", {
    complete: first.complete,
    embed: async (text) => embedStub(text),
  });
  assert.ok(!("skipped" in result1));
  assert.equal(memory.readDigestState(agentId, "default_user")?.lastMessageId, assistant1);

  // Simulate a crash after writes but before the cursor commit: the same batch
  // is re-run and must not duplicate streams or facts.
  db.prepare("DELETE FROM digest_state WHERE agent_id = ? AND user_id = 'default_user'").run(agentId);
  db.prepare("UPDATE chat_messages SET digested_at = NULL WHERE agent_id = ?").run(agentId);
  const streamCountBefore = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM hippocampus_streams WHERE agent_id = ?").get(agentId) as any).c,
  );
  const factCountBefore = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM hippocampus_facts WHERE agent_id = ?").get(agentId) as any).c,
  );
  const retry = captureComplete(response);
  await memory.runAgentDigest(agentId, "default_user", {
    complete: retry.complete,
    embed: async (text) => embedStub(text),
  });
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_streams WHERE agent_id = ?").get(agentId) as any).c),
    streamCountBefore,
  );
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_facts WHERE agent_id = ?").get(agentId) as any).c),
    factCountBefore,
  );

  const user2 = addMessage({ threadId, agentId, role: "user", content: "同一毫秒第二句", createdAt: same });
  const assistant2 = addMessage({ threadId, agentId, role: "assistant", content: "同一毫秒第二回复", createdAt: same });
  const second = captureComplete({ ...response, facts: [], streams: [] });
  const result2 = await memory.runAgentDigest(agentId, "default_user", {
    complete: second.complete,
    embed: async (text) => embedStub(text),
  });
  assert.ok(!("skipped" in result2));
  assert.match(second.calls[0].human, /同一毫秒第二句/);
  assert.doesNotMatch(second.calls[0].human, /同一毫秒第一句/);
  assert.equal(memory.readDigestState(agentId, "default_user")?.lastMessageId, assistant2);

  assert.ok(user1 && user2);
});

test("constraint new/update/remove lifecycle is scoped and repeatable", async () => {
  const agentId = createAgent("约束生命周期");
  const threadId = createThread(agentId);
  turn(threadId, agentId, "以后别叫我宝贝。", "好，记住了。", Date.now() - 30_000);
  const base = {
    should_write: true,
    constraints: [
      {
        action: "new",
        rule_type: "dont",
        description: "他不喜欢被叫宝贝",
        evidence: "以后别叫我宝贝。",
      },
    ],
    facts: [],
    streams: [],
    corrections: [],
    continuity: [],
  };
  const first = captureComplete(base);
  await memory.runAgentDigest(agentId, "default_user", {
    complete: first.complete,
    embed: async (text) => embedStub(text),
  });
  let rows = db
    .prepare("SELECT * FROM hippocampus_constraints WHERE agent_id = ?")
    .all(agentId) as any[];
  assert.equal(rows.length, 1);
  const targetId = Number(rows[0].id);

  turn(threadId, agentId, "以后可以叫我宝贝。", "好，那我改口。", Date.now() - 20_000);
  const second = captureComplete({
    ...base,
    constraints: [
      {
        action: "update",
        target_id: String(targetId),
        rule_type: "do",
        description: "他可以接受被叫宝贝",
        evidence: "以后可以叫我宝贝。",
      },
    ],
  });
  await memory.runAgentDigest(agentId, "default_user", {
    complete: second.complete,
    embed: async (text) => embedStub(text),
  });
  rows = db.prepare("SELECT * FROM hippocampus_constraints WHERE agent_id = ?").all(agentId) as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, "他可以接受被叫宝贝");

  turn(threadId, agentId, "还是别叫了。", "好，听你的。", Date.now() - 10_000);
  const third = captureComplete({
    ...base,
    constraints: [
      {
        action: "remove",
        target_id: String(targetId),
        rule_type: "dont",
        description: "",
        evidence: "还是别叫了。",
      },
    ],
  });
  await memory.runAgentDigest(agentId, "default_user", {
    complete: third.complete,
    embed: async (text) => embedStub(text),
  });
  rows = db.prepare("SELECT * FROM hippocampus_constraints WHERE agent_id = ?").all(agentId) as any[];
  assert.equal(rows.length, 0);
});

test("continuity writes relationship_threads/nodes and never the retired 心事线 tables", async () => {
  const agentId = createAgent("共同来往");
  const threadId = createThread(agentId);
  turn(threadId, agentId, "以后就用月亮当暗号提醒我。", "好，月亮。", Date.now() - 10_000);
  const first = captureComplete({
    should_write: false,
    constraints: [],
    facts: [],
    streams: [],
    corrections: [],
    continuity: [
      {
        title: "月亮暗号",
        note: "我们说好用月亮当提醒暗号",
        carries_index: -1,
        nodes: [{ index: 0 }, { index: 1 }],
      },
    ],
  });
  await memory.runAgentDigest(agentId, "default_user", {
    complete: first.complete,
    embed: async (text) => embedStub(text),
  });
  let threads = db
    .prepare("SELECT * FROM relationship_threads WHERE agent_id = ?")
    .all(agentId) as any[];
  assert.equal(threads.length, 1);
  assert.equal(threads[0].title, "月亮暗号");
  assert.equal(threads[0].status, "candidate");
  assert.equal(threads[0].summary, "我们说好用月亮当提醒暗号");
  let nodes = db
    .prepare("SELECT * FROM relationship_thread_nodes WHERE agent_id = ? ORDER BY occurred_at")
    .all(agentId) as any[];
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((node) => node.thread_id === threads[0].id));
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_threads WHERE agent_id = ?").get(agentId) as any).c),
    0,
  );
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_touchpoints WHERE agent_id = ?").get(agentId) as any).c),
    0,
  );

  turn(threadId, agentId, "月亮，该休息了。", "月亮，晚安。", Date.now() - 1_000);
  const second = captureComplete({
    should_write: false,
    constraints: [],
    facts: [],
    streams: [],
    corrections: [],
    continuity: [
      {
        title: "月亮暗号",
        note: "这次我们又用上了月亮暗号",
        carries_index: 0,
        carry_note: "按约定用月亮提醒休息",
        nodes: [{ index: 0 }, { index: 1 }],
      },
    ],
  });
  await memory.runAgentDigest(agentId, "default_user", {
    complete: second.complete,
    embed: async (text) => embedStub(text),
  });
  threads = db
    .prepare("SELECT * FROM relationship_threads WHERE agent_id = ?")
    .all(agentId) as any[];
  assert.equal(threads.length, 1);
  assert.equal(threads[0].status, "active");
  assert.equal(threads[0].summary, "这次我们又用上了月亮暗号");
  nodes = db
    .prepare("SELECT * FROM relationship_thread_nodes WHERE agent_id = ? ORDER BY occurred_at")
    .all(agentId) as any[];
  assert.equal(nodes.length, 4);
  assert.ok(nodes.some((node) => node.carry_note.includes("月亮")));
});

test("AKIN writes bidirectional edges and stays idempotent", async () => {
  const agentId = createAgent("事线");
  const now = new Date().toISOString();
  const insertStream = db.prepare(
    `INSERT INTO hippocampus_streams
      (id, agent_id, user_id, narrative, about, type, significance, archived, origin_scope,
       perspective, participants_json, created_at, updated_at)
     VALUES (?, ?, 'default_user', ?, '他·日常', 'external', 0.5, 0, 'private_dyadic', 'ta', '[]', ?, ?)`,
  );
  insertStream.run("akin-a", agentId, "他说明天要去面试，我有点替他紧张。", now, now);
  insertStream.run("akin-b", agentId, "面试结束了，他说感觉还不错。", now, now);
  const vectorA = new Array(768).fill(0);
  vectorA[0] = 1;
  const vectorB = new Array(768).fill(0);
  vectorB[0] = 0.9;
  vectorB[1] = 0.1;
  storeStreamEmbedding("akin-a", vectorA);
  storeStreamEmbedding("akin-b", vectorB);

  const scope = { agentId, userId: "default_user" };
  const judge = async () => [0];
  const first = await memory.linkStreamToExistingMemory(
    scope,
    { id: "akin-a", narrative: "他说明天要去面试，我有点替他紧张。", vector: vectorA },
    { judge },
  );
  assert.equal(first, 2);
  const edges = db
    .prepare("SELECT source_id, target_id FROM hippocampus_edges WHERE agent_id = ? AND edge_type = 'AKIN' ORDER BY source_id, target_id")
    .all(agentId) as any[];
  assert.deepEqual(
    edges.map((edge) => `${edge.source_id}->${edge.target_id}`),
    ["akin-a->akin-b", "akin-b->akin-a"],
  );
  await memory.linkStreamToExistingMemory(
    scope,
    { id: "akin-a", narrative: "他说明天要去面试，我有点替他紧张。", vector: vectorA },
    { judge },
  );
  const count = db
    .prepare("SELECT COUNT(*) AS c FROM hippocampus_edges WHERE agent_id = ? AND edge_type = 'AKIN'")
    .get(agentId) as any;
  assert.equal(Number(count.c), 2);
});

test("clearing memory invalidates an in-flight digest before it can write", async () => {
  const agentId = createAgent("清空竞态");
  const threadId = createThread(agentId);
  const ids = turn(threadId, agentId, "清空前说的话", "清空前回复", Date.now() - 5_000);
  const scope = { agentId, userId: "default_user" };
  const complete = async () => {
    memory.clearAllMemory(scope);
    return {
      should_write: false,
      constraints: [],
      facts: [],
      streams: [
        {
          narrative: "这条旧记忆不应写回。",
          about: "他·日常",
          stream_type: "external",
          significance: 0.5,
        },
      ],
      corrections: [],
      continuity: [],
    };
  };
  const result = await memory.runAgentDigest(agentId, "default_user", {
    complete,
    embed: async (text) => embedStub(text),
  });
  assert.ok("skipped" in result);
  assert.equal(result.skipped, "stale");
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_streams WHERE agent_id = ?").get(agentId) as any).c),
    0,
  );
  assert.equal(memory.readDigestState(agentId, "default_user"), null);
  const row = db.prepare("SELECT digested_at FROM chat_messages WHERE id = ?").get(ids.assistant) as any;
  assert.equal(row.digested_at, null);
  const events = listBackgroundTaskEvents({ eventType: "digest", subjectId: String(agentId), limit: 20 });
  assert.ok(events.some((event) => event.status === "stale"));
});

test("private digest never consumes group-public messages or streams", async () => {
  const agentId = createAgent("群边界");
  const threadId = createThread(agentId);
  turn(threadId, agentId, "这是私聊内容。", "这是私聊回复。", Date.now() - 5_000);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO group_sessions (id, user_id, title, description, status, created_at, updated_at)
     VALUES ('group-x', 'default_user', '群', '', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO group_messages
      (id, group_session_id, user_id, speaker_type, speaker_id, turn_id, content, status, created_at)
     VALUES ('gm-1', 'group-x', 'default_user', 'user', 'default_user', 'gt-1', '群里的公开内容', 'completed', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO hippocampus_streams
      (id, agent_id, user_id, narrative, about, type, significance, archived, revisit_count,
       origin_scope, origin_group_session_id, perspective, participants_json, created_at, updated_at)
     VALUES ('group-stream-x', ?, 'default_user', '群公开经历不应进入私聊 digest。', '他·日常',
             'group_presence', 0.5, 0, 0, 'group_public', 'group-x', 'everyone', '[]', ?, ?)`,
  ).run(agentId, now, now);

  const { calls, complete } = captureComplete(emptyExtraction());
  await memory.runAgentDigest(agentId, "default_user", {
    complete,
    embed: async (text) => embedStub(text),
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].human, /这是私聊内容/);
  assert.doesNotMatch(calls[0].human, /群里的公开内容/);
  assert.doesNotMatch(calls[0].human, /群公开经历不应进入私聊 digest/);
  const stream = db
    .prepare("SELECT revisit_count FROM hippocampus_streams WHERE id = 'group-stream-x'")
    .get() as any;
  assert.equal(Number(stream.revisit_count), 0);
});

test("affect sidecar writes points/baseline outside the digest schema and never blocks digest", async () => {
  const previous = process.env.LINGSHU_DIGEST_AFFECT_SIDECAR;
  process.env.LINGSHU_DIGEST_AFFECT_SIDECAR = "1";
  try {
    const agentId = createAgent("情绪旁路");
    const threadId = createThread(agentId);
    const ids = turn(threadId, agentId, "今天有点累，但看到你心情好多了。", "那就先歇一会儿。", Date.now() - 5_000);
    let sidecarSchema: Record<string, unknown> | undefined;
    const result = await memory.runAgentDigest(agentId, "default_user", {
      complete: async () => emptyExtraction(),
      affectComplete: async (_system, _human, schema) => {
        sidecarSchema = schema;
        return { text_valence: 0.3, text_arousal: 0.4, text_dominance: 0.6, note: "疲惫但放松" };
      },
      embed: async (text) => embedStub(text),
    });
    assert.ok(!("skipped" in result));
    assert.ok(sidecarSchema);
    const sidecarProperties = (sidecarSchema as any).properties;
    assert.ok(sidecarProperties.text_valence);
    assert.ok(!("should_write" in sidecarProperties));
    const points = db
      .prepare("SELECT * FROM hippocampus_affect_points WHERE agent_id = ? AND channel = 'text'")
      .all(agentId) as any[];
    assert.equal(points.length, 1);
    assert.equal(points[0].source, "digest_affect_sidecar");
    assert.equal(Number(points[0].turn_id), ids.assistant);
    assert.equal(points[0].note, "疲惫但放松");
    const baseline = db
      .prepare("SELECT * FROM hippocampus_baselines WHERE agent_id = ? AND user_id = 'default_user'")
      .get(agentId) as any;
    assert.ok(baseline);
    assert.ok(Number(baseline.sample_count) >= 1);
    assert.ok(Number(baseline.text_sample_count) >= 1);

    const failAgent = createAgent("情绪旁路失败");
    const failThread = createThread(failAgent);
    turn(failThread, failAgent, "旁路失败也不能影响 digest。", "嗯。", Date.now() - 2_000);
    const failed = await memory.runAgentDigest(failAgent, "default_user", {
      complete: async () => emptyExtraction(),
      affectComplete: async () => {
        throw new Error("affect_sidecar_down");
      },
      embed: async (text) => embedStub(text),
    });
    assert.ok(!("skipped" in failed));
    assert.equal(
      Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_affect_points WHERE agent_id = ?").get(failAgent) as any).c),
      0,
    );
    const events = listBackgroundTaskEvents({ eventType: "affect_sidecar", subjectId: String(failAgent), limit: 20 });
    assert.ok(events.some((event) => event.status === "failed"));
  } finally {
    if (previous === undefined) delete process.env.LINGSHU_DIGEST_AFFECT_SIDECAR;
    else process.env.LINGSHU_DIGEST_AFFECT_SIDECAR = previous;
  }
});

test("startup recovery only schedules scopes with pending messages in the last 24h", () => {
  scheduler.shutdownDigestScheduler();
  const recentAgent = createAgent("恢复近期");
  const recentThread = createThread(recentAgent);
  addMessage({
    threadId: recentThread,
    agentId: recentAgent,
    role: "assistant",
    content: "一小时前未消化",
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  const oldAgent = createAgent("恢复过期");
  const oldThread = createThread(oldAgent);
  addMessage({
    threadId: oldThread,
    agentId: oldAgent,
    role: "assistant",
    content: "二十五小时前未消化",
    createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
  });
  // Isolate recovery from pending messages left by earlier tests.
  db.prepare("DELETE FROM chat_messages WHERE agent_id NOT IN (?, ?)").run(recentAgent, oldAgent);
  const recovered = scheduler.recoverPendingDigests();
  assert.equal(recovered, 1);
  assert.equal(scheduler.digestSchedulerState().pending, 1);
  scheduler.shutdownDigestScheduler();
});

test("digest scheduler is 90s idle, resets on a new user turn and skips voice calls", async () => {
  scheduler.shutdownDigestScheduler();
  const agentId = createAgent("调度");
  const threadId = createThread(agentId);
  turn(threadId, agentId, "调度测试", "调度回复", Date.now() - 5_000);
  const runs: string[] = [];
  scheduler.__setDigestExecutorForTests(async (_agentId, _userId, source) => {
    runs.push(source);
    return {
      agentId,
      userId: "default_user",
      turnIds: [],
      turnCount: 0,
      markedDigested: 0,
      streamsWritten: 0,
      streamsSource: "llm",
      factsProcessed: 0,
      constraintsProcessed: 0,
      continuityApplied: 0,
      threadsCreated: 0,
      threadsUpdated: 0,
      touchpointsWritten: 0,
      selfEvolutionEnabled: false,
      personalitySeedAction: "noop",
      personalitySeedId: null,
      personalitySeedReason: "",
      seedsCreated: 0,
      seedsReinforced: 0,
      seedsSkipped: 0,
      batchesRun: 0,
      hasMore: false,
    };
  });
  const previous = process.env.LINGSHU_DIGEST_DELAY_MS;
  process.env.LINGSHU_DIGEST_DELAY_MS = "40";
  try {
    scheduler.noteTurnComplete(threadId);
    assert.equal(scheduler.digestSchedulerState().pending, 1);
    // New user message (chatStreamService calls this at request start) cancels
    // the pending idle digest.
    scheduler.cancelPendingDigest(threadId);
    assert.equal(scheduler.digestSchedulerState().pending, 0);
    scheduler.noteTurnComplete(threadId);
    assert.equal(scheduler.digestSchedulerState().pending, 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    scheduler.noteTurnComplete(threadId); // new user turn restarts the window
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runs.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runs.length, 1);

    beginVoiceCall("voice-test-connection", agentId);
    scheduler.noteTurnComplete(threadId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(runs.length, 1);
    const events = listBackgroundTaskEvents({ eventType: "digest", subjectId: String(agentId), limit: 20 });
    assert.ok(events.some((event) => event.status === "skipped" && event.detail === "voice_call_active"));
    endVoiceCall("voice-test-connection");
  } finally {
    if (previous === undefined) delete process.env.LINGSHU_DIGEST_DELAY_MS;
    else process.env.LINGSHU_DIGEST_DELAY_MS = previous;
    scheduler.shutdownDigestScheduler();
  }
});
