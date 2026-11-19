/**
 * Dual-buffer short MP4 queue: preload next while current plays to reduce black flashes.
 */
export class FlashHeadVideoQueue {
  private queue: { url: string; chunkIdx: number }[] = [];
  private playing = false;
  private switching = false;
  private primary: HTMLVideoElement | null = null;
  private secondary: HTMLVideoElement | null = null;
  private activeIsPrimary = true;
  private onPlayingChunk: ((chunkIdx: number) => void) | null = null;
  private preloadThresholdSec = 0.25;
  /** One full clip after flush — start as soon as the first (usually only) segment arrives. */
  private minBufferChunks = 1;
  private readonly startBufferChunks = 1;

  attach(
    primary: HTMLVideoElement,
    secondary: HTMLVideoElement,
    onPlayingChunk?: (chunkIdx: number) => void,
  ) {
    this.detach();
    this.primary = primary;
    this.secondary = secondary;
    this.onPlayingChunk = onPlayingChunk ?? null;
    this.activeIsPrimary = true;
    this.minBufferChunks = this.startBufferChunks;
    this.bind(primary);
    this.bind(secondary);
    primary.classList.add('is-active');
    secondary.classList.remove('is-active');
  }

  detach() {
    if (this.primary) this.unbind(this.primary);
    if (this.secondary) this.unbind(this.secondary);
    this.stopAndClearVideos();
    this.clear();
    this.primary = this.secondary = null;
    this.playing = false;
    this.switching = false;
  }

  enqueue(blob: Blob, chunkIdx: number) {
    const url = URL.createObjectURL(blob);
    this.queue.push({ url, chunkIdx });
    if (!this.playing && this.queue.length >= this.minBufferChunks) {
      void this.playNext();
    } else if (this.playing) {
      void this.prefetchIntoIdle();
    }
  }

  clear() {
    for (const item of this.queue) {
      URL.revokeObjectURL(item.url);
    }
    this.queue = [];
  }

  /** Stop queue for a new run, but keep the last painted frame (no black flash). */
  resetPlayback() {
    this.clear();
    this.playing = false;
    this.switching = false;
    this.minBufferChunks = this.startBufferChunks;

    const active = this.activeVideo();
    const idle = this.idleVideo();
    active?.pause();
    if (active && Number.isFinite(active.duration) && active.duration > 0) {
      try {
        // Hold near the end frame so the window stays occupied.
        active.currentTime = Math.max(0, active.duration - 0.05);
      } catch {
        /* ignore seek errors */
      }
      active.classList.add('is-active');
    }

    if (idle) {
      idle.pause();
      idle.dataset.prefetched = '0';
      const src = idle.getAttribute('src') || idle.src;
      if (src) {
        idle.removeAttribute('src');
        idle.load();
        if (src.startsWith('blob:')) URL.revokeObjectURL(src);
      }
      idle.classList.remove('is-active');
    }
  }

  /** PCM/TTS finished: allow play even if only one segment was produced. */
  notifyProducerDone() {
    this.minBufferChunks = 1;
    if (!this.playing && this.queue.length > 0) {
      void this.playNext();
    }
  }

  private bind(video: HTMLVideoElement) {
    video.addEventListener('ended', this.handleEnded);
    video.addEventListener('error', this.handleError);
    video.addEventListener('timeupdate', this.handleTimeUpdate);
  }

  private unbind(video: HTMLVideoElement) {
    video.removeEventListener('ended', this.handleEnded);
    video.removeEventListener('error', this.handleError);
    video.removeEventListener('timeupdate', this.handleTimeUpdate);
  }

  private activeVideo(): HTMLVideoElement | null {
    return this.activeIsPrimary ? this.primary : this.secondary;
  }

  private idleVideo(): HTMLVideoElement | null {
    return this.activeIsPrimary ? this.secondary : this.primary;
  }

  private stopAndClearVideos() {
    for (const v of [this.primary, this.secondary]) {
      if (!v) continue;
      v.pause();
      const src = v.src;
      v.removeAttribute('src');
      v.load();
      if (src.startsWith('blob:')) URL.revokeObjectURL(src);
      v.classList.remove('is-active');
    }
  }

  private handleEnded = () => {
    void this.playNext();
  };

  private handleError = () => {
    void this.playNext();
  };

  private handleTimeUpdate = () => {
    const active = this.activeVideo();
    if (!active || !this.playing || this.switching) return;
    const dur = active.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (dur - active.currentTime <= this.preloadThresholdSec) {
      void this.prefetchIntoIdle();
    }
  };

  private async waitCanPlay(video: HTMLVideoElement, timeoutMs = 4000): Promise<boolean> {
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return true;
    return await new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('error', onErr);
        clearTimeout(timer);
        resolve(ok);
      };
      const onReady = () => finish(true);
      const onErr = () => finish(false);
      video.addEventListener('canplay', onReady);
      video.addEventListener('error', onErr);
      const timer = window.setTimeout(() => finish(video.readyState >= 2), timeoutMs);
    });
  }

  private async prefetchIntoIdle() {
    const idle = this.idleVideo();
    if (!idle || this.switching || this.queue.length === 0) return;
    if (idle.dataset.prefetched === '1' && idle.src) return;

    const next = this.queue[0];
    if (!next) return;
    idle.dataset.prefetched = '0';
    idle.muted = false;
    idle.src = next.url;
    idle.load();
    const ok = await this.waitCanPlay(idle);
    if (ok && this.queue[0]?.url === next.url) {
      idle.dataset.prefetched = '1';
    }
  }

  private async playNext() {
    const active = this.activeVideo();
    const idle = this.idleVideo();
    if (!active || !idle) return;
    if (this.switching) return;
    this.switching = true;

    try {
      const next = this.queue.shift();
      if (!next) {
        this.playing = false;
        return;
      }

      // Prefer already-prefetched idle buffer when it matches.
      if (!(idle.dataset.prefetched === '1' && idle.src === next.url)) {
        idle.muted = false;
        idle.src = next.url;
        idle.load();
        const ok = await this.waitCanPlay(idle);
        if (!ok) {
          URL.revokeObjectURL(next.url);
          this.switching = false;
          void this.playNext();
          return;
        }
      }
      idle.dataset.prefetched = '0';

      this.playing = true;
      try {
        idle.currentTime = 0;
        await idle.play();
      } catch {
        try {
          idle.muted = true;
          await idle.play();
        } catch {
          URL.revokeObjectURL(next.url);
          this.switching = false;
          void this.playNext();
          return;
        }
      }

      idle.classList.add('is-active');
      active.classList.remove('is-active');
      active.pause();

      const oldSrc = active.src;
      if (oldSrc.startsWith('blob:') && oldSrc !== next.url) {
        active.removeAttribute('src');
        active.load();
        URL.revokeObjectURL(oldSrc);
      }

      this.activeIsPrimary = !this.activeIsPrimary;
      this.onPlayingChunk?.(next.chunkIdx);

      // Kick prefetch for the following chunk.
      void this.prefetchIntoIdle();
    } finally {
      this.switching = false;
    }
  }
}
