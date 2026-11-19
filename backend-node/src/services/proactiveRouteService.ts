import { getDb } from "../db/sqlite.js";

export interface ProactiveRoute {
  agentId: number;
  channel: "wechat" | "qqbot";
  targetType: "c2c" | "group" | string;
  targetId: string;
  contextToken: string | null;
  updatedAt: string;
}

export function saveProactiveRoute(input: {
  agentId: number;
  channel: ProactiveRoute["channel"];
  targetType: string;
  targetId: string;
  contextToken?: string | null;
}) {
  getDb()
    .prepare(
      `INSERT INTO proactive_routes (agent_id, channel, target_type, target_id, context_token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, channel) DO UPDATE SET
         target_type = excluded.target_type,
         target_id = excluded.target_id,
         context_token = excluded.context_token,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.agentId,
      input.channel,
      input.targetType,
      input.targetId,
      input.contextToken ?? null,
      new Date().toISOString(),
    );
}

export function getProactiveRoute(agentId: number, channel: ProactiveRoute["channel"]): ProactiveRoute | null {
  const row = getDb()
    .prepare("SELECT * FROM proactive_routes WHERE agent_id = ? AND channel = ?")
    .get(agentId, channel) as any;
  if (!row) return null;
  return {
    agentId: row.agent_id,
    channel: row.channel,
    targetType: row.target_type,
    targetId: row.target_id,
    contextToken: row.context_token ?? null,
    updatedAt: row.updated_at,
  };
}

export function listProactiveRoutes(agentId: number): ProactiveRoute[] {
  const rows = getDb()
    .prepare("SELECT * FROM proactive_routes WHERE agent_id = ? ORDER BY channel")
    .all(agentId) as any[];
  return rows.map((row) => ({
    agentId: row.agent_id,
    channel: row.channel,
    targetType: row.target_type,
    targetId: row.target_id,
    contextToken: row.context_token ?? null,
    updatedAt: row.updated_at,
  }));
}
