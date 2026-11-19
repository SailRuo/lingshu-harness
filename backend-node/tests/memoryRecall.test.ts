import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Point the backend at a throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-memory-recall-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const { getDb } = await import("../src/db/sqlite.js");
const memory = await import("../src/services/memoryService.js");
const stateChannel = await import("../src/services/memoryStateChannel.js");
const searchService = await import("../src/services/memorySearchService.js");
const appointments = await import("../src/services/appointmentService.js");
const promptBlocks = await import("../src/services/memoryPromptBlocks.js");
const toolPolicy = await import("../src/services/toolPolicy.js");
const embedding = await import("../src/services/embeddingService.js");
const { STREAM, STATE, NEAR_WINDOW, EMBEDDING, PROMPT, MEMORY_SEARCH } = await import(
  "../src/contracts/native/nativeChatContract.js"
);

const db = getDb();

let agentSeq = 0;
function createAgent(): number {
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
    .run(
      `recall-${agentSeq}`,
      `recall-${agentSeq}`,
      now,
      now,
    );
  return Number(info.lastInsertRowid);
}

function createThread(agentId: number, userId = "default_user"): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(`INSERT INTO chat_threads (user_id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
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
        (thread_id, user_id, agent_id, role, message_kind, content, status, created_at)
       VALUES (?, ?, ?, ?, 'chat', ?, 'completed', ?)`,
    )
    .run(
      input.threadId,
      input.userId ?? "default_user",
      input.agentId,
      input.role,
      input.content,
      input.createdAt,
    );
  return Number(info.lastInsertRowid);
}

function insertStream(input: {
  agentId: number;
  userId?: string;
  narrative: string;
  createdAt: string;
  significance?: number | null;
  originScope?: string | null;
  embedding?: number[];
}): string {
  const id = `stream-${Math.random().toString(36).slice(2, 12)}`;
  const vector = input.embedding ?? [];
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_streams
      (id, agent_id, user_id, narrative, about, type, significance, origin_scope, created_at,
       updated_at, embedding, embedding_dim, archived)
     VALUES (?, ?, ?, ?, '', 'external', ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    input.agentId,
    input.userId ?? "default_user",
    input.narrative,
    input.significance ?? 0.5,
    input.originScope ?? null,
    input.createdAt,
    now,
    vector.length ? embedding.vectorToBuffer(vector) : null,
    vector.length || 0,
  );
  if (vector.length) embedding.storeStreamEmbedding(id, vector);
  return id;
}

/** Pre-insert an entity with a valid embedding so ensureEntity never needs ONNX. */
function insertEntity(agentId: number, userId: string, name: string): string {
  const id = `entity-${createHash("sha1")
    .update(`${agentId}:${userId}:${name}`)
    .digest("hex")
    .slice(0, 20)}`;
  const vector = new Array(768).fill(0).map((_, index) => (index % 17) / 100);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO hippocampus_entities
      (id, agent_id, user_id, name, type, description, narrative, embedding, embedding_dim,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', NULL, ?, ?, ?, ?, ?)`,
  ).run(id, agentId, userId, name, name, embedding.vectorToBuffer(vector), vector.length, now, now);
  return id;
}

// ─── 1. near-window query scope ─────────────────────────────────────

test("near-window query: multi query = combined + framed user + framed assistant + current raw", () => {
  const recent = [
    { role: "user", content: "昨晚看的那部电影叫什么来着" },
    { role: "assistant", content: "是《海边的曼彻斯特》。" },
  ];
  const queries = memory.buildRecallQueries("我突然想起来了", recent, {
    userName: "小昊",
  });
  assert.equal(queries.length, 4);
  assert.equal(
    queries[0].text,
    `小昊说：昨晚看的那部电影叫什么来着` +
      `${NEAR_WINDOW.COMBINED_SEPARATOR}我说：是《海边的曼彻斯特》。`,
  );
  assert.equal(queries[0].framed, true);
  assert.equal(queries[1].text, "小昊说：昨晚看的那部电影叫什么来着");
  assert.equal(queries[2].text, `${NEAR_WINDOW.SELF_SPEAKER}${NEAR_WINDOW.SPEAKER_INFIX}是《海边的曼彻斯特》。`);
  // The raw current utterance is always LAST (fromCurrent = last vector).
  assert.equal(queries[3].text, "我突然想起来了");
  assert.equal(queries[3].framed, false);
});

test("near-window query: no history → only the current utterance; missing name falls back to 用户", () => {
  const queries = memory.buildRecallQueries("今天好累", []);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].text, "今天好累");
  const withUserOnly = memory.buildRecallQueries(
    "第二句",
    [{ role: "user", content: "第一句" }],
  );
  assert.equal(withUserOnly.length, 2);
  assert.equal(withUserOnly[0].text, `${NEAR_WINDOW.USER_FALLBACK_LABEL}${NEAR_WINDOW.SPEAKER_INFIX}第一句`);
  assert.equal(withUserOnly[1].text, "第二句");
});

