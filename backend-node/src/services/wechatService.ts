import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { decryptSecret, encryptSecret } from "./secretStore.js";
import { ensureThread } from "./chatThreadService.js";
import { streamChat } from "./chatStreamService.js";
import { saveProactiveRoute } from "./proactiveRouteService.js";
import { getChatUploadDir } from "../runtimePaths.js";
import { summarizeImage } from "./imageSummaryService.js";
import { splitForChannelDelivery } from "./channelDelivery.js";
import { sessionHub } from "./sessionHub.js";
import { config } from "../config.js";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const RETRY_DELAY_MS = 5000;

interface PendingLogin {
  qrcode: string;
  qrcodeImgContent: string;
  status?: string;
}

interface WechatBindingRow {
  id: number;
  ilink_bot_id: string | null;
  bot_token: string | null;
  bot_user_id: string | null;
  base_url: string | null;
  agent_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

let pending: PendingLogin | null = null;

function buildHeaders(botToken?: string): Record<string, string> {
  const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString("base64");
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "132100",
    "X-WECHAT-UIN": uin,
    ...(botToken ? { Authorization: `Bearer ${botToken}` } : {}),
  };
}

async function request(
  method: string,
  endpoint: string,
  body?: unknown,
  timeoutMs = 15_000,
  botToken?: string,
  baseUrl = BASE_URL,
) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`, {
    method,
    headers: buildHeaders(botToken),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`iLink ${endpoint} ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const text = await response.text();
  const parsed = text.trim() ? JSON.parse(text) : {};
  // iLink 常见 HTTP 200 但业务失败（ret !== 0，例如 -2 限频）。对齐移动端 ilinkClient：
  // 发送被拒必须抛错，否则上游会当成「已送达」。
  if (endpoint.includes("sendmessage")) {
    const retRaw = (parsed as Record<string, unknown>).ret;
    const ret =
      typeof retRaw === "number"
        ? retRaw
        : typeof retRaw === "string" && retRaw.trim() !== "" && Number.isFinite(Number(retRaw))
          ? Number(retRaw)
          : 0;
    if (ret !== 0) {
      console.warn("[WeChat] sendmessage declined", text.slice(0, 240));
      throw new Error(
        `iLink sendmessage ret=${ret} errcode=${String((parsed as Record<string, unknown>).errcode ?? "")} errmsg=${String((parsed as Record<string, unknown>).errmsg ?? "")}`,
      );
    }
    // ret === 0 但没有 message_id：微信已接受随后静默丢弃（参考 openclaw-weixin#263/#278），
    // 这类「假成功」必须显式报错，让上层走兜底而不是干等。
    const messageId = String((parsed as Record<string, unknown>).message_id ?? "").trim();
    if (!messageId) {
      console.warn("[WeChat] sendmessage no message_id", text.slice(0, 240));
      throw new Error(
        `微信已接受发送但未分配 message_id（响应 ${text.slice(0, 120)}）。常见于微信侧静默丢弃/账号受限，可稍后重试、重新扫码，或换另一微信账号验证`,
      );
    }
    console.info("[WeChat] sendmessage ok", messageId);
  }
  return parsed;
}

export async function requestWechatQrCode() {
  const data = await request("POST", "ilink/bot/get_bot_qrcode?bot_type=3", {
    local_token_list: [],
  });
  pending = {
    qrcode: String(data.qrcode || ""),
    qrcodeImgContent: String(data.qrcode_img_content || ""),
    status: "wait",
  };
  return {
    qrcode: pending.qrcode,
    qrcodeImgContent: pending.qrcodeImgContent,
  };
}

