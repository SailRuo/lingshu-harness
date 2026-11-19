import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { wavHeader } from "./ttsService.js";

const DEFAULT_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

export interface AliyunSynthesisResult {
  data: Buffer;
  format: string;
  sampleRate: number;
  mimeType: string;
}

function mimeFor(format: string): string {
  if (format === "mp3") return "audio/mpeg";
  if (format === "wav" || format === "pcm") return "audio/wav";
  if (format === "opus" || format === "ogg") return "audio/ogg";
  return "application/octet-stream";
}

function normalizeFormat(raw: string): string {
  const format = String(raw || "pcm").toLowerCase();
  if (format === "ogg_opus") return "opus";
  return format;
}

export async function synthesizeAliyun(
  settings: Record<string, any>,
  text: string,
): Promise<AliyunSynthesisResult> {
  const apiKey = String(settings.ttsAliyunApiKey || "");
  if (!apiKey) throw Object.assign(new Error("阿里云 CosyVoice API Key 未配置"), { statusCode: 503 });
  const wsUrl = String(settings.ttsAliyunWsUrl || DEFAULT_WS_URL);
  const model = String(settings.ttsAliyunModel || "cosyvoice-v3-flash");
  const voice = String(settings.ttsAliyunVoice || "longanyang");
  const format = normalizeFormat(settings.ttsAliyunFormat || "pcm");
  const sampleRate = Number(settings.ttsAliyunSampleRate || 22050);
  const taskId = randomUUID();

  const socket = new WebSocket(wsUrl, {
    headers: {
      Authorization: `bearer ${apiKey}`,
      "X-DashScope-DataInspection": "enable",
    },
  });

  const audioChunks: Buffer[] = [];
  let started = false;
  let finished = false;
  let failure: Error | null = null;
  const waiters: Array<() => void> = [];

  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      audioChunks.push(Buffer.from(data as Buffer));
      return;
    }
    try {
      const payload = JSON.parse(data.toString());
      const event = String(payload?.header?.event || "");
      if (event === "task-started") {
        started = true;
        notify();
      } else if (event === "task-finished") {
        finished = true;
        notify();
      } else if (event === "task-failed") {
        failure = new Error(
          String(payload?.header?.error_message || payload?.header?.error_code || "Aliyun TTS task failed"),
        );
        finished = true;
        notify();
      }
    } catch {
      // ignore non-JSON frames
    }
  });

  const waitFor = async (predicate: () => boolean, timeoutMs: number, label: string) => {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Aliyun TTS ${label} timeout`)), timeoutMs);
      const check = () => {
        if (predicate()) {
          clearTimeout(timer);
          resolve();
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Aliyun TTS connect timeout")), 15_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  try {
    socket.send(
      JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model,
          parameters: {
            text_type: "PlainText",
            voice,
            format,
            sample_rate: sampleRate,
            volume: Number(settings.ttsAliyunVolume ?? 50),
            rate: Number(settings.ttsAliyunRate ?? 1),
            pitch: Number(settings.ttsAliyunPitch ?? 1),
            ...(settings.ttsAliyunInstruction
              ? { instruction: String(settings.ttsAliyunInstruction) }
              : {}),
          },
          input: {},
        },
      }),
    );
    await waitFor(() => started || Boolean(failure), 20_000, "start");
    if (failure) throw failure;

    socket.send(
      JSON.stringify({
        header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
        payload: { input: { text } },
      }),
    );
    socket.send(
      JSON.stringify({
        header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
        payload: { input: {} },
      }),
    );
    await waitFor(() => finished, 120_000, "finish");
    if (failure) throw failure;
  } finally {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }

  if (!audioChunks.length) throw new Error("Aliyun TTS returned no audio");
  const raw = Buffer.concat(audioChunks);
  if (format === "pcm") {
    return {
      data: Buffer.concat([wavHeader(raw.length, sampleRate), raw]),
      format: "wav",
      sampleRate,
      mimeType: "audio/wav",
    };
  }
  return {
    data: raw,
    format: format === "wav" ? "wav" : format,
    sampleRate,
    mimeType: mimeFor(format),
  };
}
