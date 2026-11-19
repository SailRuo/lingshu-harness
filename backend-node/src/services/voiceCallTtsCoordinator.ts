import { startTtsStream, streamTtsSegment } from "./ttsService.js";
import { sanitizeTtsText } from "./ttsText.js";

/**
 * Mirrors backend/core/services/voice_tts_coordinator.py (StreamingTtsCoordinator)
 * for the Node voice-call path:
 *
 * - text deltas are buffered and split on sentence-final punctuation only
 *   (never by character count);
 * - segments are synthesized strictly one after another so `seq` order is kept;
 * - a segment is announced as soon as its first audio chunk arrives. The event
 *   only carries the live audioUrl, so the client can start progressive
 *   playback before synthesis of that sentence finishes;
 * - a failed segment is skipped and never blocks later segments;
 * - cancel() aborts in-flight synthesis and suppresses every later callback,
 *   which is what barge-in needs (no late tts_segment/tts_stop after cancel).
 */

// P9: 旁白段终止符。
// Python 参考：core/companion/narration_format.py::_SEGMENT_TERMINATORS
//   "。！？；.!?;…"
// Node 原来只有 "。！？；!?;\n"，缺了 "…"（省略号）。
// ASCII "." 故意不加进切分字符集：Python 的 narration_segment_complete 只是
// 「是否收尾」的判定，不是切分器；Node 这里要真的切段，加 "." 会把 "3.5"、
// "example.com" 从中间切断。
const SENTENCE_END_CHARS = "。！？；!?;…\n";
const SENTENCE_PATTERN_SOURCE = `[^${SENTENCE_END_CHARS}]+[${SENTENCE_END_CHARS}]+`;
// 首段允许在弱停顿处提前开合成（对齐 Python _try_schedule_early_first_segment），
// 只作用于第一句，且仍然不会按字数硬切。
const WEAK_DELIMITERS = new Set(["，", "、", ",", "；", ";", "：", ":"]);
// P9: 闭引号 / 闭括号收尾也算一个旁白段结束。
// Python narration_format.py::narration_segment_complete 里的 '"\'")」』】'
const CLOSING_MARKS = new Set(['"', "'", ")", "」", "』", "】"]);

export interface VoiceCallTtsSegmentEvent {
  segmentId: string;
  audioUrl: string;
  mimeType: string;
  format: string;
  seq: number;
  text: string;
  sampleRate: number;
}

export interface VoiceCallTtsCoordinatorOptions {
  agentId?: number | null;
  sessionId?: number | null;
  messageId?: string | null;
  /** Route-level abort (voice.cancel / new turn / socket close). */
  signal?: AbortSignal;
  onSegment: (segment: VoiceCallTtsSegmentEvent) => void;
  /** Called once after finish() and all queued segments have settled. */
  onStop: () => void;
}

interface PendingSegment {
  seq: number;
  text: string;
}

export class VoiceCallTtsCoordinator {
  private readonly agentId: number | null;
  private readonly sessionId: number | null;
  private readonly messageId: string | null;
  private readonly signal?: AbortSignal;
  private readonly onSegment: (segment: VoiceCallTtsSegmentEvent) => void;
  private readonly onStop: () => void;

  private buffer = "";
  private queue: PendingSegment[] = [];
  private sequence = 0;
  private running = false;
  private inputFinished = false;
  private cancelled = false;
  private stopEmitted = false;
  private readonly activeAborts = new Set<AbortController>();
  private readonly idlePromise: Promise<void>;
  private resolveIdle: (() => void) | null = null;
  private readonly externalAbortHandler: () => void;

  constructor(options: VoiceCallTtsCoordinatorOptions) {
    this.agentId = options.agentId ?? null;
    this.sessionId = options.sessionId ?? null;
    this.messageId = options.messageId ?? null;
    this.signal = options.signal;
    this.onSegment = options.onSegment;
    this.onStop = options.onStop;
    this.idlePromise = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
    this.externalAbortHandler = () => this.cancel();
    if (this.signal) {
      if (this.signal.aborted) {
        this.cancelled = true;
        this.resolveIdle?.();
      } else {
        this.signal.addEventListener("abort", this.externalAbortHandler, { once: true });
      }
    }
  }

  /** Feed one LLM text delta. Safe to call while segments are synthesizing. */
  ingest(text: string): void {
    if (this.cancelled || this.inputFinished || !text) return;
    this.buffer += text;
    for (const chunk of this.takeReadySentences(false)) {
      this.schedule(chunk);
    }
    this.tryScheduleEarlyFirstSegment();
  }

