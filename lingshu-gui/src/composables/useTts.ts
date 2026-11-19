import { ref, readonly, watch } from "vue";
import Message from '@arco-design/web-vue/es/message';
import { consumeSseBuffer, flushTrailingSseBuffer } from "../utils/sse.js";
import { useChatStore } from "../stores/chat";
import { getFullUrl } from "../utils/apiConfig";
import {
  isCompressedStreamFormat,
  isRemoteLiveAudioUrl,
  playCompressedLiveFromUrl,
  playPcmStreamFromUrl,
  resolvePcmStreamMode,
} from "../utils/ttsPcmStream";
import {
  getSharedAudioContext,
  getTtsOutputNode,
  getTtsReferenceAnalyserNode,
  getTtsReferenceFrame,
  setTtsOutputMuted,
} from "../utils/sharedAudioContext";
import { reportTtsDiagnostic } from "../utils/ttsDiagnostics";

const isPlaying = ref(false);
const currentPlayingId = ref<string | null>(null);
const ttsPlayStartedAt = ref<number>(0);

function audioState(): Record<string, unknown> {
  try {
    const ctx = getSharedAudioContext();
    let gain: number | null = null;
    try {
      const node = getTtsOutputNode(ctx);
      if (node instanceof GainNode) gain = node.gain.value;
    } catch {
      // output bus unavailable
    }
    return {
      ctxState: ctx.state,
      ctxRate: ctx.sampleRate,
      ctxTime: Number(ctx.currentTime.toFixed(3)),
      gain,
    };
  } catch (error) {
    return { ctxError: error instanceof Error ? error.message : String(error) };
  }
}

function unlockTtsAudio() {
  try {
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // best-effort autoplay unlock
  }
}

if (typeof window !== 'undefined') {
  for (const eventName of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(eventName, unlockTtsAudio, { once: true, capture: true });
  }
}

const storedAutoTts = localStorage.getItem('lingshu_auto_tts');
const autoTtsEnabled = ref(storedAutoTts === 'true');

watch(autoTtsEnabled, (newValue) => {
  localStorage.setItem('lingshu_auto_tts', String(newValue));
});

interface TtsChunk {
  segmentId: string;
  messageId: string;
  text?: string;
  audioUrl: string;
  audio: HTMLAudioElement | null;
  status: "idle" | "loading" | "ready" | "error";
  index: number;
  mimeType?: string;
  format?: string;
  sampleRate?: number;
}

interface RemoteSegment {
  segmentId?: string;
  text?: string;
  audioUrl?: string;
  audioBase64?: string;
  mimeType?: string;
  format?: string;
  sampleRate?: number;
  seq?: number;
}

const chunks = ref<TtsChunk[]>([]);
const currentIndex = ref(-1);
const CONCURRENCY_LIMIT = 2;
let loadWindowScheduled = false;
let streamFinished = false;
let activeStreamController: AbortController | null = null;
const chunkAbortControllers = new Map<string, AbortController>();
const seenSegmentIds = new Set<string>();
const seenStopTokens = new Set<string>();
// Every stop supersedes all outstanding asynchronous chunk loaders. Without
// this generation fence, a fetch that finishes after stop() can create a new
// Audio element and restart playback from an already-cleared queue.
let playbackGeneration = 0;

function abortChunkLoads() {
  for (const controller of chunkAbortControllers.values()) {
    controller.abort();
  }
  chunkAbortControllers.clear();
}

function resetPlaybackState() {
  chunks.value.forEach((chunk) => {
    if (chunk.audio) {
      chunk.audio.pause();
      chunk.audio.srcObject = null;
      chunk.audio.src = "";
      chunk.audio.onended = null;
      chunk.audio.onerror = null;
      chunk.audio.oncanplay = null;
      chunk.audio.onwaiting = null;
      chunk.audio.onstalled = null;
      chunk.audio.onsuspend = null;
    }
    if (chunk.audioUrl.startsWith("blob:")) {
      URL.revokeObjectURL(chunk.audioUrl);
    }
  });
  chunks.value = [];
  currentIndex.value = -1;
  // Keep consumed remote IDs across stop(): reactive chat updates can replay
  // the same segment array after an interruption, and must not enqueue it again.
  streamFinished = false;
}

