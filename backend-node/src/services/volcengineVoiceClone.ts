import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CLONE_URL = "https://openspeech.bytedance.com/api/v3/tts/voice_clone";
const GET_VOICE_URL = "https://openspeech.bytedance.com/api/v3/tts/get_voice";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const READY_STATUSES = new Set([2, 4]);

const FORMAT_BY_EXT: Record<string, string> = {
  ".wav": "wav",
  ".mp3": "mp3",
  ".ogg": "ogg",
  ".m4a": "m4a",
  ".aac": "aac",
  ".pcm": "pcm",
};

const TRAIN_ATTEMPTS: [string, number][] = [
  ["seed-icl-2.0", 4],
  ["seed-icl-2.0", 5],
  ["seed-icl-1.0", 1],
  ["seed-icl-1.0-concurr", 1],
];

function cloneResourceId(resourceId: string): string {
  return resourceId?.startsWith("seed-icl-") ? resourceId : "seed-icl-2.0";
}

function headers(apiKey: string, resourceId: string) {
  if (!apiKey) throw Object.assign(new Error("Volcengine API Key is required."), { statusCode: 400 });
  return {
    "content-type": "application/json",
    "X-Api-Key": apiKey,
    "X-Api-Request-Id": randomUUID(),
    "X-Api-Resource-Id": cloneResourceId(resourceId),
  };
}

function speakerQuery(slot: string) {
  const cleaned = String(slot || "").replace(/\s+/g, "");
  if (!cleaned) throw Object.assign(new Error("预付费音色槽位 (S_xxx) 不能为空。"), { statusCode: 400 });
  if (cleaned === "custom_speaker_id") {
    throw Object.assign(new Error("仅支持预付费音色槽位，请在火山控制台申请 S_ 开头的 speaker_id。"), {
      statusCode: 400,
    });
  }
  return { speaker_id: cleaned };
}

function readAudioPayload(filePath: string) {
  if (!filePath) throw Object.assign(new Error("Reference voice file path is empty."), { statusCode: 400 });
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`Reference voice file not found: ${filePath}`), { statusCode: 400 });
  }
  const data = fs.readFileSync(filePath);
  if (!data.length) throw Object.assign(new Error(`Reference voice file is empty: ${filePath}`), { statusCode: 400 });
  if (data.length > MAX_AUDIO_BYTES) {
    throw Object.assign(new Error("Reference audio exceeds 10MB limit."), { statusCode: 400 });
  }
  const ext = path.extname(filePath).toLowerCase();
  const format = FORMAT_BY_EXT[ext];
  if (!format) {
    throw Object.assign(
      new Error(`Unsupported reference audio format '${ext}'. Supported: wav, mp3, ogg, m4a, aac, pcm.`),
      { statusCode: 400 },
    );
  }
  const audio: Record<string, string> = { data: data.toString("base64") };
  if (format === "pcm" || format === "m4a") audio.format = format;
  return audio;
}