function saveCredentials(input: {
  botToken: string;
  botId: string;
  userId: string;
  baseUrl: string;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("DELETE FROM wechat_bindings").run();
  db.prepare(
    `INSERT INTO wechat_bindings
      (ilink_bot_id, bot_token, bot_user_id, base_url, agent_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?)`,
  ).run(
    input.botId,
    encryptSecret(input.botToken),
    input.userId || null,
    input.baseUrl || BASE_URL,
    now,
    now,
  );
}

export async function pollWechatLogin(verifyCode?: string) {
  if (!pending?.qrcode) throw Object.assign(new Error("no qrcode requested"), { code: "no_qrcode" });
  const endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(pending.qrcode)}${
    verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""
  }`;
  const data = await request("GET", endpoint, undefined, 35_000);
  const status = String(data.status || "wait");
  pending.status = status;
  if (status === "confirmed" && data.bot_token) {
    saveCredentials({
      botToken: String(data.bot_token),
      botId: String(data.ilink_bot_id || ""),
      userId: String(data.ilink_user_id || ""),
      baseUrl: String(data.baseurl || data.base_url || BASE_URL),
    });
    pending = null;
  }
  return {
    status,
    confirmed: status === "confirmed",
    scanned: status === "scaned",
    needVerifyCode: status === "need_verifycode",
    verifyCodeBlocked: status === "verify_code_blocked",
  };
}

export function getWechatBindingRow(): WechatBindingRow | null {
  return (
    (getDb().prepare("SELECT * FROM wechat_bindings ORDER BY id DESC LIMIT 1").get() as WechatBindingRow) ||
    null
  );
}

export function bindWechat(agentId: number) {
  const row = getWechatBindingRow();
  if (!row?.bot_token || !decryptSecret(row.bot_token)) {
    throw Object.assign(new Error("no confirmed wechat login"), { code: "no_login" });
  }
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE wechat_bindings SET agent_id = ?, status = 'confirmed', updated_at = ? WHERE id = ?")
    .run(agentId, now, row.id);
  startWechatRunner();
  return wechatStatus();
}

export function wechatStatus() {
  const row = getWechatBindingRow();
  if (!row) {
    return { status: "idle", bound: false, running: false, agentId: null };
  }
  return {
    status: row.status || "pending",
    bound: row.status === "confirmed" && Boolean(row.bot_token),
    running: Boolean(runner && runner.connectionState === "running"),
    agentId: row.agent_id,
    ilinkBotId: row.ilink_bot_id,
  };
}

export function unbindWechat() {
  stopWechatRunner();
  getDb().prepare("DELETE FROM wechat_bindings").run();
  pending = null;
  return { ok: true };
}

export function getWechatCredentials() {
  const row = getWechatBindingRow();
  if (!row) return null;
  return {
    botToken: decryptSecret(row.bot_token),
    botId: row.ilink_bot_id,
    userId: row.bot_user_id,
    baseUrl: row.base_url || BASE_URL,
    agentId: row.agent_id,
    status: row.status,
  };
}

export async function sendWechatText(
  toUserId: string,
  contextToken: string,
  text: string,
): Promise<void> {
  const row = getWechatBindingRow();
  const botToken = decryptSecret(row?.bot_token || null);
  if (!botToken) throw new Error("微信未绑定");
  await request(
    "POST",
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: `bot-${Date.now()}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: "2.4.4" },
    },
    20_000,
    botToken,
    row?.base_url || BASE_URL,
  );
}

export async function getWechatTypingTicket(
  toUserId: string,
  contextToken: string,
): Promise<string | null> {
  const row = getWechatBindingRow();
  const botToken = decryptSecret(row?.bot_token || null);
  if (!botToken) return null;
  const data: any = await request(
    "POST",
    "ilink/bot/getconfig",
    {
      ilink_user_id: toUserId,
      context_token: contextToken,
      base_info: { channel_version: "2.4.4" },
    },
    15_000,
    botToken,
    row?.base_url || BASE_URL,
  );
  return data?.typing_ticket ? String(data.typing_ticket) : null;
}

export async function sendWechatTyping(
  toUserId: string,
  status: 1 | 2,
  typingTicket?: string | null,
): Promise<void> {
  const row = getWechatBindingRow();
  const botToken = decryptSecret(row?.bot_token || null);
  if (!botToken) return;
  await request(
    "POST",
    "ilink/bot/sendtyping",
    {
      ilink_user_id: toUserId,
      typing_ticket: typingTicket || undefined,
      status,
    },
    15_000,
    botToken,
    row?.base_url || BASE_URL,
  );
}

