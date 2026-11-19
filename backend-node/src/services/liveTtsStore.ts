import { randomUUID } from "node:crypto";

export interface LiveTtsSegmentMeta {
  id: string;
  format: string;
  sampleRate: number;
  mimeType: string;
  text: string;
  seq: number;
  messageId: string | null;
  createdAt: number;
}

interface LiveTtsSegment extends LiveTtsSegmentMeta {
  chunks: Buffer[];
  bytes: number;
  done: boolean;
  error: Error | null;
  waiters: Set<() => void>;
  abort: AbortController;
  cleanupTimer: NodeJS.Timeout | null;
}

const MAX_LIVE_BYTES = 64 * 1024 * 1024;
const LIVE_TTL_MS = 10 * 60 * 1000;

const liveSegments = new Map<string, LiveTtsSegment>();

function notify(segment: LiveTtsSegment) {
  for (const waiter of segment.waiters) {
    try {
      waiter();
    } catch {
      // ignore waiter failures
    }
  }
  segment.waiters.clear();
}

function scheduleCleanup(segment: LiveTtsSegment) {
  if (segment.cleanupTimer) return;
  segment.cleanupTimer = setTimeout(() => {
    liveSegments.delete(segment.id);
  }, LIVE_TTL_MS);
  segment.cleanupTimer.unref?.();
}

export function createLiveTtsSegment(input: {
  format: string;
  sampleRate: number;
  mimeType: string;
  text: string;
  seq: number;
  messageId?: string | null;
}): LiveTtsSegmentMeta {
  const segment: LiveTtsSegment = {
    id: randomUUID().replace(/-/g, ""),
    format: input.format,
    sampleRate: input.sampleRate,
    mimeType: input.mimeType,
    text: input.text,
    seq: input.seq,
    messageId: input.messageId ?? null,
    createdAt: Date.now(),
    chunks: [],
    bytes: 0,
    done: false,
    error: null,
    waiters: new Set(),
    abort: new AbortController(),
    cleanupTimer: null,
  };
  liveSegments.set(segment.id, segment);
  return {
    id: segment.id,
    format: segment.format,
    sampleRate: segment.sampleRate,
    mimeType: segment.mimeType,
    text: segment.text,
    seq: segment.seq,
    messageId: segment.messageId,
    createdAt: segment.createdAt,
  };
}

export function getLiveTtsSegment(id: string): LiveTtsSegmentMeta | null {
  const segment = liveSegments.get(id);
  if (!segment) return null;
  return {
    id: segment.id,
    format: segment.format,
    sampleRate: segment.sampleRate,
    mimeType: segment.mimeType,
    text: segment.text,
    seq: segment.seq,
    messageId: segment.messageId,
    createdAt: segment.createdAt,
  };
}

export function getLiveTtsAbortSignal(id: string): AbortSignal | null {
  return liveSegments.get(id)?.abort.signal ?? null;
}

export function appendLiveTtsChunk(id: string, chunk: Buffer) {
  const segment = liveSegments.get(id);
  if (!segment || segment.done || segment.error || !chunk.length) return;
  segment.bytes += chunk.length;
  if (segment.bytes > MAX_LIVE_BYTES) {
    failLiveTtsSegment(id, new Error("live TTS segment exceeds memory limit"));
    return;
  }
  segment.chunks.push(chunk);
  notify(segment);
}

export function finishLiveTtsSegment(id: string) {
  const segment = liveSegments.get(id);
  if (!segment || segment.done) return;
  segment.done = true;
  notify(segment);
  scheduleCleanup(segment);
}

export function failLiveTtsSegment(id: string, error: unknown) {
  const segment = liveSegments.get(id);
  if (!segment || segment.done) return;
  segment.error = error instanceof Error ? error : new Error(String(error));
  segment.done = true;
  segment.abort.abort(segment.error);
  notify(segment);
  scheduleCleanup(segment);
}

export async function* readLiveTtsSegment(
  id: string,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const segment = liveSegments.get(id);
  if (!segment) throw new Error("segment not found");
  let index = 0;
  while (true) {
    if (signal?.aborted) return;
    if (index < segment.chunks.length) {
      const chunk = segment.chunks[index];
      index += 1;
      yield chunk;
      continue;
    }
    if (segment.error) throw segment.error;
    if (segment.done) return;
    await new Promise<void>((resolve, reject) => {
      const onWake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        segment.waiters.delete(onWake);
        signal?.removeEventListener("abort", onAbort);
      };
      segment.waiters.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
