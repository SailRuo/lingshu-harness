import type { FastifyInstance } from "fastify";
import {
  bindWechat,
  pollWechatLogin,
  requestWechatQrCode,
  unbindWechat,
  wechatStatus,
} from "../services/wechatService.js";
import {
  createQqBinding,
  deleteQqBinding,
  getQqBinding,
  listQqBindings,
  sendQqMessage,
  updateQqBinding,
} from "../services/qqbotService.js";
import {
  FILE_TYPE_FILE,
  FILE_TYPE_IMAGE,
  FILE_TYPE_VOICE,
  createQqBotClient,
  startQqBotRunner,
  stopQqBotRunner,
} from "../services/qqbotGateway.js";
import { prepareOutboundVoice } from "../services/qqbotAudio.js";
import { createQuickConnectSession, pollQuickConnect } from "../services/qqbotQuickConnect.js";

async function renderQrSvg(content: string) {
  const QRCode = (await import("qrcode")).default;
  return QRCode.toString(content, { type: "svg", margin: 1, width: 320 });
}

export async function registerWechatQqbotRoutes(app: FastifyInstance) {
  await registerWechatRoutes(app);
  await registerQqBotRoutes(app);
}

async function registerWechatRoutes(app: FastifyInstance) {
  app.post("/api/v1/wechat/qrcode", async (_req, reply) => {
    try {
      const qr = await requestWechatQrCode();
      return {
        qrcode: qr.qrcode,
        qrcodeImgContent: qr.qrcodeImgContent,
        qrcodeSvg: qr.qrcodeImgContent ? await renderQrSvg(qr.qrcodeImgContent) : "",
      };
    } catch {
      reply.code(502).send({ detail: "申请微信二维码失败，请稍后重试" });
    }
  });

  app.get("/api/v1/wechat/qrcode/status", async (req, reply) => {
    try {
      return await pollWechatLogin((req.query as any).verify_code);
    } catch (error: any) {
      if (String(error?.message || "").includes("no qrcode")) {
        reply.code(409).send({ detail: "尚未申请二维码" });
        return;
      }
      reply.code(502).send({ detail: "轮询扫码状态失败" });
    }
  });

  app.post("/api/v1/wechat/bind", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    try {
      return bindWechat(Number(body.agentId ?? body.agent_id));
    } catch (error: any) {
      if (String(error?.code || "") === "no_login") {
        reply.code(409).send({ detail: "尚未完成扫码登录" });
        return;
      }
      reply.code(500).send({ detail: "绑定失败" });
    }
  });

  app.get("/api/v1/wechat/status", async () => wechatStatus());
  app.post("/api/v1/wechat/unbind", async () => unbindWechat());
}