let activeSingleAudio: HTMLAudioElement | null = null;
let activeSingleAudioBlobUrl: string | null = null;

function stop() {
  reportTtsDiagnostic("stop", "TTS stop", {
    ...audioState(),
    generation: playbackGeneration,
    playingId: currentPlayingId.value,
    stack: (new Error().stack || "").split("\n").slice(1, 6).join(" | "),
  });
  playbackGeneration += 1;
  setTtsOutputMuted(true);
  loadWindowScheduled = false;
  activeStreamController?.abort();
  activeStreamController = null;
  if (activeSingleAudio) {
    activeSingleAudio.pause();
    activeSingleAudio.srcObject = null;
    activeSingleAudio.src = "";
    activeSingleAudio.onended = null;
    activeSingleAudio.onerror = null;
    activeSingleAudio = null;
  }
  if (activeSingleAudioBlobUrl) {
    URL.revokeObjectURL(activeSingleAudioBlobUrl);
    activeSingleAudioBlobUrl = null;
  }
  abortChunkLoads();
  resetPlaybackState();
  isPlaying.value = false;
  currentPlayingId.value = null;
}

/** Start or continue the global queue without clearing audio already queued/playing. */
function ensurePlaybackStarted(messageId: string) {
  setTtsOutputMuted(false);
  if (!isPlaying.value) {
    isPlaying.value = true;
    ttsPlayStartedAt.value = Date.now();
    currentPlayingId.value = messageId;
    return;
  }
  if (currentPlayingId.value === null) {
    currentPlayingId.value = messageId;
  }
}

function beginExclusivePlayback(messageId: string) {
  playbackGeneration += 1;
  setTtsOutputMuted(false);
  reportTtsDiagnostic("begin", "exclusive playback", {
    ...audioState(),
    messageId,
  });
  resetPlaybackState();
  currentPlayingId.value = messageId;
  isPlaying.value = true;
  ttsPlayStartedAt.value = Date.now();
}

function tryPlayCurrentChunk() {
  const index = currentIndex.value;
  if (index < 0 || index >= chunks.value.length) {
    return;
  }

  const chunk = chunks.value[index];
  if (chunk.status === "ready" && chunk.audio?.paused) {
    currentPlayingId.value = chunk.messageId;
    void (async () => {
      const ctx = getSharedAudioContext();
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => undefined);
      }
      await chunk.audio!.play();
      reportTtsDiagnostic("buffered_play_ok", "audio.play resolved", {
        ...audioState(),
        segmentId: chunk.segmentId,
        muted: chunk.audio!.muted,
        volume: chunk.audio!.volume,
        readyState: chunk.audio!.readyState,
      });
    })().catch((error) => {
      console.error("[TTS] Play error:", error);
      reportTtsDiagnostic("buffered_play_error", error instanceof Error ? error.message : String(error), {
        ...audioState(),
        segmentId: chunk.segmentId,
        muted: chunk.audio?.muted ?? null,
        volume: chunk.audio?.volume ?? null,
        readyState: chunk.audio?.readyState ?? null,
        mediaError: chunk.audio?.error?.code ?? null,
      });
      Message.error(`语音播放失败：${error instanceof Error ? error.message : String(error)}`);
      void playNext();
    });
  }
}

function maybeFinishPlayback() {
  if (!streamFinished) {
    return;
  }

  if (chunks.value.length === 0) {
    stop();
    return;
  }

  const allResolved = chunks.value.every((chunk) => chunk.status === "ready" || chunk.status === "error");
  if (currentIndex.value >= chunks.value.length && allResolved) {
    stop();
  }
}

async function playNext() {
  const nextIndex = currentIndex.value + 1;
  currentIndex.value = nextIndex;

  if (nextIndex >= chunks.value.length) {
    scheduleFillLoadWindow();
    maybeFinishPlayback();
    return;
  }

  scheduleFillLoadWindow();
  tryPlayCurrentChunk();
}