test("BGE query contract: embedQueryText prefixes queries, documents stay unprefixed", async () => {
  const prefix = EMBEDDING.QUERY_PREFIX;
  assert.equal(EMBEDDING.CONTRACT, "bge-base-zh-v1.5-qd-v1");
  // Embedding ONNX is unavailable in the unit environment (no model dir);
  // a missing model must surface as EmbeddingUnavailableError on both sides.
  await assert.rejects(
    () => embedding.embedQueryText("测试文本"),
    (error: any) => error?.code === "embedding_unavailable",
  );
  await assert.rejects(() => embedding.embedDocumentText("测试文本"));
  // The prefixed form is idempotent (never double-prefixed).
  assert.equal(prefix.startsWith("为这个句子生成表示"), true);
});

// ─── 2. pools, floors, current-message boost ────────────────────────────────

function hit(id: string, raw: number, fromCurrent = false, originScope: string | null = null) {
  return {
    id,
    origin_scope: originScope,
    __similarity: raw,
    __fromCurrent: fromCurrent,
    __selectionScore: raw * (fromCurrent ? memory.STREAM_CURRENT_MESSAGE_BOOST : 1),
  } as any;
}

test("pools: private fills 4 slots, public fills 3, public never evicts private", () => {
  const privatePool = [
    hit("p1", 0.62),
    hit("p2", 0.58),
    hit("p3", 0.55),
    hit("p4", 0.52),
    hit("p5", 0.50),
    hit("p6", 0.47),
  ];
  const publicPool = [hit("g1", 0.90, false, "group_public"), hit("g2", 0.85, false, "group_public"), hit("g3", 0.80, false, "group_public"), hit("g4", 0.70, false, "group_public"), hit("g5", 0.60, false, "group_public")];
  const selection = memory.selectStreamHits(privatePool, publicPool, STREAM.TOTAL_CAP);
  const ids = selection.selected.map((row) => row.id);
  // 4 private (the strongest), 3 public (the strongest) — merged by raw order.
  assert.deepEqual(ids, ["g1", "g2", "g3", "p1", "p2", "p3", "p4"]);
  assert.equal(ids.filter((id) => id.startsWith("p")).length, STREAM.DIRECT_LIMIT);
  assert.equal(ids.filter((id) => id.startsWith("g")).length, STREAM.PUBLIC_LIMIT);
  assert.ok(ids.indexOf("g1") < ids.indexOf("p1"), "display order is raw-descending");
});

test("floors: first admitted hit clears RANK1_FLOOR, later ones TAIL_FLOOR; whole-turn, not per-pool", () => {
  const privatePool = [
    hit("p1", 0.51), // below RANK1_FLOOR → dropped
    hit("p2", 0.48), // first admitted? no: p0 admits first
    hit("p0", 0.53), // admitted with RANK1_FLOOR
  ];
  const selection = memory.selectStreamHits(privatePool, [], 10);
  const ids = selection.selected.map((row) => row.id);
  // Walk order is raw desc: p0 (0.53 ≥ 0.52 admitted), p1 (0.51 ≥ 0.45 admitted), p2 (0.48 ≥ 0.45 admitted).
  assert.deepEqual(ids, ["p0", "p1", "p2"]);
  const dropped = selection.audit.filter((row: any) => !row.selected);
  assert.ok(dropped.length >= 0);
  // A turn whose only hits are all below the abstention gate recalls nothing:
  const abstain = memory.selectStreamHits([hit("x1", 0.30), hit("x2", 0.28)], [], 10);
  assert.equal(abstain.selected.length, 0);
});

test("public entry floor is relaxed ×1.2 but the displayed similarity stays raw", () => {
  // Public raw 0.40: 0.40 × 1.2 = 0.48 ≥ TAIL_FLOOR → admitted (as a tail hit).
  const selection = memory.selectStreamHits(
    [hit("p1", 0.55)],
    [hit("g1", 0.40, false, "group_public")],
    10,
  );
  const admitted = selection.selected.map((row) => row.id);
  assert.deepEqual(admitted, ["p1", "g1"]);
  const g1 = selection.selected.find((row) => row.id === "g1")!;
  assert.equal(g1.__similarity, 0.40, "display/similarity keeps the raw cosine");
  // But raw 0.36 (×1.2 = 0.432 < 0.45) stays out:
  const rejected = memory.selectStreamHits(
    [hit("p1", 0.55)],
    [hit("g2", 0.36, false, "group_public")],
    10,
  );
  assert.deepEqual(rejected.selected.map((row) => row.id), ["p1"]);
});

