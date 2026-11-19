import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAudioCacheDir, getVoiceSegmentDir } from "../runtimePaths.js";
import { getSettings } from "./settingsService.js";
import { getAgent } from "./agentService.js";
import { getThread } from "./chatThreadService.js";
import { recordTtsUsage } from "./usageService.js";
import { sanitizeTtsText } from "./ttsText.js";
import {
  normalizeEmotionSquareBrackets,
  providerKeepsEmotionTags,
  stripFishTags,
} from "./ttsTags.js";
import { synthesizeVolcengine } from "./volcengineTts.js";
import { synthesizeAliyun } from "./aliyunTts.js";
import {
  appendLiveTtsChunk,
  createLiveTtsSegment,
  failLiveTtsSegment,
  finishLiveTtsSegment,
  type LiveTtsSegmentMeta,
} from "./liveTtsStore.js";

export interface TtsRequest {
  text: string;
  messageId?: string | null;
  sessionId?: number | null;
  agentId?: number | null;
  turnId?: string | null;
  taskId?: string | null;
}

export interface TtsSegment {
  segmentId: string;
  path: string;
  audioUrl: string;
  mimeType: string;
  format: string;
  text: string;
  seq: number;
  sampleRate: number;
  createdAt: number;
}

const MIME_MAP: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  opus: "audio/ogg",
  flac: "audio/flac",
  pcm: "audio/l16",
};

const liveSegments = new Map<string, TtsSegment>();

export function mimeForFormat(format: string, sampleRate = 24000): string {
  const mime = MIME_MAP[format] || "application/octet-stream";
  return format === "pcm" ? `${mime};rate=${sampleRate}` : mime;
}

export function formatFromMime(mimeType: string): string {
  const lower = String(mimeType || "").toLowerCase();
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("aac")) return "aac";
  if (lower.includes("ogg") || lower.includes("opus")) return "opus";
  if (lower.includes("flac")) return "flac";
  if (lower.includes("l16") || lower.includes("pcm")) return "pcm";
  return "mp3";
}

export function wavHeader(dataLength: number, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

export function normalizeWavBytes(data: Buffer, sampleRate = 24000): Buffer {
  if (
    data.length < 12 ||
    data.subarray(0, 4).toString("ascii") !== "RIFF" ||
    data.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    return Buffer.concat([wavHeader(data.length, sampleRate), data]);
  }
  const normalized = Buffer.from(data);
  normalized.writeUInt32LE(Math.max(0, normalized.length - 8), 4);
  let offset = 12;
  while (offset + 8 <= normalized.length) {
    const chunkId = normalized.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = normalized.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      normalized.writeUInt32LE(Math.max(0, normalized.length - dataStart), offset + 4);
      break;
    }
    const next = dataStart + chunkSize + (chunkSize % 2);
    if (next <= offset) break;
    offset = next;
  }
  return normalized;
}

function wavSampleRate(data: Buffer): number | null {
  if (data.length < 28) return null;
  if (data.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  const rate = data.readUInt32LE(24);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 1) return present[0];
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

interface SynthResult {
  data: Buffer;
  format: string;
  sampleRate: number;
  mimeType: string;
}

export interface TtsStreamHandle {
  provider: string;
  format: string;
  sampleRate: number;
  mimeType: string;
  chunks: AsyncGenerator<Buffer, void, unknown>;
  finalize: (collected: Buffer) => SynthResult;
}

async function* readResponseBody(response: Response): AsyncGenerator<Buffer> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) yield Buffer.from(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // upstream already closed
    }
  }
}

function streamFinalizer(format: string, sampleRate: number): (collected: Buffer) => SynthResult {
  const normalized = format.toLowerCase();
  if (normalized === "pcm" || normalized === "raw") {
    return (collected) => ({
      data: Buffer.concat([wavHeader(collected.length, sampleRate), collected]),
      format: "wav",
      sampleRate,
      mimeType: "audio/wav",
    });
  }
  if (normalized === "wav") {
    return (collected) => ({
      data: normalizeWavBytes(collected, sampleRate),
      format: "wav",
      sampleRate,
      mimeType: "audio/wav",
    });
  }
  return (collected) => ({
    data: collected,
    format: normalized,
    sampleRate,
    mimeType: mimeForFormat(normalized, sampleRate),
  });
}