async function loadChunkBuffered(index: number) {
  if (index >= chunks.value.length) return;

  const chunk = chunks.value[index];
  if (!chunk || chunk.status !== "idle") return;

  const generation = playbackGeneration;
  const controller = new AbortController();
  chunkAbortControllers.set(chunk.segmentId, controller);
  chunk.status = "loading";
  let arrayBuffer: ArrayBuffer;
  try {
    const res = await fetch(chunk.audioUrl, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength === 0) throw new Error("empty audio");
  } catch (error) {
    if (controller.signal.aborted || generation !== playbackGeneration) return;
    console.error(`[TTS] Chunk ${index} buffered fetch error:`, error);
    chunk.status = "error";
    if (currentIndex.value === index) {
      void playNext();
    } else {
      maybeFinishPlayback();
    }
    return;
  } finally {
    if (chunkAbortControllers.get(chunk.segmentId) === controller) {
      chunkAbortControllers.delete(chunk.segmentId);
    }
  }

  if (generation !== playbackGeneration || !chunks.value.includes(chunk)) return;

  const audio = new Audio();
  const objectUrl = URL.createObjectURL(
    new Blob([arrayBuffer], { type: chunk.mimeType || "audio/mpeg" }),
  );
  chunk.audioUrl = objectUrl;
  audio.src = objectUrl;
  audio.preload = "auto";
  audio.load();
  chunk.audio = audio;

  audio.oncanplay = () => {
    if (generation !== playbackGeneration || !chunks.value.includes(chunk)) {
      audio.pause();
      URL.revokeObjectURL(objectUrl);
      return;
    }
    reportTtsDiagnostic("buffered_canplay", "audio canplay", {
      segmentId: chunk.segmentId,
      readyState: audio.readyState,
      duration: Number.isFinite(audio.duration) ? audio.duration : null,
    });
    if (chunk.status === "loading") {
      chunk.status = "ready";
      if (currentIndex.value === index || (currentIndex.value === -1 && index === 0)) {
        if (currentIndex.value === -1) {
          currentIndex.value = 0;
        }
        tryPlayCurrentChunk();
      }
      scheduleFillLoadWindow();
      maybeFinishPlayback();
    }
  };

  audio.onended = () => {
    URL.revokeObjectURL(objectUrl);
    if (generation !== playbackGeneration || !chunks.value.includes(chunk)) return;
    void playNext();
  };

  audio.onerror = (event) => {
    if (generation !== playbackGeneration || !chunks.value.includes(chunk)) return;
    reportTtsDiagnostic("buffered_error", "audio element error", {
      segmentId: chunk.segmentId,
      mediaError: audio.error?.code ?? null,
      mediaMessage: audio.error?.message ?? null,
      networkState: audio.networkState,
      readyState: audio.readyState,
      mimeType: chunk.mimeType,
    });
    console.error(`[TTS] Chunk ${index} load error:`, {
      event,
      audioUrl: chunk.audioUrl,
      networkState: audio.networkState,
      readyState: audio.readyState,
      error: audio.error,
    });
    URL.revokeObjectURL(objectUrl);
    chunk.status = "error";
    if (currentIndex.value === index) {
      void playNext();
    } else {
      maybeFinishPlayback();
    }
  };
}

