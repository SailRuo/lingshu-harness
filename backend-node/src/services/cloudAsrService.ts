/**
 * Cloud speech recognition providers (Xiaomi MiMo / Aliyun DashScope).
 *
 * Both speak an OpenAI-compatible `chat/completions` shape with the audio sent
 * as a base64 WAV `input_audio` part, so one HTTP path covers them. Aliyun's
 * realtime model additionally exposes the OpenAI-realtime style websocket
 * (`session.update` / `input_audio_buffer.append` / `session.finish`), which we
 * use when the configured model id says so.
 *
 * The desktop backend receives 16 kHz mono PCM16 from the renderer, so every
 * provider here consumes PCM and returns text.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { getSettings } from "./settingsService.js";
import { wavHeader } from "./ttsService.js";

export type AsrProvider = "local" | "xiaomi" | "aliyun";
export type AsrLanguage = "auto" | "zh" | "en";

export const ASR_PROVIDERS: AsrProvider[] = ["local", "xiaomi", "aliyun"];

export const ASR_PROVIDER_LABELS: Record<AsrProvider, string> = {
  local: "本地模型",
  xiaomi: "小米 MiMo",
  aliyun: "阿里云",
};

export const ASR_DEFAULTS = {
  xiaomiBaseUrl: "https://api.xiaomimimo.com/v1",
  xiaomiModel: "mimo-v2.5-asr",
  aliyunHttpBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  aliyunWsUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
  aliyunModel: "qwen3-asr-flash-realtime",
} as const;

const SAMPLE_RATE = 16000;
const MAX_UTTERANCE_SECONDS = 60;
const MAX_UTTERANCE_BYTES = SAMPLE_RATE * 2 * MAX_UTTERANCE_SECONDS;
const HTTP_TIMEOUT_MS = 60_000;
const REALTIME_SESSION_TIMEOUT_MS = 12_000;
const REALTIME_FINISH_TIMEOUT_MS = 20_000;

export interface AsrCloudConfig {
  provider: AsrProvider;
  language: AsrLanguage;
  xiaomi: {
    baseUrl: string;
    apiKey: string;
    model: string;
    language: AsrLanguage;
  };
  aliyun: {
    httpBaseUrl: string;
    wsUrl: string;
    apiKey: string;
    model: string;
    language: AsrLanguage;
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeProvider(raw: unknown): AsrProvider {
  const value = String(raw || "").trim().toLowerCase();
  return value === "xiaomi" || value === "aliyun" ? value : "local";
}

function normalizeLanguage(raw: unknown, fallback: AsrLanguage = "auto"): AsrLanguage {
  const value = String(raw || "").trim().toLowerCase();
  return value === "zh" || value === "en" || value === "auto" ? value : fallback;
}

export function isAliyunRealtimeModel(model: string): boolean {
  return /^qwen3-asr-flash-realtime(?:-|$)/i.test(model.trim());
}

/** Speech profile stored in Settings → 语音识别. */
export function resolveAsrConfig(): AsrCloudConfig {
  const settings = getSettings() as Record<string, any>;
  const rawProvider = normalizeProvider(settings.asrProvider);
  const provider = rawProvider;

  // Users who already configured the same vendor for TTS should not have to
  // paste the key twice; fall back to that key when the ASR slot is empty.
  const xiaomiKey = String(settings.asrXiaomiApiKey || "").trim()
    || String(settings.ttsXiaomoMimoApiKey || "").trim();
  const aliyunKey = String(settings.asrAliyunApiKey || "").trim()
    || String(settings.ttsAliyunApiKey || "").trim();

  return {
    provider,
    language: normalizeLanguage(settings.asrLanguage),
    xiaomi: {
      baseUrl: trimSlash(String(settings.asrXiaomiBaseUrl || "").trim() || ASR_DEFAULTS.xiaomiBaseUrl),
      apiKey: xiaomiKey,
      model: String(settings.asrXiaomiModel || "").trim() || ASR_DEFAULTS.xiaomiModel,
      language: normalizeLanguage(settings.asrXiaomiLanguage, "zh"),
    },
    aliyun: {
      httpBaseUrl: trimSlash(String(settings.asrAliyunHttpBaseUrl || "").trim() || ASR_DEFAULTS.aliyunHttpBaseUrl),
      wsUrl: String(settings.asrAliyunWsUrl || "").trim() || ASR_DEFAULTS.aliyunWsUrl,
      apiKey: aliyunKey,
      model: String(settings.asrAliyunModel || "").trim() || ASR_DEFAULTS.aliyunModel,
      language: normalizeLanguage(settings.asrAliyunLanguage, "zh"),
    },
  };
}

