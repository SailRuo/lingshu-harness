/**
 * Skill discovery/binding smoke test.
 *
 * Run against an isolated fixture so it never touches the real database:
 *   LINGSHU_SKILLS_DIR=/tmp/lingshu-skill-test/skills \
 *   LINGSHU_DATA_DIR=/tmp/lingshu-skill-test/data \
 *   DB_PATH=/tmp/lingshu-skill-test/lingshu.db \
 *   npx tsx scripts/smoke-skills.ts
 */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { getDb } from "../src/db/sqlite.js";
import { registerSkillRoutes } from "../src/routes/skills.js";
import { ensureThread } from "../src/services/chatThreadService.js";
import {
  activeSkillMetadata,
  bindSkillToThread,
  buildBoundSkillsPrompt,
  getBoundSkillRecords,
  unbindSkillFromThread,
} from "../src/services/skillBindingService.js";
import { getSkill, listSkills, refreshSkills } from "../src/services/skillService.js";
import { executeNativeTool, listNativeToolDefinitions, isNativeToolEnabled } from "../src/tools/nativeTools.js";

getDb();
const skills = refreshSkills();
const demoSkill = skills.find((skill) => skill.name === "demo-skill");
assert.ok(demoSkill, "expected demo-skill to be discovered");
assert.equal(demoSkill.version, "1.0.0");
assert.deepEqual(demoSkill.tools, ["get_weather", "skills_list"]);
assert.deepEqual(Object.keys(demoSkill.scripts), ["run.js"]);
assert.match(demoSkill.body, /技能已生效/);

const definitions = listNativeToolDefinitions();
for (const name of ["skills_list", "skills_activate", "skills_deactivate", "skills_active"]) {
  assert.ok(definitions.some((tool) => tool.name === name), `missing ${name}`);
  assert.equal(isNativeToolEnabled(name), true, `${name} should be always enabled`);
}

const thread = ensureThread("default_user", 1);
const bound = bindSkillToThread(thread.id, "demo-skill", "manual");
assert.equal(bound.ok, true);
assert.deepEqual(bound.activeSkills, ["demo-skill"]);

const prompt = buildBoundSkillsPrompt(thread.id);
assert.match(prompt, /# 已激活的技能/);
assert.match(prompt, /Demo Skill/);
assert.match(prompt, /技能已生效/);

const metadata = activeSkillMetadata(thread.id);
assert.deepEqual(metadata.active_skills, ["demo-skill"]);
assert.equal(metadata.loaded_skills[0].name, "demo-skill");

const records = getBoundSkillRecords(thread.id);
assert.equal(records.length, 1);
assert.equal(records[0].state, "bound");

(async () => {
  const listResult = await executeNativeTool("skills_list", {}, { sessionId: thread.id });
  assert.equal(listResult.status, "success");
  assert.match(listResult.preview, /demo-skill/);

  const activeResult = await executeNativeTool("skills_active", {}, { sessionId: thread.id });
  assert.equal(activeResult.status, "success");
  assert.match(activeResult.preview, /demo-skill/);

  const unbind = await executeNativeTool(
    "skills_deactivate",
    { name: "demo-skill" },
    { sessionId: thread.id },
  );
  assert.equal(unbind.status, "success");
  assert.deepEqual(activeSkillMetadata(thread.id).active_skills, []);

  const rebind = bindSkillToThread(thread.id, "demo-skill", "request");
  assert.equal(rebind.ok, true);
  const unbound = unbindSkillFromThread(thread.id, "demo-skill");
  assert.equal(unbound.ok, true);

  assert.equal(getSkill("missing-skill"), null);

  const app = Fastify();
  await registerSkillRoutes(app);

  const listResponse = await app.inject({ method: "GET", url: "/api/v1/skills" });
  assert.equal(listResponse.statusCode, 200);
  const listed = listResponse.json() as any[];
  const listedDemo = listed.find((skill) => skill.name === "demo-skill");
  assert.ok(listedDemo, "expected demo-skill in skill list");
  assert.deepEqual(listedDemo.scripts, ["run.js"]);

  const detailResponse = await app.inject({ method: "GET", url: "/api/v1/skills/demo-skill" });
  assert.equal(detailResponse.statusCode, 200);
  assert.match((detailResponse.json() as any).body, /Demo Skill/);

  const activateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/skills/demo-skill/activate",
    payload: { threadId: thread.id },
  });
  assert.equal(activateResponse.statusCode, 200);
  assert.deepEqual((activateResponse.json() as any).active_skills, ["demo-skill"]);

  const activeResponse = await app.inject({
    method: "GET",
    url: `/api/v1/skills/active?threadId=${thread.id}`,
  });
  assert.equal(activeResponse.statusCode, 200);
  assert.deepEqual((activeResponse.json() as any).active_skills, ["demo-skill"]);

  const deactivateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/skills/demo-skill/deactivate",
    payload: { threadId: thread.id },
  });
  assert.equal(deactivateResponse.statusCode, 200);
  assert.deepEqual((deactivateResponse.json() as any).active_skills, []);

  const refreshResponse = await app.inject({ method: "POST", url: "/api/v1/skills/refresh" });
  assert.equal(refreshResponse.statusCode, 200);
  assert.ok((refreshResponse.json() as any).count >= 1);

  await app.close();
  console.log("skill smoke test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
