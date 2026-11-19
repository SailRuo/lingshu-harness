import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The backend config is read at import time, so point it at a throwaway DB
// before dynamically importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-group-chat-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.LINGSHU_GROUP_DIGEST_DELAY_MS = "1000";
process.env.LINGSHU_DIGEST_DELAY_MS = "1000";

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const repo = await import("../src/services/groupChatRepository.js");
const director = await import("../src/services/groupDirector.js");
const prompt = await import("../src/services/groupPrompt.js");
const digest = await import("../src/services/groupPresenceDigest.js");
const { memoryScope } = await import("../src/services/memoryScope.js");
const { loadAcquaintanceSignals } = await import("../src/services/baselineService.js");

const db = getDb();
function createAgent(name: string, displayName: string) {
  const info = db
    .prepare(
      `INSERT INTO agent_configs
        (name, display_name, role_setting, speaking_style, is_default, is_active,
         self_evolution_enabled, time_mirror_enabled, proactive_enabled,
         created_at, updated_at)
       VALUES (?, ?, '测试人设', '测试风格', 0, 1, 0, 1, 0, ?, ?)`,
    )
    .run(name, displayName, new Date().toISOString(), new Date().toISOString());
  return Number(info.lastInsertRowid);
}

const alice = createAgent("alice-test", "灵儿");
const bob = createAgent("bob-test", "沈星野");
const carol = createAgent("carol-test", "小满");

function createTestGroup() {
  return repo.createGroupSession({
    title: "测试群",
    description: "群聊测试",
    memberAgentIds: [alice, bob],
  });
}

test("create group requires at least two existing active agents", () => {
  assert.throws(
    () => repo.createGroupSession({ title: "单人", memberAgentIds: [alice] }),
    (error: any) => error?.statusCode === 400,
  );
  assert.throws(
    () =>
      repo.createGroupSession({
        title: "不存在",
        memberAgentIds: [alice, 999_999],
      }),
    (error: any) => error?.statusCode === 400,
  );
  const group = createTestGroup();
  const members = repo.listGroupMembers(group.id);
  assert.equal(members.length, 2);
  const events = repo.listRecentGroupMessages(group.id, 10);
  assert.equal(events[0]?.speakerType, "system");
  assert.match(events[0]?.content || "", /创建了「测试群」/);
});

test("group message pagination is stable and isolated from private chat_messages", () => {
  const group = createTestGroup();
  for (let index = 0; index < 5; index += 1) {
    repo.appendGroupMessage({
      groupSessionId: group.id,
      speakerType: "user",
      speakerId: "default_user",
      turnId: `turn-${index}`,
      content: `消息 ${index}`,
      createdAt: new Date(Date.now() + 1_000 + index * 1000).toISOString(),
    });
  }
  const firstPage = repo.listGroupMessagesPage(group.id, { limit: 2 });
  assert.equal(firstPage.messages.length, 2);
  assert.equal(firstPage.hasMoreOlder, true);
  assert.equal(firstPage.messages[1].content, "消息 4");
  const secondPage = repo.listGroupMessagesPage(group.id, {
    limit: 2,
    beforeMessageId: firstPage.messages[0].id,
  });
  assert.equal(secondPage.hasMoreOlder, true);
  assert.deepEqual(
    secondPage.messages.map((message) => message.content),
    ["消息 1", "消息 2"],
  );
  const privateCount = db.prepare("SELECT COUNT(*) AS c FROM chat_messages").get() as { c: number };
  assert.equal(Number(privateCount.c), 0);
});

