import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { getModelsDir } from "../runtimePaths.js";
import { wavHeader } from "./ttsService.js";
import { punctuateText, punctuationStatus } from "./punctuationService.js";
import { DEFAULT_ASR_MODEL_URL } from "./asrModelConstants.js";
import {
  ASR_PROVIDER_LABELS,
  CloudAsrStreamingSession,
  asrProviderMessage,
  asrProviderModel,
  asrProviderReady,
  resolveAsrConfig,
  recognizePcm,
} from "./cloudAsrService.js";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 16000;
// Padding of trailing silence fed to the recognizer before `inputFinished()`.
// Paraformer/Zipformer keep undecided CIF tokens until the decoder sees a
// silence boundary; without this the last syllable of a sentence is dropped.
const TAIL_SILENCE_SECONDS = 0.6;
const TAIL_SILENCE_SAMPLES = Math.floor(SAMPLE_RATE * TAIL_SILENCE_SECONDS);

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
}

export function parseWav(buffer: Buffer): WavData | null {
  if (buffer.length < 44 || buffer.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  let offset = 12;
  let format = 1;
  let channels = 1;
  let sampleRate = 16000;
  let bits = 16;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buffer.length) {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataLength = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (dataStart < 0 || !dataLength) return null;
  const bytesPerSample = Math.max(1, bits / 8);
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const index = dataStart + (frame * channels + channel) * bytesPerSample;
      let value = 0;
      if (format === 3 && bits === 32) value = buffer.readFloatLE(index);
      else if (bits === 16) value = buffer.readInt16LE(index) / 32768;
      else if (bits === 32) value = buffer.readInt32LE(index) / 2147483648;
      else if (bits === 8) value = (buffer.readUInt8(index) - 128) / 128;
      sum += value;
    }
    samples[frame] = sum / Math.max(1, channels);
  }
  return { samples, sampleRate };
}