async function prepareStreamHandle(input: {
  provider: string;
  format: string;
  sampleRate: number;
  source: AsyncGenerator<Buffer, void, unknown>;
}): Promise<TtsStreamHandle> {
  let format = input.format.toLowerCase();
  if (format === "mpeg") format = "mp3";
  let sampleRate = input.sampleRate;
  let first: Buffer | null = null;
  while (true) {
    const { done, value } = await input.source.next();
    if (done) break;
    if (value?.length) {
      first = value;
      break;
    }
  }
  if (!first) {
    throw Object.assign(new Error("TTS 未返回音频"), { statusCode: 502 });
  }
  if ((format === "pcm" || format === "raw") && first.subarray(0, 4).toString("ascii") === "RIFF") {
    format = "wav";
  }
  if (format === "wav") {
    sampleRate = wavSampleRate(first) || sampleRate;
  }
  const mimeType = format === "wav" ? "audio/wav" : mimeForFormat(format, sampleRate);
  const prepended = (async function* () {
    yield first as Buffer;
    yield* input.source;
  })();
  return {
    provider: input.provider,
    format,
    sampleRate,
    mimeType,
    chunks: prepended,
    finalize: streamFinalizer(format, sampleRate),
  };
}

function isRecognizedAudio(data: Buffer): boolean {
  if (data.length < 4) return false;
  return (
    data.subarray(0, 3).toString("ascii") === "ID3" ||
    data.subarray(0, 4).toString("ascii") === "RIFF" ||
    data.subarray(0, 4).toString("ascii") === "OggS" ||
    (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
  );
}

function activeProvider(settings: Record<string, any>): string {
  return String(settings.ttsActiveProvider || "openai_compat").trim().toLowerCase();
}

/**
 * Inline `[]` emotion tags are only understood by Fish Audio and Xiaomi MiMo
 * (emotion mode). Every other provider would read them out loud, so they are
 * stripped before the text reaches the wire. The existing markdown cleanup
 * (`sanitizeTtsText`) always runs afterwards, unchanged.
 */
function prepareTtsText(
  text: string,
  provider: string,
  settings: Record<string, any>,
): string {
  const raw = String(text || "");
  const prepared = providerKeepsEmotionTags(provider, settings)
    ? normalizeEmotionSquareBrackets(raw)
    : stripFishTags(raw);
  return sanitizeTtsText(prepared);
}

function providerBase(baseUrl: string): string {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function resolveTtsAgentId(
  agentId?: number | null,
  sessionId?: number | null,
): number | null {
  if (agentId) return Number(agentId);
  if (!sessionId) return null;
  return getThread(Number(sessionId))?.agent_id ?? null;
}

export function resolveAgentTtsVoice(
  agentId?: number | null,
  sessionId?: number | null,
  explicitVoice?: string | null,
): string | null {
  const explicit = String(explicitVoice || "").trim();
  if (explicit) return explicit;
  const id = resolveTtsAgentId(agentId, sessionId);
  if (!id) return null;
  const voice = String(getAgent(id)?.voice || "").trim();
  return voice || null;
}

function withVoiceOverride(
  settings: Record<string, any>,
  key: string,
  voice: string | null,
): Record<string, any> {
  return voice ? { ...settings, [key]: voice } : settings;
}

async function requestOpenAICompatSpeech(
  settings: Record<string, any>,
  text: string,
  signal: AbortSignal,
  voiceOverride?: string | null,
): Promise<{ response: Response; format: string }> {
  const baseUrl = String(settings.ttsOpenaiCompatBaseUrl || "").replace(/\/+$/, "");
  const apiKey = String(settings.ttsOpenaiCompatApiKey || "");
  const model = String(settings.ttsOpenaiCompatModel || settings.ttsModel || "");
  if (!baseUrl || !model) throw Object.assign(new Error("OpenAI 兼容 TTS 未配置"), { statusCode: 503 });
  const format = String(settings.ttsOpenaiCompatDefaultFormat || settings.ttsDefaultFormat || "mp3");
  const body = {
    model,
    input: text,
    voice: String(voiceOverride || settings.ttsOpenaiCompatDefaultVoice || settings.ttsDefaultVoice || "alloy"),
    response_format: format,
    speed: Number(settings.ttsOpenaiCompatDefaultSpeed ?? settings.ttsDefaultSpeed ?? 1),
    seed: Number(settings.ttsOpenaiCompatDefaultSeed ?? settings.ttsDefaultSeed ?? -1),
    cfg_value: Number(settings.ttsOpenaiCompatDefaultCfg ?? settings.ttsDefaultCfg ?? 1),
    inference_timesteps: Number(
      settings.ttsOpenaiCompatDefaultTimesteps ?? settings.ttsDefaultTimesteps ?? 10,
    ),
  };
  const response = await fetch(`${providerBase(baseUrl)}/audio/speech`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(new Error(`TTS 请求失败 (${response.status}) ${detail.slice(0, 200)}`), {
      statusCode: 502,
    });
  }
  return { response, format };
}

async function synthesizeOpenAICompat(
  settings: Record<string, any>,
  text: string,
  voiceOverride?: string | null,
): Promise<SynthResult> {
  const { response, format } = await requestOpenAICompatSpeech(
    settings,
    text,
    AbortSignal.timeout(120_000),
    voiceOverride,
  );
  const raw = Buffer.from(await response.arrayBuffer());
  const contentType = String(response.headers.get("content-type") || "");
  const upstreamFormat = String(response.headers.get("x-audio-format") || "").toLowerCase();
  const sampleRate = Number(response.headers.get("x-sample-rate") || 24000);
  const detected = upstreamFormat || format;
  if (detected === "pcm" || (!isRecognizedAudio(raw) && format !== "mp3")) {
    return {
      data: Buffer.concat([wavHeader(raw.length, sampleRate), raw]),
      format: "wav",
      sampleRate,
      mimeType: "audio/wav",
    };
  }
  const finalFormat = formatFromMime(contentType) !== "mp3" ? formatFromMime(contentType) : detected;
  return { data: raw, format: finalFormat, sampleRate, mimeType: mimeForFormat(finalFormat, sampleRate) };
}

async function startOpenAICompatStream(
  settings: Record<string, any>,
  text: string,
  signal: AbortSignal,
  voiceOverride?: string | null,
): Promise<TtsStreamHandle> {
  const { response, format } = await requestOpenAICompatSpeech(settings, text, signal, voiceOverride);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  let declared = String(response.headers.get("x-audio-format") || format).toLowerCase();
  if (contentType.includes("wav")) declared = "wav";
  else if (contentType.includes("mpeg") || contentType.includes("mp3")) declared = "mp3";
  else if (contentType.includes("ogg") || contentType.includes("opus")) declared = "opus";
  else if (contentType.includes("aac")) declared = "aac";
  else if (contentType.includes("flac")) declared = "flac";
  const headerRate = Number(response.headers.get("x-sample-rate") || 0);
  return prepareStreamHandle({
    provider: "openai_compat",
    format: declared,
    sampleRate: headerRate > 0 ? headerRate : 24000,
    source: readResponseBody(response),
  });
}

async function requestXiaomoSpeech(
  settings: Record<string, any>,
  text: string,
  signal: AbortSignal,
  voiceOverride?: string | null,
): Promise<Response> {
  const baseUrl = String(settings.ttsXiaomoMimoBaseUrl || "").replace(/\/+$/, "");
  const apiKey = String(settings.ttsXiaomoMimoApiKey || "");
  const model = String(settings.ttsXiaomoMimoModel || "");
  if (!baseUrl || !apiKey || !model) {
    throw Object.assign(new Error("小米 MIMO TTS 未配置"), { statusCode: 503 });
  }
  const mode = String(settings.ttsXiaomoMimoMode || "voice_clone");
  const voice =
    mode === "preset"
      ? String(voiceOverride || settings.ttsXiaomoMimoPresetVoiceName || "冰糖")
      : String(settings.ttsXiaomoMimoRefVoicePath || "");
  const prompt =
    mode === "voice_design"
      ? String(settings.ttsXiaomoMimoDesignPrompt || "")
      : String(settings.ttsXiaomoMimoDirectorPrompt || "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "user", content: prompt || "请自然朗读下面这段文字。" },
        { role: "assistant", content: text },
      ],
      audio: {
        format: "pcm16",
        ...(mode === "preset" ? { voice } : { optimize_text_preview: true }),
      },
      stream: true,
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(new Error(`小米 TTS 请求失败 (${response.status}) ${detail.slice(0, 200)}`), {
      statusCode: 502,
    });
  }
  return response;
}

async function* readXiaomoAudio(response: Response): AsyncGenerator<Buffer> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeLine = (line: string): Buffer | null => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return null;
    try {
      const json = JSON.parse(payload);
      const data = json.choices?.[0]?.delta?.audio?.data;
      return typeof data === "string" && data ? Buffer.from(data, "base64") : null;
    } catch {
      return null;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const chunk = consumeLine(line);
        if (chunk?.length) yield chunk;
      }
    }
    const trailing = consumeLine(buffer);
    if (trailing?.length) yield trailing;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // upstream already closed
    }
  }
}

