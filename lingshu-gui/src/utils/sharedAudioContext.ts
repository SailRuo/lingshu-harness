// Global AudioContext singleton to unify TTS playback and mic capture pipelines.
// This allows the browser/WebRTC audio engine to recognise TTS playback as far-end reference,
// enabling full Acoustic Echo Cancellation (AEC) and avoiding speaker feedback into the microphone.

let globalAudioCtx: AudioContext | null = null;
let ttsOutputBus: GainNode | null = null;
let ttsReferenceAnalyser: AnalyserNode | null = null;

export function getSharedAudioContext(): AudioContext {
  if (!globalAudioCtx || globalAudioCtx.state === 'closed') {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    globalAudioCtx = new AudioContextClass();
    ttsOutputBus = null;
    ttsReferenceAnalyser = null;
  }
  if (globalAudioCtx.state === 'suspended') {
    void globalAudioCtx.resume().catch(() => {});
  }
  return globalAudioCtx;
}

/** Return the existing context without creating one (creation must happen in a user gesture). */
export function getSharedAudioContextIfExists(): AudioContext | null {
  return globalAudioCtx && globalAudioCtx.state !== 'closed' ? globalAudioCtx : null;
}

/**
 * Single TTS output bus. Besides keeping every TTS path in the same audio
 * graph, the analyser gives the VAD a real far-end reference for local echo
 * rejection when platform AEC is insufficient.
 */
export function getTtsOutputNode(ctx = getSharedAudioContext()): AudioNode {
  // AudioNodes cannot cross AudioContext boundaries. Non-call playback that
  // intentionally owns another context must keep using its own destination.
  if (ctx !== globalAudioCtx) return ctx.destination;
  if (ttsOutputBus && ttsReferenceAnalyser && ctx === globalAudioCtx) {
    return ttsOutputBus;
  }
  ttsOutputBus = ctx.createGain();
  ttsOutputBus.gain.value = 1;
  ttsReferenceAnalyser = ctx.createAnalyser();
  ttsReferenceAnalyser.fftSize = 2048;
  ttsReferenceAnalyser.smoothingTimeConstant = 0;
  // Tap the bus in parallel: keep the audible path direct so a stalled or
  // throttled analyser can never swallow playback, while the VAD still gets
  // the far-end reference.
  ttsOutputBus.connect(ctx.destination);
  ttsOutputBus.connect(ttsReferenceAnalyser);
  return ttsOutputBus;
}

/** Far-end reference tap for the VAD; returns null for non-shared contexts. */
export function getTtsReferenceAnalyserNode(ctx = getSharedAudioContext()): AnalyserNode | null {
  if (ctx !== globalAudioCtx) return null;
  getTtsOutputNode(ctx);
  return ttsReferenceAnalyser;
}

/** Hard mute all WebAudio TTS paths while an interruption tears them down. */
export function setTtsOutputMuted(muted: boolean): void {
  const ctx = getSharedAudioContextIfExists();
  if (!ctx) return;
  const node = getTtsOutputNode(ctx);
  if (!(node instanceof GainNode)) return;
  node.gain.cancelScheduledValues(ctx.currentTime);
  node.gain.setValueAtTime(muted ? 0 : 1, ctx.currentTime);
  // Keep the intrinsic value in sync; some WebKit builds keep a suspended
  // context's scheduled automation at t=0 and never apply it after resume.
  node.gain.value = muted ? 0 : 1;
}

/** Return a 16kHz snapshot of the audible TTS output, or null before TTS starts. */
export function getTtsReferenceFrame(targetSampleRate = 16_000): Float32Array | null {
  const ctx = globalAudioCtx;
  const analyser = ttsReferenceAnalyser;
  if (!ctx || !analyser) return null;

  const source = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(source);
  if (ctx.sampleRate === targetSampleRate) return source;

  const ratio = ctx.sampleRate / targetSampleRate;
  const output = new Float32Array(Math.max(1, Math.round(source.length / ratio)));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(source.length, Math.floor((outputIndex + 1) * ratio));
    let sum = 0;
    for (let sourceIndex = start; sourceIndex < Math.max(start + 1, end); sourceIndex += 1) {
      sum += source[sourceIndex] || 0;
    }
    output[outputIndex] = sum / Math.max(1, end - start);
  }
  return output;
}

const elementSourceMap = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

export function connectMediaElementToSharedContext(audio: HTMLMediaElement, ctx = getSharedAudioContext()): void {
  if (elementSourceMap.has(audio)) return;
  try {
    const source = ctx.createMediaElementSource(audio);
    source.connect(getTtsOutputNode(ctx));
    elementSourceMap.set(audio, source);
  } catch (err) {
    console.warn('[SharedAudioContext] Failed to attach media element source:', err);
  }
}
