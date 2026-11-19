import { connectMediaElementToSharedContext } from './sharedAudioContext';

const DEFAULT_PCM_SAMPLE_RATE = 24000;

export type PcmStreamMode = 'pcm' | 'wav';

export function resolvePcmStreamMode(mimeType?: string, format?: string): PcmStreamMode | null {
  const fmt = (format || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (fmt === 'pcm' || mime.includes('l16') || mime === 'application/octet-stream') return 'pcm';
  if (fmt === 'wav' || mime.includes('wav')) return 'wav';
  return null;
}

export function isRemoteLiveAudioUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function isCompressedStreamFormat(mimeType?: string, format?: string): boolean {
  const fmt = (format || "").toLowerCase();
  const mime = (mimeType || "").toLowerCase();
  return (
    fmt === "mp3" ||
    fmt === "mpeg" ||
    fmt === "opus" ||
    fmt === "aac" ||
    fmt === "flac" ||
    mime.includes("mpeg") ||
    mime.includes("mp3") ||
    mime.includes("ogg") ||
    mime.includes("opus") ||
    mime.includes("aac") ||
    mime.includes("flac")
  );
}

/** Preferred MIME for compressed Fish/OpenAI live blobs. */
export function resolveCompressedMseMime(mimeType?: string, format?: string): string | null {
  const fmt = (format || "").toLowerCase();
  const mime = (mimeType || "").toLowerCase();
  if (fmt === "mp3" || fmt === "mpeg" || mime.includes("mpeg") || mime.includes("mp3")) {
    return "audio/mpeg";
  }
  if (fmt === "aac" || mime.includes("aac")) {
    return "audio/aac";
  }
  return null;
}

function waitSourceBufferQuiet(sourceBuffer: SourceBuffer): Promise<void> {
  if (!sourceBuffer.updating) return Promise.resolve();
  return new Promise((resolve) => {
    sourceBuffer.addEventListener("updateend", () => resolve(), { once: true });
  });
}

function waitAudioEnded(audio: HTMLAudioElement, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("audio playback error"));
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Play a live compressed audio HTTP stream (e.g. Fish MP3) with low TTFA.
 *
 * Prefer MSE: append as bytes arrive, start playback early, call endOfStream
 * only after the HTTP body finishes, then wait for true `audio.ended`.
 * That avoids treating synthesis EOF as playback EOF (the progressive
 * `<audio src>` failure mode) without waiting for the full body first.
 */
export async function playCompressedLiveFromUrl(
  audioUrl: string,
  options: {
    mimeType?: string;
    format?: string;
    signal?: AbortSignal;
    onFirstScheduled?: () => void;
  } = {},
): Promise<void> {
  const mime =
    options.mimeType
    || resolveCompressedMseMime(options.mimeType, options.format)
    || "audio/mpeg";

  try {
    await playCompressedLiveViaMse(audioUrl, { ...options, mime });
    return;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    console.warn("[TTS] MSE live play failed, falling back to full blob:", error);
  }

  await playCompressedLiveAsBlob(audioUrl, options);
}

async function playCompressedLiveViaMse(
  audioUrl: string,
  options: {
    mime: string;
    signal?: AbortSignal;
    onFirstScheduled?: () => void;
  },
): Promise<void> {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(options.mime)) {
    throw new Error(`MSE unsupported for ${options.mime}`);
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  const audio = new Audio(objectUrl);
  connectMediaElementToSharedContext(audio);
  let sourceBuffer: SourceBuffer | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("MediaSource open failed"));
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        mediaSource.removeEventListener("sourceopen", onOpen);
        mediaSource.removeEventListener("error", onError);
        options.signal?.removeEventListener("abort", onAbort);
      };
      mediaSource.addEventListener("sourceopen", onOpen, { once: true });
      mediaSource.addEventListener("error", onError, { once: true });
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });

    sourceBuffer = mediaSource.addSourceBuffer(options.mime);
    const res = await fetch(audioUrl, { cache: "no-store", signal: options.signal });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    if (!res.body) throw new Error("no response body");

    const reader = res.body.getReader();
    let pending = new Uint8Array(0);
    let started = false;
    // Hold a little MP3 before the first append so the decoder has a frame.
    const firstAppendMinBytes = 2 * 1024;

    const appendBytes = async (bytes: Uint8Array) => {
      if (!bytes.byteLength || !sourceBuffer) return;
      await waitSourceBufferQuiet(sourceBuffer);
      if (mediaSource.readyState !== "open") return;
      sourceBuffer.appendBuffer(bytes);
      await waitSourceBufferQuiet(sourceBuffer);
    };

    const flushPending = async (force: boolean) => {
      if (!pending.byteLength) return;
      if (!force && !started && pending.byteLength < firstAppendMinBytes) return;
      const toAppend = pending;
      pending = new Uint8Array(0);
      await appendBytes(toAppend);
      if (!started) {
        started = true;
        options.onFirstScheduled?.();
        await audio.play();
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (!pending.byteLength) {
        pending = value;
      } else {
        const merged = new Uint8Array(pending.byteLength + value.byteLength);
        merged.set(pending);
        merged.set(value, pending.byteLength);
        pending = merged;
      }
      await flushPending(false);
    }

    await flushPending(true);

    if (!started) {
      // Empty stream — nothing to play.
      return;
    }

    await waitSourceBufferQuiet(sourceBuffer);
    if (mediaSource.readyState === "open") {
      mediaSource.endOfStream();
    }

    await waitAudioEnded(audio, options.signal);
  } finally {
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {
      /* ignore */
    }
    if (mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch {
        /* ignore */
      }
    }
    URL.revokeObjectURL(objectUrl);
  }
}