function orderedAttempts(preferred: string): [string, number][] {
  const resolved = cloneResourceId(preferred);
  const ordered: [string, number][] = [];
  const seen = new Set<string>();
  const add = (resourceId: string, modelType: number) => {
    const key = `${resourceId}:${modelType}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push([resourceId, modelType]);
  };
  for (const [resourceId, modelType] of TRAIN_ATTEMPTS) {
    if (resourceId === resolved) add(resourceId, modelType);
  }
  for (const [resourceId, modelType] of TRAIN_ATTEMPTS) add(resourceId, modelType);
  return ordered;
}

async function postOnce(url: string, apiKey: string, resourceId: string, payload: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: headers(apiKey, resourceId),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  let data: Record<string, any> = {};
  try {
    data = (await response.json()) as Record<string, any>;
  } catch {
    throw Object.assign(new Error(`Volcengine voice clone returned invalid JSON (${response.status})`), {
      statusCode: response.status || 502,
    });
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(String(data.message || data.error || `Voice clone HTTP ${response.status}`)),
      { statusCode: response.status, payload: data },
    );
  }
  const code = data.code;
  if (code !== undefined && code !== null && ![0, 20000000, "0"].includes(code)) {
    throw Object.assign(new Error(String(data.message || "Volcengine voice clone request failed")), {
      statusCode: 502,
      payload: data,
    });
  }
  return data;
}

async function postCloneApi(
  apiKey: string,
  payload: Record<string, unknown>,
  preferredResourceId: string,
  action: "train" | "status",
) {
  let lastMismatch: any = null;
  for (const [resourceId, modelType] of orderedAttempts(preferredResourceId)) {
    try {
      const attemptPayload = action === "train" ? { ...payload, model_type: modelType } : payload;
      const data = await postOnce(action === "train" ? CLONE_URL : GET_VOICE_URL, apiKey, resourceId, attemptPayload);
      return { data, resourceId, modelType };
    } catch (error: any) {
      const text = String(error?.message || "").toLowerCase();
      if (text.includes("mismatched") || text.includes("55000000")) {
        lastMismatch = error;
        continue;
      }
      throw error;
    }
  }
  throw lastMismatch || Object.assign(new Error("Volcengine voice clone request failed."), { statusCode: 400 });
}

export async function trainVolcengineVoiceClone(input: {
  apiKey: string;
  resourceId: string;
  refVoicePath: string;
  cloneSpeakerSlot: string;
  referenceText?: string;
  language?: number;
  demoText?: string;
  enableDenoise?: boolean;
  disableVolumeNorm?: boolean;
}) {
  const payload: Record<string, unknown> = {
    ...speakerQuery(input.cloneSpeakerSlot),
    audio: readAudioPayload(input.refVoicePath),
    language: input.language ?? 0,
  };
  if (input.referenceText?.trim()) payload.text = input.referenceText.trim();
  const extraParams: Record<string, unknown> = {
    enable_audio_denoise: Boolean(input.enableDenoise),
    disable_volume_normalization: Boolean(input.disableVolumeNorm),
  };
  if (input.demoText?.trim()) extraParams.demo_text = input.demoText.trim();
  payload.extra_params = extraParams;
  return postCloneApi(input.apiKey, payload, input.resourceId, "train");
}

export async function getVolcengineVoiceStatus(input: {
  apiKey: string;
  resourceId: string;
  cloneSpeakerSlot: string;
  modelType?: number;
}) {
  return postCloneApi(input.apiKey, speakerQuery(input.cloneSpeakerSlot), input.resourceId, "status");
}

export async function pollVolcengineVoiceReady(input: {
  apiKey: string;
  resourceId: string;
  cloneSpeakerSlot: string;
  modelType?: number;
  timeoutSec?: number;
  intervalSec?: number;
}) {
  const deadline = Date.now() + (input.timeoutSec ?? 120) * 1000;
  let last: any = {};
  let matchedResource = input.resourceId;
  let matchedModelType = input.modelType ?? 4;
  while (Date.now() < deadline) {
    const { data, resourceId, modelType } = await getVolcengineVoiceStatus({
      apiKey: input.apiKey,
      resourceId: matchedResource,
      cloneSpeakerSlot: input.cloneSpeakerSlot,
      modelType: input.modelType,
    });
    last = data;
    matchedResource = resourceId;
    matchedModelType = modelType;
    const status = Number(data.status ?? -1);
    if (READY_STATUSES.has(status)) return { data, resourceId, modelType };
    if (status === 3) {
      throw Object.assign(new Error(String(data.message || "Voice clone training failed")), {
        statusCode: 400,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, (input.intervalSec ?? 2) * 1000));
  }
  if (Number(last.status ?? -1) === 1) return { data: last, resourceId: matchedResource, modelType: matchedModelType };
  throw Object.assign(new Error("Voice clone training timed out while polling status."), {
    statusCode: 408,
  });
}

export function voiceCloneResponse(input: {
  status: number;
  speakerId: string;
  resourceId: string;
  modelType: number;
  message: string;
  data: Record<string, any>;
}) {
  return {
    status: input.status,
    ready: READY_STATUSES.has(input.status),
    speaker_id: input.speakerId,
    resource_id: input.resourceId,
    model_type: input.modelType,
    message: input.message,
    available_training_times: input.data.available_training_times,
    demo_audio: input.data.demo_audio,
    create_time: input.data.create_time,
    language: input.data.language,
  };
}