export async function sendWechatImage(
  toUserId: string,
  contextToken: string,
  raw: Buffer,
): Promise<void> {
  const row = getWechatBindingRow();
  const botToken = decryptSecret(row?.bot_token || null);
  if (!botToken) throw new Error("微信未绑定");
  const baseUrl = row?.base_url || BASE_URL;
  const key = crypto.randomBytes(16);
  const keyHex = key.toString("hex");
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  const rawMd5 = crypto.createHash("md5").update(raw).digest("hex");
  const filekey = crypto.randomBytes(16).toString("hex");
  const uploadInfo: any = await request(
    "POST",
    "ilink/bot/getuploadurl",
    {
      filekey,
      media_type: 1,
      to_user_id: toUserId,
      rawsize: raw.length,
      rawfilemd5: rawMd5,
      filesize: ciphertext.length,
      aeskey: keyHex,
      no_need_thumb: true,
      base_info: { channel_version: "2.4.4" },
    },
    30_000,
    botToken,
    baseUrl,
  );
  const uploadFullUrl = String(uploadInfo.upload_full_url || uploadInfo.uploadFullUrl || "").trim();
  const uploadParam = String(
    uploadInfo.upload_param || uploadInfo.uploadParam || uploadInfo.encrypted_query_param || "",
  ).trim();
  if (!uploadFullUrl && !uploadParam) throw new Error("getuploadurl missing upload target");
  const uploadUrl = uploadFullUrl
    ? uploadFullUrl
    : `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "X-WECHAT-UIN": buildHeaders(botToken)["X-WECHAT-UIN"],
    },
    body: ciphertext,
    signal: AbortSignal.timeout(60_000),
  });
  if (![200, 201, 204].includes(uploadResponse.status)) {
    throw new Error(`wechat cdn upload failed ${uploadResponse.status}`);
  }
  let encryptQueryParam =
    String(uploadResponse.headers.get("x-encrypted-param") || "").trim() || "";
  if (!encryptQueryParam) {
    try {
      const body: any = await uploadResponse.json();
      encryptQueryParam = String(
        body?.encrypt_query_param ||
          body?.download_encrypted_query_param ||
          body?.encrypted_query_param ||
          "",
      ).trim();
    } catch {
      // ignore
    }
  }
  if (!encryptQueryParam) throw new Error("wechat cdn upload returned no encrypt_query_param");
  await request(
    "POST",
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: `bot-${Date.now()}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: encryptQueryParam,
                aes_key: Buffer.from(keyHex).toString("base64"),
                encrypt_type: 1,
              },
              mid_size: ciphertext.length,
              aeskey: keyHex,
            },
          },
        ],
      },
      base_info: { channel_version: "2.4.4" },
    },
    20_000,
    botToken,
    baseUrl,
  );
}

async function fetchUpdates(botToken: string, buffer: string, baseUrl: string) {
  const data = await request(
    "POST",
    "ilink/bot/getupdates",
    { get_updates_buf: buffer, base_info: { channel_version: "2.4.4" } },
    40_000,
    botToken,
    baseUrl,
  );
  return {
    msgs: Array.isArray(data.msgs) ? (data.msgs as Record<string, any>[]) : [],
    buffer: String(data.get_updates_buf || buffer),
  };
}