  /**
   * Flush the remaining text after the LLM finished and resolve once every
   * queued segment has been synthesized or skipped. `onStop` fires right
   * before the promise resolves (and never after cancel()).
   */
  finish(): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    if (!this.inputFinished) {
      this.inputFinished = true;
      for (const chunk of this.takeReadySentences(true)) {
        this.schedule(chunk);
      }
      this.pump();
      this.maybeEmitStop();
    }
    return this.idlePromise;
  }

  /** Abort everything (barge-in). No callback may fire after this returns. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.buffer = "";
    this.queue = [];
    this.signal?.removeEventListener("abort", this.externalAbortHandler);
    for (const controller of [...this.activeAborts]) {
      try {
        controller.abort(new DOMException("voice_call_tts_cancelled", "AbortError"));
      } catch {
        // ignore
      }
    }
    this.activeAborts.clear();
    this.resolveIdle?.();
  }

  abort(): void {
    this.cancel();
  }

  private takeReadySentences(final: boolean): string[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    if (final) {
      const ready = this.buffer;
      this.buffer = "";
      return ready.trim() ? [ready] : [];
    }
    const pattern = new RegExp(SENTENCE_PATTERN_SOURCE, "g");
    const matches = [...this.buffer.matchAll(pattern)];
    if (!matches.length) {
      // P9: 还没有句末标点，但整段以闭引号 / 闭括号收尾时，Python 判定旁白段已完整。
      const trimmed = this.buffer.replace(/\s+$/, "");
      if (trimmed.length > 1 && CLOSING_MARKS.has(trimmed[trimmed.length - 1])) {
        this.buffer = this.buffer.slice(trimmed.length);
        return [trimmed];
      }
      return [];
    }
    const last = matches[matches.length - 1];
    const end = (last.index ?? 0) + last[0].length;
    const ready = matches.map((match) => match[0]);
    let rest = this.buffer.slice(end);
    // 句末标点后紧跟闭引号时，闭引号属于同一段（与 Python 规则一致）。
    if (rest.length && CLOSING_MARKS.has(rest[0])) {
      ready[ready.length - 1] += rest[0];
      rest = rest.slice(1);
    }
    this.buffer = rest;
    return ready;
  }

  private tryScheduleEarlyFirstSegment(): void {
    if (this.sequence > 0 || this.queue.length > 0 || this.running) return;
    if (!this.buffer.trim()) return;
    for (let index = 0; index < this.buffer.length; index += 1) {
      if (!WEAK_DELIMITERS.has(this.buffer[index])) continue;
      const chunk = this.buffer.slice(0, index + 1);
      if (!sanitizeTtsText(chunk).trim()) continue;
      this.buffer = this.buffer.slice(index + 1);
      this.schedule(chunk);
      return;
    }
  }

  private schedule(rawText: string): void {
    if (this.cancelled) return;
    const text = sanitizeTtsText(rawText).trim();
    if (!text) return;
    this.sequence += 1;
    this.queue.push({ seq: this.sequence, text });
    this.pump();
  }

  private pump(): void {
    if (this.running || this.cancelled) return;
    if (!this.queue.length) {
      this.maybeEmitStop();
      return;
    }
    this.running = true;
    void this.pumpLoop()
      .catch((error) => {
        console.warn("[VoiceCallTts] synthesis pump failed:", error);
      })
      .finally(() => {
        this.running = false;
        if (!this.cancelled && this.queue.length > 0) {
          this.pump();
          return;
        }
        this.maybeEmitStop();
      });
  }

  private async pumpLoop(): Promise<void> {
    while (!this.cancelled) {
      const item = this.queue.shift();
      if (!item) break;
      await this.synthesize(item);
    }
  }

  private maybeEmitStop(): void {
    if (this.cancelled || this.stopEmitted) return;
    if (!this.inputFinished || this.running || this.queue.length > 0) return;
    this.stopEmitted = true;
    try {
      this.onStop();
    } catch (error) {
      console.warn("[VoiceCallTts] onStop callback failed:", error);
    } finally {
      this.resolveIdle?.();
    }
  }

  private async synthesize(item: PendingSegment): Promise<void> {
    if (this.cancelled) return;
    const localAbort = new AbortController();
    const relayAbort = () => {
      try {
        localAbort.abort(new DOMException("voice_call_tts_aborted", "AbortError"));
      } catch {
        // ignore
      }
    };
    if (this.signal?.aborted) {
      relayAbort();
    } else {
      this.signal?.addEventListener("abort", relayAbort, { once: true });
    }
    this.activeAborts.add(localAbort);

    try {
      const handle = await startTtsStream(item.text, {
        agentId: this.agentId,
        sessionId: this.sessionId,
        signal: localAbort.signal,
        // Bound a stuck provider so one bad sentence cannot block the rest.
        timeoutMs: 90_000,
      });
      if (this.cancelled) return;

      const iterator = streamTtsSegment(handle, {
        text: item.text,
        seq: item.seq,
        messageId: this.messageId,
      });

      // Wait only for the first chunk of this sentence, then announce it.
      const first = await iterator.next();
      if (first.done || this.cancelled) {
        if (!first.done) {
          await iterator.return(undefined as never);
        }
        return;
      }
      const live = first.value.segment;
      try {
        this.onSegment({
          segmentId: live.id,
          audioUrl: `/api/voice/tts/segments/${live.id}`,
          mimeType: live.mimeType,
          format: live.format,
          seq: item.seq,
          text: item.text,
          sampleRate: live.sampleRate,
        });
      } catch (error) {
        console.warn("[VoiceCallTts] onSegment callback failed:", error);
      }

      // Keep the stream alive until this segment is fully synthesized; the
      // next sentence starts only after it settles (serial synthesis).
      let step = await iterator.next();
      while (!step.done) {
        if (this.cancelled) {
          await iterator.return(undefined as never);
          return;
        }
        step = await iterator.next();
      }
    } catch (error) {
      if (!this.cancelled && !this.signal?.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[VoiceCallTts] segment seq=${item.seq} failed, skipped: ${detail}`);
      }
    } finally {
      this.signal?.removeEventListener("abort", relayAbort);
      this.activeAborts.delete(localAbort);
    }
  }
}
