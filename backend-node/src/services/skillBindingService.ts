import { getDb } from "../db/sqlite.js";
import { getSkill, truncateSkillBody } from "./skillService.js";

/**
 * Session-scoped skill binding.
 *
 * `chat_threads.active_skills` keeps the ordered list of names that should be
 * injected into the system prompt. `chat_threads.thread_skills` keeps the
 * lifecycle records used by the UI and by future maintenance jobs. Both are
 * JSON columns, matching the Python backend's schema shape.
 */

const MAX_PROMPT_CHARS = 16_000;
const MAX_PROMPT_CHARS_PER_SKILL = 8_000;

export type SkillBindingSource = "tool" | "request" | "manual";
export type SkillBindingState = "bound" | "stale" | "failed";

export interface BoundSkillRecord {
  name: string;
  version: string | null;
  description: string;
  state: SkillBindingState;
  bound_at: string;
  last_used_at: string;
  use_count: number;
  source: SkillBindingSource;
  metadata?: Record<string, unknown>;
}

export interface LoadedSkillSummary {
  name: string;
  state: SkillBindingState;
  version: string | null;
  description: string;
  bound_at?: string;
  use_count?: number;
}

export interface SkillBindingResult {
  ok: boolean;
  message: string;
  activeSkills: string[];
  loadedSkills: LoadedSkillSummary[];
}

interface ThreadSkillRow {
  active_skills: string | null;
  thread_skills: string | null;
}

