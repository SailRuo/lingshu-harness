/**
 * SoulX-FlashHead WebSocket PCM client.
 * Protocol: see SoulX-FlashHead/PCM_STREAM_API.md
 */
export type FlashHeadStatus =
  | 'idle'
  | 'connecting'
  | 'uploading'
  | 'loading'
  | 'ready'
  | 'streaming'
  | 'flushing'
  | 'done'
  | 'error'
  | 'closed';

export interface FlashHeadStartOptions {
  condImage?: string;
  modelType?: 'lite' | 'pro';
  sampleRate?: number;
  fmt?: 's16le' | 'f32le';
  sendMp4Binary?: boolean;
  /** Mux driving PCM into each mp4 (Gradio-style A/V sync). Default true. */
  muxAudio?: boolean;
  /** Merge N model micro-chunks into one playable mp4 (Gradio default 3). */
  chunksPerSegment?: number;
  /** How many micro-chunks before the first playable mp4 (default 1 = fast TTFF). */
  firstSegmentChunks?: number;
  /**
   * If true, hold all video until flush and emit one mp4 (no mid-play hard cuts).
   * Best for short lab TTS clips.
   */
  emitOnFlushOnly?: boolean;
  /** Continuous frame stream (canvas) vs short mp4 clips. Default mp4. */
  streamMode?: 'mp4' | 'frames';
  jpegQuality?: number;
  /** Downscale JPEG wire size (preview). 0/undefined = full. Default server 512. */
  streamMaxLongSide?: number;
  /** Output aspect: 1:1 | 3:4 | 4:3 | 9:16 | 16:9 | original */
  aspectRatio?: string;
  /** When aspect=original, clamp long side to this (768/1024/1280). */
  maxLongSide?: number;
  height?: number;
  width?: number;
  useFaceCrop?: boolean;
  seed?: number;
  ckptDir?: string;
  wav2vecDir?: string;
}

export interface FlashHeadVideoChunk {
  chunkIdx: number;
  nFrames: number;
  height: number;
  width: number;
  fps: number;
  elapsedSec: number;
  videoPath?: string;
  byteLength?: number;
  blob: Blob;
}

export interface FlashHeadFrameBatchMsg {
  chunkIdx: number;
  nFrames: number;
  pts0: number;
  fps: number;
  height: number;
  width: number;
  audioSampleRate: number;
  elapsedSec: number;
  /** packed binary: audio + jpegs */
  payload: ArrayBuffer;
}

type StatusHandler = (status: FlashHeadStatus, detail?: string) => void;
type VideoHandler = (chunk: FlashHeadVideoChunk) => void;
type FrameBatchHandler = (batch: FlashHeadFrameBatchMsg) => void;
type InfoHandler = (info: Record<string, unknown>) => void;