async function synthesizeXiaomo(
  settings: Record<string, any>,
  text: string,
  voiceOverride?: string | null,
): Promise<SynthResult> {
  const response = await requestXiaomoSpeech(
    settings,
    text,
    AbortSignal.timeout(120_000),
    voiceOverride,
  );
  const audioChunks: Buffer[] = [];
  for await (const chunk of readXiaomoAudio(response)) audioChunks.push(chunk);
  if (!audioChunks.length) throw Object.assign(new Error("小米 TTS 未返回音频"), { statusCode: 502 });
  const pcm = Buffer.concat(audioChunks);
  return {
    data: Buffer.concat([wavHeader(pcm.length, 24000), pcm]),
    format: "wav",
    sampleRate: 24000,
    mimeType: "audio/wav",
  };
}

async function startXiaomoStream(
  settings: Record<string, any>,
  text: string,
  signal: AbortSignal,
  voiceOverride?: string | null,
): Promise<TtsStreamHandle> {
  const response = await requestXiaomoSpeech(settings, text, signal, voiceOverride);
  return prepareStreamHandle({
    provider: "xiaomo_mimo",
    format: "pcm",
    sampleRate: 24000,
    source: readXiaomoAudio(response),
  });
}

function fishSpeechRequest(settings: Record<string, any>, text: string, voiceOverride?: string | null) {
  const baseUrl = String(settings.ttsFishAudioBaseUrl || "").replace(/\/+$/, "");
  const apiKey = String(settings.ttsFishAudioApiKey || "");
  const model = String(settings.ttsFishAudioModel || "");
  if (!baseUrl || !apiKey || !model) {
    throw Object.assign(new Error("Fish Audio TTS 未配置"), { statusCode: 503 });
  }
  const format = String(settings.ttsFishAudioFormat || "mp3").toLowerCase();
  const referenceId = String(voiceOverride || settings.ttsFishAudioReferenceId || "").trim();
  return {
    url: `${baseUrl}/tts`,
    format,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        model,
      },
      body: JSON.stringify({
        text,
        format,
        latency: String(settings.ttsFishAudioLatency || "balanced"),
        ...(referenceId ? { reference_id: referenceId } : {}),
      }),
    } satisfies RequestInit,
  };
}