/** Fallback: wait for full body, then play blob to true ended. Higher TTFA. */
async function playCompressedLiveAsBlob(
  audioUrl: string,
  options: {
    mimeType?: string;
    format?: string;
    signal?: AbortSignal;
    onFirstScheduled?: () => void;
  },
): Promise<void> {
  const res = await fetch(audioUrl, { cache: "no-store", signal: options.signal });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) return;

  const mime =
    options.mimeType
    || resolveCompressedMseMime(options.mimeType, options.format)
    || "audio/mpeg";
  const objectUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));
  const audio = new Audio(objectUrl);
  connectMediaElementToSharedContext(audio);

  try {
    options.onFirstScheduled?.();
    await audio.play();
    await waitAudioEnded(audio, options.signal);
  } finally {
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(objectUrl);
  }
}

export async function playPcmStreamFromUrl(
  audioUrl: string,
  ctx: AudioContext,
  options: {
    mode: PcmStreamMode;
    sampleRate?: number;
    signal?: AbortSignal;
    destination?: AudioNode;
    /** Optional reference tap; receives the same source signal without affecting output. */
    tap?: AudioNode | null;
    onFirstScheduled?: () => void;
    /** Fired with even-length s16le PCM bytes (same bytes used for local playback). */
    onPcmChunk?: (bytes: Uint8Array) => void;
    /** If true, still tap onPcmChunk but do not play through speakers. */
    muteLocalPlayback?: boolean;
  },
): Promise<void> {
  const sampleRate = options.sampleRate ?? DEFAULT_PCM_SAMPLE_RATE;
  const res = await fetch(audioUrl, { cache: 'no-store', signal: options.signal });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  if (!res.body) throw new Error('no response body');

  const destination = options.destination ?? ctx.destination;
  const reader = res.body.getReader();
  let leftover = new Uint8Array(0);
  let scheduleTime = ctx.currentTime;
  let wavHeaderSkipped = options.mode !== 'wav';
  let firstScheduled = false;
  const sources: AudioBufferSourceNode[] = [];
  const muteLocal = Boolean(options.muteLocalPlayback);

  const schedulePcmBytes = (pcmBytes: Uint8Array) => {
    const playLen = pcmBytes.length - (pcmBytes.length % 2);
    if (playLen < 2) return;

    const slice = pcmBytes.subarray(0, playLen);
    options.onPcmChunk?.(slice);

    if (muteLocal) {
      if (!firstScheduled) {
        firstScheduled = true;
        options.onFirstScheduled?.();
      }
      return;
    }

    const int16 = new Int16Array(slice.buffer, slice.byteOffset, playLen / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, float32.length, sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    if (options.tap && options.tap !== destination) {
      source.connect(options.tap);
    }
    if (scheduleTime < ctx.currentTime) {
      scheduleTime = ctx.currentTime;
    }
    source.start(scheduleTime);
    scheduleTime += buffer.duration;
    sources.push(source);

    if (!firstScheduled) {
      firstScheduled = true;
      options.onFirstScheduled?.();
    }
  };

  const ingestBytes = (incoming: Uint8Array) => {
    let chunk = incoming;
    if (!wavHeaderSkipped) {
      const headerBuf = new Uint8Array(leftover.length + chunk.length);
      headerBuf.set(leftover);
      headerBuf.set(chunk, leftover.length);
      leftover = new Uint8Array(0);
      if (headerBuf.length < 44) {
        leftover = headerBuf;
        return;
      }
      wavHeaderSkipped = true;
      chunk = headerBuf.subarray(44);
    } else if (leftover.length > 0) {
      const merged = new Uint8Array(leftover.length + chunk.length);
      merged.set(leftover);
      merged.set(chunk, leftover.length);
      leftover = new Uint8Array(0);
      chunk = merged;
    }

    const playLen = chunk.length - (chunk.length % 2);
    if (playLen > 0) {
      schedulePcmBytes(chunk.subarray(0, playLen));
      if (playLen < chunk.length) {
        leftover = chunk.subarray(playLen);
      }
    } else {
      leftover = chunk;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) ingestBytes(value);
    }

    if (leftover.length >= 2) {
      schedulePcmBytes(leftover);
    }

    if (!sources.length) return;

    await new Promise<void>((resolve, reject) => {
      const last = sources[sources.length - 1];
      const onEnded = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const cleanup = () => {
        last.removeEventListener('ended', onEnded);
        options.signal?.removeEventListener('abort', onAbort);
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      last.addEventListener('ended', onEnded, { once: true });
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  } catch (error) {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    throw error;
  }
}
