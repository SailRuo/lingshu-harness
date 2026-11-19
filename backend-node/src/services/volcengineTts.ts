import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { wavHeader } from "./ttsService.js";

const WS_URL = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";

const enum MsgType {
  FullClientRequest = 1,
  AudioOnlyClient = 2,
  FullServerResponse = 9,
  AudioOnlyServer = 11,
  Error = 15,
}

const enum Flag {
  NoSeq = 0,
  PositiveSeq = 1,
  LastNoSeq = 2,
  NegativeSeq = 3,
  WithEvent = 4,
}

const enum EventType {
  StartConnection = 1,
  FinishConnection = 2,
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,
  StartSession = 100,
  FinishSession = 102,
  SessionStarted = 150,
  SessionFinished = 152,
  SessionFailed = 153,
  TaskRequest = 200,
  TTSResponse = 352,
}

interface ParsedMessage {
  type: number;
  flag: number;
  event: number;
  sessionId: string;
  connectId: string;
  payload: Buffer;
  errorCode: number;
}

function buildMessage(input: {
  type: number;
  flag: number;
  event?: number;
  sessionId?: string;
  payload?: Buffer | string;
}): Buffer {
  const header = Buffer.from([0x11, (input.type << 4) | input.flag, 0x10, 0x00]);
  const parts: Buffer[] = [header];
  const event = input.event ?? 0;
  if (input.flag === Flag.WithEvent) {
    const eventBuffer = Buffer.alloc(4);
    eventBuffer.writeInt32BE(event, 0);
    parts.push(eventBuffer);
    if (![EventType.StartConnection, EventType.FinishConnection, EventType.ConnectionStarted, EventType.ConnectionFailed].includes(event)) {
      const sessionBuffer = Buffer.from(input.sessionId || "", "utf-8");
      const size = Buffer.alloc(4);
      size.writeUInt32BE(sessionBuffer.length, 0);
      parts.push(size, sessionBuffer);
    }
  }
  const payload = Buffer.isBuffer(input.payload)
    ? input.payload
    : Buffer.from(input.payload ?? "", "utf-8");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  parts.push(size, payload);
  return Buffer.concat(parts);
}

function parseMessage(data: Buffer): ParsedMessage {
  const versionAndHeader = data[0];
  const headerSize = 4 * (versionAndHeader & 0x0f);
  const typeAndFlag = data[1];
  const type = typeAndFlag >> 4;
  const flag = typeAndFlag & 0x0f;
  let offset = headerSize;
  let event = 0;
  let sessionId = "";
  let connectId = "";
  let errorCode = 0;
  if (flag === Flag.WithEvent) {
    event = data.readInt32BE(offset);
    offset += 4;
    if (![1, 2, 50, 51].includes(event)) {
      const sessionSize = data.readUInt32BE(offset);
      offset += 4;
      if (sessionSize) {
        sessionId = data.subarray(offset, offset + sessionSize).toString("utf-8");
        offset += sessionSize;
      }
    }
    if ([50, 51, 52].includes(event)) {
      const connectSize = data.readUInt32BE(offset);
      offset += 4;
      if (connectSize) {
        connectId = data.subarray(offset, offset + connectSize).toString("utf-8");
        offset += connectSize;
      }
    }
  }
  if (type === MsgType.Error) {
    errorCode = data.readUInt32BE(offset);
    offset += 4;
  }
  const payloadSize = data.readUInt32BE(offset);
  offset += 4;
  const payload = data.subarray(offset, offset + payloadSize);
  return { type, flag, event, sessionId, connectId, payload, errorCode };
}

interface VolcConfig {
  apiKey: string;
  resourceId: string;
  speakerId: string;
  model: string;
  format: string;
  sampleRate: number;
  useTagParser: boolean | null;
  contextTexts: string;
  voiceMode: string;
  cloneModelType: number;
}

export interface VolcSynthesisResult {
  data: Buffer;
  format: string;
  sampleRate: number;
  mimeType: string;
}

function configFromSettings(settings: Record<string, any>): VolcConfig {
  return {
    apiKey: String(settings.ttsVolcengineApiKey || ""),
    resourceId: String(settings.ttsVolcengineResourceId || "seed-icl-2.0"),
    speakerId: String(settings.ttsVolcengineSpeakerId || ""),
    model: String(settings.ttsVolcengineModel || ""),
    format: String(settings.ttsVolcengineFormat || "pcm"),
    sampleRate: Number(settings.ttsVolcengineSampleRate || 24000),
    useTagParser:
      settings.ttsVolcengineUseTagParser === null || settings.ttsVolcengineUseTagParser === undefined
        ? null
        : Boolean(settings.ttsVolcengineUseTagParser),
    contextTexts: String(settings.ttsVolcengineContextTexts || ""),
    voiceMode: String(settings.ttsVolcengineVoiceMode || "preset"),
    cloneModelType: Number(settings.ttsVolcengineCloneModelType || 0),
  };
}

function sessionPayload(config: VolcConfig): string {
  const params: Record<string, any> = {
    speaker: config.speakerId,
    audio_params: {
      format: config.format,
      sample_rate: config.sampleRate,
    },
  };
  if (config.model) params.model = config.model;
  const additions: Record<string, any> = {};
  if (config.contextTexts) additions.context_texts = config.contextTexts.split("\n").filter(Boolean);
  if (config.useTagParser !== null) additions.use_tag_parser = config.useTagParser;
  if (config.voiceMode === "voice_clone" && config.speakerId.startsWith("S_") && config.cloneModelType > 0) {
    additions.model_type = config.cloneModelType;
  }
  if (Object.keys(additions).length) {
    params.additions = JSON.stringify(additions);
  }
  return JSON.stringify({ user: { uid: "lingshu" }, req_params: params });
}