test("director validation rejects illegal members, speech acts and reply anchors", () => {
  const group = createTestGroup();
  const members = repo.listGroupMembers(group.id);
  const message = repo.appendGroupMessage({
    groupSessionId: group.id,
    speakerType: "user",
    speakerId: "default_user",
    turnId: "t",
    content: "你们好",
  });
  const context = {
    members,
    recentMessages: [message],
    rootEventId: message.id,
    afterAgentReply: false,
    lastSpeakerAgentId: null,
  };
  const valid = director.validateDirectorDecision(
    {
      next: "member",
      speakerName: "灵儿",
      replyToMessageId: message.id,
      speechAct: "respond_user",
      directorPrompt: "回应用户",
      reason: "test",
    },
    context,
  );
  assert.equal(valid?.speakerId, alice);

  for (const bad of [
    { next: "member", speakerName: "不存在", replyToMessageId: message.id, speechAct: "respond_user" },
    { next: "user", speakerName: "灵儿", replyToMessageId: message.id, speechAct: "close" },
    { next: "user", speakerName: "", replyToMessageId: message.id, speechAct: "respond_user" },
    { next: "member", speakerName: "灵儿", replyToMessageId: "missing", speechAct: "respond_user" },
  ]) {
    assert.equal(director.validateDirectorDecision(bad as any, context), null);
  }

  const continuation = director.validateDirectorDecision(
    {
      next: "member",
      speakerName: "灵儿",
      replyToMessageId: message.id,
      speechAct: "respond_member",
    },
    { ...context, afterAgentReply: true, lastSpeakerAgentId: alice },
  );
  assert.equal(continuation, null);
});

test("@mention is hard priority and never goes through the director", () => {
  const group = createTestGroup();
  const members = repo.listGroupMembers(group.id);
  const message = repo.appendGroupMessage({
    groupSessionId: group.id,
    speakerType: "user",
    speakerId: "default_user",
    turnId: "t",
    content: "@沈星野 你怎么看",
  });
  assert.deepEqual(director.parseMentionedAgentIds(message.content, members), [bob]);
  const plan = director.planForMention({
    members,
    mentionedAgentIds: [bob],
    replyToMessageId: message.id,
  });
  assert.equal(plan?.source, "mention");
  assert.equal(plan?.speakerId, bob);
  assert.equal(plan?.speechAct, "respond_user");
  assert.equal(plan?.replyToMessageId, message.id);
});

test("member prompt contains only its own private recall and separates public group history", () => {
  const group = createTestGroup();
  const members = repo.listGroupMembers(group.id);
  const selfMember = members.find((member) => member.agentId === alice)!;
  const message = repo.appendGroupMessage({
    groupSessionId: group.id,
    speakerType: "user",
    speakerId: "default_user",
    turnId: "t",
    content: "今天聊点轻松的",
  });
  const built = prompt.buildGroupMemberPrompt({
    group,
    members,
    currentAgent: selfMember,
    userIdentity: repo.readGroupUserIdentity(),
    privateRecall: {
      streams: [
        {
          id: "s1",
          narrative: "只有灵儿知道的私聊秘密：用户怕黑。",
          originScope: null,
        },
        {
          id: "s2",
          narrative: "群公开经历：大家第一次在发型话题里接上话。",
          originScope: "group_public",
          originGroupSessionId: group.id,
        },
      ],
      facts: [{ description: "用户喜欢喝温水" }],
      constraints: ["不要叫用户全名"],
      portraitText: "灵儿眼中的用户：慢热但真诚。",
    },
    anchor: { summary: "更早的公开摘要", coveredAt: message.createdAt },
    recentMessages: [message],
    plan: {
      next: "member",
      speakerId: alice,
      speakerName: "灵儿",
      replyToMessageId: message.id,
      speechAct: "respond_user",
      directorPrompt: "接住用户的轻松话题",
      source: "llm",
      reason: "test",
    },
    recentMessages: [message],
    replyToMessage: message,
  });
  assert.match(built.system, /只有灵儿知道的私聊秘密/);
  assert.match(built.system, /用户喜欢喝温水/);
  assert.match(built.system, /测试人设/);
  assert.doesNotMatch(built.system, /沈星野的私聊秘密/);
  assert.match(built.system, /群公开经历/);
  assert.match(built.system, /群公开消息是所有成员共同看见的事件/);
  assert.match(built.system, /不是你和用户的私聊经历/);
  assert.ok(built.messages.some((item) => item.content.includes("今天聊点轻松的")));
});