function readThreadSkills(threadId: number): ThreadSkillRow | null {
  if (!Number.isInteger(threadId) || threadId <= 0) return null;
  const row = getDb()
    .prepare("SELECT active_skills, thread_skills FROM chat_threads WHERE id = ?")
    .get(threadId) as ThreadSkillRow | undefined;
  return row ?? null;
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseActiveNames(raw: string | null): string[] {
  const value = parseJsonArray(raw);
  const names: string[] = [];
  for (const item of value) {
    const name = String(item || "").trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function normalizeRecords(raw: string | null, activeNames: string[]): BoundSkillRecord[] {
  const records: BoundSkillRecord[] = [];
  const epoch = new Date(0).toISOString();
  for (const item of parseJsonArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, any>;
    const name = String(value.name || "").trim();
    if (!name || records.some((record) => record.name === name)) continue;
    const skill = getSkill(name);
    const source: SkillBindingSource =
      value.source === "request" || value.source === "manual" ? value.source : "tool";
    records.push({
      name,
      version: value.version == null ? skill?.version ?? null : String(value.version),
      description: String(value.description || skill?.description || ""),
      state: skill ? (value.state === "failed" ? "failed" : "bound") : "stale",
      bound_at: String(value.bound_at || value.boundAt || epoch),
      last_used_at: String(value.last_used_at || value.lastUsedAt || value.bound_at || epoch),
      use_count: Math.max(1, Number(value.use_count ?? value.useCount ?? 1) || 1),
      source,
      ...(value.metadata && typeof value.metadata === "object"
        ? { metadata: value.metadata as Record<string, unknown> }
        : {}),
    });
  }

  // Older rows only have active_skills; materialize records so both columns
  // stay consistent after the next write.
  for (const name of activeNames) {
    if (records.some((record) => record.name === name)) continue;
    const skill = getSkill(name);
    records.push({
      name,
      version: skill?.version ?? null,
      description: skill?.description ?? "",
      state: skill ? "bound" : "stale",
      bound_at: epoch,
      last_used_at: epoch,
      use_count: 1,
      source: "manual",
    });
  }
  return records;
}

function toSummaries(records: BoundSkillRecord[]): LoadedSkillSummary[] {
  return records.map((record) => ({
    name: record.name,
    state: record.state,
    version: record.version,
    description: record.description,
    bound_at: record.bound_at,
    use_count: record.use_count,
  }));
}

function persist(threadId: number, activeNames: string[], records: BoundSkillRecord[]) {
  getDb()
    .prepare("UPDATE chat_threads SET active_skills = ?, thread_skills = ? WHERE id = ?")
    .run(JSON.stringify(activeNames), JSON.stringify(records), threadId);
}

export function getBoundSkillRecords(threadId: number): BoundSkillRecord[] {
  const row = readThreadSkills(threadId);
  if (!row) return [];
  return normalizeRecords(row.thread_skills, parseActiveNames(row.active_skills));
}

export function getActiveSkillNames(threadId: number): string[] {
  return getBoundSkillRecords(threadId)
    .filter((record) => record.state === "bound")
    .map((record) => record.name);
}

export function bindSkillToThread(
  threadId: number,
  name: string,
  source: SkillBindingSource = "manual",
): SkillBindingResult {
  const skillName = String(name || "").trim();
  const row = readThreadSkills(threadId);
  if (!row) {
    return { ok: false, message: "会话不存在，无法绑定技能", activeSkills: [], loadedSkills: [] };
  }
  const skill = getSkill(skillName);
  if (!skill) {
    const records = normalizeRecords(row.thread_skills, parseActiveNames(row.active_skills));
    return {
      ok: false,
      message: `技能「${skillName}」不存在，请先调用 skills_list 查看已安装技能`,
      activeSkills: records.filter((record) => record.state === "bound").map((record) => record.name),
      loadedSkills: toSummaries(records),
    };
  }

  const activeNames = parseActiveNames(row.active_skills);
  const records = normalizeRecords(row.thread_skills, activeNames);
  const now = new Date().toISOString();
  const existing = records.find((record) => record.name === skill.name);
  if (existing) {
    existing.state = "bound";
    existing.version = skill.version;
    existing.description = skill.description;
    existing.last_used_at = now;
    existing.use_count += 1;
    if (source !== "manual") existing.source = source;
  } else {
    records.push({
      name: skill.name,
      version: skill.version,
      description: skill.description,
      state: "bound",
      bound_at: now,
      last_used_at: now,
      use_count: 1,
      source,
    });
  }
  const nextActive = activeNames.includes(skill.name)
    ? activeNames
    : [...activeNames, skill.name];
  persist(threadId, nextActive, records);
  return {
    ok: true,
    message: `技能「${skill.name}」已激活`,
    activeSkills: nextActive,
    loadedSkills: toSummaries(records),
  };
}

export function unbindSkillFromThread(threadId: number, name: string): SkillBindingResult {
  const skillName = String(name || "").trim();
  const row = readThreadSkills(threadId);
  if (!row) {
    return { ok: false, message: "会话不存在，无法解绑技能", activeSkills: [], loadedSkills: [] };
  }
  const activeNames = parseActiveNames(row.active_skills);
  const records = normalizeRecords(row.thread_skills, activeNames);
  if (!records.some((record) => record.name === skillName)) {
    return {
      ok: false,
      message: `技能「${skillName}」当前未激活`,
      activeSkills: activeNames,
      loadedSkills: toSummaries(records),
    };
  }
  const nextRecords = records.filter((record) => record.name !== skillName);
  const nextActive = activeNames.filter((item) => item !== skillName);
  persist(threadId, nextActive, nextRecords);
  return {
    ok: true,
    message: `技能「${skillName}」已停用`,
    activeSkills: nextActive,
    loadedSkills: toSummaries(nextRecords),
  };
}

export function clearBoundSkills(threadId: number) {
  if (!Number.isInteger(threadId) || threadId <= 0) return;
  getDb()
    .prepare("UPDATE chat_threads SET active_skills = NULL, thread_skills = NULL WHERE id = ?")
    .run(threadId);
}

export function buildBoundSkillsPrompt(threadId: number): string {
  const activeNames = getActiveSkillNames(threadId);
  if (!activeNames.length) return "";
  const sections: string[] = [];
  let remaining = MAX_PROMPT_CHARS;
  for (const name of activeNames) {
    if (remaining <= 0) break;
    const skill = getSkill(name);
    if (!skill || !skill.body.trim()) continue;
    const body = truncateSkillBody(
      skill.body,
      Math.min(MAX_PROMPT_CHARS_PER_SKILL, remaining),
    );
    const description = skill.description ? `${skill.description}\n\n` : "";
    sections.push(`## ${skill.name}\n${description}${body}`);
    remaining -= body.length;
  }
  if (!sections.length) return "";
  return `\n\n# 已激活的技能\n以下技能已绑定到当前会话。请优先遵循其中的流程、约束和输出格式；与安全要求或用户当前请求冲突时，以安全和用户当下意图为准。\n\n${sections.join("\n\n")}`;
}

export function activeSkillMetadata(threadId: number): {
  active_skills: string[];
  loaded_skills: LoadedSkillSummary[];
} {
  const records = getBoundSkillRecords(threadId);
  const usable = records.filter((record) => record.state === "bound");
  return {
    active_skills: usable.map((record) => record.name),
    loaded_skills: toSummaries(usable),
  };
}
