import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { getAgent } from "../services/agentService.js";
import { normalizeUserId } from "../services/chatThreadService.js";

const TRANSFER_TTL_MS = 300_000;
const tokens = new Map<string, { agentId: number; userId: string; expiresAt: number; used: boolean }>();

function requestOrigin(req: any): string {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost");
  return `${proto}://${host}`;
}

async function renderQrSvg(content: string): Promise<string> {
  const QRCode = (await import("qrcode")).default;
  return QRCode.toString(content, { type: "svg", margin: 1, width: 320 });
}

function rows(table: string, agentId: number, userId: string, order = "created_at ASC") {
  try {
    return getDb()
      .prepare(`SELECT * FROM ${table} WHERE agent_id = ? AND user_id = ? ORDER BY ${order}`)
      .all(agentId, userId) as Record<string, any>[];
  } catch {
    return [];
  }
}

function stripBinary(rowsData: Record<string, any>[]) {
  return rowsData.map((row) => {
    const next: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (Buffer.isBuffer(value)) continue;
      next[key] = value;
    }
    return next;
  });
}

export async function registerAgentTransferRoutes(app: FastifyInstance) {
  app.post("/api/v1/agent-transfer/:agentId/session", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    const agent = getAgent(agentId);
    if (!agent) {
      reply.code(404).send({ detail: "Agent not found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, any>;
    const userId = normalizeUserId(String(body.userId || "default_user"));
    const token = randomUUID().replace(/-/g, "");
    const expiresAt = Date.now() + TRANSFER_TTL_MS;
    tokens.set(token, { agentId, userId, expiresAt, used: false });
    const snapshotUrl = `${requestOrigin(req)}/api/v1/agent-transfer/${agentId}/snapshot?token=${token}`;
    return {
      format: "lingshu-pc-agent-transfer-pairing",
      version: 1,
      snapshotUrl,
      qrSvg: await renderQrSvg(snapshotUrl),
      expiresAt: Math.floor(expiresAt / 1000),
    };
  });

  app.get("/api/v1/agent-transfer/:agentId/snapshot", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    const token = String((req.query as any).token || "");
    const entry = tokens.get(token);
    if (!entry || entry.used) {
      reply.code(410).send({ detail: "Transfer token expired or already used" });
      return;
    }
    if (entry.expiresAt < Date.now()) {
      tokens.delete(token);
      reply.code(410).send({ detail: "Transfer token expired" });
      return;
    }
    if (entry.agentId !== agentId) {
      reply.code(410).send({ detail: "Transfer token does not match agent" });
      return;
    }
    const agent = getAgent(agentId);
    if (!agent) {
      reply.code(404).send({ detail: "Agent not found" });
      return;
    }
    entry.used = true;
    const userId = entry.userId;
    const db = getDb();
    const messages = db
      .prepare(
        `SELECT id, role, message_kind, content, reply_to_message_id, turn_pair_id, task_id,
                user_images_json, assistant_images_json, input_metadata, status, error_message,
                created_at, completed_at
         FROM chat_messages WHERE agent_id = ? AND user_id = ? ORDER BY id ASC`,
      )
      .all(agentId, userId) as Record<string, any>[];
    return {
      format: "lingshu-pc-agent-transfer",
      version: 1,
      createdAt: new Date().toISOString(),
      embedding: {
        dimension: 768,
        textContract: "bge-base-zh-v1.5",
        source: "node-local-onnx",
      },
      agent,
      rows: {
        streams: stripBinary(rows("hippocampus_streams", agentId, userId)),
        seeds: stripBinary(rows("hippocampus_seeds", agentId, userId)),
        entities: rows("hippocampus_entities", agentId, userId),
        facts: rows("hippocampus_facts", agentId, userId),
        edges: rows("hippocampus_edges", agentId, userId),
        messages,
        constraints: rows("hippocampus_constraints", agentId, userId),
        appointments: rows("hippocampus_appointments", agentId, userId),
        portraits: rows("hippocampus_portraits", agentId, userId),
        baselines: rows("hippocampus_baselines", agentId, userId),
        selfStates: rows("hippocampus_self_state", agentId, userId),
      },
    };
  });
}