async function loadChunkLiveAudio(index: number) {
  if (index >= chunks.value.length) return;

  const chunk = chunks.value[index];
  if (!chunk || chunk.status !== "idle") return;
  if (!isRemoteLiveAudioUrl(chunk.audioUrl)) {
    return loadChunkBuffered(index);
  }

  // MSE appends live bytes as they arrive (low TTFA); endOfStream only after
  // HTTP completes, then wait for true audio.ended. Blob fallback if MSE fails.
  const controller = new AbortController();
  chunkAbortControllers.set(chunk.segmentId, controller);
  chunk.status = "loading";

  try {
    const ctx = getSharedAudioContext();
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => undefined);
    }
    await playCompressedLiveFromUrl(chunk.audioUrl, {
      mimeType: chunk.mimeType,
      format: chunk.format,
      signal: controller.signal,
      onFirstScheduled: () => {
        chunk.status = "ready";
        currentPlayingId.value = chunk.messageId;
        isPlaying.value = true;
        ttsPlayStartedAt.value = Date.now();
        if (currentIndex.value === index || (currentIndex.value === -1 && index === 0)) {
          if (currentIndex.value === -1) {
            currentIndex.value = 0;
          }
        }
      },
    });

    chunk.status = "ready";
    if (currentIndex.value === index) {
      void playNext();
    } else {
      scheduleFillLoadWindow();
      maybeFinishPlayback();
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    console.warn(`[TTS] Chunk ${index} compressed live failed, falling back:`, error);
    chunk.status = "idle";
    await loadChunkBuffered(index);
  } finally {
    chunkAbortControllers.delete(chunk.segmentId);
  }
}

function parseSampleRateFromMime(mimeType?: string): number | null {
  if (!mimeType) return null;
  const match = mimeType.match(/rate=(\d+)/i);
  if (match && match[1]) {
    const rate = parseInt(match[1], 10);
    if (!isNaN(rate) && rate > 0) return rate;
  }
  return null;
}