export function resample(samples: Float32Array, fromRate: number, toRate = SAMPLE_RATE): Float32Array {
  if (fromRate === toRate || !samples.length) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const weight = position - left;
    output[index] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

export function pcm16ToFloat(pcm: Buffer): Float32Array {
  const count = Math.floor(pcm.length / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

export function floatToPcm16(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  return buffer;
}

export function pcm16ToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  return Buffer.concat([wavHeader(pcm.length, sampleRate, 1, 16), pcm]);
}

interface AsrModelInfo {
  kind: "online" | "offline";
  family: "transducer" | "paraformer" | "offline";
  modelName: string;
  dir: string;
  encoder?: string;
  decoder?: string;
  joiner?: string;
  model?: string;
  tokens: string;
}

function walkDirs(root: string, maxDepth = 4): string[] {
  const result: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    result.push(dir);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        visit(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  visit(root, 0);
  return result;
}

function pickFile(dir: string, names: string[]): string | null {
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function discoverModel(): AsrModelInfo | null {
  // ASR 模型只从两个明确的位置加载，不做任何目录猜测/兜底：
  //  1. 用户在设置页下载/导入后安装到的 <data>/models/asr/
  //  2. 显式指定的 LINGSHU_ASR_MODEL_DIR（离线全量包由 Rust 启动时注入）
  const installedRoot = path.join(getModelsDir(), "asr");
  const roots = [
    installedRoot,
    ...(process.env.LINGSHU_ASR_MODEL_DIR ? [process.env.LINGSHU_ASR_MODEL_DIR] : []),
  ];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const dir of walkDirs(root)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const tokens = path.join(dir, "tokens.txt");
      if (!fs.existsSync(tokens)) continue;
      const encoder = pickFile(dir, [
        "encoder.int8.onnx",
        "encoder.onnx",
        path.join("onnx", "encoder.int8.onnx"),
        path.join("onnx", "encoder.onnx"),
      ]);
      const decoder = pickFile(dir, [
        "decoder.int8.onnx",
        "decoder.onnx",
        path.join("onnx", "decoder.int8.onnx"),
        path.join("onnx", "decoder.onnx"),
      ]);
      if (encoder && decoder) {
        const joiner = pickFile(dir, [
          "joiner.int8.onnx",
          "joiner.onnx",
          path.join("onnx", "joiner.int8.onnx"),
          path.join("onnx", "joiner.onnx"),
        ]);
        return joiner
          ? {
              kind: "online",
              family: "transducer",
              modelName: path.basename(dir),
              dir,
              encoder,
              decoder,
              joiner,
              tokens,
            }
          : {
              kind: "online",
              family: "paraformer",
              modelName: path.basename(dir),
              dir,
              encoder,
              decoder,
              tokens,
            };
      }
      const offlineModel = pickFile(dir, [
        "model.int8.onnx",
        "model.onnx",
        "model_quantized.onnx",
        path.join("onnx", "model.int8.onnx"),
        path.join("onnx", "model.onnx"),
      ]);
      if (offlineModel) {
        return {
          kind: "offline",
          family: "offline",
          modelName: path.basename(dir),
          dir,
          model: offlineModel,
          tokens,
        };
      }
    }
  }
  return null;
}

let modelInfo: AsrModelInfo | null | undefined;
let recognizer: any = null;
let recognizerKind: "online" | "offline" | null = null;
let initError: string | null = null;

/**
 * Forget the loaded recognizer and re-run model discovery on the next call.
 * Used after a model is downloaded / imported / removed so the change takes
 * effect without restarting the backend.
 */
export function resetAsrRuntime(): void {
  modelInfo = undefined;
  recognizer = null;
  recognizerKind = null;
  initError = null;
}

/** The model currently discovered on disk (does not force recognizer init). */
export function discoveredAsrModel(): { name: string; dir: string } | null {
  const info = modelInfo === undefined ? (modelInfo = discoverModel()) : modelInfo;
  return info ? { name: info.modelName, dir: info.dir } : null;
}

function ensureRecognizer(): { recognizer: any; kind: "online" | "offline"; info: AsrModelInfo } | null {
  if (recognizer) return { recognizer, kind: recognizerKind!, info: modelInfo! };
  if (modelInfo === undefined) modelInfo = discoverModel();
  if (!modelInfo) {
    initError = "未找到本地 Sherpa-ONNX ASR 模型";
    return null;
  }
  try {
    const sherpa = require("sherpa-onnx-node") as any;
    const featConfig = { sampleRate: SAMPLE_RATE, featureDim: 80 };
    if (modelInfo.kind === "online") {
      const { OnlineRecognizer } = sherpa;
      const modelConfig =
        modelInfo.family === "transducer"
          ? {
              transducer: {
                encoder: modelInfo.encoder,
                decoder: modelInfo.decoder,
                joiner: modelInfo.joiner,
              },
              tokens: modelInfo.tokens,
              numThreads: 2,
              provider: "cpu",
              debug: 0,
            }
          : {
              paraformer: { encoder: modelInfo.encoder, decoder: modelInfo.decoder },
              tokens: modelInfo.tokens,
              numThreads: 2,
              provider: "cpu",
              debug: 0,
            };
      recognizer = new OnlineRecognizer({
        featConfig,
        modelConfig,
        decodingMethod: "greedy_search",
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20,
      });
      recognizerKind = "online";
    } else {
      const { OfflineRecognizer } = sherpa;
      recognizer = new OfflineRecognizer({
        featConfig,
        modelConfig: {
          paraformer: { model: modelInfo.model },
          tokens: modelInfo.tokens,
          numThreads: 2,
          provider: "cpu",
          debug: 0,
        },
      });
      recognizerKind = "offline";
    }
    initError = null;
    return { recognizer, kind: recognizerKind!, info: modelInfo! };
  } catch (error) {
    initError = error instanceof Error ? error.message : String(error);
    recognizer = null;
    recognizerKind = null;
    return null;
  }
}

export function asrStatus() {
  const config = resolveAsrConfig();
  const discovered = discoveredAsrModel();
  const punctuation = punctuationStatus();

  // Cloud providers do not need (and may not have) the local sherpa model, so
  // never touch the recognizer here — loading it would be slow and pointless.
  if (config.provider !== "local") {
    return {
      ready: asrProviderReady(config),
      installed: Boolean(discovered),
      model: asrProviderModel(config),
      installDir: discovered?.dir || "",
      downloadUrl: DEFAULT_ASR_MODEL_URL,
      streaming: true,
      punctuation: false,
      punctuationModel: punctuation.model,
      punctuationMessage: punctuation.message,
      provider: config.provider,
      providerLabel: ASR_PROVIDER_LABELS[config.provider],
      message: asrProviderMessage(config),
    };
  }

  const state = ensureRecognizer();
  const model = state ? { name: state.info.modelName, dir: state.info.dir } : discovered;
  const message = state
    ? "ASR 已就绪"
    : model
      ? initError || "ASR 模型已安装但加载失败，请查看日志或重新安装"
      : "语音识别模型未安装，请在 设置 → 语音识别 中下载或导入";
  return {
    ready: Boolean(state),
    installed: Boolean(model),
    model: model?.name || "",
    installDir: model?.dir || "",
    downloadUrl: DEFAULT_ASR_MODEL_URL,
    streaming: true,
    punctuation: punctuation.ready,
    punctuationModel: punctuation.model,
    punctuationMessage: punctuation.message,
    provider: "local" as const,
    providerLabel: ASR_PROVIDER_LABELS.local,
    message,
  };
}

/**
 * Flush an online stream so every pending token is emitted.
 *
 * The trailing silence has to be fed *before* `inputFinished()`, otherwise the
 * CIF predictor never sees a silence boundary and keeps the last one or two
 * characters in flight. The order below mirrors the Python backend exactly:
 * silence -> decode -> inputFinished -> decode.
 */
function finishOnlineStream(recognizer: any, stream: any): string {
  const tailSilence = new Float32Array(TAIL_SILENCE_SAMPLES);
  stream.acceptWaveform({ samples: tailSilence, sampleRate: SAMPLE_RATE });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  if (typeof stream.inputFinished === "function") stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  return String(recognizer.getResult(stream)?.text || "").trim();
}

function decodeSamples(samples: Float32Array): string {
  const state = ensureRecognizer();
  if (!state) throw Object.assign(new Error(initError || "ASR 未就绪"), { statusCode: 503 });
  if (state.kind === "online") {
    const stream = state.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    while (state.recognizer.isReady(stream)) state.recognizer.decode(stream);
    return finishOnlineStream(state.recognizer, stream);
  }
  const stream = state.recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  state.recognizer.decode(stream);
  return String(state.recognizer.getResult(stream)?.text || "").trim();
}

export function recognizeWavBytes(buffer: Buffer): {
  text: string;
  rawText: string;
  punctuatedText: string;
  model: string;
} {
  const wav = parseWav(buffer);
  if (!wav) throw Object.assign(new Error("背景音频不是有效的 WAV"), { statusCode: 400 });
  const samples = resample(wav.samples, wav.sampleRate);
  const rawText = decodeSamples(samples);
  const punctuatedText = punctuateText(rawText);
  return { text: punctuatedText, rawText, punctuatedText, model: modelInfo?.modelName || "" };
}

/**
 * Provider-aware variant used by every non-streaming caller (voice messages,
 * QQ attachments, the `/recognize` route). Cloud providers return text that is
 * already punctuated, so local punctuation is skipped for them.
 */
export async function recognizeWavBytesAsync(buffer: Buffer): Promise<{
  text: string;
  rawText: string;
  punctuatedText: string;
  model: string;
}> {
  const config = resolveAsrConfig();
  if (config.provider === "local") return recognizeWavBytes(buffer);

  const wav = parseWav(buffer);
  if (!wav) throw Object.assign(new Error("音频不是有效的 WAV"), { statusCode: 400 });
  const samples = resample(wav.samples, wav.sampleRate);
  const text = (await recognizePcm(floatToPcm16(samples), config)).trim();
  return { text, rawText: text, punctuatedText: text, model: asrProviderModel(config) };
}

export interface AsrSession {
  readonly id: string;
  acceptPcm(chunk: Buffer): void;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}

/** Build the session matching the configured provider. */
export function createAsrSession(
  events: AsrSessionEvents,
  options: { autoEndpointFinal?: boolean } = {},
): AsrSession {
  const config = resolveAsrConfig();
  if (config.provider !== "local") {
    // Cloud providers have no endpoint rule of their own: the renderer sends
    // `flush` from its VAD, so `autoEndpointFinal` does not apply.
    return new CloudAsrStreamingSession(events, config);
  }
  return new AsrStreamingSession(events, options);
}

export interface AsrSessionEvents {
  partial?: (text: string, utteranceId: string) => void;
  final?: (payload: {
    text: string;
    rawText: string;
    utteranceId: string;
    durationS: number;
    audioPcm: Buffer;
  }) => void;
}

export class AsrStreamingSession {
  private pcmChunks: Buffer[] = [];
  private utteranceId = randomUUID();
  private lastPartial = "";
  private onlineStream: any = null;
  private closed = false;
  private autoEndpointFinal: boolean;

  constructor(
    private events: AsrSessionEvents,
    options: { autoEndpointFinal?: boolean } = {},
  ) {
    this.autoEndpointFinal = options.autoEndpointFinal !== false;
    const state = ensureRecognizer();
    if (!state) throw Object.assign(new Error(initError || "ASR 未就绪"), { statusCode: 503 });
    if (state.kind === "online") {
      this.onlineStream = state.recognizer.createStream();
    }
  }

  get id() {
    return this.utteranceId;
  }

  acceptPcm(chunk: Buffer) {
    if (this.closed || !chunk.length) return;
    this.pcmChunks.push(Buffer.from(chunk));
    const state = ensureRecognizer();
    if (!state) return;
    if (state.kind === "online" && this.onlineStream) {
      this.onlineStream.acceptWaveform({
        samples: pcm16ToFloat(chunk),
        sampleRate: SAMPLE_RATE,
      });
      while (state.recognizer.isReady(this.onlineStream)) state.recognizer.decode(this.onlineStream);
      const text = String(state.recognizer.getResult(this.onlineStream)?.text || "");
      if (text && text !== this.lastPartial) {
        this.lastPartial = text;
        this.events.partial?.(text, this.utteranceId);
      }
      if (this.autoEndpointFinal && state.recognizer.isEndpoint(this.onlineStream)) {
        this.flush();
      }
    }
  }

  flush() {
    if (this.closed) return;
    const pcm = Buffer.concat(this.pcmChunks);
    this.pcmChunks = [];
    if (!pcm.length) {
      this.utteranceId = randomUUID();
      this.lastPartial = "";
      return;
    }
    let text = "";
    try {
      const state = ensureRecognizer();
      if (state?.kind === "online" && this.onlineStream) {
        text = finishOnlineStream(state.recognizer, this.onlineStream);
      } else {
        const samples = resample(pcm16ToFloat(pcm), SAMPLE_RATE);
        text = decodeSamples(samples);
      }
    } catch {
      text = "";
    }
    const utteranceId = this.utteranceId;
    this.events.final?.({
      text,
      rawText: text,
      utteranceId,
      durationS: pcm.length / 2 / SAMPLE_RATE,
      audioPcm: pcm,
    });
    this.reset();
  }

  private reset() {
    this.utteranceId = randomUUID();
    this.lastPartial = "";
    const state = ensureRecognizer();
    if (state?.kind === "online") {
      this.onlineStream = state.recognizer.createStream();
    }
  }

  close() {
    this.closed = true;
    try {
      this.flush();
    } catch {
      // ignore
    }
    this.onlineStream = null;
  }
}

export function buildAsrFinalPayload(input: {
  text: string;
  rawText: string;
  punctuatedText?: string;
  utteranceId: string;
  durationS: number;
  audioPcm: Buffer;
  voiceprint?: Record<string, unknown>;
}) {
  const config = resolveAsrConfig();
  const cloud = config.provider !== "local";
  const rawText = String(input.rawText || input.text || "").trim();
  // Cloud providers return punctuated text; running the local punctuation model
  // again would yield doubled punctuation.
  const punctuatedText = String(
    input.punctuatedText || (cloud ? rawText : punctuateText(rawText)) || rawText,
  ).trim();
  return {
    type: "asr_final",
    text: punctuatedText || rawText,
    rawText,
    punctuatedText: punctuatedText || rawText,
    utteranceId: input.utteranceId,
    durationS: input.durationS,
    sampleRate: SAMPLE_RATE,
    asrModel: cloud ? asrProviderModel(config) : modelInfo?.modelName || "",
    asrProvider: config.provider,
    audioBase64: pcm16ToWav(input.audioPcm).toString("base64"),
    audioMimeType: "audio/wav",
    ...(input.voiceprint || {}),
  };
}