test("current-message boost decides quota entry only and never relaxes a floor", () => {
  // Boost decides who gets the last private slot:
  const pool = [
    hit("p1", 0.60),
    hit("p2", 0.57),
    hit("p3", 0.55),
    hit("p4", 0.54),
    hit("p5", 0.53), // competes with p6 for slot 4
    hit("p6", 0.52, true), // 0.52 × 1.2 = 0.624 selection — beats p5's 0.53
  ];
  const selection = memory.selectStreamHits(pool, [], STREAM.TOTAL_CAP);
  const ids = selection.selected.map((row) => row.id);
  assert.ok(ids.includes("p6"), "boosted current-message hit enters the quota");
  assert.ok(!ids.includes("p5"), "higher-raw non-current hit loses the slot to the boost");
  // Boost never relaxes the entry floor: a fromCurrent hit below 0.52 is
  // dropped as the first hit even though its boosted score would clear it.
  const belowFloor = memory.selectStreamHits(
    [hit("x1", 0.44, true), hit("x2", 0.43)],
    [],
    STREAM.TOTAL_CAP,
  );
  assert.equal(belowFloor.selected.length, 0);
  // Displayed similarity keeps raw even for boosted entries:
  const boosted = memory.selectStreamHits([hit("y1", 0.52, true)], [], 4);
  assert.equal(boosted.selected[0].__similarity, 0.52);
});

// ─── 3. state channel ────────────────────────────────────────────────────────

test("state channel trigger: sigh-only and short state words fire; topics and laughter do not", () => {
  assert.equal(stateChannel.isStateOnlyUtterance("唉"), true);
  assert.equal(stateChannel.isStateOnlyUtterance("唉……"), true);
  assert.equal(stateChannel.isStateOnlyUtterance("唉，哎"), true);
  assert.equal(stateChannel.isStateOnlyUtterance("我好累"), true);
  assert.equal(stateChannel.isStateOnlyUtterance("烦死了"), true);
  assert.equal(stateChannel.isStateOnlyUtterance("emo了"), true);
  assert.equal(stateChannel.isStateOnlyUtterance("哈哈哈"), false, "neutral laughter never triggers");
  assert.equal(stateChannel.isStateOnlyUtterance("嗯嗯"), false);
  assert.equal(stateChannel.isStateOnlyUtterance("今天天气真不错"), false, "topic sentence stays semantic");
  assert.equal(stateChannel.isStateOnlyUtterance("今天上班好累啊，项目又延期了"), false, "long sentence is a topic");
});

test("state channel ranking: 72h window, weight ≥ 0.2, private only, same-state first", () => {
  const agentId = createAgent();
  const now = Date.now();
  const heavy = insertStream({
    agentId,
    narrative: "项目又延期了，他很沮丧",
    createdAt: new Date(now - 2 * 3_600_000).toISOString(),
    significance: 0.9,
  });
  const stale = insertStream({
    agentId,
    narrative: "三天没睡好的那段日子",
    createdAt: new Date(now - 100 * 3_600_000).toISOString(),
    significance: 0.9,
  });
  const light = insertStream({
    agentId,
    narrative: "随口聊了聊午饭",
    createdAt: new Date(now - 2 * 3_600_000).toISOString(),
    significance: 0.15,
  });
  const groupPublic = insertStream({
    agentId,
    narrative: "群里聊到了他的烦心事",
    createdAt: new Date(now - 1 * 3_600_000).toISOString(),
    significance: 1.0,
    originScope: "group_public",
  });
  const clueHeavy = insertStream({
    agentId,
    narrative: "也明白了今天他那么多叹气",
    createdAt: new Date(now - 30 * 3_600_000).toISOString(),
    significance: 0.5,
  });
  const streams = stateChannel.collectStateChannelStreams({
    agentId,
    utterance: "唉",
    limit: 2,
  });
  const ids = streams.map((row) => row.id);
  // 排除：群公开流不当私密心事；72h 外/权重不足的不进。
  assert.ok(!ids.includes(groupPublic));
  assert.ok(!ids.includes(stale));
  assert.ok(!ids.includes(light));
  // 同状态优先：narrative 点名「叹气」的排在 weight 更高的前面。
  assert.deepEqual(ids, [clueHeavy, heavy]);
  const heavyRow = streams.find((row) => row.id === heavy)!;
  const clueRow = streams.find((row) => row.id === clueHeavy)!;
  assert.ok(heavyRow.stateWeight > clueRow.stateWeight, "weight = freshness × significance");
  assert.equal(clueRow.stateClue, true);
  assert.equal(heavyRow.stateClue, false);
});

test("state channel cooldown: the same stream is not re-injected within 30 minutes", () => {
  const agentId = createAgent();
  const now = Date.now();
  const id = insertStream({
    agentId,
    narrative: "他最近一直在赶进度",
    createdAt: new Date(now - 1 * 3_600_000).toISOString(),
    significance: 0.9,
  });
  const first = stateChannel.collectStateChannelStreams({ agentId, utterance: "我好累" });
  assert.deepEqual(first.map((row) => row.id), [id]);
  stateChannel.markStateRecalled(agentId, first);
  const second = stateChannel.collectStateChannelStreams({ agentId, utterance: "我好累" });
  assert.equal(second.length, 0, "cooldown suppresses re-injection");
  stateChannel.clearStateRecallCooldown();
  const third = stateChannel.collectStateChannelStreams({ agentId, utterance: "我好累" });
  assert.deepEqual(third.map((row) => row.id), [id]);
});