function parseWechatMessage(msg: Record<string, any>) {
  const fromUserId = String(msg.from_user_id || "");
  const contextToken = String(msg.context_token || "");
  if (!fromUserId || !contextToken) return null;
  const textParts: string[] = [];
  let hadVoice = false;
  let hadImage = false;
  let hadUnsupported = false;
  const imageMedia: { encryptQueryParam: string; aesKey: string }[] = [];
  for (const item of Array.isArray(msg.item_list) ? msg.item_list : []) {
    const type = Number(item?.type);
    if (type === 1) {
      const text = String(item?.text_item?.text || "");
      if (text) textParts.push(text);
    } else if (type === 2) {
      hadImage = true;
      const media = item?.image_item?.media || {};
      const encryptQueryParam = String(media.encrypt_query_param || "");
      const aesKey = String(media.aes_key || "");
      if (encryptQueryParam && aesKey) imageMedia.push({ encryptQueryParam, aesKey });
      else hadUnsupported = true;
    } else if (type === 3) {
      hadVoice = true;
      const text = String(item?.voice_item?.text || "");
      if (text) textParts.push(text);
    } else {
      hadUnsupported = true;
    }
  }
  return {
    fromUserId,
    contextToken,
    text: textParts.join("\n").trim(),
    hadVoice,
    hadImage,
    hadUnsupported,
    imageMedia,
  };
}

function parseAesKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const text = decoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, "hex");
  }
  throw new Error("invalid wechat media aes key");
}

function decryptWechatMedia(ciphertext: Buffer, aesKey: string): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", parseAesKey(aesKey), null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function imageSuffix(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ".jpg";
  if (data.subarray(0, 3).toString("ascii") === "GIF") return ".gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }
  return ".jpg";
}

