/**
 * Memory prompt / proactive smoke test.
 *
 * Run against an isolated fixture so it never touches the real database:
 *   LINGSHU_DATA_DIR=/tmp/lingshu-memory-test \
 *   DB_PATH=/tmp/lingshu-memory-test/lingshu.db \
 *   npx tsx scripts/smoke-memory.ts
 */
import { getDb } from "../src/db/sqlite.js";
import { memoryScope } from "../src/services/memoryService.js";
import { collectPromptData, composeSystemPrompt } from "../src/services/memoryPromptBlocks.js";
import { proactiveTick } from "../src/services/proactiveService.js";

getDb();
const scope = memoryScope(1, "default_user");
const data = collectPromptData({
  scope,
  streams: [],
  selfState: null,
  lastSeenAt: null,
  now: new Date(),
});
const prompt = composeSystemPrompt({
  agentName: "灵",
  roleIdentity: "测试角色",
  ...data,
  innerRippleLines: [],
  speakingStyleLines: [],
  guestBlock: "",
  skillBlock: "",
  scene: { voiceCall: false },
  toolHint: "工具提示",
});
if (!prompt.includes("# 底线") || !prompt.includes("# 表达方式") || !prompt.includes("当前时间：")) {
  throw new Error("prompt blocks missing");
}
const result = await proactiveTick();
console.log("prompt chars", prompt.length, "proactive", JSON.stringify(result).slice(0, 300));
console.log("smoke-memory passed");