async function loadChunkStreaming(index: number) {
  if (index >= chunks.value.length) return;

  const chunk = chunks.value[index];
  if (!chunk || chunk.status !== "idle") return;

  const pcmMode = resolvePcmStreamMode(chunk.mimeType, chunk.format);
  if (!pcmMode || !isRemoteLiveAudioUrl(chunk.audioUrl)) {
    return loadChunkBuffered(index);
  }

  const resolvedSampleRate = chunk.sampleRate ?? parseSampleRateFromMime(chunk.mimeType) ?? 24000;
  // Use the same context as mic capture and every other TTS path. AudioBuffer
  // retains its own sample rate, so this does not resample the source early.
  const ctx = getSharedAudioContext();
  const controller = new AbortController();
  chunkAbortControllers.set(chunk.segmentId, controller);
  chunk.status = "loading";
  const streamDestination = ctx.createMediaStreamDestination();
  const streamAudio = new Audio();
  streamAudio.srcObject = streamDestination.stream;
  streamAudio.autoplay = true;
  chunk.audio = streamAudio;
  const cleanupStream = () => {
    try {
      streamAudio.pause();
    } catch {
      // ignore
    }
    streamAudio.srcObject = null;
    for (const track of streamDestination.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore
      }
    }
    if (chunk.audio === streamAudio) chunk.audio = null;
  };
  let pcmBytes = 0;
  let pcmSamples = 0;
  let pcmSumSq = 0;
  let pcmPeak = 0;
  let pcmChunks = 0;
  const onPcmChunk = (bytes: Uint8Array) => {
    pcmBytes += bytes.byteLength;
    pcmChunks += 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let chunkSumSq = 0;
    let chunkSamples = 0;
    let chunkPeak = 0;
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
      const sample = view.getInt16(i, true) / 32768;
      chunkSumSq += sample * sample;
      chunkSamples += 1;
      const abs = Math.abs(sample);
      if (abs > chunkPeak) chunkPeak = abs;
    }
    pcmSumSq += chunkSumSq;
    pcmSamples += chunkSamples;
    if (chunkPeak > pcmPeak) pcmPeak = chunkPeak;
    if (pcmChunks <= 3) {
      reportTtsDiagnostic("pcm_bytes", "pcm chunk decoded", {
        segmentId: chunk.segmentId,
        chunkIndex: pcmChunks,
        bytes: bytes.byteLength,
        rms: chunkSamples ? Math.sqrt(chunkSumSq / chunkSamples) : 0,
        peak: chunkPeak,
        totalBytes: pcmBytes,
      });
    }
  };

  try {
    reportTtsDiagnostic("pcm_start", "pcm stream start", {
      ...audioState(),
      segmentId: chunk.segmentId,
      sampleRate: resolvedSampleRate,
      mimeType: chunk.mimeType,
      format: chunk.format,
    });
    if (ctx.state === "suspended") {
      await ctx.resume();
      reportTtsDiagnostic("pcm_resumed", "context resumed", {
        ...audioState(),
        segmentId: chunk.segmentId,
      });
    }

    await streamAudio.play();
    reportTtsDiagnostic("stream_audio_play", "native media stream playing", {
      ...audioState(),
      segmentId: chunk.segmentId,
      paused: streamAudio.paused,
      volume: streamAudio.volume,
      audioTracks: streamDestination.stream.getAudioTracks().length,
      trackState: streamDestination.stream.getAudioTracks()[0]?.readyState ?? null,
    });
    await playPcmStreamFromUrl(chunk.audioUrl, ctx, {
      mode: pcmMode,
      sampleRate: resolvedSampleRate,
      signal: controller.signal,
      destination: streamDestination,
      tap: getTtsReferenceAnalyserNode(ctx),
      onPcmChunk,
      onFirstScheduled: () => {
        chunk.status = "ready";
        currentPlayingId.value = chunk.messageId;
        isPlaying.value = true;
        ttsPlayStartedAt.value = Date.now();
        reportTtsDiagnostic("pcm_scheduled", "first pcm buffer scheduled", {
          ...audioState(),
          segmentId: chunk.segmentId,
          sampleRate: resolvedSampleRate,
        });
        window.setTimeout(() => {
          const frame = getTtsReferenceFrame(16_000);
          let sumSq = 0;
          let peak = 0;
          if (frame) {
            for (const sample of frame) {
              sumSq += sample * sample;
              const abs = Math.abs(sample);
              if (abs > peak) peak = abs;
            }
          }
          reportTtsDiagnostic("pcm_output_level", "analyser output level", {
            ...audioState(),
            segmentId: chunk.segmentId,
            rms: frame ? Math.sqrt(sumSq / frame.length) : null,
            peak: frame ? peak : null,
          });
        }, 400);
        if (currentIndex.value === index || (currentIndex.value === -1 && index === 0)) {
          if (currentIndex.value === -1) {
            currentIndex.value = 0;
          }
        }
      },
    });

    await new Promise((resolve) => window.setTimeout(resolve, 150));
    cleanupStream();
    chunk.status = "ready";
    reportTtsDiagnostic("pcm_done", "pcm stream ended", {
      ...audioState(),
      segmentId: chunk.segmentId,
      bytes: pcmBytes,
      chunks: pcmChunks,
      rms: pcmSamples ? Math.sqrt(pcmSumSq / pcmSamples) : 0,
      peak: pcmPeak,
    });
    if (currentIndex.value === index) {
      void playNext();
    } else {
      scheduleFillLoadWindow();
      maybeFinishPlayback();
    }
  } catch (error) {
    cleanupStream();
    if (controller.signal.aborted) return;
    reportTtsDiagnostic("pcm_error", error instanceof Error ? error.message : String(error), {
      ...audioState(),
      segmentId: chunk.segmentId,
      sampleRate: resolvedSampleRate,
      mimeType: chunk.mimeType,
    });
    console.warn(`[TTS] Chunk ${index} PCM stream failed:`, error);
    chunk.status = "error";
    if (currentIndex.value === index) {
      void playNext();
    } else {
      maybeFinishPlayback();
    }
  } finally {
    chunkAbortControllers.delete(chunk.segmentId);
  }
}