function taskPayload(config: VolcConfig, text: string): string {
  const base = JSON.parse(sessionPayload(config));
  base.req_params.text = text;
  return JSON.stringify(base);
}

function waitForEvent(
  queue: ParsedMessage[],
  waiters: Array<(message: ParsedMessage) => void>,
  predicate: (message: ParsedMessage) => boolean,
  timeoutMs: number,
  onMessage: (message: ParsedMessage) => void,
): Promise<ParsedMessage> {
  const existingIndex = queue.findIndex(predicate);
  if (existingIndex >= 0) {
    return Promise.resolve(queue.splice(existingIndex, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(handler);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error("Volcengine TTS timeout"));
    }, timeoutMs);
    const handler = (message: ParsedMessage) => {
      if (!predicate(message)) {
        queue.push(message);
        return;
      }
      clearTimeout(timer);
      const index = waiters.indexOf(handler);
      if (index >= 0) waiters.splice(index, 1);
      resolve(message);
    };
    waiters.push(handler);
  });
}

function chunkText(text: string, maxLength = 300): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let split = remaining.lastIndexOf("。", maxLength);
    if (split < maxLength / 2) split = remaining.lastIndexOf("，", maxLength);
    if (split < maxLength / 2) split = maxLength;
    chunks.push(remaining.slice(0, split + 1));
    remaining = remaining.slice(split + 1);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function synthesizeVolcengine(
  settings: Record<string, any>,
  text: string,
): Promise<VolcSynthesisResult> {
  const config = configFromSettings(settings);
  if (!config.apiKey) {
    throw Object.assign(new Error("Volcengine TTS API key is required"), { statusCode: 400 });
  }
  const url = String(settings.ttsVolcengineWsUrl || WS_URL);
  const connectId = randomUUID();
  const socket = new WebSocket(url, {
    headers: {
      "X-Api-Key": config.apiKey,
      "X-Api-Resource-Id": config.resourceId,
      "X-Api-Connect-Id": connectId,
      "X-Api-Request-Id": connectId,
      "X-Api-Sequence": "-1",
    },
  });

  const queue: ParsedMessage[] = [];
  const waiters: Array<(message: ParsedMessage) => void> = [];
  const audioChunks: Buffer[] = [];
  let failure: Error | null = null;

  socket.on("message", (data) => {
    try {
      const message = parseMessage(Buffer.from(data as Buffer));
      if (message.type === MsgType.Error || message.event === EventType.ConnectionFailed) {
        failure = new Error(
          `Volcengine TTS error ${message.errorCode}: ${message.payload.toString("utf-8").slice(0, 300)}`,
        );
      }
      if (message.event === EventType.TTSResponse && message.payload.length) {
        audioChunks.push(message.payload);
      }
      const listeners = [...waiters];
      for (const listener of listeners) listener(message);
    } catch {
      // ignore malformed frames
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Volcengine TTS connect timeout")), 15_000);
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
    socket.send(buildMessage({ type: MsgType.FullClientRequest, flag: Flag.WithEvent, event: EventType.StartConnection, payload: "{}" }));
    await waitForEvent(queue, waiters, (m) => m.event === EventType.ConnectionStarted, 10_000, () => undefined);
    if (failure) throw failure;

    const sessionId = randomUUID().replace(/-/g, "");
    socket.send(
      buildMessage({
        type: MsgType.FullClientRequest,
        flag: Flag.WithEvent,
        event: EventType.StartSession,
        sessionId,
        payload: sessionPayload(config),
      }),
    );
    await waitForEvent(queue, waiters, (m) => m.event === EventType.SessionStarted, 10_000, () => undefined);
    if (failure) throw failure;

    for (const chunk of chunkText(text)) {
      socket.send(
        buildMessage({
          type: MsgType.FullClientRequest,
          flag: Flag.WithEvent,
          event: EventType.TaskRequest,
          sessionId,
          payload: taskPayload(config, chunk),
        }),
      );
    }
    socket.send(
      buildMessage({
        type: MsgType.FullClientRequest,
        flag: Flag.WithEvent,
        event: EventType.FinishSession,
        sessionId,
        payload: "{}",
      }),
    );
    await waitForEvent(queue, waiters, (m) => m.event === EventType.SessionFinished, 60_000, () => undefined);
    if (failure) throw failure;

    try {
      socket.send(
        buildMessage({ type: MsgType.FullClientRequest, flag: Flag.WithEvent, event: EventType.FinishConnection, payload: "{}" }),
      );
    } catch {
      // ignore
    }
  } finally {
    socket.close();
  }

  if (!audioChunks.length) throw new Error("Volcengine TTS returned no audio");
  const raw = Buffer.concat(audioChunks);
  const format = config.format.toLowerCase();
  if (format === "pcm" || format === "raw") {
    return {
      data: Buffer.concat([wavHeader(raw.length, config.sampleRate), raw]),
      format: "wav",
      sampleRate: config.sampleRate,
      mimeType: "audio/wav",
    };
  }
  const mime =
    format === "mp3" ? "audio/mpeg" : format === "ogg_opus" ? "audio/ogg" : "application/octet-stream";
  return { data: raw, format: format === "ogg_opus" ? "opus" : format, sampleRate: config.sampleRate, mimeType: mime };
}