export class FlashHeadPcmClient {
  private ws: WebSocket | null = null;
  private status: FlashHeadStatus = 'idle';
  private waitingMp4Meta: Record<string, unknown> | null = null;
  private waitingFrameMeta: Record<string, unknown> | null = null;
  private lastCondImage: string | null = null;
  private startWaiters: Array<{
    resolve: (info: Record<string, unknown>) => void;
    reject: (err: Error) => void;
  }> = [];
  private uploadWaiters: Array<{
    resolve: (condImage: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private uploadAckWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private flushWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  onStatus: StatusHandler | null = null;
  onVideo: VideoHandler | null = null;
  onFrameBatch: FrameBatchHandler | null = null;
  onInfo: InfoHandler | null = null;

  get currentStatus() {
    return this.status;
  }

  get condImage() {
    return this.lastCondImage;
  }

  private setStatus(status: FlashHeadStatus, detail?: string) {
    this.status = status;
    this.onStatus?.(status, detail);
  }

  async connect(wsUrl: string): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus('connecting');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.setStatus('idle', 'connected');
        this.startKeepalive();
        resolve();
      };
      ws.onerror = () => {
        this.stopKeepalive();
        this.setStatus('error', 'websocket error');
        reject(new Error('FlashHead WebSocket connection failed'));
      };
      ws.onclose = () => {
        this.stopKeepalive();
        this.setStatus('closed');
        this.ws = null;
        this.rejectWaiters(new Error('WebSocket closed'));
      };
      ws.onmessage = (ev) => this.handleMessage(ev);
    });
  }

  private rejectWaiters(err: Error) {
    for (const w of this.startWaiters.splice(0)) w.reject(err);
    for (const w of this.uploadWaiters.splice(0)) w.reject(err);
    for (const w of this.uploadAckWaiters.splice(0)) w.reject(err);
    for (const w of this.flushWaiters.splice(0)) w.reject(err);
  }

  private startKeepalive() {
    this.stopKeepalive();
    // App-level ping so the server sees traffic during long GPU-bound stretches.
    this.keepaliveTimer = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      } catch {
        /* ignore */
      }
    }, 10000);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer != null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private ensureOpen(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('FlashHead WebSocket is not connected');
    }
    return this.ws;
  }

  private sendJson(payload: Record<string, unknown>) {
    this.ensureOpen().send(JSON.stringify(payload));
  }

  /** Upload image file bytes; returns server-side cond_image path. */
  async uploadImage(file: File | Blob, filename = 'face.png'): Promise<string> {
    const ws = this.ensureOpen();
    this.setStatus('uploading');
    const name = file instanceof File ? file.name : filename;

    const ackPromise = new Promise<void>((resolve, reject) => {
      this.uploadAckWaiters.push({ resolve, reject });
    });
    const readyPromise = new Promise<string>((resolve, reject) => {
      this.uploadWaiters.push({ resolve, reject });
    });

    this.sendJson({ type: 'upload_image', filename: name || filename });
    await ackPromise;
    const buf = await file.arrayBuffer();
    ws.send(buf);
    return readyPromise;
  }

  async start(options: FlashHeadStartOptions = {}): Promise<Record<string, unknown>> {
    this.ensureOpen();
    const payload: Record<string, unknown> = {
      type: 'start',
      model_type: options.modelType ?? 'lite',
      sample_rate: options.sampleRate ?? 24000,
      fmt: options.fmt ?? 's16le',
      send_mp4_binary: options.sendMp4Binary ?? true,
      mux_audio: options.muxAudio ?? true,
      chunks_per_segment: options.chunksPerSegment ?? 2,
      first_segment_chunks: options.firstSegmentChunks ?? 1,
      emit_on_flush_only: options.emitOnFlushOnly ?? false,
      stream_mode: options.streamMode ?? 'mp4',
      jpeg_quality: options.jpegQuality ?? 60,
      stream_max_long_side: options.streamMaxLongSide ?? 512,
      aspect_ratio: options.aspectRatio ?? '1:1',
      max_long_side: options.maxLongSide ?? 1024,
      use_face_crop: options.useFaceCrop ?? false,
      seed: options.seed ?? 9999,
    };
    if (options.condImage) payload.cond_image = options.condImage;
    if (options.ckptDir) payload.ckpt_dir = options.ckptDir;
    if (options.wav2vecDir) payload.wav2vec_dir = options.wav2vecDir;
    if (options.height != null) payload.height = options.height;
    if (options.width != null) payload.width = options.width;

    this.setStatus('loading');
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.startWaiters.push({ resolve, reject });
    });
    this.sendJson(payload);
    return promise;
  }

  sendPcm(bytes: ArrayBuffer | Uint8Array) {
    const ws = this.ensureOpen();
    if (this.status !== 'ready' && this.status !== 'streaming') {
      throw new Error(`cannot send PCM in status=${this.status}`);
    }
    this.setStatus('streaming');
    const data =
      bytes instanceof Uint8Array
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : bytes;
    ws.send(data);
  }

  async flush(padSilence = true): Promise<void> {
    this.ensureOpen();
    this.setStatus('flushing');
    const promise = new Promise<void>((resolve, reject) => {
      this.flushWaiters.push({ resolve, reject });
    });
    this.sendJson({ type: 'flush', pad_silence: padSilence });
    return promise;
  }

  close() {
    this.stopKeepalive();
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendJson({ type: 'close' });
      }
    } catch {
      /* ignore */
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  private handleMessage(ev: MessageEvent) {
    if (typeof ev.data !== 'string') {
      const buf = ev.data as ArrayBuffer;
      if (this.waitingMp4Meta) {
        const meta = this.waitingMp4Meta;
        this.waitingMp4Meta = null;
        const blob = new Blob([buf], { type: 'video/mp4' });
        this.onVideo?.({
          chunkIdx: Number(meta.chunk_idx ?? 0),
          nFrames: Number(meta.n_frames ?? 0),
          height: Number(meta.height ?? 0),
          width: Number(meta.width ?? 0),
          fps: Number(meta.fps ?? 25),
          elapsedSec: Number(meta.elapsed_sec ?? 0),
          videoPath: meta.video_path ? String(meta.video_path) : undefined,
          byteLength: Number(meta.byte_length ?? buf.byteLength),
          blob,
        });
        return;
      }
      if (this.waitingFrameMeta) {
        const meta = this.waitingFrameMeta;
        this.waitingFrameMeta = null;
        this.onFrameBatch?.({
          chunkIdx: Number(meta.chunk_idx ?? 0),
          nFrames: Number(meta.n_frames ?? 0),
          pts0: Number(meta.pts0 ?? 0),
          fps: Number(meta.fps ?? 25),
          height: Number(meta.height ?? 0),
          width: Number(meta.width ?? 0),
          audioSampleRate: Number(meta.audio_sample_rate ?? 16000),
          elapsedSec: Number(meta.elapsed_sec ?? 0),
          payload: buf,
        });
        return;
      }
      // unexpected binary
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      this.setStatus('error', 'invalid JSON from server');
      return;
    }

    const type = String(msg.type || '');
    if (type === 'upload_image_ack') {
      for (const w of this.uploadAckWaiters.splice(0)) w.resolve();
      return;
    }
    if (type === 'image_ready') {
      const path = String(msg.cond_image || '');
      this.lastCondImage = path;
      this.setStatus('idle', `image_ready: ${path}`);
      for (const w of this.uploadWaiters.splice(0)) w.resolve(path);
      this.onInfo?.(msg);
      return;
    }
    if (type === 'loading') {
      this.setStatus('loading', String(msg.message || 'loading'));
      return;
    }
    if (type === 'ready') {
      this.setStatus('ready');
      if (msg.cond_image) this.lastCondImage = String(msg.cond_image);
      for (const w of this.startWaiters.splice(0)) w.resolve(msg);
      this.onInfo?.(msg);
      return;
    }
    if (type === 'video') {
      this.waitingMp4Meta = msg;
      return;
    }
    if (type === 'frame_batch') {
      this.waitingFrameMeta = msg;
      return;
    }
    if (type === 'status') {
      this.onInfo?.(msg);
      return;
    }
    if (type === 'done') {
      this.setStatus('done');
      for (const w of this.flushWaiters.splice(0)) w.resolve();
      this.onInfo?.(msg);
      return;
    }
    if (type === 'error') {
      const err = new Error(String(msg.error || 'FlashHead error'));
      this.setStatus('error', err.message);
      this.rejectWaiters(err);
      return;
    }
    if (type === 'pong' || type === 'bye') {
      return;
    }
  }
}
