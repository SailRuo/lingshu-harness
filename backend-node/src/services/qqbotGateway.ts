import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { getChatUploadDir } from "../runtimePaths.js";
import { decryptSecret } from "./secretStore.js";
import { ensureThread } from "./chatThreadService.js";
import { streamChat } from "./chatStreamService.js";
import { splitForChannelDelivery, stripThinkBlocks } from "./channelDelivery.js";
import { getQqBindingRow, getQqBindingRowByAgent } from "./qqbotService.js";
import { saveProactiveRoute } from "./proactiveRouteService.js";
import { summarizeImage } from "./imageSummaryService.js";
import { recognizeWavBytesAsync } from "./asrService.js";
import { audioBytesToWav } from "./qqbotAudio.js";
import { synthesizeText } from "./ttsService.js";
import { prepareOutboundVoice } from "./qqbotAudio.js";
import { getSettings } from "./settingsService.js";
import { sessionHub } from "./sessionHub.js";
import { config } from "../config.js";
import { handleQQGroupInbound } from "./qqbotGroupBridge.js";
import {
  clearQqBotConnectionState,
  getQqBotConnectionState,
  setQqBotConnectionState,
  setQqBotRunnerActive,
} from "./qqbotRuntimeState.js";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const INTENTS = 1_174_409_216;
const FILE_TYPE_IMAGE = 1;
const FILE_TYPE_VOICE = 3;
const FILE_TYPE_FILE = 4;
/** 腾讯开放平台一键绑定（对齐移动端 quickConnect.ts）。 */
const QQ_LITE_API_HOST = "https://q.qq.com";
/** 全量模式正文里的 @ 标签。 */
const QQ_MENTION_INLINE_RE = /<@!?([A-Za-z0-9_-]+)>/g;
const QQ_FACE_TAG_RE = /<\s*face[A-Za-z0-9_:-]*\s*=[^>]*>/gi;
const QQ_FACE_EXT_RE = /\bext\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s>]+))/i;
const ONEBOT_FACE_TAG_RE = /\[CQ:(?:face|mface),[^\]]*\]/gi;
const STICKER_PLACEHOLDER = "表情";

/** 对齐移动端 client.ts：msg_seq 用时间低 8 位与 16 位随机数异或。 */
function nextMsgSeq(): number {
  const timePart = Date.now() % 100000000;
  const randPart = Math.floor(Math.random() * 65536);
  return (timePart ^ randPart) % 65536;
}

interface UploadedMedia {
  fileInfo: string;
}

export class QQBotClient {
  private token: string | null = null;
  private tokenExpiry = 0;
  /** 令牌互斥：并发请求不再各自取一次 token（对齐移动端 client.ts 的 tokenLock）。 */
  private tokenLock: Promise<void> = Promise.resolve();

  constructor(
    private appId: string,
    private clientSecret: string,
  ) {}