async function requestFishSpeech(
  settings: Record<string, any>,
  text: string,
  signal: AbortSignal,
  voiceOverride?: string | null,
): Promise<{ response: Response; format: string }> {
  const request = fishSpeechRequest(settings, text, voiceOverride);
  const response = await fetch(request.url, { ...request.init, signal });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(new Error(`Fish TTS 请求失败 (${response.status}) ${detail.slice(0, 200)}`), {
      statusCode: 502,
    });
  }
  return { response, format: request.format };
}

async function synthesizeFish(
  settings: Record<string, any>,
  text: string,
  voiceOverride?: string | null,
): Promise<SynthResult> {
  const { response, format } = await requestFishSpeech(
    settings,
    text,
    AbortSignal.timeout(120_000),
    voiceOverride,
  );
  const raw = Buffer.from(await response.arrayBuffer());
  if (format === "pcm" || format === "raw") {
    return {
      data: Buffer.concat([wavHeader(raw.length, 44100), raw]),
      format: "wav",
      sampleRate: 44100,
      mimeType: "audio/wav",
    };
  }
  if (format === "wav") {
    return {
      data: normalizeWavBytes(raw, 44100),
      format: "wav",
      sampleRate: 44100,
      mimeType: "audio/wav",
    };
  }
  return { data: raw, format, sampleRate: 44100, mimeType: mimeForFormat(format) };
}

