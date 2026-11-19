import { getDb } from "../db/sqlite.js";
import { decryptSecret, encryptSecret } from "./secretStore.js";
import { getQqBotConnectionState, isQqBotRunnerActive } from "./qqbotRuntimeState.js";

interface QqBindingRow {
  id: number;
  app_id: string;
  agent_id: number;
  client_secret_enc: string;
  reply_with_voice: number;
  enabled_private: number;
  enabled_group: number;
  status: string;
  created_at: string;
  updated_at: string;
}

function toStatus(row: QqBindingRow) {
  const connectionState = getQqBotConnectionState(row.id);
  return {
    id: row.id,
    status: row.status || "confirmed",
    bound: true,
    running: isQqBotRunnerActive(row.id),
    connectionState,
    agentId: row.agent_id,
    appId: row.app_id,
    replyWithVoice: Boolean(row.reply_with_voice),
    enabledPrivate: Boolean(row.enabled_private),
    enabledGroup: Boolean(row.enabled_group),
  };
}

export function listQqBindings() {
  const rows = getDb()
    .prepare("SELECT * FROM qqbot_bindings ORDER BY id ASC")
    .all() as QqBindingRow[];
  return rows.map(toStatus);
}

export function getQqBindingRow(id: number): QqBindingRow | null {
  return (
    (getDb().prepare("SELECT * FROM qqbot_bindings WHERE id = ?").get(id) as QqBindingRow) || null
  );
}

export function getQqBinding(id: number) {
  const row = getDb().prepare("SELECT * FROM qqbot_bindings WHERE id = ?").get(id) as
    | QqBindingRow
    | undefined;
  return row ? toStatus(row) : null;
}

export function getQqBindingRowByAgent(agentId: number): QqBindingRow | null {
  return (getDb().prepare("SELECT * FROM qqbot_bindings WHERE agent_id = ?").get(agentId) as QqBindingRow) || null;
}

/** 全部绑定原始行（含密文），供群桥跨绑定发送时解析凭据。 */
export function listQqBindingRows(): QqBindingRow[] {
  return getDb().prepare("SELECT * FROM qqbot_bindings ORDER BY id ASC").all() as QqBindingRow[];
}

export function createQqBinding(input: {
  appId: string;
  clientSecret: string;
  agentId: number;
  replyWithVoice?: boolean;
  enabledPrivate?: boolean;
  enabledGroup?: boolean;
}) {
  const appId = String(input.appId || "").trim();
  const clientSecret = String(input.clientSecret || "").trim();
  if (!appId || !clientSecret || !input.agentId) {
    throw Object.assign(new Error("appId, clientSecret and agentId are required"), { statusCode: 400 });
  }
  const db = getDb();
  const duplicateApp = db.prepare("SELECT id FROM qqbot_bindings WHERE app_id = ?").get(appId);
  if (duplicateApp) throw Object.assign(new Error("appId already bound"), { statusCode: 409 });
  const duplicateAgent = db.prepare("SELECT id FROM qqbot_bindings WHERE agent_id = ?").get(input.agentId);
  if (duplicateAgent) throw Object.assign(new Error("agentId already bound"), { statusCode: 409 });
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO qqbot_bindings
        (app_id, agent_id, client_secret_enc, reply_with_voice, enabled_private, enabled_group,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
    )
    .run(
      appId,
      input.agentId,
      encryptSecret(clientSecret),
      input.replyWithVoice ? 1 : 0,
      input.enabledPrivate === false ? 0 : 1,
      input.enabledGroup ? 1 : 0,
      now,
      now,
    );
  return getQqBinding(Number(info.lastInsertRowid))!;
}

export function updateQqBinding(
  id: number,
  input: {
    agentId: number;
    replyWithVoice?: boolean;
    enabledPrivate?: boolean;
    enabledGroup?: boolean;
    clientSecret?: string;
  },
) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM qqbot_bindings WHERE id = ?").get(id) as
    | QqBindingRow
    | undefined;
  if (!existing) throw Object.assign(new Error("binding not found"), { statusCode: 404 });
  const duplicate = db
    .prepare("SELECT id FROM qqbot_bindings WHERE agent_id = ? AND id != ?")
    .get(input.agentId, id);
  if (duplicate) throw Object.assign(new Error("agentId already bound"), { statusCode: 409 });
  db.prepare(
    `UPDATE qqbot_bindings SET agent_id = ?, reply_with_voice = ?, enabled_private = ?,
      enabled_group = ?, client_secret_enc = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.agentId,
    input.replyWithVoice ? 1 : 0,
    input.enabledPrivate === false ? 0 : 1,
    input.enabledGroup ? 1 : 0,
    input.clientSecret ? encryptSecret(String(input.clientSecret).trim()) : existing.client_secret_enc,
    new Date().toISOString(),
    id,
  );
  return getQqBinding(id)!;
}

export function deleteQqBinding(id: number) {
  const info = getDb().prepare("DELETE FROM qqbot_bindings WHERE id = ?").run(id);
  return info.changes > 0;
}

/** 对齐移动端 client.ts：msg_seq 用时间低 8 位与 16 位随机数异或。 */
function nextMsgSeq(): number {
  const timePart = Date.now() % 100000000;
  const randPart = Math.floor(Math.random() * 65536);
  return (timePart ^ randPart) % 65536;
}

async function accessToken(row: QqBindingRow): Promise<string> {  const secret = decryptSecret(row.client_secret_enc);
  if (!secret) throw new Error("client secret unavailable");
  const response = await fetch("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: row.app_id, clientSecret: secret }),
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`QQBot token failed: ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  return String(data.access_token);
}

export async function sendQqMessage(
  id: number,
  input: {
    targetType: string;
    targetId: string;
    msgType: string;
    text?: string;
    fileData?: string;
    fileName?: string;
    replyMsgId?: string;
  },
): Promise<{ ok: true; messageId: string | null }> {
  const row = getDb().prepare("SELECT * FROM qqbot_bindings WHERE id = ?").get(id) as
    | QqBindingRow
    | undefined;
  if (!row) throw Object.assign(new Error("binding not found"), { statusCode: 404 });
  if (!["c2c", "group"].includes(input.targetType)) {
    throw Object.assign(new Error("unsupported targetType"), { statusCode: 409 });
  }
  if (input.msgType !== "text") {
    throw Object.assign(new Error("media messages are not implemented in node backend yet"), {
      statusCode: 409,
    });
  }
  const token = await accessToken(row);
  const url =
    input.targetType === "c2c"
      ? `https://api.sgroup.qq.com/v2/users/${encodeURIComponent(input.targetId)}/messages`
      : `https://api.sgroup.qq.com/v2/groups/${encodeURIComponent(input.targetId)}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `QQBot ${token}`,
    },
    body: JSON.stringify({
      content: String(input.text || ""),
      msg_type: 0,
      msg_seq: nextMsgSeq(),
      ...(input.replyMsgId ? { msg_id: input.replyMsgId } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`QQBot send failed: ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { ok: true, messageId: data.id ? String(data.id) : null };
}
