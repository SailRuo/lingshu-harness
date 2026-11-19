/**
 * QQ 机器人一键绑定（对齐移动端 src/qqbot/quickConnect.ts）。
 *
 * 流程：生成 AES-256 key → q.qq.com/lite/create_bind_task 建任务 →
 * 用户在手机 QQ 里打开 connect.html 授权 → 轮询 poll_bind_result →
 * 用 key 解密 bot_encrypt_secret（AES-256-GCM：12 字节 IV || 密文 || 16 字节 tag）。
 *
 * key 只存在本进程内存（10 分钟 TTL）：桌面后端与 GUI 同机，GUI 轮询时即可拿到解密结果，
 * 不需要把 key 持久化或下发给客户端。
 */
import crypto from "node:crypto";

const QQ_LITE_API_HOST = "https://q.qq.com";
const QQBOT_CONNECT_URL = "https://q.qq.com/qqbot/openclaw/connect.html";
/** 任务 key 的内存保留时长：一次绑定流程最长 5 分钟，放宽到 10 分钟。 */
const KEY_TTL_MS = 10 * 60 * 1000;

interface QuickConnectTask {
  key: string;
  createdAt: number;
}

const taskKeys = new Map<string, QuickConnectTask>();

function pruneTaskKeys(now: number): void {
  for (const [taskId, task] of taskKeys) {
    if (now - task.createdAt > KEY_TTL_MS) taskKeys.delete(taskId);
  }
}

/** 32 字节随机数 → base64，即平台要求的 AES-256 key。 */
export function generateBindKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

export interface QuickConnectSession {
  taskId: string;
  connectUrl: string;
}

export async function createQuickConnectSession(source = "lingshu"): Promise<QuickConnectSession> {
  const key = generateBindKey();
  const response = await fetch(`${QQ_LITE_API_HOST}/lite/create_bind_task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await response.json().catch(() => ({}));
  const taskId = String(data?.data?.task_id || "");
  if (!response.ok || data?.retcode !== 0 || !taskId) {
    throw new Error(
      `QQ 快捷绑定任务创建失败: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  taskKeys.set(taskId, { key, createdAt: Date.now() });
  return { taskId, connectUrl: buildQQBotConnectUrl(taskId, source) };
}

export function buildQQBotConnectUrl(taskId: string, source = "lingshu"): string {
  const params = new URLSearchParams({
    task_id: String(taskId || ""),
    source,
    _wv: "2",
  });
  return `${QQBOT_CONNECT_URL}?${params.toString()}`;
}

export interface QuickConnectPollResult {
  status: "pending" | "completed" | "expired" | "unknown";
  appId?: string;
  clientSecret?: string;
  userOpenid?: string;
}

/** 用 WebCrypto 布局（12 字节 IV || 密文 || 16 字节 tag）解密 bot secret。 */
export function decryptQuickConnectSecret(encryptedBase64: string, keyBase64: string): string {
  const raw = Buffer.from(String(encryptedBase64 || ""), "base64");
  const keyBytes = Buffer.from(String(keyBase64 || ""), "base64");
  if (raw.length <= 12 + 16 || keyBytes.length !== 32) {
    throw new Error("invalid quick connect payload");
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export async function pollQuickConnect(taskId: string): Promise<QuickConnectPollResult> {
  pruneTaskKeys(Date.now());
  const task = taskKeys.get(String(taskId || ""));
  if (!task) {
    return { status: "expired" };
  }
  const response = await fetch(`${QQ_LITE_API_HOST}/lite/poll_bind_result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id: String(taskId || "") }),
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`QQ 快捷绑定轮询失败: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (data?.retcode !== 0) {
    throw new Error(String(data?.msg || "查询授权状态失败"));
  }
  const payload = data?.data ?? {};
  // 平台状态是数字枚举（对齐移动端 QQBotBindStatus）：0 未开始 / 1 等待授权 / 2 完成 / 3 过期。
  const rawStatus = payload.status;
  const status =
    typeof rawStatus === "number"
      ? rawStatus
      : /^\d+$/.test(String(rawStatus ?? ""))
        ? Number(rawStatus)
        : -1;
  if (status === 2) {
    const appId = String(payload.bot_appid || "");
    const encrypted = String(payload.bot_encrypt_secret || "");
    if (!appId || !encrypted) {
      return { status: "unknown" };
    }
    const clientSecret = decryptQuickConnectSecret(encrypted, task.key);
    taskKeys.delete(String(taskId));
    return {
      status: "completed",
      appId,
      clientSecret,
      userOpenid: String(payload.user_openid || "") || undefined,
    };
  }
  if (status === 1) return { status: "pending" };
  if (status === 3) return { status: "expired" };
  return { status: status === 0 ? "pending" : "unknown" };
}