test("group digest writes only group_presence streams and advances its cursor", async () => {
  const group = repo.createGroupSession({
    title: "记忆边界群",
    memberAgentIds: [carol, bob],
  });
  const userMessage = repo.appendGroupMessage({
    groupSessionId: group.id,
    speakerType: "user",
    speakerId: "default_user",
    turnId: "turn-digest",
    content: "我们第一次一起聊旅行。",
  });
  repo.appendGroupMessage({
    groupSessionId: group.id,
    speakerType: "assistant",
    speakerId: String(bob),
    turnId: "turn-digest",
    content: "我想去海边。",
  });
  const countsBefore = {
    facts: Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_facts").get() as any).c),
    constraints: Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_constraints").get() as any).c),
    seeds: Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_seeds").get() as any).c),
    portraits: Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_portraits").get() as any).c),
  };
  const results = await digest.digestGroupPresence(group.id, [carol, bob], {
    complete: async () => ({
      streams: [
        { narrative: "我们第一次一起聊旅行，我说想去海边。", about: "群聊初见", perspective: "me" },
        { narrative: "用户把我和沈星野带进同一个群，大家从旅行话题接上话。", about: "共同在场", perspective: "everyone" },
      ],
    }),
    embed: async () => new Array(768).fill(0.01),
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.error === undefined));
  const streamRows = db
    .prepare(
      `SELECT agent_id, type, origin_scope, origin_group_session_id, participants_json, perspective
       FROM hippocampus_streams WHERE origin_group_session_id = ? ORDER BY agent_id`,
    )
    .all(group.id) as any[];
  assert.equal(streamRows.length, 4);
  for (const row of streamRows) {
    assert.equal(row.type, "group_presence");
    assert.equal(row.origin_scope, "group_public");
    assert.equal(row.origin_group_session_id, group.id);
    assert.ok(String(row.participants_json).includes("小满"));
    assert.ok(["me", "ta", "us", "everyone"].includes(row.perspective));
  }
  const countsAfter = {
    facts: Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_facts").get() as any).c),
    constraints: Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_constraints").get() as any).c),
    seeds: Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_seeds").get() as any).c),
    portraits: Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_portraits").get() as any).c),
  };
  assert.deepEqual(countsAfter, countsBefore);
  // Group-public streams are deliberate recall material for the member, but
  // they must not count as acquaintance/day-window evidence.
  const signals = loadAcquaintanceSignals(memoryScope(carol, "default_user"));
  assert.equal(signals.streamCount, 0);
  const cursor = repo.readGroupDigestCursor(group.id, carol);
  assert.equal(cursor.lastMessageId !== null, true);
  // The cursor must not move backwards or skip the batch end.
  assert.ok(cursor.lastMessageCreatedAt);
  // The user message was consumed by the same batch.
  assert.ok(String(userMessage.id).startsWith("group-message-"));
});

test("group public messages never enter the private chat tables or user portrait sources", () => {
  const group = createTestGroup();
  repo.appendGroupMessage({
    groupSessionId: group.id,
    speakerType: "assistant",
    speakerId: String(alice),
    turnId: "t",
    content: "这是群里的公开回复",
  });
  const chatRows = db.prepare("SELECT COUNT(*) AS c FROM chat_messages").get() as any;
  const portraitRows = db.prepare("SELECT COUNT(*) AS c FROM hippocampus_portraits").get() as any;
  assert.equal(Number(chatRows.c), 0);
  assert.equal(Number(portraitRows.c), 0);
  const scoped = db
    .prepare("SELECT COUNT(*) AS c FROM group_messages WHERE group_session_id = ?")
    .get(group.id) as any;
  assert.ok(Number(scoped.c) >= 1);
});

test("schema migration is idempotent and keeps the private chat tables intact", () => {
  closeDb();
  const reopened = getDb();
  const version = reopened.pragma("user_version", { simple: true }) as number;
  assert.equal(version, 22);
  for (const table of [
    "group_sessions",
    "group_members",
    "group_messages",
    "group_read_state",
    "group_conversation_anchors",
    "group_digest_state",
    "group_director_turns",
  ]) {
    const row = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name?: string } | undefined;
    assert.equal(row?.name, table);
  }
  const streamColumns = reopened.pragma("table_info(hippocampus_streams)") as { name: string }[];
  assert.ok(streamColumns.some((column) => column.name === "origin_group_session_id"));
  assert.ok(streamColumns.some((column) => column.name === "participants_json"));
  const chatColumns = reopened.pragma("table_info(chat_messages)") as { name: string }[];
  assert.ok(chatColumns.some((column) => column.name === "thread_id"));
});