  async getToken(): Promise<string> {
    let release!: () => void;
    const wait = this.tokenLock;
    this.tokenLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      if (this.token && Date.now() < this.tokenExpiry - 300_000) return this.token;
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
        signal: AbortSignal.timeout(20_000),
      });
      const data: any = await response.json().catch(() => ({}));
      if (!response.ok || !data.access_token) {
        throw new Error(`QQ token request failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
      }
      this.token = String(data.access_token);
      this.tokenExpiry = Date.now() + Number(data.expires_in || 7200) * 1000;
      return this.token;
    } finally {
      release();
    }
  }

  clearToken() {
    this.token = null;
    this.tokenExpiry = 0;
  }

  private targetUrl(targetType: string, targetId: string, suffix: string): string {
    if (targetType === "c2c") return `${API_BASE}/v2/users/${targetId}/${suffix}`;
    if (targetType === "group") return `${API_BASE}/v2/groups/${targetId}/${suffix}`;
    throw new Error(`unsupported QQBot targetType: ${targetType}`);
  }

  async getGatewayUrl(): Promise<string> {
    const token = await this.getToken();
    const response = await fetch(`${API_BASE}/gateway`, {
      headers: { authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) {
      throw new Error(`QQ gateway request failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    return String(data.url);
  }

  async sendText(
    targetType: string,
    targetId: string,
    content: string,
    replyMsgId?: string | null,
  ): Promise<{ id?: string }> {
    const token = await this.getToken();
    const response = await fetch(this.targetUrl(targetType, targetId, "messages"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `QQBot ${token}` },
      body: JSON.stringify({
        content,
        msg_type: 0,
        msg_seq: nextMsgSeq(),
        ...(replyMsgId ? { msg_id: replyMsgId } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data: any = await response.json().catch(() => ({}));
    if (![200, 201, 202].includes(response.status)) {
      throw new Error(`QQ text send failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data;
  }

  /**
   * 群基础信息（群名 + 群公告）。
   *
   * `group_openid` 是按机器人分配的：同一个群，两个机器人拿到两个不同的 openid。
   * 但 `GET /v2/groups/{openid}/info` 返回的 `group_name` 是跨机器人一致的，
   * 所以 QQ 群会话按群名归并（见 qqbotGroupBridge.ts）。
   * 必须带本 client 自己的 token（openid 授权按机器人发）。
   * 失败 / 字段缺失一律返回 null，绝不抛。
   */
  async fetchGroupInfo(groupOpenid: string): Promise<{ groupName: string; description: string } | null> {
    const openid = String(groupOpenid || "").trim();
    if (!openid) return null;
    try {
      const token = await this.getToken();
      const response = await fetch(`${API_BASE}/v2/groups/${encodeURIComponent(openid)}/info`, {
        headers: { authorization: `QQBot ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const data: any = await response.json().catch(() => ({}));
      const groupName = String(data?.group_name || "").trim();
      if (!groupName) return null;
      return {
        groupName,
        description: String(data?.group_finger_memo || ""),
      };
    } catch {
      return null;
    }
  }

  async uploadMedia(
    targetType: string,
    targetId: string,
    fileType: number,
    fileData: Buffer,
    filename?: string,
  ): Promise<UploadedMedia> {
    const token = await this.getToken();
    const response = await fetch(this.targetUrl(targetType, targetId, "files"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `QQBot ${token}` },
      body: JSON.stringify({
        file_type: fileType,
        file_data: fileData.toString("base64"),
        srv_send_msg: false,
        ...(filename ? { file_name: filename } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const data: any = await response.json().catch(() => ({}));
    if (![200, 201, 202].includes(response.status) || !data.file_info) {
      throw new Error(`QQ media upload failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    return { fileInfo: String(data.file_info) };
  }

  async sendMedia(
    targetType: string,
    targetId: string,
    fileInfo: string,
    content = "",
    replyMsgId?: string | null,
  ): Promise<{ id?: string }> {
    const token = await this.getToken();
    const response = await fetch(this.targetUrl(targetType, targetId, "messages"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `QQBot ${token}` },
      body: JSON.stringify({
        msg_type: 7,
        media: { file_info: fileInfo },
        msg_seq: nextMsgSeq(),
        ...(content ? { content } : {}),
        ...(replyMsgId ? { msg_id: replyMsgId } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data: any = await response.json().catch(() => ({}));
    if (![200, 201, 202].includes(response.status)) {
      throw new Error(`QQ media send failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data;
  }

  async sendFileBytes(
    targetType: string,
    targetId: string,
    fileType: number,
    fileData: Buffer,
    filename?: string,
    content = "",
    replyMsgId?: string | null,
  ) {
    const uploaded = await this.uploadMedia(targetType, targetId, fileType, fileData, filename);
    return this.sendMedia(targetType, targetId, uploaded.fileInfo, content, replyMsgId);
  }
}

export function createQqBotClient(bindingId: number): QQBotClient | null {
  const row = getQqBindingRow(bindingId);
  if (!row) return null;
  const secret = decryptSecret(row.client_secret_enc);
  if (!secret) return null;
  return new QQBotClient(row.app_id, secret);
}

function splitBubbles(text: string): string[] {
  // 对齐移动端：一行一条气泡，单独成行的圆括号动作跟随后一句话投递。
  return splitForChannelDelivery(text);
}

function decodeFaceDescription(faceTag: string): string | null {
  const extMatch = QQ_FACE_EXT_RE.exec(faceTag);
  if (!extMatch) return null;
  const encoded = extMatch[1] || extMatch[2] || extMatch[3] || "";
  if (!encoded) return null;
  try {
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { text?: string };
    const description = String(payload.text || "").trim();
    return description.replace(/^\[|\]$/g, "") || null;
  } catch {
    return null;
  }
}

function replaceRichTextTags(content: string): string {
  let stickerSeen = false;
  const replace = (match: string) => {
    if (stickerSeen) return "";
    stickerSeen = true;
    return decodeFaceDescription(match) || STICKER_PLACEHOLDER;
  };
  return content.replace(QQ_FACE_TAG_RE, replace).replace(ONEBOT_FACE_TAG_RE, replace);
}

/** 私聊正文清洗：表情标签 → 「表情」，保留换行结构。 */
function cleanPrivateContent(content: string): string {
  const text = replaceRichTextTags(content).replace(/\r/g, "\n");
  return text
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function attachmentFiles(data: Record<string, any>): Record<string, any>[] {
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  return attachments.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const contentType = String(item?.content_type || "").toLowerCase();
    const filename = String(item?.filename || "").toLowerCase();
    return (
      !contentType.startsWith("image/") &&
      !/\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filename) &&
      contentType !== "voice" &&
      !contentType.startsWith("audio/") &&
      !contentType.includes("silk") &&
      !contentType.includes("amr") &&
      !/\.(silk|slk|slac|amr)$/i.test(filename)
    );
  });
}

function attachmentImages(data: Record<string, any>): Record<string, any>[] {
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  return attachments.filter((item) => String(item?.content_type || "").startsWith("image/"));
}

function attachmentVoices(data: Record<string, any>): Record<string, any>[] {
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  return attachments.filter((item) => {
    const contentType = String(item?.content_type || "").toLowerCase();
    const filename = String(item?.filename || "").toLowerCase();
    return (
      contentType === "voice" ||
      contentType.startsWith("audio/") ||
      contentType.includes("silk") ||
      contentType.includes("amr") ||
      /\.(silk|slk|slac|amr)$/.test(filename)
    );
  });
}

function voiceWavUrl(attachment: Record<string, any>): string | null {
  for (const key of ["voice_wav_url", "voiceWavUrl"]) {
    const value = attachment?.[key];
    if (value) {
      const url = String(value);
      return url.startsWith("//") ? `https:${url}` : url;
    }
  }
  return null;
}

function asrReferText(attachment: Record<string, any>): string {
  for (const key of ["asr_refer_text", "asrReferText"]) {
    const value = attachment?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function downloadAttachment(url: string, timeoutMs = 60_000): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const data = Buffer.from(await response.arrayBuffer());
    return data.length ? data : null;
  } catch {
    return null;
  }
}

async function transcribeVoiceAttachment(attachment: Record<string, any>): Promise<string> {
  const refer = asrReferText(attachment);
  if (refer) return refer.replace(/\s+/g, " ").trim();
  const filename = String(attachment.filename || "voice.amr");
  const contentType = String(attachment.content_type || "");
  const wavUrl = voiceWavUrl(attachment);
  if (wavUrl) {
    const raw = await downloadAttachment(wavUrl);
    if (raw) {
      try {
        return (await recognizeWavBytesAsync(raw)).text.trim();
      } catch {
        // fall through to attachment URL
      }
    }
  }
  const url = String(attachment.url || "");
  if (!url) return "";
  const raw = await downloadAttachment(url);
  if (!raw) return "";
  try {
    if (raw.subarray(0, 4).toString("ascii") === "RIFF" || contentType.startsWith("audio/wav")) {
      return (await recognizeWavBytesAsync(raw)).text.trim();
    }
    const wav = await audioBytesToWav(raw, filename);
    return wav ? (await recognizeWavBytesAsync(wav)).text.trim() : "";
  } catch {
    return "";
  }
}

async function downloadImageAttachment(attachment: Record<string, any>) {
  const url = String(attachment.url || "");
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length) return null;
    const contentType = String(attachment.content_type || "image/png");
    const ext = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : ".jpg";
    const uploadId = `${randomUUID().replace(/-/g, "")}${ext}`;
    fs.writeFileSync(path.join(getChatUploadDir(), uploadId), data);
    const summary = await summarizeImage({ uploadName: uploadId, mimeType: contentType, data }).catch(
      () => null,
    );
    return {
      uploadId,
      url: `/api/v1/chat/uploads/${uploadId}`,
      mimeType: contentType,
      fileName: attachment.filename ? String(attachment.filename) : undefined,
      sizeBytes: data.length,
      ...(summary ? { summaryText: summary } : {}),
    };
  } catch {
    return null;
  }
}

class QQBotGatewayRunner {
  connectionState = "disconnected";
  private socket: WebSocket | null = null;
  private stopped = false;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private seenMessages = new Set<string>();
  private client: QQBotClient;

  constructor(
    public bindingId: number,
    appId: string,
    private clientSecret: string,
    private agentId: number,
    private enabledPrivate: boolean,
    private enabledGroup: boolean,
    private replyWithVoice: boolean,
  ) {
    this.client = new QQBotClient(appId, clientSecret);
  }

  start() {
    if (this.socket) return;
    setQqBotRunnerActive(this.bindingId, true);
    void this.runLoop();
  }

  async stop() {
    this.stopped = true;
    setQqBotRunnerActive(this.bindingId, false);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = null;
    this.connectionState = "disconnected";
    setQqBotConnectionState(this.bindingId, "disconnected");
  }

  private async runLoop() {
    this.stopped = false;
    while (!this.stopped) {
      try {
        this.connectionState = "connecting";
        setQqBotConnectionState(this.bindingId, "connecting");
        const gatewayUrl = await this.client.getGatewayUrl();
        await new Promise<void>((resolve) => {
          const socket = new WebSocket(gatewayUrl);
          this.socket = socket;
          socket.on("open", () => {
            this.reconnectDelay = 1000;
          });
          socket.on("message", (data) => {
            void this.handleGatewayMessage(Buffer.from(data as Buffer));
          });
          socket.on("close", () => {
            this.connectionState = "disconnected";
            setQqBotConnectionState(this.bindingId, "disconnected");
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
            resolve();
          });
          socket.on("error", () => {
            this.connectionState = "disconnected";
            setQqBotConnectionState(this.bindingId, "disconnected");
          });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("token not exist") || message.includes("11244")) this.client.clearToken();
      }
      if (this.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay));
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    }
  }

  private async handleGatewayMessage(data: Buffer) {
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    const op = Number(payload.op);
    const d = payload.d || {};
    if (payload.s !== undefined && payload.s !== null) this.lastSeq = Number(payload.s);

    if (op === 10) {
      const interval = Number(d.heartbeat_interval || 45000) * 0.8;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ op: 1, d: this.lastSeq }));
        }
      }, interval);
      await this.identifyOrResume();
      return;
    }
    if (op === 11) return;
    if (op === 7) {
      this.socket?.close();
      return;
    }
    if (op === 9) {
      this.sessionId = null;
      this.lastSeq = null;
      this.socket?.close();
      return;
    }
    if (op !== 0) return;
    const eventType = String(payload.t || "");
    if (eventType === "READY") {
      this.connectionState = "connected";
      setQqBotConnectionState(this.bindingId, "connected");
      this.sessionId = String(d.session_id || "");
      return;
    }
    if (eventType === "RESUMED") {
      this.connectionState = "connected";
      setQqBotConnectionState(this.bindingId, "connected");
      return;
    }
    if (
      eventType === "C2C_MESSAGE_CREATE" ||
      eventType === "GROUP_AT_MESSAGE_CREATE" ||
      eventType === "GROUP_MESSAGE_CREATE"
    ) {
      void this.handleIncoming(eventType, d).catch(() => undefined);
    }
  }

  private async identifyOrResume() {
    const freshToken = await this.client.getToken();
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.sessionId && this.lastSeq !== null) {
      this.socket.send(
        JSON.stringify({
          op: 6,
          d: { token: `QQBot ${freshToken}`, session_id: this.sessionId, seq: this.lastSeq },
        }),
      );
      return;
    }
    this.socket.send(
      JSON.stringify({
        op: 2,
        d: { token: `QQBot ${freshToken}`, intents: INTENTS, shard: [0, 1] },
      }),
    );
  }

  private async handleIncoming(eventType: string, data: Record<string, any>) {
    const messageId = String(data.id || "");
    if (messageId) {
      if (this.seenMessages.has(messageId)) return;
      this.seenMessages.add(messageId);
      if (this.seenMessages.size > 500) {
        const first = this.seenMessages.values().next().value;
        if (first) this.seenMessages.delete(first);
      }
    }

    if (eventType === "C2C_MESSAGE_CREATE") {
      if (!this.enabledPrivate) return;
      await this.handleC2CIncoming(data, messageId);
      return;
    }
    if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") {
      if (!this.enabledGroup) return;
      await this.handleGroupIncoming(eventType, data);
    }
  }

  private safeSendText(targetType: string, targetId: string, content: string, replyMsgId?: string | null) {
    return this.client.sendText(targetType, targetId, content, replyMsgId).catch((error) => {
      console.warn("[QQBot] text send failed:", error);
    });
  }

  /** QQ 私聊（c2c）回合，对齐移动端 messageRouter.handleMessage 的私聊分支。 */
  private async handleC2CIncoming(data: Record<string, any>, messageId: string) {
    const senderId = String(data.author?.user_openid || "").trim();
    if (!senderId) return;
    let text = cleanPrivateContent(String(data.content || ""));

    const images: Record<string, any>[] = [];
    for (const attachment of attachmentImages(data).slice(0, 3)) {
      const image = await downloadImageAttachment(attachment);
      if (image) images.push(image);
    }
    const hadImage = attachmentImages(data).length > 0;
    const hadUnsupported = attachmentFiles(data).length > 0;
    let hadVoice = false;
    const voiceAttachment = attachmentVoices(data)[0];
    if (voiceAttachment) {
      hadVoice = true;
      const transcript = await transcribeVoiceAttachment(voiceAttachment);
      if (transcript) text = [text, transcript].filter(Boolean).join("\n");
    }

    saveProactiveRoute({
      agentId: this.agentId,
      channel: "qqbot",
      targetType: "c2c",
      targetId: senderId,
    });

    if (!text && !images.length) {
      // 对齐移动端：语音没转出来 → 语音兜底；图片没取到 → 图片提示；其余不打扰。
      if (hadVoice) {
        await this.safeSendText(
          "c2c",
          senderId,
          "（这条语音我没太听清，能再说一遍或者打字告诉我吗～）",
          messageId,
        );
      } else if (hadImage) {
        await this.safeSendText(
          "c2c",
          senderId,
          "（这张图片我这边没打开，能重新发一次吗～）",
          messageId,
        );
      } else if (hadUnsupported) {
        await this.safeSendText("c2c", senderId, "（这个类型的消息我暂时看不了～）", messageId);
      }
      return;
    }

    const thread = ensureThread("default_user", this.agentId);
    const controller = new AbortController();
    let fullText = "";
    const outboundImages: string[] = [];
    try {
      for await (const event of streamChat({
        request: {
          message: text,
          sessionId: thread.id,
          agentId: this.agentId,
          userId: "default_user",
          mode: "chat",
          images: images as any,
          clientHints: {
            surface: "qqbot",
            interactionMode: hadVoice ? "voice_message" : "text_chat",
            inputKind: images.length && !text ? "image" : hadVoice ? "voice" : "text",
            outputMode: "text_bubble",
            transport: "qqbot_gateway",
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

    for (const url of outboundImages.slice(0, 3)) {
      try {
        const target = url.startsWith("/") ? `http://127.0.0.1:${config.PORT}${url}` : url;
        const response = await fetch(target, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length) continue;
        await this.client.sendFileBytes(
          "c2c",
          senderId,
          FILE_TYPE_IMAGE,
          bytes,
          "image.png",
          "",
          messageId,
        );
      } catch {
        // best-effort media delivery
      }
    }

    const reply = stripThinkBlocks(fullText);
    if (!reply) {
      this.notifyGuiChannelSync(thread.id);
      return;
    }

    // 语音 + 文本双推（对齐移动端）：只发语音时 QQ 会收下（2xx）但客户端未必能播，
    // 用户看到的就是「语音没推、文本也没了」。文本是通道的保底载体，语音成功也照发。
    if (this.replyWithVoice) {
      const settings = getSettings() as Record<string, any>;
      if (settings.ttsEnabled) {
        try {
          const audio = await synthesizeText(reply, { agentId: this.agentId });
          const prepared = await prepareOutboundVoice(
            audio.data,
            `reply.${audio.format}`,
            audio.format,
            audio.sampleRate,
          );
          if (!prepared) throw new Error("unsupported voice format");
          await this.client.sendFileBytes(
            "c2c",
            senderId,
            FILE_TYPE_VOICE,
            prepared.data,
            prepared.filename,
            "",
            messageId,
          );
        } catch (error) {
          console.warn("[QQBot] voice reply failed, text still follows:", error);
        }
      }
    }

    // 被动回复必须每条都带 msg_id：不带 msg_id 的发送会消耗每日主动消息额度。
    const bubbles = splitBubbles(reply);
    for (let index = 0; index < bubbles.length; index += 1) {
      await this.safeSendText("c2c", senderId, bubbles[index], messageId);
      if (index < bubbles.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }

    this.notifyGuiChannelSync(thread.id);
  }

  /**
   * QQ 群消息：解析图片/语音附件后交给群桥（qqbotGroupBridge）。
   * 群名归并、presence、去重、配额、点名路由、发送全部在桥里对齐移动端。
   */
  private async handleGroupIncoming(eventType: string, data: Record<string, any>) {
    const images: Record<string, any>[] = [];
    for (const attachment of attachmentImages(data).slice(0, 3)) {
      const image = await downloadImageAttachment(attachment);
      if (image) images.push(image);
    }
    let voiceTranscript = "";
    let hadVoice = false;
    const voiceAttachment = attachmentVoices(data)[0];
    if (voiceAttachment) {
      hadVoice = true;
      voiceTranscript = await transcribeVoiceAttachment(voiceAttachment);
    }
    handleQQGroupInbound({
      bindingId: this.bindingId,
      agentId: this.agentId,
      replyWithVoice: this.replyWithVoice,
      client: this.client,
      eventType,
      data,
      images,
      voiceTranscript,
      hadVoice,
      hadUnsupported: attachmentFiles(data).length > 0,
      eventTimestamp: String(data.timestamp || ""),
    });
  }

  /** 渠道回合已落库，通知同一 thread 上打开的 GUI 重新拉取历史（Python 的 notify_gui_channel_turn）。 */
  private notifyGuiChannelSync(threadId: number) {
    try {
      sessionHub.broadcastJson(threadId, {
        type: "chat.channel_sync",
        threadId,
        agentId: this.agentId,
      });
    } catch (error) {
      console.warn("[QQBot] channel_sync broadcast failed:", error);
    }
  }
}

const runners = new Map<number, QQBotGatewayRunner>();

export function startQqBotRunner(bindingId: number): boolean {
  const row = getQqBindingRow(bindingId);
  if (!row) return false;
  const secret = decryptSecret(row.client_secret_enc);
  if (!secret) return false;
  runners.get(bindingId)?.stop();
  const runner = new QQBotGatewayRunner(
    bindingId,
    row.app_id,
    secret,
    row.agent_id,
    Boolean(row.enabled_private),
    Boolean(row.enabled_group),
    Boolean(row.reply_with_voice),
  );
  runners.set(bindingId, runner);
  runner.start();
  return true;
}

export function stopQqBotRunner(bindingId: number) {
  const runner = runners.get(bindingId);
  if (runner) {
    void runner.stop();
    runners.delete(bindingId);
  }
  clearQqBotConnectionState(bindingId);
}

export function stopAllQqBotRunners() {
  for (const bindingId of [...runners.keys()]) stopQqBotRunner(bindingId);
}

export function startAllQqBotRunners() {
  const rows = getDb().prepare("SELECT id FROM qqbot_bindings").all() as { id: number }[];
  for (const row of rows) startQqBotRunner(row.id);
}

export function qqBotRunnerState(bindingId: number) {
  return getQqBotConnectionState(bindingId);
}

export function qqBotClientForAgent(agentId: number): QQBotClient | null {
  const row = getQqBindingRowByAgent(agentId);
  if (!row) return null;
  return createQqBotClient(row.id);
}

export { FILE_TYPE_IMAGE, FILE_TYPE_FILE, FILE_TYPE_VOICE };
