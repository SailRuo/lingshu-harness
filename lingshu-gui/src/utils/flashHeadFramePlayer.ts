/**
 * Live talking-head player: canvas + Web Audio on a shared pts timeline.
 *
 * True streaming for long TTS:
 * - Prebuffer a small jitter window, then play while more batches arrive.
 * - If playout catches the producer, AudioContext.suspend() until the next batch
 *   (freeze on last frame; no “wait for entire speech to finish”).
 */
export type FrameStreamBatch = {
  chunkIdx: number;
  pts0: number;
  fps: number;
  height: number;
  width: number;
  audioSampleRate: number;
  audio: Float32Array;
  frames: ImageBitmap[];
  elapsedSec: number;
};

export type FramePlayerOptions = {
  /** Seconds of media to queue before first start. Default 1.5. */
  minBufferSec?: number;
  leadInSec?: number;
};

export type BufferingInfo = {
  bufferedSec: number;
  /** true once continuous playout has started (may still rebuffer). */
  started: boolean;
  rebuffering: boolean;
};

export class FlashHeadFramePlayer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private audioCtx: AudioContext | null = null;
  private queue: FrameStreamBatch[] = [];
  private playing = false;
  private raf = 0;
  private epoch: number | null = null;
  private leadInSec = 0.08;
  /** Start after this much queued media. 0.9 ≈ first micro-chunk @25fps. */
  private minBufferSec = 0.9;
  private rtfEma: number | null = null;
  private showedBufferStill = false;
  private onPlayingChunk: ((chunkIdx: number) => void) | null = null;
  private onBuffering: ((info: BufferingInfo) => void) | null = null;
  private lastDrawnChunk = -1;
  private done = false;
  private rebuffering = false;
  private scheduledAudio = new Set<number>();

  configure(opts: FramePlayerOptions = {}) {
    if (opts.minBufferSec != null) this.minBufferSec = Math.max(0.3, opts.minBufferSec);
    if (opts.leadInSec != null) this.leadInSec = Math.max(0, opts.leadInSec);
  }

  get targetBufferSec(): number {
    return this.minBufferSec;
  }

  get started(): boolean {
    return this.playing;
  }

  attach(
    canvas: HTMLCanvasElement,
    onPlayingChunk?: (chunkIdx: number) => void,
    onBuffering?: (info: BufferingInfo) => void,
  ) {
    this.detach();
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.onPlayingChunk = onPlayingChunk ?? null;
    this.onBuffering = onBuffering ?? null;
  }

  detach() {
    this.reset();
    this.canvas = null;
    this.ctx2d = null;
    this.onPlayingChunk = null;
    this.onBuffering = null;
  }

  reset() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.playing = false;
    this.epoch = null;
    this.done = false;
    this.rebuffering = false;
    this.lastDrawnChunk = -1;
    this.rtfEma = null;
    this.showedBufferStill = false;
    this.scheduledAudio.clear();
    for (const b of this.queue) {
      for (const f of b.frames) f.close();
    }
    this.queue = [];
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close();
    }
    this.audioCtx = null;
  }

  bufferedSec(): number {
    if (this.queue.length === 0) return 0;
    return Math.max(0, this.mediaEndPts() - this.queue[0].pts0);
  }

  /** End pts of all queued video. */
  private mediaEndPts(): number {
    let end = 0;
    for (const b of this.queue) {
      const bEnd = b.pts0 + b.frames.length / Math.max(1, b.fps);
      if (bEnd > end) end = bEnd;
    }
    return end;
  }

  async pushBatch(batch: FrameStreamBatch) {
    this.queue.push(batch);
    this.noteGenPace(batch);

    if (!this.playing && !this.showedBufferStill && batch.frames[0]) {
      this.drawStill(batch.frames[0], batch.chunkIdx);
      this.showedBufferStill = true;
    }

    if (!this.playing) {
      this.emitBuffering();
      await this.startIfReady();
      return;
    }

    this.scheduleAudio(batch);
    if (this.rebuffering) {
      await this.resumeFromRebuffer();
    }
  }

  private noteGenPace(batch: FrameStreamBatch) {
    const dur = batch.frames.length / Math.max(1, batch.fps);
    const rtf = batch.elapsedSec / Math.max(1e-3, dur);
    this.rtfEma = this.rtfEma == null ? rtf : this.rtfEma * 0.5 + rtf * 0.5;
    // Only add jitter when generation is clearly slower than realtime.
    if (!this.playing && this.rtfEma > 0.95) {
      this.minBufferSec = Math.max(this.minBufferSec, 1.8);
    } else if (!this.playing && this.rtfEma <= 0.95) {
      // Fast / borderline: open after the first micro-chunk.
      this.minBufferSec = Math.min(this.minBufferSec, 0.9);
    }
  }

  notifyProducerDone() {
    this.done = true;
    this.emitBuffering();
    if (!this.playing && this.queue.length > 0) {
      void this.startIfReady(true);
    } else if (this.rebuffering) {
      void this.resumeFromRebuffer();
    }
  }

  private canStart(force = false): boolean {
    if (this.queue.length === 0) return false;
    if (force || this.done) return true;
    return this.bufferedSec() + 1e-3 >= this.minBufferSec;
  }

  private emitBuffering() {
    this.onBuffering?.({
      bufferedSec: this.bufferedSec(),
      started: this.playing,
      rebuffering: this.rebuffering,
    });
  }

  private async ensureAudio(): Promise<AudioContext> {
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      if (this.audioCtx.state === 'suspended' && this.playing && !this.rebuffering) {
        await this.audioCtx.resume();
      }
      return this.audioCtx;
    }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    this.audioCtx = new AC();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    return this.audioCtx;
  }

  private async startIfReady(force = false) {
    if (this.playing || !this.canStart(force)) {
      this.emitBuffering();
      return;
    }
    const audio = await this.ensureAudio();
    this.playing = true;
    this.rebuffering = false;
    this.epoch = audio.currentTime + this.leadInSec - this.queue[0].pts0;
    for (const b of this.queue) this.scheduleAudio(b);
    this.emitBuffering();
    this.tick();
  }

  private async resumeFromRebuffer() {
    if (!this.audioCtx || this.epoch == null) return;
    this.rebuffering = false;
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    this.emitBuffering();
  }

  private scheduleAudio(batch: FrameStreamBatch) {
    if (!this.audioCtx || this.epoch == null || batch.audio.length < 2) return;
    if (this.scheduledAudio.has(batch.chunkIdx)) return;
    this.scheduledAudio.add(batch.chunkIdx);

    const buffer = this.audioCtx.createBuffer(1, batch.audio.length, batch.audioSampleRate);
    buffer.copyToChannel(batch.audio, 0);
    const src = this.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.audioCtx.destination);
    const when = this.epoch + batch.pts0;
    const now = this.audioCtx.currentTime;
    if (when <= now) {
      const offset = Math.min(buffer.duration, now - when);
      src.start(now, offset);
    } else {
      src.start(when);
    }
  }

  private drawStill(bitmap: ImageBitmap | undefined, chunkIdx: number) {
    if (!bitmap) return;
    this.paint(bitmap);
    if (chunkIdx !== this.lastDrawnChunk) {
      this.lastDrawnChunk = chunkIdx;
      this.onPlayingChunk?.(chunkIdx);
    }
  }

  private paint(bitmap: ImageBitmap) {
    const canvas = this.canvas;
    const g = this.ctx2d;
    if (!canvas || !g) return;
    const bw = bitmap.width;
    const bh = bitmap.height;
    const cw = canvas.clientWidth || bw;
    const ch = canvas.clientHeight || bh;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const scale = Math.min(cw / bw, ch / bh);
    const dw = bw * scale;
    const dh = bh * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    g.fillStyle = '#000';
    g.fillRect(0, 0, cw, ch);
    g.drawImage(bitmap, dx, dy, dw, dh);
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const audio = this.audioCtx;
    if (!audio || this.epoch == null || !this.playing) return;

    const mediaEnd = this.mediaEndPts();
    let t = audio.currentTime - this.epoch;

    // Catching up to producer: pause clock until next batch (long-text safe).
    if (!this.done && mediaEnd > 0 && t >= mediaEnd - 0.04) {
      if (!this.rebuffering) {
        this.rebuffering = true;
        void audio.suspend();
        this.emitBuffering();
      }
      t = Math.max(0, mediaEnd - 0.04);
    }

    let best: { bitmap: ImageBitmap; chunkIdx: number } | null = null;
    for (const batch of this.queue) {
      for (let i = 0; i < batch.frames.length; i++) {
        const pts = batch.pts0 + i / batch.fps;
        if (pts <= t + 1e-4) {
          best = { bitmap: batch.frames[i], chunkIdx: batch.chunkIdx };
        } else {
          break;
        }
      }
    }
    if (!best) return;

    this.paint(best.bitmap);
    if (best.chunkIdx !== this.lastDrawnChunk) {
      this.lastDrawnChunk = best.chunkIdx;
      this.onPlayingChunk?.(best.chunkIdx);
    }

    while (this.queue.length > 1) {
      const head = this.queue[0];
      const end = head.pts0 + head.frames.length / head.fps;
      if (end < t - 0.35) {
        this.queue.shift();
        for (const f of head.frames) f.close();
      } else break;
    }
  };
}

/** Parse packed frame_batch binary from server. */
export function parseFrameBatchBinary(buf: ArrayBuffer): {
  audio: Float32Array;
  jpegBlobs: Blob[];
} {
  const view = new DataView(buf);
  let off = 0;
  const audioLen = view.getUint32(off, false);
  off += 4;
  const audioCopy = new Uint8Array(audioLen);
  audioCopy.set(new Uint8Array(buf, off, audioLen));
  off += audioLen;
  const int16 = new Int16Array(audioCopy.buffer);
  const audio = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) audio[i] = int16[i] / 32768;

  const nFrames = view.getUint32(off, false);
  off += 4;
  const jpegBlobs: Blob[] = [];
  for (let i = 0; i < nFrames; i++) {
    const len = view.getUint32(off, false);
    off += 4;
    const slice = new Uint8Array(buf, off, len);
    off += len;
    jpegBlobs.push(new Blob([slice], { type: 'image/jpeg' }));
  }
  return { audio, jpegBlobs };
}