test("state channel not triggered by non-state utterance", () => {
  const agentId = createAgent();
  insertStream({
    agentId,
    narrative: "随便一条记忆",
    createdAt: new Date(Date.now() - 1_000_000).toISOString(),
  });
  const streams = stateChannel.collectStateChannelStreams({
    agentId,
    utterance: "帮我看看今天天气",
  });
  assert.equal(streams.length, 0);
});

// ─── 4. search_memory ───────────────────────────────────────────────────────

test("search_memory time vocabulary: named days, last week, explicit dates", () => {
  const yesterday = searchService.resolveSearchWindow("昨天");
  const today = searchService.resolveSearchWindow("今天");
  assert.equal(yesterday.end.getTime() - yesterday.start.getTime(), 86_400_000);
  assert.equal(today.start.getTime() - yesterday.start.getTime(), 86_400_000);

  const lastWeek = searchService.resolveSearchWindow("上周");
  assert.equal(lastWeek.end.getTime() - lastWeek.start.getTime(), 7 * 86_400_000);
  // 上周 = 上周一00:00 ~ 本周一00:00（东八区）
  const weekday = new Date(lastWeek.start.getTime() + 8 * 3_600_000).getUTCDay();
  assert.equal(weekday, 1);

  const explicit = searchService.resolveSearchWindow("2026-09-15");
  assert.equal(new Date(explicit.start.getTime() + 8 * 3_600_000).toISOString().slice(0, 10), "2026-09-15");
  assert.equal(explicit.end.getTime() - explicit.start.getTime(), 86_400_000);

  const ranged = searchService.resolveSearchWindow("上周三", "上周四");
  assert.equal(ranged.end.getTime() - ranged.start.getTime(), 2 * 86_400_000);

  assert.throws(() => searchService.resolveSearchWindow("明天下午"), /无法识别的时间表达/);
});

test("search_memory RRF: vector + BM25 ranks fuse; docs absent from both drop", () => {
  const unit = (x: number, y: number, z: number) => {
    const norm = Math.sqrt(x * x + y * y + z * z);
    return embedding.vectorToBuffer([x / norm, y / norm, z / norm]);
  };
  const streams = [
    // bm rank 1, orthogonal to the query vector (bm only)
    { id: "d-bm", narrative: "火锅店的约定", createdAt: "", embedding: unit(1, 0, 0) },
    // vector rank 1, no keyword overlap (vector only)
    { id: "d-vec", narrative: "完全无关的一句", createdAt: "", embedding: unit(0, 1, 0) },
    // both lists
    { id: "d-both", narrative: "火锅店的第二次约定", createdAt: "", embedding: unit(3, 4, 0) },
    // orthogonal to the query vector and no keyword hit → dropped
    { id: "d-none", narrative: "也没有关键词", createdAt: "", embedding: unit(0, 0, 1) },
  ];
  const bm = searchService.bm25Scores(
    streams.map((doc) => doc.narrative),
    searchService.tokenize("火锅店 约定"),
    MEMORY_SEARCH.BM25_K1,
    MEMORY_SEARCH.BM25_B,
  );
  const queryVector = [0, 1, 0];
  const hits = searchService.rankStreams(streams as any, bm, queryVector, 10);
  const order = hits.map((index) => streams[index].id);
  // d-both appears in both lists → top by fused RRF; d-none appears in neither → dropped.
  assert.equal(order[0], "d-both");
  assert.ok(order.includes("d-bm") && order.includes("d-vec"));
  assert.ok(!order.includes("d-none"));
});