async function startFishStream(
  settings: Record<string, any>,
  text: string,
  signal: AbortSignal,
  voiceOverride?: string | null,
): Promise<TtsStreamHandle> {
  const { response, format } = await requestFishSpeech(settings, text, signal, voiceOverride);
  return prepareStreamHandle({
    provider: "fish_audio",
    format,
    sampleRate: 44100,
    source: readResponseBody(response),
  });
}

async function synthesizeWithProvider(
  settings: Record<string, any>,
  provider: string,
  text: string,
  voice: string | null = null,
): Promise<SynthResult> {
  if (provider === "openai_compat") return synthesizeOpenAICompat(settings, text, voice);
  if (provider === "xiaomo_mimo") return synthesizeXiaomo(settings, text, voice);
  if (provider === "fish_audio") return synthesizeFish(settings, text, voice);
  if (provider === "volcengine") {
    return synthesizeVolcengine(withVoiceOverride(settings, "ttsVolcengineSpeakerId", voice), text);
  }
  if (provider === "aliyun_cosyvoice" || provider === "aliyun") {
    return synthesizeAliyun(withVoiceOverride(settings, "ttsAliyunVoice", voice), text);
  }
  throw Object.assign(new Error(`TTS provider not implemented in node backend yet: ${provider}`), {
    statusCode: 503,
  });
}

export async function synthesizeText(
  text: string,
  options: {
    provider?: string;
    agentId?: number | null;
    sessionId?: number | null;
    voice?: string | null;
    /** 仅用于设置页试听：用未保存的表单配置覆盖当前设置，不落库。 */
    settingsOverride?: Record<string, any>;
    /** 设置页试听不计入用量统计。 */
    recordUsage?: boolean;
  } = {},
): Promise<{ data: Buffer; format: string; sampleRate: number; mimeType: string; provider: string }> {
  const settings = { ...(getSettings() as Record<string, any>), ...(options.settingsOverride || {}) };
  const provider = String(options.provider || activeProvider(settings)).toLowerCase();
  const trimmed = prepareTtsText(text, provider, settings);
  if (!trimmed) throw Object.assign(new Error("text is empty"), { statusCode: 400 });
  const voice = resolveAgentTtsVoice(options.agentId, options.sessionId, options.voice);
  const result = await synthesizeWithProvider(settings, provider, trimmed, voice);
  if (options.recordUsage !== false) recordTtsUsage(provider, trimmed.length);
  return { ...result, provider };
}

export async function startTtsStream(
  text: string,
  options: {
    provider?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    agentId?: number | null;
    sessionId?: number | null;
    voice?: string | null;
  } = {},
): Promise<TtsStreamHandle> {
  const settings = getSettings() as Record<string, any>;
  const provider = String(options.provider || activeProvider(settings)).toLowerCase();
  const trimmed = prepareTtsText(text, provider, settings);
  if (!trimmed) throw Object.assign(new Error("text is empty"), { statusCode: 400 });
  const voice = resolveAgentTtsVoice(options.agentId, options.sessionId, options.voice);
  const signal = combineAbortSignals([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? 600_000),
  ]);
  if (provider === "fish_audio") return startFishStream(settings, trimmed, signal, voice);
  if (provider === "openai_compat") return startOpenAICompatStream(settings, trimmed, signal, voice);
  if (provider === "xiaomo_mimo") return startXiaomoStream(settings, trimmed, signal, voice);
  const result = await synthesizeWithProvider(settings, provider, trimmed, voice);
  return {
    provider,
    format: result.format,
    sampleRate: result.sampleRate,
    mimeType: result.mimeType,
    chunks: (async function* () {
      yield result.data;
    })(),
    finalize: (collected) => ({
      data: collected,
      format: result.format,
      sampleRate: result.sampleRate,
      mimeType: result.mimeType,
    }),
  };
}