export function asrProviderModel(config: AsrCloudConfig): string {
  if (config.provider === "xiaomi") return config.xiaomi.model;
  if (config.provider === "aliyun") return config.aliyun.model;
  return "";
}

export function asrProviderReady(config: AsrCloudConfig = resolveAsrConfig()): boolean {
  if (config.provider === "xiaomi") return Boolean(config.xiaomi.apiKey);
  if (config.provider === "aliyun") return Boolean(config.aliyun.apiKey);
  return false;
}

export function asrProviderMessage(config: AsrCloudConfig = resolveAsrConfig()): string {
  const label = ASR_PROVIDER_LABELS[config.provider];
  if (config.provider === "local") return "使用本地语音识别模型";
  if (!asrProviderReady(config)) return `请先在 设置 → 语音识别 中配置${label} API Key`;
  return `${label} ASR 已就绪（${asrProviderModel(config)}）`;
}

/**
 * Public configuration shape for the settings API. Keys intentionally stay in
 * plaintext (same policy as the existing TTS provider keys).
 */
export function asrConfigSnapshot() {
  const config = resolveAsrConfig();
  return {
    ...config,
    defaults: ASR_DEFAULTS,
    ready: config.provider === "local" ? null : asrProviderReady(config),
    message: config.provider === "local" ? "" : asrProviderMessage(config),
    providers: ASR_PROVIDERS.map((value) => ({ value, label: ASR_PROVIDER_LABELS[value] })),
  };
}

interface RecognizeOptions {
  onPartial?: (text: string) => void;
  signal?: AbortSignal;
}

function floatWavDataUrl(pcm: Buffer, sampleRate = SAMPLE_RATE): string {
  const wav = Buffer.concat([wavHeader(pcm.length, sampleRate, 1, 16), pcm]);
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function extractDelta(parsed: any): string {
  const choice = parsed?.choices?.[0];
  const fromDelta = extractText(choice?.delta?.content);
  if (fromDelta) return fromDelta;
  const fromMessage = extractText(choice?.message?.content);
  if (fromMessage) return fromMessage;
  if (typeof parsed?.text === "string") return parsed.text;
  if (typeof parsed?.output_text === "string") return parsed.output_text;
  if (typeof parsed?.result === "string") return parsed.result;
  return "";
}

function providerHttpTarget(config: AsrCloudConfig) {
  if (config.provider === "xiaomi") {
    const headers: Record<string, string> = {
      "api-key": config.xiaomi.apiKey,
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
    };
    return {
      url: `${config.xiaomi.baseUrl}/chat/completions`,
      headers,
      model: config.xiaomi.model,
      language: config.language !== "auto" ? config.language : config.xiaomi.language,
      asrOptions: (language: AsrLanguage) => ({
        language: language === "auto" ? config.xiaomi.language : language,
      }),
    };
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.aliyun.apiKey}`,
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
  };
  return {
    url: `${config.aliyun.httpBaseUrl}/chat/completions`,
    headers,
    model: config.aliyun.model,
    language: config.language !== "auto" ? config.language : config.aliyun.language,
    asrOptions: (language: AsrLanguage) => ({
      enable_itn: true,
      ...(language === "auto" ? {} : { language }),
    }),
  };
}

async function readSseText(
  response: Response,
  onDelta?: (text: string) => void,
): Promise<string> {
  if (!response.body) throw new Error("语音服务未返回可读流");
  const contentType = String(response.headers.get("content-type") || "");
  if (!contentType.includes("event-stream")) {
    const raw = await response.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw.trim();
    }
    const text = extractDelta(parsed).trim();
    if (text) onDelta?.(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed: any = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = extractDelta(parsed);
      if (!delta) continue;
      // Some gateways stream cumulative text, others stream deltas.
      full = delta.startsWith(full) ? delta : full + delta;
      onDelta?.(full);
    }
  }
  return full.trim();
}

async function recognizeViaHttp(
  pcm: Buffer,
  config: AsrCloudConfig,
  options: RecognizeOptions = {},
): Promise<string> {
  const target = providerHttpTarget(config);
  const language = target.language;
  const response = await fetch(target.url, {
    method: "POST",
    headers: target.headers,
    signal: options.signal,
    body: JSON.stringify({
      model: target.model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: floatWavDataUrl(pcm) },
            },
          ],
        },
      ],
      asr_options: target.asrOptions(language),
      stream: true,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${ASR_PROVIDER_LABELS[config.provider]} ASR 失败 (${response.status}): ${detail.slice(0, 300)}`,
    );
  }
  return readSseText(response, options.onPartial);
}