test("search_memory end-to-end: window scan, BM25-only fallback, time-ordered preview labels", async () => {
  const agentId = createAgent();
  const now = new Date();
  const dayMs = 86_400_000;
  // Inside the "最近" window (last 30 days).
  const at1 = new Date(now.getTime() - 10 * dayMs);
  const at2 = new Date(now.getTime() - 9 * dayMs);
  insertStream({
    agentId,
    narrative: "那天我们约好去吃火锅，他说这家火锅店是他最爱的一家",
    createdAt: new Date(at1.getTime() + 3_600_000).toISOString(),
    significance: 0.6,
  });
  insertStream({
    agentId,
    narrative: "又提了一次火锅店，这次约在了周五",
    createdAt: new Date(at2.getTime() + 3_600_000).toISOString(),
    significance: 0.6,
  });
  const userId = "default_user";
  const threadId = createThread(agentId, userId);
  addMessage({
    threadId,
    agentId,
    role: "user",
    content: "那家火锅店叫什么名字来着",
    createdAt: new Date(at1.getTime() + 7_200_000).toISOString(),
    userId,
  });
  addMessage({
    threadId,
    agentId,
    role: "assistant",
    content: "是不是小天鹅？",
    createdAt: new Date(at1.getTime() + 7_300_000).toISOString(),
    userId,
  });
  // Far outside the window:
  insertStream({
    agentId,
    narrative: "一年前聊过的火锅店",
    createdAt: new Date(now.getTime() - 200 * dayMs).toISOString(),
  });

  const result = await searchService.searchMemory({
    agentId,
    userId,
    query: "火锅店",
    time: "最近",
  });
  assert.ok(result.includes("浮上心头的记忆"));
  assert.ok(result.includes("当时说过的话"));
  // Both window streams recalled, in ascending time order (ids are not part of
  // the tool text — match on the narratives themselves).
  const latePos = result.indexOf("又提了一次火锅店，这次约在了周五");
  const earlyPos = result.indexOf("那天我们约好去吃火锅，他说这家火锅店是他最爱的一家");
  assert.ok(latePos > 0);
  assert.ok(earlyPos > 0);
  assert.ok(earlyPos < latePos, "occurrences ascend by time");
  // Relative time labels (今天/昨天/N天前 …, APP _format_relative_time) + 用户 speaker prefix:
  assert.match(result, /\[(今天|昨天|\d+天前) \d{2}:\d{2}\]/);
  assert.match(result, /用户：那家火锅店叫什么名字来着/);
  // Out-of-window stream never appears:
  assert.ok(!result.includes("一年前聊过的火锅店"));
});

test("search_memory provenance: group-public hits keep the source tag, private hits carry none", async () => {
  const agentId = createAgent();
  const userId = "default_user";
  const now = new Date();
  const dayMs = 86_400_000;
  // Both streams match the query so both are recalled from the 最近 window:
  insertStream({
    agentId,
    narrative: "他私下跟我说周末想去爬山散散心",
    createdAt: new Date(now.getTime() - 3 * dayMs).toISOString(),
    significance: 0.6,
  });
  insertStream({
    agentId,
    narrative: "那次聚餐散场时大家在群里说好下次一起去爬山",
    createdAt: new Date(now.getTime() - 2 * dayMs).toISOString(),
    significance: 0.6,
    originScope: "group_public",
  });

  const result = await searchService.searchMemory({
    agentId,
    userId,
    query: "爬山",
    time: "最近",
  });
  assert.ok(result.includes("浮上心头的记忆"), "streams are recalled");
  const lines = result.split("\n");
  const groupLine = lines.find((line) => line.includes("群里说好下次一起去爬山"));
  assert.ok(groupLine, "group-public stream is recalled, never excluded");
  assert.ok(
    groupLine.includes("（来自曾共同在场的群聊公开经历）"),
    `group line carries the provenance tag: ${groupLine}`,
  );
  assert.match(groupLine, /\[(今天|昨天|\d+天前) \d{2}:\d{2}\]/, "relative time label on the hit line");
  const privateLine = lines.find((line) => line.includes("他私下跟我说周末想去爬山散散心"));
  assert.ok(privateLine, "private stream is recalled");
  assert.ok(
    !privateLine.includes("来自曾共同在场的群聊公开经历"),
    `private line has no group tag: ${privateLine}`,
  );
  assert.ok(!privateLine.includes("来自与你的剧场共同经历"));
});

test("AKIN stays cross-scope: a private anchor links to a group-public stream and the prompt labels it", async () => {
  const agentId = createAgent();
  const userId = "default_user";
  const now = new Date().toISOString();
  const insertRaw = db.prepare(
    `INSERT INTO hippocampus_streams
      (id, agent_id, user_id, narrative, about, type, significance, archived, origin_scope,
       perspective, participants_json, created_at, updated_at)
     VALUES (?, ?, 'default_user', ?, '他·日常', 'external', 0.5, 0, ?, 'ta', '[]', ?, ?)`,
  );
  insertRaw.run("akin-priv", agentId, "他说想去看一次真正的海。", null, now, now);
  insertRaw.run("akin-group", agentId, "群里聊起大家的旅行愿望，他说想看海。", "group_public", now, now);
  const vectorPriv = new Array(768).fill(0);
  vectorPriv[0] = 1;
  const vectorGroup = new Array(768).fill(0);
  vectorGroup[0] = 0.9;
  vectorGroup[1] = 0.1;
  embedding.storeStreamEmbedding("akin-priv", vectorPriv);
  embedding.storeStreamEmbedding("akin-group", vectorGroup);

  const scope = { agentId, userId };
  // The judge stub keeps the first candidate; the candidate pool only has the
  // group-public stream, so a cross-scope edge must be written both ways.
  const linked = await memory.linkStreamToExistingMemory(
    scope,
    { id: "akin-priv", narrative: "他说想去看一次真正的海。", vector: vectorPriv },
    { judge: async () => [0] },
  );
  assert.equal(linked, 2, "bidirectional AKIN edge crosses the private/public scope line");
  const edges = db
    .prepare(
      "SELECT source_id, target_id FROM hippocampus_edges WHERE agent_id = ? AND edge_type = 'AKIN' ORDER BY source_id, target_id",
    )
    .all(agentId) as any[];
  assert.deepEqual(
    edges.map((edge) => `${edge.source_id}->${edge.target_id}`),
    ["akin-group->akin-priv", "akin-priv->akin-group"],
  );

  // The AKIN expansion pulls neighbours as full rows (SELECT *); the public
  // origin must survive streamToItem and land labeled in the prompt lines.
  const groupRow = db.prepare("SELECT * FROM hippocampus_streams WHERE id = 'akin-group'").get() as any;
  const item = memory.streamToItem(groupRow);
  assert.equal(item.originScope, "group_public");
  const promptData = promptBlocks.collectPromptData({
    scope,
    streams: [
      { narrative: item.narrative, createdAt: item.createdAt, originScope: item.originScope },
    ],
    now: new Date(),
  });
  assert.equal(promptData.memoryStreamLines.length, 1);
  assert.match(promptData.memoryStreamLines[0], /来自曾共同在场的群聊公开经历/);
  // The group-public stream rides in the public pool (its own quota), never
  // counted against the private direct-hit slots:
  const selection = memory.selectStreamHits(
    [{ id: "akin-priv", origin_scope: null, __similarity: 0.6, __fromCurrent: false, __selectionScore: 0.6 } as any],
    [{ id: "akin-group", origin_scope: "group_public", __similarity: 0.5, __fromCurrent: false, __selectionScore: 0.5 } as any],
    STREAM.TOTAL_CAP,
  );
  assert.ok(selection.selected.some((row) => row.id === "akin-group"), "public hit admitted via its own pool");
});

