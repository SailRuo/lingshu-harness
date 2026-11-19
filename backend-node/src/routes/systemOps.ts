import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDataRoot, getRuntimeDir } from "../runtimePaths.js";
import {
  getSettings,
} from "../services/settingsService.js";
import {
  patchProactiveConfig,
  proactiveReload,
  proactiveSnapshot,
  proactiveTick,
  resetProactiveConfig,
  testQqPush,
} from "../services/proactiveService.js";
import {
  getVolcengineVoiceStatus,
  pollVolcengineVoiceReady,
  trainVolcengineVoiceClone,
  voiceCloneResponse,
} from "../services/volcengineVoiceClone.js";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac"]);

export async function registerSystemOpsRoutes(app: FastifyInstance) {
  app.get("/api/settings/asr", async () => {
    const settings = getSettings() as Record<string, any>;
    return {
      enabled: Boolean(settings.asrEnabled),
      url: String(settings.asrUrl || ""),
      deprecated: true,
      detail: "ASR 使用本地 sherpa-onnx 模型，url 字段仅为兼容保留",
    };
  });

  app.get("/api/settings/list-dir-files", async (req) => {
    const raw = String((req.query as any).path || "");
    if (!raw) return [];
    try {
      const entries = fs.readdirSync(raw, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  });

  app.post("/api/settings/choose-directory", async () => {
    if (process.platform !== "darwin") return { directory: "" };
    try {
      const output = execFileSync(
        "osascript",
        ["-e", 'POSIX path of (choose folder with prompt "选择目录")'],
        { encoding: "utf-8", timeout: 60_000 },
      ).trim();
      return { directory: output.replace(/\/$/, "") };
    } catch {
      return { directory: "" };
    }
  });

  // 移动端 App「扫码配置连接」：二维码内容即当前后端地址。
  app.get("/api/system/mobile-config.svg", async (req, reply) => {
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost");
    const QRCode = (await import("qrcode")).default;
    const svg = await QRCode.toString(`${proto}://${host}`, {
      type: "svg",
      margin: 1,
      width: 320,
      errorCorrectionLevel: "M",
    });
    return reply.type("image/svg+xml; charset=utf-8").send(svg);
  });

  app.post("/api/system/data-path", async (req, reply) => {    const body = (req.body ?? {}) as Record<string, any>;
    const raw = String(body.dataPath ?? body.data_path ?? "").trim();
    if (!raw || !path.isAbsolute(raw)) {
      reply.code(400).send({ detail: "dataPath must be an absolute path" });
      return;
    }
    const target = path.resolve(raw);
    const current = path.resolve(getDataRoot());
    if (target === current) {
      return {
        status: "unchanged",
        dataPath: current,
        defaultDataPath: path.join(os.homedir(), ".lingshu"),
        runtimePath: getRuntimeDir(),
        modelsPath: path.join(current, "models"),
        persisted: false,
      };
    }
    const relative = path.relative(current, target);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      reply.code(400).send({ detail: "dataPath cannot be nested inside current data directory" });
      return;
    }
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.accessSync(target, fs.constants.W_OK);
      let copiedEntries = 0;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === "data-path") continue;
        const source = path.join(current, entry.name);
        const destination = path.join(target, entry.name);
        fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: false });
        copiedEntries += 1;
      }
      const pointer = path.join(os.homedir(), ".lingshu", "data-path");
      fs.mkdirSync(path.dirname(pointer), { recursive: true });
      fs.writeFileSync(pointer, target, "utf-8");
      return {
        status: "ok",
        message: "数据目录已切换，重启后端后生效",
        dataPath: target,
        defaultDataPath: path.join(os.homedir(), ".lingshu"),
        runtimePath: path.join(target, "runtime"),
        modelsPath: path.join(target, "models"),
        persisted: true,
        migrated: true,
        copiedEntries,
        previousDataPath: current,
      };
    } catch (error) {
      reply.code(500).send({
        detail: `数据目录迁移失败: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  app.post("/api/settings/volcengine/voice-clone/train", async (req, reply) => {
    const settings = getSettings() as Record<string, any>;
    const body = (req.body ?? {}) as Record<string, any>;
    const apiKey = String(settings.ttsVolcengineApiKey || "");
    if (!apiKey) {
      reply.code(503).send({ detail: "火山引擎 TTS API Key 未配置，无法训练音色" });
      return;
    }
    const resourceId = String(settings.ttsVolcengineResourceId || "seed-icl-2.0");
    const slot = String(body.cloneSpeakerSlot ?? body.clone_speaker_slot ?? "");
    try {
      const train = await trainVolcengineVoiceClone({
        apiKey,
        resourceId,
        refVoicePath: String(body.refVoicePath ?? body.ref_voice_path ?? ""),
        cloneSpeakerSlot: slot,
        referenceText: String(body.referenceText ?? body.reference_text ?? ""),
        language: Number(body.language ?? 0),
        demoText: String(body.demoText ?? body.demo_text ?? ""),
        enableDenoise: Boolean(body.enableDenoise ?? body.enable_denoise),
        disableVolumeNorm: Boolean(body.disableVolumeNorm ?? body.disable_volume_norm),
      });
      let final = train;
      if (body.poll !== false) {
        final = await pollVolcengineVoiceReady({
          apiKey,
          resourceId: train.resourceId,
          cloneSpeakerSlot: slot,
          modelType: train.modelType,
        });
      }
      const status = Number(final.data.status ?? -1);
      const speakerId = String(final.data.speaker_id || slot);
      return voiceCloneResponse({
        status,
        speakerId,
        resourceId: final.resourceId,
        modelType: final.modelType,
        message: String(final.data.message || train.data.message || ""),
        data: final.data,
      });
    } catch (error: any) {
      reply.code(error?.statusCode || 500).send({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/settings/volcengine/voice-clone/status", async (req, reply) => {
    const settings = getSettings() as Record<string, any>;
    const body = (req.body ?? {}) as Record<string, any>;
    const apiKey = String(settings.ttsVolcengineApiKey || "");
    if (!apiKey) {
      reply.code(503).send({ detail: "火山引擎 TTS API Key 未配置" });
      return;
    }
    try {
      const result = await getVolcengineVoiceStatus({
        apiKey,
        resourceId: String(settings.ttsVolcengineResourceId || "seed-icl-2.0"),
        cloneSpeakerSlot: String(body.cloneSpeakerSlot ?? body.clone_speaker_slot ?? ""),
        modelType:
          Number(settings.ttsVolcengineCloneModelType || 0) > 0
            ? Number(settings.ttsVolcengineCloneModelType)
            : undefined,
      });
      const status = Number(result.data.status ?? -1);
      return voiceCloneResponse({
        status,
        speakerId: String(result.data.speaker_id || ""),
        resourceId: result.resourceId,
        modelType: result.modelType,
        message: String(result.data.message || ""),
        data: result.data,
      });
    } catch (error: any) {
      reply.code(error?.statusCode || 500).send({ detail: error?.message || String(error) });
    }
  });

  app.get("/api/system/proactive-pool", async () => proactiveSnapshot());
  app.patch("/api/system/proactive-pool/config", async (req) => ({
    config: patchProactiveConfig((req.body ?? {}) as Record<string, unknown>),
  }));
  app.post("/api/system/proactive-pool/config/reset", async () => ({
    config: resetProactiveConfig(),
  }));
  app.post("/api/system/proactive-pool/tick", async () => proactiveTick());
  app.post("/api/system/proactive-pool/reload", async () => proactiveReload());
  app.post("/api/system/proactive-pool/test-qq-push", async (req) => {
    const body = (req.body ?? {}) as Record<string, any>;
    return testQqPush(Number(body.agentId || 0), body.text ? String(body.text) : undefined);
  });

  app.get("/api/system/proactive-pool/stream", async (_req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const writeSnapshot = () => {
      if (res.writableEnded) return;
      res.write(`event: snapshot\ndata: ${JSON.stringify(proactiveSnapshot())}\n\n`);
    };
    writeSnapshot();
    const timer = setInterval(writeSnapshot, 5000);
    res.on("close", () => clearInterval(timer));
  });
}