function realtimeEndpoint(wsUrl: string, model: string): string {
  let base = String(wsUrl || "").trim() || ASR_DEFAULTS.aliyunWsUrl;
  base = base.replace("/inference", "/realtime");
  return `${base}${base.includes("?") ? "&" : "?"}model=${encodeURIComponent(model)}`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Avoid "unhandled rejection" when the caller only awaits one side.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Aliyun Qwen realtime (OpenAI-realtime style events). */
class QwenRealtimeSession {
  private socket: WebSocket | null = null;
  private readonly ready = deferred<void>();
  private readonly finished = deferred<string>();
  private latest = "";
  private closed = false;
  private failure: Error | null = null;

  constructor(
    private readonly config: AsrCloudConfig,
    private readonly onPartial?: (text: string) => void,
  ) {}

  async open(): Promise<void> {
    if (!this.config.aliyun.apiKey) {
      throw new Error("未配置阿里云 ASR API Key");
    }
    const url = realtimeEndpoint(this.config.aliyun.wsUrl, this.config.aliyun.model);
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.config.aliyun.apiKey}` },
    });
    this.socket = socket;
    socket.on("open", () => this.sendSessionUpdate());
    socket.on("message", (data) => this.handleMessage(String(data)));
    socket.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => {
      this.closed = true;
      this.ready.reject(this.failure || new Error("阿里云 ASR 连接已关闭"));
      this.finished.resolve(this.latest);
    });
    await withTimeout(this.ready.promise, REALTIME_SESSION_TIMEOUT_MS, "等待阿里云 session.updated 超时");
  }

  append(pcm: Buffer): void {
    if (this.closed || !pcm.length) return;
    this.send("input_audio_buffer.append", { audio: pcm.toString("base64") });
  }

  async finish(): Promise<string> {
    if (this.closed) return this.latest;
    this.send("input_audio_buffer.commit", {});
    this.send("session.finish", {});
    const text = await withTimeout(
      this.finished.promise,
      REALTIME_FINISH_TIMEOUT_MS,
      "等待阿里云 session.finished 超时",
    );
    return String(text || this.latest || "").trim();
  }

  cancel(): void {
    this.closed = true;
    try {
      this.socket?.close(1000, "cancel");
    } catch {
      // ignore
    }
    this.ready.reject(new Error("cancelled"));
    this.finished.resolve(this.latest);
  }

  private sendSessionUpdate(): void {
    const transcription: Record<string, unknown> = {};
    const language = this.config.language !== "auto"
      ? this.config.language
      : this.config.aliyun.language;
    if (language !== "auto") transcription.language = language;
    this.send("session.update", {
      session: {
        input_audio_format: "pcm",
        sample_rate: SAMPLE_RATE,
        input_audio_transcription: transcription,
        // Client VAD owns utterance boundaries, so Qwen runs in manual mode.
        turn_detection: null,
      },
    });
  }

  private send(type: string, payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(
        JSON.stringify({
          ...payload,
          type,
          event_id: `evt_${randomUUID().replace(/-/g, "")}`,
        }),
      );
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleMessage(raw: string): void {
    let event: any = null;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const type = String(event?.type || "");
    if (type === "session.updated") {
      this.ready.resolve();
      return;
    }
    if (type === "conversation.item.input_audio_transcription.text") {
      const text = `${event.text || ""}${event.stash || ""}`.trim();
      if (text) {
        this.latest = text;
        this.onPartial?.(text);
      }
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = String(event.transcript || "").trim();
      if (text) {
        this.latest = text;
        this.onPartial?.(text);
      }
      return;
    }
    if (type === "session.finished") {
      this.finished.resolve(this.latest);
      return;
    }
    if (type === "error") {
      const message = event?.error?.message || event?.message || "阿里云 ASR 失败";
      this.fail(new Error(String(message)));
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    this.ready.reject(error);
    this.finished.reject(error);
  }
}

async function recognizeViaRealtime(
  pcm: Buffer,
  config: AsrCloudConfig,
  options: RecognizeOptions = {},
): Promise<string> {
  const session = new QwenRealtimeSession(config, options.onPartial);
  try {
    await session.open();
    session.append(pcm);
    return await session.finish();
  } finally {
    session.cancel();
  }
}

/**
 * One-shot recognition of a complete utterance.
 * `local` is handled by asrService and never reaches this function.
 */
export async function recognizePcm(
  pcm: Buffer,
  config: AsrCloudConfig,
  options: RecognizeOptions = {},
): Promise<string> {
  if (!pcm.length) return "";
  if (config.provider === "local") {
    throw new Error("本地识别不走云端服务");
  }
  if (config.provider === "aliyun" && isAliyunRealtimeModel(config.aliyun.model)) {
    return recognizeViaRealtime(pcm, config, options);
  }
  return recognizeViaHttp(pcm, config, options);
}

export interface CloudAsrEvents {
  partial?: (text: string, utteranceId: string) => void;
  final?: (payload: {
    text: string;
    rawText: string;
    utteranceId: string;
    durationS: number;
    audioPcm: Buffer;
  }) => void;
}

/**
 * Streaming session handed to the renderer's websocket. Speaks the same
 * interface as the local sherpa session: `acceptPcm` / `flush` / `close`.
 *
 * Aliyun realtime pushes frames as they arrive; the HTTP providers buffer until
 * `flush`, which the renderer sends at end-of-speech (client-side VAD).
 */
export class CloudAsrStreamingSession {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private utteranceId = randomUUID();
  private lastPartial = "";
  private closed = false;
  private realtime: QwenRealtimeSession | null = null;
  private realtimeOpening: Promise<void> | null = null;
  private realtimeFailed = false;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly events: CloudAsrEvents,
    private readonly config: AsrCloudConfig,
  ) {}

  get id(): string {
    return this.utteranceId;
  }

  acceptPcm(chunk: Buffer): void {
    if (this.closed || !chunk.length) return;
    this.chunks.push(Buffer.from(chunk));
    this.bytes += chunk.length;
    if (this.usesRealtime()) this.pushRealtime(chunk);
    if (this.bytes >= MAX_UTTERANCE_BYTES) void this.flush();
  }

  /** Serialized so an auto flush (max utterance) cannot race a client flush. */
  flush(): Promise<void> {
    this.inflight = this.inflight.then(
      () => this.flushNow(),
      () => this.flushNow(),
    );
    return this.inflight;
  }

  private async flushNow(): Promise<void> {
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    if (!pcm.length) {
      this.resetUtterance();
      return;
    }
    const utteranceId = this.utteranceId;
    let text = "";
    try {
      text = await this.resolveText(pcm);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A failed utterance should surface, not silently commit an empty turn.
      throw Object.assign(new Error(detail), { statusCode: 502 });
    } finally {
      this.resetUtterance();
    }
    this.events.final?.({
      text,
      rawText: text,
      utteranceId,
      durationS: pcm.length / 2 / SAMPLE_RATE,
      audioPcm: pcm,
    });
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.closed = true;
      this.realtime?.cancel();
      this.realtime = null;
      this.realtimeOpening = null;
    }
  }

  private usesRealtime(): boolean {
    return this.config.provider === "aliyun" && isAliyunRealtimeModel(this.config.aliyun.model);
  }

  private pushRealtime(chunk: Buffer): void {
    if (this.realtimeFailed) return;
    if (!this.realtimeOpening) {
      const session = new QwenRealtimeSession(this.config, (text) => this.emitPartial(text));
      this.realtime = session;
      this.realtimeOpening = session.open().catch((error) => {
        this.realtimeFailed = true;
        this.realtime = null;
        this.realtimeOpening = null;
        throw error;
      });
    }
    const opening = this.realtimeOpening;
    if (!opening) return;
    opening
      .then(() => this.realtime?.append(chunk))
      .catch(() => {
        // `flush` falls back to the HTTP path for this utterance.
      });
  }

  private async resolveText(pcm: Buffer): Promise<string> {
    if (this.realtime && !this.realtimeFailed) {
      return this.realtime.finish();
    }
    return recognizePcm(pcm, this.config, {
      onPartial: (text) => this.emitPartial(text),
    });
  }

  private emitPartial(text: string): void {
    const value = String(text || "").trim();
    if (!value || value === this.lastPartial) return;
    this.lastPartial = value;
    this.events.partial?.(value, this.utteranceId);
  }

  private resetUtterance(): void {
    this.utteranceId = randomUUID();
    this.lastPartial = "";
    this.realtime?.cancel();
    this.realtime = null;
    this.realtimeOpening = null;
    this.realtimeFailed = false;
  }
}