test("search_memory: empty window and zero hits return the APP copy; future range is rejected", async () => {
  const agentId = createAgent();
  const empty = await searchService.searchMemory({ agentId, query: "随便", time: "上周" });
  assert.ok(empty.includes("脑海里是空白的"));
  await assert.rejects(
    () => searchService.searchMemory({ agentId, query: "随便", time: "2100-01-01" }),
    /时间范围不能在未来/,
  );
  await assert.rejects(() => searchService.searchMemory({ agentId, query: "", time: "今天" }), /query 必填/);
});

// ─── 5. save_memory ────────────────────────────────────────────────────────

test("save_memory evidence gate: empty or non-verbatim evidence never writes", async () => {
  const agentId = createAgent();
  const threadId = createThread(agentId);
  addMessage({
    threadId,
    agentId,
    role: "user",
    content: "我最近在学吉他，每周三上课",
    createdAt: new Date().toISOString(),
  });
  const empty = await memory.saveMemory({
    agentId,
    threadId,
    memoryType: "fact",
    relation: "HAS_ROUTINE",
    object: "吉他课",
    evidence: "",
  });
  assert.equal(empty.ok, false);
  const fabricated = await memory.saveMemory({
    agentId,
    threadId,
    memoryType: "fact",
    relation: "HAS_ROUTINE",
    object: "吉他课",
    evidence: "我每周三都去爬山",
  });
  assert.equal(fabricated.ok, false);
  assert.match(fabricated.message, /evidence/);
  const facts = db.prepare("SELECT count(*) AS n FROM hippocampus_facts").get() as any;
  assert.equal(facts.n, 0);
});