function loadChunk(index: number) {
  const chunk = chunks.value[index];
  if (!chunk || chunk.status !== "idle") return;

  if (chunk.audioUrl.startsWith("blob:")) {
    void loadChunkBuffered(index);
    return;
  }

  const pcmMode = resolvePcmStreamMode(chunk.mimeType, chunk.format);
  if (pcmMode === "pcm" && isRemoteLiveAudioUrl(chunk.audioUrl)) {
    void loadChunkStreaming(index);
    return;
  }
  if (pcmMode === "wav" && isRemoteLiveAudioUrl(chunk.audioUrl)) {
    // Complete WAV files play more reliably through a native audio element than
    // through the WKWebView AudioContext scheduling path.
    void loadChunkBuffered(index);
    return;
  }

  if (isCompressedStreamFormat(chunk.mimeType, chunk.format) && isRemoteLiveAudioUrl(chunk.audioUrl)) {
    void loadChunkLiveAudio(index);
    return;
  }

  void loadChunkBuffered(index);
}

function fillLoadWindow() {
  let loadingCount = chunks.value.filter((chunk) => chunk.status === "loading").length;
  const activeIdx = currentIndex.value < 0 ? 0 : currentIndex.value;

  while (loadingCount < CONCURRENCY_LIMIT) {
    const nextToLoad = chunks.value.find((chunk) => {
      if (chunk.status !== "idle") return false;
      const pcmMode = resolvePcmStreamMode(chunk.mimeType, chunk.format);
      const isStream =
        (pcmMode || isCompressedStreamFormat(chunk.mimeType, chunk.format)) &&
        isRemoteLiveAudioUrl(chunk.audioUrl);
      if (isStream) return chunk.index === activeIdx;
      return true;
    });
    if (!nextToLoad) {
      break;
    }
    loadChunk(nextToLoad.index);
    loadingCount += 1;
  }
}

function scheduleFillLoadWindow() {
  if (loadWindowScheduled) return;
  loadWindowScheduled = true;
  queueMicrotask(() => {
    loadWindowScheduled = false;
    fillLoadWindow();
  });
}

function enqueueRemoteSegments(messageId: string, segments: RemoteSegment[], stopToken?: string | null) {
  ensurePlaybackStarted(messageId);

  const additions: TtsChunk[] = [];
  for (const segment of segments) {
    const segmentId = String(segment.segmentId || "").trim();
    if (!segmentId || seenSegmentIds.has(segmentId)) {
      continue;
    }

    // Resolve audio URL: prefer inline base64 (no extra HTTP request) over remote URL.
    let resolvedUrl: string;
    if (segment.audioBase64) {
      try {
        const binary = atob(segment.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const mime = segment.mimeType || "audio/mpeg";
        resolvedUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      } catch {
        const audioUrl = String(segment.audioUrl || "").trim();
        if (!audioUrl) continue;
        resolvedUrl = getFullUrl(audioUrl);
      }
    } else {
      const audioUrl = String(segment.audioUrl || "").trim();
      if (!audioUrl) continue;
      resolvedUrl = getFullUrl(audioUrl);
    }

    seenSegmentIds.add(segmentId);
    additions.push({
      segmentId,
      messageId,
      text: segment.text,
      audioUrl: resolvedUrl,
      audio: null,
      status: "idle",
      index: chunks.value.length + additions.length,
      mimeType: segment.mimeType,
      format: segment.format,
      sampleRate: segment.sampleRate,
    });
  }

  if (additions.length > 0) {
    reportTtsDiagnostic("enqueue", "tts segments enqueued", {
      ...audioState(),
      messageId,
      segments: additions.map((chunk) => ({
        segmentId: chunk.segmentId,
        mimeType: chunk.mimeType,
        format: chunk.format,
        sampleRate: chunk.sampleRate,
        url: chunk.audioUrl.startsWith("blob:") ? "blob" : chunk.audioUrl,
      })),
    });
    chunks.value.push(...additions);
    // New audio is arriving — ensure the queue doesn't terminate early while
    // more chunks are being added (handles the follow-up race condition).
    streamFinished = false;
    if (currentIndex.value === -1) {
      currentIndex.value = 0;
    }
    scheduleFillLoadWindow();
  }

  if (stopToken && !seenStopTokens.has(stopToken)) {
    seenStopTokens.add(stopToken);
    streamFinished = true;
    maybeFinishPlayback();
  }
}

async function consumeTtsEventStream(response: Response, messageId: string) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No TTS stream reader found");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { payloads, rest } = consumeSseBuffer(buffer);
    buffer = rest;

    for (const jsonStr of payloads) {
      const eventData = JSON.parse(jsonStr) as {
        type?: string;
        eventId?: string;
        metadata?: RemoteSegment;
      };

      if (eventData.type === 'tts_segment') {
        enqueueRemoteSegments(messageId, [eventData.metadata || {}]);
      } else if (eventData.type === 'tts_stop') {
        enqueueRemoteSegments(messageId, [], eventData.eventId || `${Date.now()}`);
      }
    }
  }

  for (const jsonStr of flushTrailingSseBuffer(buffer)) {
    const eventData = JSON.parse(jsonStr) as {
      type?: string;
      eventId?: string;
      metadata?: RemoteSegment;
    };
    if (eventData.type === 'tts_segment') {
      enqueueRemoteSegments(messageId, [eventData.metadata || {}]);
    } else if (eventData.type === 'tts_stop') {
      enqueueRemoteSegments(messageId, [], eventData.eventId || `${Date.now()}`);
    }
  }
}