export async function* streamTtsSegment(
  handle: TtsStreamHandle,
  options: { text: string; seq?: number; messageId?: string | null },
): AsyncGenerator<{ type: "segment"; segment: LiveTtsSegmentMeta }, TtsSegment> {
  const seq = options.seq ?? 1;
  let spokenText = "";
  try {
    spokenText = prepareTtsText(options.text, handle.provider, getSettings() as Record<string, any>);
  } catch {
    spokenText = sanitizeTtsText(options.text);
  }
  if (!spokenText) spokenText = options.text;
  const segment = createLiveTtsSegment({
    format: handle.format,
    sampleRate: handle.sampleRate,
    mimeType: handle.mimeType,
    text: spokenText,
    seq,
    messageId: options.messageId ?? null,
  });
  const collected: Buffer[] = [];
  let announced = false;
  let completed = false;
  try {
    for await (const chunk of handle.chunks) {
      if (!chunk.length) continue;
      collected.push(chunk);
      appendLiveTtsChunk(segment.id, chunk);
      if (!announced) {
        announced = true;
        yield { type: "segment", segment };
      }
    }
    if (!collected.length) {
      throw Object.assign(new Error("TTS 未返回音频"), { statusCode: 502 });
    }
    const final = handle.finalize(Buffer.concat(collected));
    const filePath = path.join(getVoiceSegmentDir(), `${segment.id}.${final.format || "wav"}`);
    try {
      fs.writeFileSync(filePath, final.data);
    } catch {
      // Live playback can finish from memory even if persistence fails.
    }
    if (options.messageId) {
      try {
        saveMessageAudio(options.messageId, final.data, final.format);
      } catch {
        // message audio cache is best-effort
      }
    }
    finishLiveTtsSegment(segment.id);
    completed = true;
    try {
      recordTtsUsage(handle.provider, spokenText.length);
    } catch {
      // usage accounting is best-effort
    }
    return {
      segmentId: segment.id,
      path: filePath,
      audioUrl: `/api/voice/tts/segments/${segment.id}`,
      mimeType: final.mimeType,
      format: final.format,
      text: spokenText,
      seq,
      sampleRate: final.sampleRate,
      createdAt: segment.createdAt,
    };
  } catch (error) {
    failLiveTtsSegment(segment.id, error);
    throw error;
  } finally {
    if (!completed) {
      failLiveTtsSegment(segment.id, new Error("TTS 流已中断"));
    }
  }
}

export function saveMessageAudio(messageId: string, data: Buffer, format: string): string {
  const dir = getAudioCacheDir();
  for (const ext of ["mp3", "wav", "aac", "ogg", "flac"]) {
    const existing = path.join(dir, `${messageId}.${ext}`);
    if (fs.existsSync(existing)) {
      try {
        fs.unlinkSync(existing);
      } catch {
        // ignore
      }
    }
  }
  const target = path.join(dir, `${messageId}.${format}`);
  fs.writeFileSync(target, data);
  return target;
}

export function findMessageAudio(messageId: string): { path: string; mimeType: string } | null {
  const dir = getAudioCacheDir();
  for (const ext of ["mp3", "wav", "aac", "ogg", "flac"]) {
    const target = path.join(dir, `${messageId}.${ext}`);
    if (fs.existsSync(target)) {
      return { path: target, mimeType: mimeForFormat(ext) };
    }
  }
  return null;
}

export function storeSegment(input: {
  data: Buffer;
  format: string;
  mimeType: string;
  text: string;
  seq: number;
  sampleRate: number;
}): TtsSegment {
  const segmentId = randomUUID().replace(/-/g, "");
  const ext = input.format || "mp3";
  const filePath = path.join(getVoiceSegmentDir(), `${segmentId}.${ext}`);
  fs.writeFileSync(filePath, input.data);
  const segment: TtsSegment = {
    segmentId,
    path: filePath,
    audioUrl: `/api/voice/tts/segments/${segmentId}`,
    mimeType: input.mimeType,
    format: ext,
    text: input.text,
    seq: input.seq,
    sampleRate: input.sampleRate,
    createdAt: Date.now(),
  };
  liveSegments.set(segmentId, segment);
  return segment;
}

