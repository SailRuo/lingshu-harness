import { getDb } from "../db/sqlite.js";
import { invalidateSelfPortraitBlockCacheForAgent } from "./selfPortraitCache.js";

export interface AgentRow {
  id: number;
  name: string;
  display_name: string;
  avatar: string | null;
  color: string | null;
  voice: string | null;
  role_setting: string | null;
  speaking_style: string | null;
  is_default: number;
  is_active: number;
  self_evolution_enabled: number;
  time_mirror_enabled: number;
  proactive_enabled: number;
  created_at: string;
  updated_at: string;
}

export interface AgentResponse {
  id: number;
  name: string;
  displayName: string;
  avatar: string | null;
  color: string | null;
  voice: string | null;
  isDefault: boolean;
  isActive: boolean;
  roleSetting: string | null;
  speakingStyle: string | null;
  selfEvolutionEnabled: boolean;
  timeMirrorEnabled: boolean;
  proactiveEnabled: boolean;
}

function toResponse(row: AgentRow): AgentResponse {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    avatar: row.avatar,
    color: row.color,
    voice: row.voice,
    isDefault: !!row.is_default,
    isActive: !!row.is_active,
    roleSetting: row.role_setting,
    speakingStyle: row.speaking_style,
    selfEvolutionEnabled: !!row.self_evolution_enabled,
    timeMirrorEnabled: !!row.time_mirror_enabled,
    proactiveEnabled: !!row.proactive_enabled,
  };
}

export function listAgents(): AgentResponse[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM agent_configs ORDER BY id ASC").all() as AgentRow[];
  return rows.map(toResponse);
}

export function listSimpleAgents() {
  return listAgents().map((a) => ({
    id: a.id,
    name: a.name,
    displayName: a.displayName,
    avatar: a.avatar,
    isDefault: a.isDefault,
    isActive: a.isActive,
  }));
}

export function getAgent(id: number): AgentResponse | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agent_configs WHERE id = ?").get(id) as AgentRow | undefined;
  return row ? toResponse(row) : null;
}

export function getDefaultAgent(): AgentResponse | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agent_configs WHERE is_default = 1 LIMIT 1").get() as AgentRow | undefined;
  if (row) return toResponse(row);
  const first = db.prepare("SELECT * FROM agent_configs ORDER BY id ASC LIMIT 1").get() as AgentRow | undefined;
  return first ? toResponse(first) : null;
}

export interface AgentCreateInput {
  name: string;
  displayName: string;
  avatar?: string | null;
  color?: string | null;
  voice?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  roleSetting?: string | null;
  speakingStyle?: string | null;
  selfEvolutionEnabled?: boolean;
  timeMirrorEnabled?: boolean;
  proactiveEnabled?: boolean;
}

export function createAgent(input: AgentCreateInput): AgentResponse {
  const db = getDb();
  const isDefault = input.isDefault ? 1 : 0;
  if (isDefault) {
    db.prepare("UPDATE agent_configs SET is_default = 0").run();
  }
  const info = db
    .prepare(
      `INSERT INTO agent_configs
        (name, display_name, avatar, color, voice, role_setting, speaking_style, is_default, is_active,
         self_evolution_enabled, time_mirror_enabled, proactive_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.displayName,
      input.avatar ?? null,
      input.color ?? null,
      input.voice ?? null,
      input.roleSetting ?? null,
      input.speakingStyle ?? null,
      isDefault,
      input.isActive === false ? 0 : 1,
      input.selfEvolutionEnabled === false ? 0 : 1,
      input.timeMirrorEnabled === false ? 0 : 1,
      input.proactiveEnabled === false ? 0 : 1,
    );
  const agent = getAgent(Number(info.lastInsertRowid));
  if (!agent) throw new Error("failed to create agent");
  return agent;
}

export function updateAgent(id: number, input: Partial<AgentCreateInput>): AgentResponse | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM agent_configs WHERE id = ?").get(id) as AgentRow | undefined;
  if (!existing) return null;
  if (input.isDefault) {
    db.prepare("UPDATE agent_configs SET is_default = 0").run();
  }
  db.prepare(
    `UPDATE agent_configs SET
      name = COALESCE(?, name),
      display_name = COALESCE(?, display_name),
      avatar = COALESCE(?, avatar),
      color = COALESCE(?, color),
      voice = COALESCE(?, voice),
      role_setting = COALESCE(?, role_setting),
      speaking_style = COALESCE(?, speaking_style),
      is_default = COALESCE(?, is_default),
      is_active = COALESCE(?, is_active),
      self_evolution_enabled = COALESCE(?, self_evolution_enabled),
      time_mirror_enabled = COALESCE(?, time_mirror_enabled),
      proactive_enabled = COALESCE(?, proactive_enabled),
      updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    input.name ?? null,
    input.displayName ?? null,
    input.avatar === undefined ? null : input.avatar,
    input.color === undefined ? null : input.color,
    input.voice === undefined ? null : input.voice,
    input.roleSetting === undefined ? null : input.roleSetting,
    input.speakingStyle === undefined ? null : input.speakingStyle,
    input.isDefault === undefined ? null : (input.isDefault ? 1 : 0),
    input.isActive === undefined ? null : (input.isActive ? 1 : 0),
    input.selfEvolutionEnabled === undefined ? null : (input.selfEvolutionEnabled ? 1 : 0),
    input.timeMirrorEnabled === undefined ? null : (input.timeMirrorEnabled ? 1 : 0),
    input.proactiveEnabled === undefined ? null : (input.proactiveEnabled ? 1 : 0),
    id,
  );
  return getAgent(id);
}

export function deleteAgent(id: number): boolean {
  const db = getDb();
  // The anchor is keyed by agent+user and has no FK to agent_configs; drop it
  // with the companion so a re-import cannot inherit a dead self portrait.
  const info = db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  if (info.changes > 0) {
    db.prepare("DELETE FROM conversation_anchors WHERE agent_id = ?").run(id);
    invalidateSelfPortraitBlockCacheForAgent(id);
  }
  return info.changes > 0;
}

export function setDefaultAgent(id: number): AgentResponse | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM agent_configs WHERE id = ?").get(id) as AgentRow | undefined;
  if (!existing) return null;
  db.prepare("UPDATE agent_configs SET is_default = 0").run();
  db.prepare("UPDATE agent_configs SET is_default = 1 WHERE id = ?").run(id);
  return getAgent(id);
}

export function seedDefaultAgentIfEmpty() {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) as c FROM agent_configs").get() as { c: number };
  if (count.c > 0) return;
  createAgent({
    name: "linger",
    displayName: "灵儿",
    isDefault: true,
    isActive: true,
    roleSetting: "你是一个温柔、善解人意的陪伴型助手，代号「灵儿」。",
  });
}