import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { getDataRoot } from "../runtimePaths.js";

/**
 * Minimal Agent Skills loader (SKILL.md + YAML frontmatter).
 *
 * This mirrors the discovery half of the Python `SkillRegistry` without the
 * task-orchestration pieces: skills are plain instruction bundles that can be
 * bound to a chat thread and injected into the system prompt.
 */

const SKILL_FILE = "SKILL.md";
const MAX_BODY_CHARS = 24_000;
const CACHE_TTL_MS = 1_500;

export interface SkillMetadata {
  name: string;
  description: string;
  version: string | null;
  tools: string[];
  scripts: Record<string, string>;
  references: Record<string, string>;
  assets: Record<string, string>;
  body: string;
  bodyChars: number;
  path: string;
  source: string;
  updatedAt: string;
}

interface SkillCache {
  at: number;
  skills: SkillMetadata[];
}

let cache: SkillCache | null = null;

function isDir(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function collectFiles(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!isDir(directory)) return files;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files[path.relative(directory, full).split(path.sep).join("/")] = full;
      }
    }
  };
  walk(directory);
  return files;
}

/**
 * Skill roots, highest priority first. The first definition of a name wins so
 * a user can override a bundled skill by placing it in the data directory.
 */
export function resolveSkillRoots(): string[] {
  const executableDir = path.dirname(process.execPath);
  const roots = [
    process.env.LINGSHU_SKILLS_DIR || "",
    path.join(getDataRoot(), "skills"),
    path.join(process.cwd(), ".lingshu", "skills"),
    path.join(os.homedir(), ".lingshu", "skills"),
    path.join(process.cwd(), "skills"),
    // Packaged layout: Resources/backend/runtime/node -> Resources/backend/skills
    path.join(executableDir, "..", "skills"),
  ];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const normalized = path.resolve(root);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function splitFrontmatter(content: string): { data: Record<string, any>; body: string } {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/.exec(normalized);
  if (!match) return { data: {}, body: normalized.trim() };
  let data: Record<string, any> = {};
  try {
    const parsed = loadYaml(match[1]);
    if (parsed && typeof parsed === "object") data = parsed as Record<string, any>;
  } catch {
    // A malformed frontmatter block should not hide the skill body.
    data = {};
  }
  return { data, body: match[2].trim() };
}

function normalizeTools(data: Record<string, any>): string[] {
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const raw = data.tools ?? metadata.tools ?? data["allowed-tools"] ?? data.allowed_tools;
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function loadSkill(skillDir: string, source: string): SkillMetadata | null {
  const skillFile = path.join(skillDir, SKILL_FILE);
  if (!isFile(skillFile)) return null;
  try {
    const stat = fs.statSync(skillFile);
    const content = fs.readFileSync(skillFile, "utf-8");
    const { data, body } = splitFrontmatter(content);
    const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
    const name = String(data.name || path.basename(skillDir)).trim() || path.basename(skillDir);
    const description = String(data.description || metadata.description || "").trim();
    const versionValue = data.version ?? metadata.version;
    const version = versionValue === undefined || versionValue === null ? null : String(versionValue);
    return {
      name,
      description,
      version,
      tools: normalizeTools(data),
      scripts: collectFiles(path.join(skillDir, "scripts")),
      references: collectFiles(path.join(skillDir, "references")),
      assets: collectFiles(path.join(skillDir, "assets")),
      body: body.slice(0, MAX_BODY_CHARS),
      bodyChars: body.length,
      path: skillDir,
      source,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function scanSkills(): SkillMetadata[] {
  const byName = new Map<string, SkillMetadata>();
  for (const root of resolveSkillRoots()) {
    if (!isDir(root)) continue;
    // A root may itself be a single skill directory (LINGSHU_SKILLS_DIR=/path/to/skill).
    if (isFile(path.join(root, SKILL_FILE))) {
      const single = loadSkill(root, root);
      if (single && !byName.has(single.name)) byName.set(single.name, single);
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skill = loadSkill(path.join(root, entry.name), root);
      if (skill && !byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function listSkills(options: { force?: boolean } = {}): SkillMetadata[] {
  const now = Date.now();
  if (!options.force && cache && now - cache.at < CACHE_TTL_MS) return cache.skills;
  const skills = scanSkills();
  cache = { at: now, skills };
  return skills;
}

export function refreshSkills(): SkillMetadata[] {
  return listSkills({ force: true });
}

export function getSkill(name: string): SkillMetadata | null {
  const normalized = String(name || "").trim();
  if (!normalized) return null;
  return listSkills().find((skill) => skill.name === normalized) || null;
}

export function skillCatalogText(): string {
  const skills = listSkills();
  if (!skills.length) return "";
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

export function truncateSkillBody(body: string, maxChars = 12_000): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n...[技能正文已截断，原始长度 ${body.length} 字符]`;
}
