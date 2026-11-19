export type VoiceMode = 'push' | 'call' | null;

export interface VoiceTranscriptMeta {
  source?: 'cloud_asr' | 'local_asr' | 'hybrid' | 'backend_asr';
  transport?: string;
  utteranceId?: string;
  rawText?: string;
  punctuatedText?: string;
  durationS?: number;
  decodeS?: number;
  rtf?: number;
  serviceS?: number;
  startS?: number;
  sampleRate?: number;
  platform?: string;
  asrModel?: string;
  punctModel?: string;
  audioBase64?: string;
  audioMimeType?: string;
  voiceprintScore?: number;
  voiceprintPassed?: boolean;
  voiceprintEnabled?: boolean;
  isGuest?: boolean;
}

export type VoiceAsrState = 'unavailable' | 'ready' | 'error';

export interface VoiceAsrStatusPayload {
  state: VoiceAsrState;
  message?: string;
  progress?: number;
}

export type VoiceEngineEvent =
  | { type: 'voice.ready' }
  | { type: 'voice.vad_start'; utteranceId?: string }
  | { type: 'voice.vad_end'; utteranceId?: string }
  | { type: 'voice.asr_partial'; text: string; meta: VoiceTranscriptMeta }
  | { type: 'voice.asr_final'; text: string; meta: VoiceTranscriptMeta }
  | { type: 'voice.asr_status'; status: VoiceAsrStatusPayload }
  | { type: 'voice.error'; detail: string }
  | { type: 'voice.closed' };

export function normalizeCloudVoiceEvent(payload: Record<string, unknown>): VoiceEngineEvent | null {
  const eventType = String(payload.type || '');
  if (eventType === 'voice.session_ready') {
    return { type: 'voice.ready' };
  }
  if (eventType === 'voice.vad_start') {
    return {
      type: 'voice.vad_start',
      utteranceId: typeof payload.utteranceId === 'string' ? payload.utteranceId : undefined,
    };
  }
  if (eventType === 'voice.vad_end') {
    return {
      type: 'voice.vad_end',
      utteranceId: typeof payload.utteranceId === 'string' ? payload.utteranceId : undefined,
    };
  }
  if (eventType === 'voice.asr_final') {
    return {
      type: 'voice.asr_final',
      text: String(payload.text || '').trim(),
      meta: {
        source: 'cloud_asr',
        transport: 'websocket_cloud',
        utteranceId: typeof payload.utteranceId === 'string' ? payload.utteranceId : undefined,
      },
    };
  }
  if (eventType === 'voice.error') {
    return { type: 'voice.error', detail: String(payload.detail || '语音服务不可用') };
  }
  if (eventType === 'voice.session_closed') {
    return { type: 'voice.closed' };
  }
  return null;
}

export function normalizeLocalVoiceEvent(payload: Record<string, unknown>): VoiceEngineEvent | null {
  const eventType = String(payload.type || '');
  if (eventType === 'ready') {
    return { type: 'voice.ready' };
  }
  if (eventType === 'asr_partial') {
    return {
      type: 'voice.asr_partial',
      text: String(payload.text || '').trim(),
      meta: {
        source: 'local_asr',
        transport: typeof payload.transport === 'string' ? payload.transport : 'apple_speech',
        utteranceId: typeof payload.utteranceId === 'string' ? payload.utteranceId : undefined,
      },
    };
  }
  if (eventType === 'vad_start') {
    return {
      type: 'voice.vad_start',
      utteranceId: typeof payload.utteranceId === 'string' ? payload.utteranceId : undefined,
    };
  }
  if (eventType === 'vad_end') {
    return {
      type: 'voice.vad_end',
      utteranceId: typeof payload.utteranceId === 'string' ? payload.utteranceId : undefined,
    };
  }
  if (eventType === 'asr_final') {
    return {
      type: 'voice.asr_final',
      text: String(payload.text || '').trim(),
      meta: {
        source: 'local_asr',
        transport: typeof payload.transport === 'string' ? payload.transport : 'tauri_local',
        utteranceId: typeof payload.utteranceId === 'string' ? payload.utteranceId : undefined,
        rawText: typeof payload.rawText === 'string' ? payload.rawText : undefined,
        punctuatedText: typeof payload.punctuatedText === 'string' ? payload.punctuatedText : undefined,
        durationS: typeof payload.durationS === 'number' ? payload.durationS : undefined,
        decodeS: typeof payload.decodeS === 'number' ? payload.decodeS : undefined,
        rtf: typeof payload.rtf === 'number' ? payload.rtf : undefined,
        serviceS: typeof payload.serviceS === 'number' ? payload.serviceS : undefined,
        startS: typeof payload.startS === 'number' ? payload.startS : undefined,
        sampleRate: typeof payload.sampleRate === 'number' ? payload.sampleRate : undefined,
        platform: typeof payload.platform === 'string' ? payload.platform : undefined,
        asrModel: typeof payload.asrModel === 'string' ? payload.asrModel : undefined,
        punctModel: typeof payload.punctModel === 'string' ? payload.punctModel : undefined,
        audioBase64: typeof payload.audioBase64 === 'string' ? payload.audioBase64 : undefined,
        audioMimeType: typeof payload.audioMimeType === 'string' ? payload.audioMimeType : undefined,
      },
    };
  }
  if (eventType === 'asr_status') {
    return {
      type: 'voice.asr_status',
      status: {
        state: String(payload.state || 'unavailable') as VoiceAsrState,
        message: typeof payload.message === 'string' ? payload.message : undefined,
        progress: typeof payload.progress === 'number' ? payload.progress : undefined,
      },
    };
  }
  if (eventType === 'error') {
    return { type: 'voice.error', detail: String(payload.detail || '本地语音服务不可用') };
  }
  if (eventType === 'closed') {
    return { type: 'voice.closed' };
  }
  return null;
}