async function speakAppend(text: string, messageId?: string, agentId?: number | null): Promise<void> {
  const content = String(text || "").trim();
  if (!content) return;

  const playbackId = messageId || `followup-${Date.now()}`;
  ensurePlaybackStarted(playbackId);
  streamFinished = false;

  const chatStore = useChatStore();
  const resolvedAgentId =
    agentId ??
    chatStore.currentAgentId ??
    (chatStore.currentConversationId
      ? (chatStore.conversations.find((c) => c.id === chatStore.currentConversationId)?.metadata?.agentId as number | undefined)
      : undefined) ??
    null;

  const controller = new AbortController();
  const previousController = activeStreamController;
  activeStreamController = controller;

  try {
    const response = await fetch(getFullUrl('/api/tts/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: content,
        messageId: playbackId,
        agentId: resolvedAgentId != null ? Number(resolvedAgentId) : undefined,
        sessionId: chatStore.currentConversationId
          ? Number(chatStore.currentConversationId)
          : undefined,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`TTS stream failed (${response.status})`);
    }

    await consumeTtsEventStream(response, playbackId);
    enqueueRemoteSegments(playbackId, [], `followup-end-${playbackId}`);
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    console.error('[TTS] Follow-up stream failed:', error);
  } finally {
    if (activeStreamController === controller) {
      activeStreamController = previousController;
    }
  }
}

const followUpSpeakQueue: Array<{ content: string; messageId: string; agentId?: number | null }> = [];
let drainingFollowUpSpeakQueue = false;

/**
 * `[]` 情绪标签只对 TTS 可见：气泡正文是剥掉标签的展示文本，
 * 而后端 done 事件带下来的 metadata.ttsText 才是这条消息真正的朗读文本
 * （Fish Audio / 小米 MiMo 情绪模式会保留标签，其它 provider 由后端剥离）。
 */
function resolveMessageTtsText(messageId?: string | null): string {
  if (!messageId) return '';
  try {
    const chatStore = useChatStore();
    const conversationId = chatStore.currentConversationId;
    if (!conversationId) return '';
    const messages = chatStore.messagesMap[conversationId] as
      | Array<{ id?: string; metadata?: Record<string, unknown>; ttsText?: string }>
      | undefined;
    if (!Array.isArray(messages)) return '';
    const message = messages.find((item) => item?.id === messageId);
    const ttsText = message?.metadata?.ttsText ?? message?.ttsText;
    return typeof ttsText === 'string' ? ttsText : '';
  } catch {
    return '';
  }
}

async function drainFollowUpSpeakQueue() {
  if (drainingFollowUpSpeakQueue) return;
  drainingFollowUpSpeakQueue = true;
  try {
    while (followUpSpeakQueue.length > 0) {
      const item = followUpSpeakQueue.shift();
      if (!item) continue;
      await speakAppend(item.content, item.messageId, item.agentId);
    }
  } finally {
    drainingFollowUpSpeakQueue = false;
  }
}