async function downloadWechatMedia(
  botToken: string,
  encryptQueryParam: string,
  baseUrl: string,
): Promise<Buffer> {
  const cdnUrl = `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  let response = await fetch(cdnUrl, {
    headers: buildHeaders(botToken),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    response = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/ilink/bot/downloadmedia?encrypt_query_param=${encodeURIComponent(encryptQueryParam)}`,
      { headers: buildHeaders(botToken), signal: AbortSignal.timeout(30_000) },
    );
  }
  if (response.status !== 200) throw new Error(`wechat media download failed ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function splitBubbles(text: string): string[] {
  // 对齐移动端：一行一条气泡，单独成行的圆括号动作跟随后一句话投递。
  return splitForChannelDelivery(text);
}

class WechatBotRunner {
  connectionState = "starting";
  private stopped = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private botToken: string,
    private baseUrl: string,
    private agentId: number,
  ) {}

  start() {
    if (this.loopPromise) return;
    this.stopped = false;
    this.connectionState = "running";
    this.loopPromise = this.run();
  }

  async stop() {
    this.stopped = true;
    this.connectionState = "stopped";
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
  }

  private async run() {
    let buffer = "";
    while (!this.stopped) {
      try {
        const result = await fetchUpdates(this.botToken, buffer, this.baseUrl);
        buffer = result.buffer;
        for (const message of result.msgs) {
          if (this.stopped) break;
          await this.handleMessage(message);
        }
      } catch {
        if (this.stopped) break;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  private async handleMessage(message: Record<string, any>) {
    const parsed = parseWechatMessage(message);
    if (!parsed) return;
    saveProactiveRoute({
      agentId: this.agentId,
      channel: "wechat",
      targetType: "c2c",
      targetId: parsed.fromUserId,
      contextToken: parsed.contextToken,
    });

    const images: Record<string, any>[] = [];
    for (const media of parsed.imageMedia.slice(0, 3)) {
      try {
        const ciphertext = await downloadWechatMedia(
          this.botToken,
          media.encryptQueryParam,
          this.baseUrl,
        );
        const data = decryptWechatMedia(ciphertext, media.aesKey);
        const suffix = imageSuffix(data);
        const uploadName = `${crypto.randomUUID().replace(/-/g, "")}${suffix}`;
        fs.writeFileSync(path.join(getChatUploadDir(), uploadName), data);
        const mimeType =
          suffix === ".png"
            ? "image/png"
            : suffix === ".gif"
              ? "image/gif"
              : suffix === ".webp"
                ? "image/webp"
                : "image/jpeg";
        const summary = await summarizeImage({ uploadName, mimeType, data }).catch(() => null);
        images.push({
          uploadId: uploadName,
          url: `/api/v1/chat/uploads/${uploadName}`,
          mimeType,
          fileName: uploadName,
          sizeBytes: data.length,
          ...(summary ? { summaryText: summary } : {}),
        });
      } catch {
        // ignore broken media
      }
    }

    if (!parsed.text && !images.length) {
      const fallback = parsed.hadVoice
        ? "（这条语音我没太听清，能再说一遍或者打字告诉我吗～）"
        : parsed.hadImage
          ? "（这张图片我这边没打开，能重新发一次吗～）"
          : "这条消息我暂时没看懂，能打字再说一遍吗～";
      await sendWechatText(parsed.fromUserId, parsed.contextToken, fallback).catch(() => undefined);
      return;
    }

    const typingTicket = await getWechatTypingTicket(
      parsed.fromUserId,
      parsed.contextToken,
    ).catch(() => null);
    if (typingTicket) {
      await sendWechatTyping(parsed.fromUserId, 1, typingTicket).catch(() => undefined);
    }
    try {
      const thread = ensureThread("default_user", this.agentId);
      const controller = new AbortController();
      let fullText = "";
      const outboundImages: string[] = [];
      try {
        for await (const event of streamChat({
          request: {
            message: parsed.text,
            sessionId: thread.id,
            agentId: this.agentId,
            userId: "default_user",
            mode: "chat",
            images: images as any,
            clientHints: {
              surface: "wechat",
              interactionMode: parsed.hadVoice ? "voice_message" : "text_chat",
              inputKind: images.length && !parsed.text ? "image" : parsed.hadVoice ? "voice" : "text",
              outputMode: "text_bubble",
              transport: "wechat_ilink",
              botMode: true,
            },
          },
          signal: controller.signal,
          controller,
        })) {
          if (event.type === "text_delta" && event.content) fullText += event.content;
          if (event.type === "image") {
            const url = (event.metadata as any)?.url || event.content;
            if (url) outboundImages.push(String(url));
          }
          if (event.type === "tool_result") {
            const result = (event.metadata as any)?.tool_result;
            for (const image of Array.isArray(result?.images) ? result.images : []) {
              if (image?.url) outboundImages.push(String(image.url));
            }
          }
        }
      } catch {
        fullText = "";
      }
      const bubbles = splitBubbles(fullText);
      if (bubbles.length) {
        await sendWechatText(parsed.fromUserId, parsed.contextToken, bubbles[0]).catch(() => undefined);
      }
      for (const url of outboundImages.slice(0, 3)) {
        try {
          const target = url.startsWith("/")
            ? `http://127.0.0.1:${config.PORT}${url}`
            : url;
          const response = await fetch(target, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) continue;
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length) await sendWechatImage(parsed.fromUserId, parsed.contextToken, bytes);
        } catch {
          // best-effort image delivery
        }
      }
      for (const bubble of bubbles.slice(1)) {
        await sendWechatText(parsed.fromUserId, parsed.contextToken, bubble).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      // 渠道回合已落库，通知同一 thread 上打开的 GUI 重新拉取历史（Python 的 notify_gui_channel_turn）
      try {
        sessionHub.broadcastJson(thread.id, {
          type: "chat.channel_sync",
          threadId: thread.id,
          agentId: this.agentId,
        });
      } catch (error) {
        console.warn("[WeChat] channel_sync broadcast failed:", error);
      }
    } finally {
      if (typingTicket) {
        await sendWechatTyping(parsed.fromUserId, 2, typingTicket).catch(() => undefined);
      }
    }
  }
}

let runner: WechatBotRunner | null = null;

export function startWechatRunner(): boolean {
  const row = getWechatBindingRow();
  const botToken = decryptSecret(row?.bot_token || null);
  if (!row || !botToken || row.status !== "confirmed" || !row.agent_id) return false;
  void stopWechatRunner();
  runner = new WechatBotRunner(botToken, row.base_url || BASE_URL, row.agent_id);
  runner.start();
  return true;
}

export async function stopWechatRunner() {
  const current = runner;
  runner = null;
  await current?.stop();
}

export function startWechatRunnerIfBound() {
  return startWechatRunner();
}
