import { getApiBaseUrl, getFullUrl } from '../utils/apiConfig';

export type AsrStreamServerEvent =
  | { type: 'ready'; asrModel?: string; sampleRate?: number; transport?: string }
  | { type: 'asr_partial'; text: string; utteranceId?: string }
  | {
      type: 'asr_final';
      text: string;
      utteranceId?: string;
      rawText?: string;
      punctuatedText?: string;
      durationS?: number;
      sampleRate?: number;
      asrModel?: string;
      asrProvider?: 'local' | 'xiaomi' | 'aliyun';
      audioBase64?: string;
      audioMimeType?: string;
      voiceprintScore?: number;
      voiceprintPassed?: boolean;
      voiceprintEnabled?: boolean;
      isGuest?: boolean;
    }
  | { type: 'error'; detail: string };

export interface BackendAsrStatus {
  ready: boolean;
  installed?: boolean;
  model?: string;
  installDir?: string;
  downloadUrl?: string;
  streaming?: boolean;
  message?: string;
  provider?: 'local' | 'xiaomi' | 'aliyun';
  providerLabel?: string;
}

export function buildAsrStreamWsUrl(): string {
  const url = new URL('/api/v1/asr/stream', getApiBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function fetchBackendAsrStatus(): Promise<BackendAsrStatus> {
  try {
    const res = await fetch(getFullUrl('/api/v1/asr/status'));
    if (!res.ok) {
      return { ready: false, message: `服务端 ASR 状态不可用 (${res.status})` };
    }
    return (await res.json()) as BackendAsrStatus;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ready: false, message: `无法连接服务端 ASR：${detail}` };
  }
}

export class AsrStreamAbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AsrStreamAbortedError';
  }
}

export class AsrStreamClient {
  private socket: WebSocket | null = null;
  private ready = false;
  private connectPromise: Promise<void> | null = null;
  private aborted = false;
  private pendingAudio: ArrayBuffer[] = [];
  private pendingBytes = 0;
  private pendingFlush = false;
  /** 8s of 16kHz/16-bit PCM; enough to cover a slow local handshake, bounded. */
  private static readonly MAX_PENDING_BYTES = 16_000 * 2 * 8;

  connect(onEvent: (event: AsrStreamServerEvent) => void): Promise<void> {
    if (this.socket && this.ready) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.close(false);
    this.aborted = false;
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(buildAsrStreamWsUrl());
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.ready = false;
        this.connectPromise = null;
        reject(error);
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let payload: AsrStreamServerEvent;
        try {
          payload = JSON.parse(event.data) as AsrStreamServerEvent;
        } catch {
          return;
        }
        if (payload.type === 'ready') {
          this.ready = true;
          this.drainPending();
          if (this.pendingFlush) {
            this.pendingFlush = false;
            try { socket.send(JSON.stringify({ type: 'flush' })); } catch { /* ignore */ }
          }
          if (!settled) {
            settled = true;
            this.connectPromise = null;
            resolve();
          }
        }
        if (payload.type === 'error' && !this.ready && !settled) {
          if (this.aborted) {
            fail(new AsrStreamAbortedError());
            return;
          }
          fail(new Error(payload.detail || 'ASR 流式连接失败'));
          return;
        }
        onEvent(payload);
      };

      socket.onerror = () => {
        if (this.aborted) {
          fail(new AsrStreamAbortedError());
          return;
        }
        fail(new Error('ASR 流式 WebSocket 连接失败'));
      };

      socket.onclose = () => {
        this.ready = false;
        this.socket = null;
        if (!settled) {
          if (this.aborted) {
            fail(new AsrStreamAbortedError());
          } else {
            fail(new Error('ASR 流式连接已关闭'));
          }
        }
      };
    });

    return this.connectPromise;
  }

  sendPcm(pcm: number[] | Int16Array) {
    const samples = pcm instanceof Int16Array ? pcm : Int16Array.from(pcm);
    const buffer = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength,
    ) as ArrayBuffer;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.ready) {
      this.enqueuePending(buffer);
      return;
    }
    this.socket.send(buffer);
  }

  flush() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.ready) {
      this.pendingFlush = true;
      return;
    }
    this.drainPending();
    this.socket.send(JSON.stringify({ type: 'flush' }));
  }

  private enqueuePending(buffer: ArrayBuffer) {
    this.pendingAudio.push(buffer);
    this.pendingBytes += buffer.byteLength;
    while (
      this.pendingBytes > AsrStreamClient.MAX_PENDING_BYTES
      && this.pendingAudio.length > 0
    ) {
      const dropped = this.pendingAudio.shift();
      this.pendingBytes -= dropped?.byteLength || 0;
    }
  }

  private drainPending() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.ready) return;
    const pending = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    for (const buffer of pending) this.socket.send(buffer);
  }

  close(notifyServer = true) {
    this.aborted = true;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.connectPromise = null;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.pendingFlush = false;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN && notifyServer) {
      try {
        socket.send(JSON.stringify({ type: 'close' }));
      } catch {
        /* ignore */
      }
    }
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
}