async function registerQqBotRoutes(app: FastifyInstance) {
  // 一键绑定：建任务 → 面板内展示二维码（手机 QQ 扫码授权）→ 轮询拿 appId/secret
  app.post("/api/v1/qqbot/quick-connect", async (_req, reply) => {
    try {
      const session = await createQuickConnectSession();
      return {
        ...session,
        connectUrlQrSvg: await renderQrSvg(session.connectUrl).catch(() => ""),
      };
    } catch (error: any) {
      reply.code(502).send({ detail: error?.message || "QQ 快捷绑定任务创建失败" });
    }
  });

  app.get("/api/v1/qqbot/quick-connect/:taskId", async (req, reply) => {
    try {
      return await pollQuickConnect(String((req.params as any).taskId || ""));
    } catch (error: any) {
      reply.code(502).send({ detail: error?.message || "QQ 快捷绑定轮询失败" });
    }
  });

  app.get("/api/v1/qqbot/bindings", async () => listQqBindings());
  app.post("/api/v1/qqbot/bindings", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    try {
      const binding = createQqBinding({
        appId: String(body.appId ?? body.app_id ?? ""),
        clientSecret: String(body.clientSecret ?? body.client_secret ?? ""),
        agentId: Number(body.agentId ?? body.agent_id),
        replyWithVoice: Boolean(body.replyWithVoice ?? body.reply_with_voice),
        enabledPrivate: body.enabledPrivate ?? body.enabled_private,
        enabledGroup: body.enabledGroup ?? body.enabled_group,
      });
      startQqBotRunner(binding.id);
      return getQqBinding(binding.id);
    } catch (error: any) {
      reply.code(error?.statusCode || 500).send({
        detail: error?.message || "QQBot 绑定失败",
      });
    }
  });

  app.get("/api/v1/qqbot/bindings/:bindingId", async (req, reply) => {
    const binding = getQqBinding(Number((req.params as any).bindingId));
    if (!binding) {
      reply.code(404).send({ detail: "binding not found" });
      return;
    }
    return binding;
  });

  app.patch("/api/v1/qqbot/bindings/:bindingId", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    try {
      const id = Number((req.params as any).bindingId);
      const binding = updateQqBinding(id, {
        agentId: Number(body.agentId ?? body.agent_id),
        replyWithVoice: Boolean(body.replyWithVoice ?? body.reply_with_voice),
        enabledPrivate: body.enabledPrivate ?? body.enabled_private,
        enabledGroup: body.enabledGroup ?? body.enabled_group,
        clientSecret: body.clientSecret ?? body.client_secret,
      });
      stopQqBotRunner(id);
      startQqBotRunner(id);
      return getQqBinding(id) || binding;
    } catch (error: any) {
      reply.code(error?.statusCode || 500).send({
        detail: error?.message || "QQBot 配置更新失败",
      });
    }
  });

  app.delete("/api/v1/qqbot/bindings/:bindingId", async (req, reply) => {
    const id = Number((req.params as any).bindingId);
    if (!deleteQqBinding(id)) {
      reply.code(404).send({ detail: "binding not found" });
      return;
    }
    stopQqBotRunner(id);
    return { ok: true };
  });

  app.post("/api/v1/qqbot/bindings/:bindingId/reconnect", async (req, reply) => {
    const id = Number((req.params as any).bindingId);
    const binding = getQqBinding(id);
    if (!binding) {
      reply.code(404).send({ detail: "binding not found" });
      return;
    }
    stopQqBotRunner(id);
    startQqBotRunner(id);
    return getQqBinding(id) || binding;
  });

  app.post("/api/v1/qqbot/bindings/:bindingId/send", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const bindingId = Number((req.params as any).bindingId);
    const targetType = String(body.targetType ?? body.target_type ?? "");
    const targetId = String(body.targetId ?? body.target_id ?? "");
    const msgType = String(body.msgType ?? body.msg_type ?? "text");
    try {
      if (msgType === "text") {
        return await sendQqMessage(bindingId, {
          targetType,
          targetId,
          msgType,
          text: body.text ? String(body.text) : undefined,
          fileData: body.fileData ?? body.file_data,
          fileName: body.fileName ?? body.file_name,
          replyMsgId: body.replyMsgId ?? body.reply_msg_id,
        });
      }
      const fileData = body.fileData ?? body.file_data;
      if (!fileData) {
        reply.code(400).send({ detail: "fileData is required for media messages" });
        return;
      }
      const client = createQqBotClient(bindingId);
      if (!client) {
        reply.code(404).send({ detail: "binding not found" });
        return;
      }
      const raw = Buffer.from(String(fileData), "base64");
      if (!raw.length) {
        reply.code(400).send({ detail: "Invalid fileData base64" });
        return;
      }
      const fileName = String(body.fileName ?? body.file_name ?? "");
      const fileType =
        msgType === "image" ? FILE_TYPE_IMAGE : msgType === "voice" ? FILE_TYPE_VOICE : FILE_TYPE_FILE;
      let voice: Awaited<ReturnType<typeof prepareOutboundVoice>> = null;
      if (msgType === "voice") {
        const extension = fileName.includes(".") ? fileName.split(".").pop() || "mp3" : "mp3";
        voice = await prepareOutboundVoice(raw, fileName || "voice.mp3", extension, 24000);
        if (!voice) {
          reply.code(400).send({ detail: "语音格式无法转换为 QQ 支持的上传格式" });
          return;
        }
      }
      const result = await client.sendFileBytes(
        targetType,
        targetId,
        fileType,
        voice?.data || raw,
        voice?.filename || fileName || undefined,
        body.text ? String(body.text) : "",
        body.replyMsgId ?? body.reply_msg_id,
      );
      return { ok: true, messageId: result.id ?? null };
    } catch (error: any) {
      reply.code(error?.statusCode || 500).send({ detail: error?.message || String(error) });
    }
  });
}
