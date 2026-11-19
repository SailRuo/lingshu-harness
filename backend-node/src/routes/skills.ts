import type { FastifyInstance } from "fastify";
import { getSkill, listSkills, refreshSkills, type SkillMetadata } from "../services/skillService.js";
import {
  bindSkillToThread,
  clearBoundSkills,
  getActiveSkillNames,
  getBoundSkillRecords,
  unbindSkillFromThread,
} from "../services/skillBindingService.js";

function toSummary(skill: SkillMetadata) {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    source: skill.source,
    path: skill.path,
    tools: skill.tools,
    scripts: Object.keys(skill.scripts),
    references: Object.keys(skill.references),
    assets: Object.keys(skill.assets),
    body_chars: skill.bodyChars,
    updated_at: skill.updatedAt,
  };
}

function parseThreadId(value: unknown): number | null {
  const threadId = Number(value);
  return Number.isInteger(threadId) && threadId > 0 ? threadId : null;
}

export async function registerSkillRoutes(app: FastifyInstance) {
  app.get("/api/v1/skills", async (req) => {
    const query = req.query as Record<string, unknown>;
    const threadId = parseThreadId(query.threadId ?? query.sessionId);
    const active = threadId ? new Set(getActiveSkillNames(threadId)) : null;
    return listSkills().map((skill) => ({
      ...toSummary(skill),
      ...(active ? { active: active.has(skill.name) } : {}),
    }));
  });

  app.get("/api/v1/skills/active", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const threadId = parseThreadId(query.threadId ?? query.sessionId);
    if (!threadId) {
      reply.code(400).send({ detail: "threadId is required" });
      return;
    }
    return {
      threadId,
      active_skills: getActiveSkillNames(threadId),
      thread_skills: getBoundSkillRecords(threadId),
    };
  });

  app.post("/api/v1/skills/refresh", async () => {
    const skills = refreshSkills();
    return { status: "success", count: skills.length, skills: skills.map(toSummary) };
  });

  app.delete("/api/v1/skills/active", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const threadId = parseThreadId(query.threadId ?? query.sessionId);
    if (!threadId) {
      reply.code(400).send({ detail: "threadId is required" });
      return;
    }
    clearBoundSkills(threadId);
    return { status: "success", threadId, active_skills: [] };
  });

  app.get("/api/v1/skills/:name", async (req, reply) => {
    const name = decodeURIComponent(String((req.params as any).name || ""));
    const skill = getSkill(name);
    if (!skill) {
      reply.code(404).send({ detail: "Skill not found" });
      return;
    }
    return {
      ...toSummary(skill),
      body: skill.body,
    };
  });

  app.post("/api/v1/skills/:name/activate", async (req, reply) => {
    const name = decodeURIComponent(String((req.params as any).name || ""));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const threadId = parseThreadId(body.threadId ?? body.sessionId);
    if (!threadId) {
      reply.code(400).send({ detail: "threadId is required" });
      return;
    }
    if (!getSkill(name)) {
      reply.code(404).send({ detail: "Skill not found" });
      return;
    }
    const source = body.source === "request" || body.source === "tool" ? body.source : "manual";
    const result = bindSkillToThread(threadId, name, source);
    if (!result.ok) {
      reply.code(400).send({ detail: result.message });
      return;
    }
    return {
      status: "success",
      message: result.message,
      threadId,
      active_skills: result.activeSkills,
      loaded_skills: result.loadedSkills,
    };
  });

  app.post("/api/v1/skills/:name/deactivate", async (req, reply) => {
    const name = decodeURIComponent(String((req.params as any).name || ""));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const threadId = parseThreadId(body.threadId ?? body.sessionId);
    if (!threadId) {
      reply.code(400).send({ detail: "threadId is required" });
      return;
    }
    const result = unbindSkillFromThread(threadId, name);
    if (!result.ok) {
      reply.code(404).send({ detail: result.message });
      return;
    }
    return {
      status: "success",
      message: result.message,
      threadId,
      active_skills: result.activeSkills,
      loaded_skills: result.loadedSkills,
    };
  });
}