function enqueueFollowUpSpeak(text: string, messageId: string, agentId?: number | null) {
  const content = String(resolveMessageTtsText(messageId) || text || "").trim();
  if (!content || !messageId) return;
  console.info('[followup-tts] enqueue', { messageId, chars: content.length, queueLen: followUpSpeakQueue.length + 1 });
  followUpSpeakQueue.push({ content, messageId, agentId });
  void drainFollowUpSpeakQueue();
}

async function speak(text: string, messageId?: string, agentId?: number | null): Promise<void> {
  // 优先使用消息自带的朗读文本（含 [] 情绪标签），没有才退回正文。
  const content = String(resolveMessageTtsText(messageId) || text || "").trim();
  if (!content) return;

  // Must run synchronously inside the click gesture: WebKit keeps AudioContexts
  // created by non-gesture callers silent even after resume() reports "running".
  unlockTtsAudio();

  const playbackId = messageId || `manual-${Date.now()}`;
  if (currentPlayingId.value === playbackId && isPlaying.value) {
    stop();
    return;
  }

  const chatStore = useChatStore();
  const resolvedAgentId =
    agentId ??
    chatStore.currentAgentId ??
    (chatStore.currentConversationId
      ? (chatStore.conversations.find((c) => c.id === chatStore.currentConversationId)?.metadata?.agentId as number | undefined)
      : undefined) ??
    null;

  beginExclusivePlayback(playbackId);
  streamFinished = false;

  activeStreamController?.abort();
  const controller = new AbortController();
  activeStreamController = controller;
  reportTtsDiagnostic("speak_start", "manual speak start", {
    ...audioState(),
    playbackId,
    agentId: resolvedAgentId,
    chars: content.length,
  });

  try {
    const response = await fetch(getFullUrl('/api/tts/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: content,
        messageId: playbackId,
        agentId: resolvedAgentId != null ? Number(resolvedAgentId) : undefined,
        sessionId: chatStore.currentConversationId
          ? Number(chatStore.currentConversationId)
          : undefined,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`TTS stream failed (${response.status})`);
    }

    reportTtsDiagnostic("sse_ok", "tts sse response", {
      playbackId,
      status: response.status,
      contentType: response.headers.get("content-type"),
      ...audioState(),
    });
    await consumeTtsEventStream(response, playbackId);
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    console.error('[TTS] Manual stream failed:', error);
    reportTtsDiagnostic("sse_error", error instanceof Error ? error.message : String(error), {
      playbackId,
      ...audioState(),
    });
    Message.error(error instanceof Error ? error.message : String(error));
    stop();
  } finally {
    if (activeStreamController === controller) {
      activeStreamController = null;
    }
  }
}

function syncMessageTts(
  messageId: string,
  segments: RemoteSegment[] = [],
  stopToken?: string | null,
) {
  if (!messageId || (!segments.length && !stopToken)) {
    return;
  }

  enqueueRemoteSegments(messageId, segments, stopToken);
}

function toggleAutoTts() {
  autoTtsEnabled.value = !autoTtsEnabled.value;
  if (!autoTtsEnabled.value) {
    stop();
  }
}

async function replayMessageAudio(messageId: string, textFallback?: string, agentId?: number | null) {
  if (!messageId) return;

  if (isPlaying.value && currentPlayingId.value === messageId) {
    stop();
    return;
  }

  stop();

  if (textFallback && textFallback.trim()) {
    await speak(textFallback, messageId, agentId);
  }
}

export function useTts() {
  return {
    isPlaying: readonly(isPlaying),
    currentPlayingId: readonly(currentPlayingId),
    autoTtsEnabled: readonly(autoTtsEnabled),
    ttsPlayStartedAt: readonly(ttsPlayStartedAt),
    speak,
    enqueueFollowUpSpeak,
    stop,
    syncMessageTts,
    toggleAutoTts,
    replayMessageAudio,
  };
}