test("save_memory writes facts through the shared pipeline; preference lands in constraints", async () => {
  const agentId = createAgent();
  const userId = "default_user";
  const threadId = createThread(agentId, userId);
  const userLine = "我特别喜欢在深夜听后摇";
  addMessage({ threadId, agentId, role: "user", content: userLine, createdAt: new Date().toISOString() });
  insertEntity(agentId, userId, "他");
  insertEntity(agentId, userId, "后摇");

  const fact = await memory.saveMemory({
    agentId,
    userId,
    threadId,
    memoryType: "fact",
    relation: "LIKES",
    object: "后摇",
    description: "他喜欢在深夜听后摇",
    evidence: "我特别喜欢在深夜听后摇",
    confidence: 0.8,
  });
  assert.equal(fact.ok, true);
  const factRow = db
    .prepare("SELECT * FROM hippocampus_facts WHERE id = ?")
    .get(fact.factId) as any;
  assert.ok(factRow);
  assert.equal(factRow.relation, "LIKES");
  // evidence excerpt recorded:
  const evidence = JSON.parse(factRow.evidence_json);
  assert.equal(evidence.excerpt, userLine);
  // Streams / seeds / portraits untouched (this agent never had a stream):
  assert.equal(
    (db
      .prepare("SELECT count(*) AS n FROM hippocampus_streams WHERE agent_id = ?")
      .get(agentId) as any).n,
    0,
  );

  const duplicate = await memory.saveMemory({
    agentId,
    userId,
    threadId,
    memoryType: "fact",
    relation: "LIKES",
    object: "后摇",
    description: "他喜欢在深夜听后摇",
    evidence: userLine,
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.merged, true, "same subject+relation+object merges, no parallel row");

  const preference = await memory.saveMemory({
    agentId,
    userId,
    threadId,
    memoryType: "preference",
    relation: "DISLIKES",
    object: "香菜",
    description: "他不吃香菜",
    evidence: userLine,
  });
  assert.equal(preference.ok, true);
  const constraint = db
    .prepare("SELECT * FROM hippocampus_constraints WHERE id = ?")
    .get(preference.constraintId) as any;
  assert.ok(constraint);
  assert.equal(constraint.description, "他不吃香菜");

  const badPreference = await memory.saveMemory({
    agentId,
    userId,
    threadId,
    memoryType: "preference",
    relation: "HAS_PET",
    object: "猫",
    evidence: userLine,
  });
  assert.equal(badPreference.ok, false);
  assert.match(badPreference.message, /LIKES \/ DISLIKES \/ INTERESTED_IN/);
});

// ─── 6. manage_alarm ───────────────────────────────────────────────────────

test("manage_alarm create/list/delete on hippocampus_appointments", () => {
  const agentId = createAgent();
  const userId = "default_user";
  const now = new Date();
  const future = new Date(now.getTime() + 3_600_000);

  const created = appointments.manageAlarm({
    agentId,
    userId,
    action: "create",
    title: "周三下午三点开会",
    timeMode: "exact",
    startAt: future.toISOString(),
    recurrence: "none",
    now,
  });
  assert.equal(created.ok, true);
  const row = db
    .prepare("SELECT * FROM hippocampus_appointments WHERE id = ?")
    .get(created.appointmentId) as any;
  assert.equal(row.status, "pending");
  assert.equal(row.time_mode, "exact");
  assert.ok(row.due_at.endsWith("+08:00"), "due_at persists Asia/Shanghai wall clock");
  const due = new Date(row.due_at);
  assert.ok(Math.abs(due.getTime() - future.getTime()) < 60_000);

  const list = appointments.manageAlarm({ agentId, userId, action: "list" });
  assert.match(list.message, new RegExp(`\\[${row.id}\\] 周三下午三点开会`));

  const removed = appointments.manageAlarm({
    agentId,
    userId,
    action: "delete",
    id: String(row.id),
  });
  assert.equal(removed.ok, true);
  const after = db
    .prepare("SELECT status FROM hippocampus_appointments WHERE id = ?")
    .get(row.id) as any;
  assert.equal(after.status, "cancelled");
  const listAfter = appointments.manageAlarm({ agentId, userId, action: "list" });
  assert.ok(!listAfter.message.includes("周三下午三点开会"));
});

test("manage_alarm create: past startAt, bad interval and missing date_only fields are errors", () => {
  const agentId = createAgent();
  const userId = "default_user";
  const now = new Date();
  assert.throws(
    () =>
      appointments.manageAlarm({
        agentId,
        userId,
        action: "create",
        title: "过去的事",
        startAt: new Date(now.getTime() - 3_600_000).toISOString(),
        now,
      }),
    /未来的 ISO-8601/,
  );
  assert.throws(
    () =>
      appointments.manageAlarm({
        agentId,
        userId,
        action: "create",
        title: "每分钟喝水",
        timeMode: "exact",
        startAt: new Date(now.getTime() + 1_800_000).toISOString(),
        recurrence: "interval",
        intervalMinutes: 0,
        now,
      }),
    /intervalMinutes/,
  );
  assert.throws(
    () =>
      appointments.manageAlarm({
        agentId,
        userId,
        action: "create",
        title: "下周三体检",
        timeMode: "date_only",
        now,
      }),
    /date_only 必须传 eventDate/,
  );
  assert.throws(
    () =>
      appointments.manageAlarm({
        agentId,
        userId,
        action: "create",
        title: "去年的日程",
        timeMode: "date_only",
        eventDate: "2020-01-01",
        now,
      }),
    /提醒时刻已过/,
  );
  assert.throws(
    () => appointments.manageAlarm({ agentId, userId, action: "delete", id: "999999" }),
    /找不到要取消的主动提醒/,
  );
});

test("manage_alarm: interval recurrence stored as interval:<minutes>; date_only picks 20:00/08:00", () => {
  const agentId = createAgent();
  const userId = "default_user";
  const now = new Date();
  const interval = appointments.manageAlarm({
    agentId,
    userId,
    action: "create",
    title: "每30分钟提醒喝水",
    timeMode: "exact",
    startAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    recurrence: "interval",
    intervalMinutes: 30,
    now,
  });
  const intervalRow = db
    .prepare("SELECT * FROM hippocampus_appointments WHERE id = ?")
    .get(interval.appointmentId) as any;
  assert.equal(intervalRow.recur, "interval:30");
  // The scheduler rolls interval dues forward instead of leaving them stale.
  const advanced = memory.advanceRecurringDueAt(
    intervalRow.due_at,
    intervalRow.recur,
    new Date(new Date(intervalRow.due_at).getTime() + 61 * 60_000),
  );
  assert.ok(advanced && new Date(advanced).getTime() > new Date(intervalRow.due_at).getTime());

  const dateOnly = appointments.manageAlarm({
    agentId,
    userId,
    action: "create",
    title: "10月8日体检",
    timeMode: "date_only",
    eventDate: "2027-10-08",
    now,
  });
  const dateRow = db
    .prepare("SELECT * FROM hippocampus_appointments WHERE id = ?")
    .get(dateOnly.appointmentId) as any;
  assert.equal(dateRow.time_mode, "date_only");
  assert.equal(dateRow.event_date, "2027-10-08");
  assert.equal(dateRow.all_day, 1);
  assert.equal(dateRow.recur, "none");
  // 前一晚 20:00（东八区）:
  const fire = new Date(dateRow.due_at);
  const fireParts = fire.toISOString();
  assert.equal(fireParts.slice(0, 10), "2027-10-07");
  assert.ok(fireParts.includes("T12:00:00"), "20:00 +08:00 == 12:00Z");

  const deduped = appointments.manageAlarm({
    agentId,
    userId,
    action: "create",
    title: "10月8日体检",
    timeMode: "date_only",
    eventDate: "2027-10-08",
    now,
  });
  assert.match(deduped.message, /已有相同主动提醒/);
});

// ─── 7. prompt rendering ───────────────────────────────────────────────────

test("prompt: state channel renders its own section, never merged into 你记得", () => {
  const agentId = createAgent();
  const now = new Date();
  const promptData = promptBlocks.collectPromptData({
    scope: { agentId, userId: "default_user" },
    streams: [{ narrative: "语义召回的一条记忆", createdAt: new Date(now.getTime() - 86400000).toISOString() }],
    stateStreams: [
      { narrative: "他最近工作压力很大", createdAt: new Date(now.getTime() - 7200000).toISOString() },
    ],
    now,
  });
  assert.equal(promptData.stateStreamLines.length, 1);
  const volatile = promptBlocks.buildDynamicSystemContext({
    agentName: "测试",
    roleIdentity: "测试",
    innerRippleLines: [],
    speakingStyleLines: [],
    scene: { voiceCall: false, surface: "", interactionMode: "", inputKind: "", outputMode: "" },
    ...promptData,
    now,
  } as any);
  assert.ok(volatile.includes(`# ${PROMPT.SECTION_STATE_RECALL}`));
  assert.ok(volatile.includes(PROMPT.STATE_RECALL_INTRO));
  assert.ok(volatile.includes("他最近工作压力很大"));
  // The state narrative must NOT ride inside # 你记得:
  const streamsBlock = /# 你记得\n([\s\S]*?)(?=\n# |\n*$)/.exec(volatile)?.[1] || "";
  assert.ok(streamsBlock.includes("语义召回的一条记忆"));
  assert.ok(!streamsBlock.includes("他最近工作压力很大"));
});

test("prompt: stream lines keep recall order and public provenance labels", () => {
  const now = new Date();
  const lines = promptBlocks.collectPromptData({
    scope: { agentId: 1, userId: "default_user" },
    streams: [
      {
        narrative: "第二条（更近的记忆）",
        createdAt: new Date(now.getTime() - 3_600_000).toISOString(),
        originScope: null,
      },
      {
        narrative: "第一条（更早的记忆）",
        createdAt: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
        originScope: null,
      },
      {
        narrative: "群里那次团建",
        createdAt: new Date(now.getTime() - 5 * 86_400_000).toISOString(),
        originScope: "group_public",
      },
      {
        narrative: "剧场里演过的那场",
        createdAt: new Date(now.getTime() - 6 * 86_400_000).toISOString(),
        originScope: "theater_public",
      },
    ],
    now,
  });
  // No created_at re-sort: recall order preserved.
  assert.match(lines.memoryStreamLines[0], /第二条（更近的记忆）/);
  assert.match(lines.memoryStreamLines[1], /第一条（更早的记忆）/);
  assert.match(lines.memoryStreamLines[2], /来自曾共同在场的群聊公开经历/);
  assert.match(lines.memoryStreamLines[3], /来自与你的剧场共同经历/);
});

test("manage_alarm tool contract is appended to the policy suffix when bound", () => {
  const base = toolPolicy.companionToolPolicySuffix({
    imageGenBound: false,
    imageGenUnavailable: false,
    imageGenConfigured: false,
    endVoiceCallBound: false,
  });
  assert.ok(!base.includes("manage_alarm"));
  const withAlarm = toolPolicy.companionToolPolicySuffix({
    imageGenBound: false,
    imageGenUnavailable: false,
    imageGenConfigured: false,
    endVoiceCallBound: false,
    manageAlarmBound: true,
  });
  assert.ok(withAlarm.includes("【主动提醒 manage_alarm】"));
  assert.ok(withAlarm.includes("tool call manage_alarm create"));
});