export function getSegment(segmentId: string): TtsSegment | null {
  const live = liveSegments.get(segmentId);
  if (live) return live;
  const dir = getVoiceSegmentDir();
  for (const ext of ["mp3", "wav", "aac", "ogg", "flac", "pcm"]) {
    const target = path.join(dir, `${segmentId}.${ext}`);
    if (fs.existsSync(target)) {
      return {
        segmentId,
        path: target,
        audioUrl: `/api/voice/tts/segments/${segmentId}`,
        mimeType: mimeForFormat(ext),
        format: ext,
        text: "",
        seq: 1,
        sampleRate: 24000,
        createdAt: fs.statSync(target).mtimeMs,
      };
    }
  }
  return null;
}

export async function listTtsVoices(params: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<{ statusCode: number; body: unknown }> {
  const settings = getSettings() as Record<string, any>;
  const provider = activeProvider(settings);
  if (provider === "openai_compat") {
    const baseUrl = String(params.baseUrl || settings.ttsOpenaiCompatBaseUrl || "").replace(/\/+$/, "");
    const apiKey = params.apiKey || String(settings.ttsOpenaiCompatApiKey || "");
    if (!baseUrl) return { statusCode: 200, body: { voices: [] } };
    try {
      const res = await fetch(`${providerBase(baseUrl)}/voices`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      try {
        return { statusCode: 200, body: JSON.parse(text) };
      } catch {
        return { statusCode: 200, body: { error: text.slice(0, 500) } };
      }
    } catch (error) {
      return {
        statusCode: 200,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }
  if (provider === "volcengine") {
    return {
      statusCode: 200,
      body: {
        Speakers: [
          { VoiceType: "zh_female_shuangkuaisisi_moon_bigtts", Name: "爽快思思", Gender: "female" },
          { VoiceType: "zh_male_wennuanahu_moon_bigtts", Name: "温暖阿虎", Gender: "male" },
          { VoiceType: "zh_female_wanwanxiaohe_moon_bigtts", Name: "湾湾小何", Gender: "female" },
          { VoiceType: "zh_male_yangguangqingnian_moon_bigtts", Name: "阳光青年", Gender: "male" },
        ],
      },
    };
  }
  if (provider === "xiaomo_mimo") {
    return {
      statusCode: 200,
      body: { preset_voices: ["冰糖", "茉莉", "苏打", "白桦", "Chloe", "Mia", "Milo", "Dean"] },
    };
  }
  if (provider === "fish_audio") {
    return { statusCode: 200, body: { data: [] } };
  }
  return { statusCode: 501, body: { detail: "TTS voices not supported for this provider" } };
}

export function buildTtsEvents(input: {
  segment: TtsSegment;
  sessionId?: number | null;
  messageId?: string | null;
  eventSequence?: number;
  cached?: boolean;
  text?: string;
}) {
  const sequence = input.eventSequence ?? 1;
  const segmentEvent = {
    type: "tts_segment",
    eventId: randomUUID(),
    sessionId: input.sessionId ?? null,
    turnId: null,
    taskId: null,
    eventSequence: sequence,
    timestamp: new Date().toISOString(),
    content: null,
    metadata: {
      segmentId: input.cached ? `cache-${input.messageId || input.segment.segmentId}` : input.segment.segmentId,
      audioUrl: input.cached
        ? `/api/voice/tts/messages/${input.messageId}/audio`
        : input.segment.audioUrl,
      audioBase64: input.cached
        ? fs.readFileSync(input.segment.path).toString("base64")
        : undefined,
      mimeType: input.segment.mimeType,
      format: input.segment.format,
      seq: input.segment.seq,
      text: input.text ?? input.segment.text,
      sampleRate: input.segment.sampleRate,
    },
    messageId: input.messageId ?? null,
  };
  const stopEvent = {
    type: "tts_stop",
    eventId: randomUUID(),
    sessionId: input.sessionId ?? null,
    turnId: null,
    taskId: null,
    eventSequence: sequence + 1,
    timestamp: new Date().toISOString(),
    content: null,
    metadata: {},
    messageId: input.messageId ?? null,
  };
  return { segmentEvent, stopEvent };
}
