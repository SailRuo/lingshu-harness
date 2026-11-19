import { getDb } from "../db/sqlite.js";
import { affectPeriodKey } from "./memoryTime.js";
import { readAffectDailyPoints } from "./affectDailyService.js";

const BASELINE_RING_MAX = 60;
const BASELINE_WARMING_THRESHOLD = 4;
const BASELINE_STABLE_THRESHOLD = 15;
const NEUTRAL_PRIOR_VAD = 0;
const DEVIATION_STRONG_THRESHOLD = 0.5;
const DEVIATION_MILD_THRESHOLD = 0.25;
const AFFECT_NOTE_MAX_LENGTH = 255;
const CLOSENESS_SCALE = 15;
const TREND_THRESHOLD = 0.02;
const SAMPLES_PER_DEPTH = 0.12;

// P13 cold-start thresholds — hard data, mirrors Python self_state.py.
const COLD_START_MAX_SAMPLE_COUNT = 12;
const COLD_START_MAX_FACT_COUNT = 4;
const COLD_START_MAX_STREAM_COUNT = 6;

export const COLD_START_STAGE_ATTENTION =
  "你们刚开始认识，对他的真实生活、偏好、压力来源和说话习惯还了解很少。可询问怎么称呼，希望你怎么对待他";

/**
 * Per-turn affect input. Text VAD is the digest path (Python `AffectSignal`
 * text_* fields); voice VAD is optional and only used when the caller actually
 * provides all three voice dimensions. Missing dimensions are never coerced to
 * 0 — the whole sample is skipped instead (Python `channel_vad_from_signal`).
 */
export interface AffectInput {
  valence?: number | null;
  arousal?: number | null;
  dominance?: number | null;
  note?: string | null;
  /** camelCase voice aliases */
  voiceValence?: number | null;
  voiceArousal?: number | null;
  voiceDominance?: number | null;
  /** snake_case aliases accepted from raw digest payloads */
  text_valence?: number | null;
  text_arousal?: number | null;
  text_dominance?: number | null;
  voice_valence?: number | null;
  voice_arousal?: number | null;
  voice_dominance?: number | null;
}

export type TextAffect = AffectInput;
export type VadTriplet = [number, number, number];
export type DeviationLevel = "unknown" | "none" | "mild" | "strong";

export interface BaselineState {
  baselineStatus: string;
  textAffect: Record<string, number>;
  voiceAffect: Record<string, number>;
  textIqr: Record<string, number>;
  voiceIqr: Record<string, number>;
  textSamples: number[][];
  voiceSamples: number[][];
  sampleCount: number;
  textSampleCount: number;
  voiceSampleCount: number;
  evidenceRefs: unknown[];
}

export interface AcquaintanceSignals {
  sampleCount: number;
  factCount: number;
  streamCount: number;
}

export interface RecentTextAffectBand {
  median: VadTriplet;
  direction: "up" | "down" | "flat" | null;
  note: string | null;
  sampleCount: number;
}

interface BaselineRow {
  baseline_status: string | null;
  text_valence: number | null;
  text_arousal: number | null;
  text_dominance: number | null;
  voice_affect_json: string | null;
  text_iqr_json: string | null;
  voice_iqr_json: string | null;
  text_samples_json: string | null;
  voice_samples_json: string | null;
  evidence_refs_json: string | null;
  sample_count: number;
  text_sample_count: number;
  voice_sample_count: number;
  updated_at: string;
}

interface TrackUpdate {
  ring: number[][];
  affect: Record<string, number>;
  iqr: Record<string, number>;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toFinite(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function iqr(values: number[]): number {
  if (values.length < 2) return 0.12;
  if (values.length < 4) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.max(0.08, Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length));
  }
  const sorted = [...values].sort((left, right) => left - right);
  const q1 = sorted[Math.floor((sorted.length - 1) / 4)];
  const q3 = sorted[Math.floor((3 * (sorted.length - 1)) / 4)];
  return Math.max(0.05, q3 - q1);
}

function baselineStatus(sampleCount: number): string {
  if (sampleCount >= BASELINE_STABLE_THRESHOLD) return "stable";
  if (sampleCount >= BASELINE_WARMING_THRESHOLD) return "warming";
  return "cold";
}

function triplet(valence: unknown, arousal: unknown, dominance: unknown): VadTriplet | null {
  const v = toFinite(valence);
  const a = toFinite(arousal);
  const d = toFinite(dominance);
  // Missing any dimension -> no sample at all. Never substitute 0.
  if (v === null || a === null || d === null) return null;
  return [v, a, d];
}

export function textVadTriplet(affect: AffectInput | null | undefined): VadTriplet | null {
  if (!affect) return null;
  return triplet(
    affect.valence ?? affect.text_valence,
    affect.arousal ?? affect.text_arousal,
    affect.dominance ?? affect.text_dominance,
  );
}

export function voiceVadTriplet(affect: AffectInput | null | undefined): VadTriplet | null {
  if (!affect) return null;
  return triplet(
    affect.voiceValence ?? affect.voice_valence,
    affect.voiceArousal ?? affect.voice_arousal,
    affect.voiceDominance ?? affect.voice_dominance,
  );
}

function hasTextVad(affect: AffectInput | null | undefined): boolean {
  if (!affect) return false;
  return [affect.valence ?? affect.text_valence, affect.arousal ?? affect.text_arousal, affect.dominance ?? affect.text_dominance].some(
    (value) => toFinite(value) !== null,
  );
}

function hasVoiceVad(affect: AffectInput | null | undefined): boolean {
  if (!affect) return false;
  return [
    affect.voiceValence ?? affect.voice_valence,
    affect.voiceArousal ?? affect.voice_arousal,
    affect.voiceDominance ?? affect.voice_dominance,
  ].some((value) => toFinite(value) !== null);
}

function sanitizeRing(raw: unknown): number[][] {
  if (!Array.isArray(raw)) return [];
  const ring: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const sample = triplet(row[0], row[1], row[2]);
    if (sample) ring.push(sample);
  }
  return ring;
}

function completeVad(values: Record<string, number> | null | undefined): VadTriplet | null {
  if (!values) return null;
  return triplet(values.valence, values.arousal, values.dominance);
}

function storedTextAffect(row: BaselineRow | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!row) return out;
  const v = toFinite(row.text_valence);
  const a = toFinite(row.text_arousal);
  const d = toFinite(row.text_dominance);
  if (v !== null) out.valence = v;
  if (a !== null) out.arousal = a;
  if (d !== null) out.dominance = d;
  return out;
}

function storedVoiceAffect(row: BaselineRow | null): Record<string, number> {
  if (!row) return {};
  const parsed = parseJson<Record<string, unknown>>(row.voice_affect_json, {});
  const out: Record<string, number> = {};
  for (const key of ["valence", "arousal", "dominance"]) {
    const value = toFinite(parsed[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}

function readBaselineRow(agentId: number, userId: string): BaselineRow | null {
  return (getDb()
    .prepare("SELECT * FROM hippocampus_baselines WHERE agent_id = ? AND user_id = ?")
    .get(agentId, userId) as BaselineRow | undefined) || null;
}

function seedRingFromStored(values: Record<string, number>): number[][] {
  const sample = completeVad(values);
  return sample ? [sample] : [];
}

function updateTrack(
  ring: number[][],
  sample: VadTriplet | null,
  stored: Record<string, number>,
): TrackUpdate | null {
  if (!sample) return null;
  const next = ring.map((row) => [...row]);
  if (!next.length) next.push(...seedRingFromStored(stored));
  next.push(sample);
  if (next.length > BASELINE_RING_MAX) next.splice(0, next.length - BASELINE_RING_MAX);

  return {
    ring: next,
    affect: {
      valence: median(next.map((row) => Number(row[0]))),
      arousal: median(next.map((row) => Number(row[1]))),
      dominance: median(next.map((row) => Number(row[2]))),
    },
    iqr: {
      valence: iqr(next.map((row) => Number(row[0]))),
      arousal: iqr(next.map((row) => Number(row[1]))),
      dominance: iqr(next.map((row) => Number(row[2]))),
    },
  };
}

export function readBaseline(scope: { agentId: number; userId: string }): BaselineState {
  const row = readBaselineRow(scope.agentId, scope.userId);
  if (!row) {
    return {
      baselineStatus: "cold",
      textAffect: {},
      voiceAffect: {},
      textIqr: {},
      voiceIqr: {},
      textSamples: [],
      voiceSamples: [],
      sampleCount: 0,
      textSampleCount: 0,
      voiceSampleCount: 0,
      evidenceRefs: [],
    };
  }
  const textSamples = sanitizeRing(parseJson<unknown>(row.text_samples_json, []));
  const voiceSamples = sanitizeRing(parseJson<unknown>(row.voice_samples_json, []));
  return {
    baselineStatus: row.baseline_status || baselineStatus(Number(row.sample_count || 0)),
    textAffect: storedTextAffect(row),
    voiceAffect: storedVoiceAffect(row),
    textIqr: parseJson<Record<string, number>>(row.text_iqr_json, {}),
    voiceIqr: parseJson<Record<string, number>>(row.voice_iqr_json, {}),
    textSamples: textSamples.length ? textSamples : seedRingFromStored(storedTextAffect(row)),
    voiceSamples: voiceSamples.length ? voiceSamples : seedRingFromStored(storedVoiceAffect(row)),
    sampleCount: Number(row.sample_count || 0),
    textSampleCount: Number(row.text_sample_count || 0),
    voiceSampleCount: Number(row.voice_sample_count || 0),
    evidenceRefs: parseJson<unknown[]>(row.evidence_refs_json, []),
  };
}

export function getBaselineItem(scope: { agentId: number; userId: string }) {
  const baseline = readBaseline(scope);
  return {
    baselineStatus: baseline.baselineStatus,
    textAffect: baseline.textAffect,
    voiceAffect: baseline.voiceAffect,
    textIqr: baseline.textIqr,
    voiceIqr: baseline.voiceIqr,
    sampleCount: baseline.sampleCount,
    evidenceRefs: baseline.evidenceRefs,
  };
}

export function applyTextAffect(
  scope: { agentId: number; userId: string },
  affect: AffectInput,
  options: { turnId?: number | null; createdAt?: string; source?: string } = {},
) {
  const db = getDb();
  const now = options.createdAt || new Date().toISOString();
  const row = readBaselineRow(scope.agentId, scope.userId);
  const textSample = textVadTriplet(affect);
  const voiceSample = voiceVadTriplet(affect);

  const textUpdate = textSample
    ? updateTrack(
        sanitizeRing(parseJson<unknown>(row?.text_samples_json, [])),
        textSample,
        storedTextAffect(row),
      )
    : null;
  // Voice track: only advanced when the caller supplied a complete voice VAD
  // triplet. Otherwise the existing voice_* columns are preserved untouched.
  //
  // TODO(voice-affect): the Node voice duplex / ASR path does not expose an
  // emotion signal today (sherpa-onnx ASR returns text only; SER was explicitly
  // not migrated). Until a real voice VAD source exists, this track stays
  // dormant rather than being fed text affect or synthetic values.
  const voiceUpdate = voiceSample
    ? updateTrack(
        sanitizeRing(parseJson<unknown>(row?.voice_samples_json, [])),
        voiceSample,
        storedVoiceAffect(row),
      )
    : null;

  const sampleCount = Number(row?.sample_count || 0) + 1;
  const status = baselineStatus(sampleCount);
  const note = String(affect.note ?? "").trim().slice(0, AFFECT_NOTE_MAX_LENGTH) || null;
  const source = options.source || "digest";

  const textValence = textUpdate ? textUpdate.affect.valence : row?.text_valence ?? null;
  const textArousal = textUpdate ? textUpdate.affect.arousal : row?.text_arousal ?? null;
  const textDominance = textUpdate ? textUpdate.affect.dominance : row?.text_dominance ?? null;
  const textIqrJson = textUpdate ? JSON.stringify(textUpdate.iqr) : row?.text_iqr_json ?? null;
  const textSamplesJson = textUpdate ? JSON.stringify(textUpdate.ring) : row?.text_samples_json ?? null;
  const voiceAffectJson = voiceUpdate ? JSON.stringify(voiceUpdate.affect) : row?.voice_affect_json ?? null;
  const voiceIqrJson = voiceUpdate ? JSON.stringify(voiceUpdate.iqr) : row?.voice_iqr_json ?? null;
  const voiceSamplesJson = voiceUpdate ? JSON.stringify(voiceUpdate.ring) : row?.voice_samples_json ?? null;
  const textSampleCount = textUpdate ? textUpdate.ring.length : Number(row?.text_sample_count || 0);
  const voiceSampleCount = voiceUpdate ? voiceUpdate.ring.length : Number(row?.voice_sample_count || 0);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO hippocampus_baselines
        (agent_id, user_id, baseline_status, text_valence, text_arousal, text_dominance,
         voice_affect_json, text_iqr_json, voice_iqr_json, text_samples_json, voice_samples_json,
         evidence_refs_json, sample_count, text_sample_count, voice_sample_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, user_id) DO UPDATE SET
         baseline_status = excluded.baseline_status,
         text_valence = excluded.text_valence, text_arousal = excluded.text_arousal,
         text_dominance = excluded.text_dominance, text_iqr_json = excluded.text_iqr_json,
         text_samples_json = excluded.text_samples_json, sample_count = excluded.sample_count,
         text_sample_count = excluded.text_sample_count,
         voice_affect_json = excluded.voice_affect_json, voice_iqr_json = excluded.voice_iqr_json,
         voice_samples_json = excluded.voice_samples_json,
         voice_sample_count = excluded.voice_sample_count,
         updated_at = excluded.updated_at`,
    ).run(
      scope.agentId,
      scope.userId,
      status,
      textValence,
      textArousal,
      textDominance,
      voiceAffectJson,
      textIqrJson,
      voiceIqrJson,
      textSamplesJson,
      voiceSamplesJson,
      row?.evidence_refs_json ?? "[]",
      sampleCount,
      textSampleCount,
      voiceSampleCount,
      now,
    );

    if (textSample) {
      if (options.turnId != null) {
        db.prepare(
          "DELETE FROM hippocampus_affect_points WHERE agent_id = ? AND user_id = ? AND turn_id = ? AND channel = 'text'",
        ).run(scope.agentId, scope.userId, options.turnId);
      }
      db.prepare(
        `INSERT INTO hippocampus_affect_points
          (agent_id, user_id, turn_id, channel, source, valence, arousal, dominance, note, created_at)
         VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?, ?)`,
      ).run(
        scope.agentId,
        scope.userId,
        options.turnId ?? null,
        source,
        textSample[0],
        textSample[1],
        textSample[2],
        note,
        now,
      );
    }

    if (voiceSample) {
      if (options.turnId != null) {
        db.prepare(
          "DELETE FROM hippocampus_affect_points WHERE agent_id = ? AND user_id = ? AND turn_id = ? AND channel = 'voice'",
        ).run(scope.agentId, scope.userId, options.turnId);
      }
      db.prepare(
        `INSERT INTO hippocampus_affect_points
          (agent_id, user_id, turn_id, channel, source, valence, arousal, dominance, note, created_at)
         VALUES (?, ?, ?, 'voice', ?, ?, ?, ?, ?, ?)`,
      ).run(
        scope.agentId,
        scope.userId,
        options.turnId ?? null,
        source,
        voiceSample[0],
        voiceSample[1],
        voiceSample[2],
        note,
        now,
      );
    }
  });
  tx();

  return { ...getBaselineItem(scope), status };
}

// ─── ΔVAD deviation (Python state.py) ────────────────────────────────────────

function referenceAffectForDeviation(
  baseline: BaselineState,
  text: boolean,
): Record<string, number> {
  const stored = text ? baseline.textAffect : baseline.voiceAffect;
  const keys = ["valence", "arousal", "dominance"] as const;
  if (baseline.baselineStatus === "stable") {
    const out: Record<string, number> = {};
    for (const key of keys) {
      const value = toFinite(stored[key]);
      if (value !== null) out[key] = value;
    }
    return out;
  }
  if (baseline.baselineStatus === "warming") {
    const out: Record<string, number> = {};
    for (const key of keys) out[key] = toFinite(stored[key]) ?? NEUTRAL_PRIOR_VAD;
    return out;
  }
  return {};
}

function vadEuclideanDistance(
  current: VadTriplet | null,
  reference: Record<string, number>,
): number | null {
  if (!current) return null;
  const v = toFinite(reference.valence);
  const a = toFinite(reference.arousal);
  const d = toFinite(reference.dominance);
  if (v === null || a === null || d === null) return null;
  return Math.sqrt((current[0] - v) ** 2 + (current[1] - a) ** 2 + (current[2] - d) ** 2);
}

/** Pure ΔVAD classification. COLD baseline always returns `unknown`. */
export function computeDeviation(
  current: AffectInput | null | undefined,
  baseline: BaselineState,
): DeviationLevel {
  if (baseline.baselineStatus === "cold") return "unknown";

  const textDist = vadEuclideanDistance(
    textVadTriplet(current),
    referenceAffectForDeviation(baseline, true),
  );
  const voiceDist = vadEuclideanDistance(
    voiceVadTriplet(current),
    referenceAffectForDeviation(baseline, false),
  );

  let maxDist: number | null = null;
  if (textDist !== null && voiceDist !== null) maxDist = Math.max(textDist, voiceDist);
  else if (textDist !== null) maxDist = textDist;
  else if (voiceDist !== null) maxDist = voiceDist;

  if (maxDist === null) return "none";
  if (maxDist >= DEVIATION_STRONG_THRESHOLD) return "strong";
  if (maxDist >= DEVIATION_MILD_THRESHOLD) return "mild";
  return "none";
}

// ─── Baseline rendering (Python state.py renderers) ─────────────────────────

const VAD_DIM_LABELS: Record<"valence" | "arousal" | "dominance", string> = {
  valence: "情绪基调",
  arousal: "活跃度",
  dominance: "掌控感",
};

function deltaStrengthWord(absDelta: number, spread: number | null): string {
  if (spread !== null && spread > 0) {
    const ratio = absDelta / spread;
    if (ratio < 0.5) return "略";
    if (ratio < 1.2) return "";
    if (ratio < 2.0) return "不少";
    return "很多";
  }
  if (absDelta < 0.15) return "略";
  if (absDelta < 0.35) return "";
  if (absDelta < 0.55) return "不少";
  return "很多";
}

function formatVadDeltaClause(
  dimKey: "valence" | "arousal" | "dominance",
  delta: number,
  spread: number | null,
): string {
  const label = VAD_DIM_LABELS[dimKey];
  if (Math.abs(delta) < 0.08) return `${label}与平时持平`;

  const strength = deltaStrengthWord(Math.abs(delta), spread);
  let direction: string;
  if (dimKey === "valence") direction = delta > 0 ? "高" : "低";
  else if (dimKey === "arousal") direction = delta > 0 ? "更激动" : "更蔫";
  else direction = delta > 0 ? "更有掌控感" : "更无力";

  return `${label}比平时${direction}${strength}(约 ${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`;
}

/** Python `render_deviation_signal` — objective ΔVAD signal, no instructions. */
export function renderDeviationSignal(
  deviation: DeviationLevel,
  options: { relativeCue?: string; basetone?: string } = {},
): string {
  const lines: string[] = [];
  if (options.basetone) lines.push(options.basetone);
  if (options.relativeCue) {
    lines.push(options.relativeCue);
  } else if (deviation === "unknown") {
    lines.push("他此刻情绪（相对个人基线）：基线还嫩，信号不足");
  }
  return lines.join("\n");
}

/** Python `render_baseline_contextual_delta` — ΔVAD with dispersion context. */
export function renderBaselineContextualDelta(
  current: AffectInput,
  baseline: BaselineState,
  options: { modality?: "text" | "voice"; iqr?: Record<string, number> | null } = {},
): string {
  if (baseline.sampleCount < BASELINE_WARMING_THRESHOLD) {
    return renderDeviationSignal("unknown");
  }

  const modality = options.modality || "text";
  const useVoice = modality === "voice";
  const base = useVoice ? baseline.voiceAffect : baseline.textAffect;
  const iqrMap = options.iqr ?? (useVoice ? baseline.voiceIqr : baseline.textIqr);
  const currentValues = useVoice
    ? [
        toFinite(current.voiceValence ?? current.voice_valence),
        toFinite(current.voiceArousal ?? current.voice_arousal),
        toFinite(current.voiceDominance ?? current.voice_dominance),
      ]
    : [
        toFinite(current.valence ?? current.text_valence),
        toFinite(current.arousal ?? current.text_arousal),
        toFinite(current.dominance ?? current.text_dominance),
      ];

  const clauses: string[] = [];
  const dims = ["valence", "arousal", "dominance"] as const;
  for (let index = 0; index < dims.length; index += 1) {
    const key = dims[index];
    const baseValue = toFinite(base[key]);
    const currentValue = currentValues[index];
    // Render each available dimension independently, like Python. Missing
    // dimensions are skipped, never treated as 0.
    if (currentValue === null || baseValue === null) continue;
    clauses.push(formatVadDeltaClause(key, currentValue - baseValue, toFinite(iqrMap[key])));
  }

  if (!clauses.length) return renderDeviationSignal("unknown");
  if (clauses.every((clause) => clause.includes("与平时持平"))) {
    return "他此刻情绪接近个人基线（三维与平时持平）";
  }
  return "他此刻 " + clauses.join("；");
}

/** Python `render_baseline_basetone` — "他平时的样子" reference. */
export function renderBaselineBasetone(baseline: BaselineState): string {
  if (baseline.sampleCount < BASELINE_WARMING_THRESHOLD) return "";
  const textAffect = baseline.textAffect || {};
  const valence = toFinite(textAffect.valence);
  const arousal = toFinite(textAffect.arousal);
  const bits: string[] = [];
  if (valence !== null) {
    if (valence >= 0.6) bits.push("整体基调偏明朗、平和");
    else if (valence <= 0.4) bits.push("整体基调偏内敛、不太外露情绪");
  }
  if (arousal !== null) {
    if (arousal >= 0.6) bits.push("平时表达比较密、外放");
    else if (arousal <= 0.4) bits.push("平时比较安静、话不多");
  }
  if (!bits.length) return "";
  return `他平时：${bits.join("，")}`;
}

/** Python `render_his_current_state` — voice preferred when both are present. */
export function renderHisCurrentState(current: AffectInput, baseline: BaselineState): string {
  let block: string;
  let label = "";
  if (hasVoiceVad(current)) {
    block = renderBaselineContextualDelta(current, baseline, { modality: "voice" });
    label = "语音感知：VAD 三维相对他个人基线的差异";
  } else if (hasTextVad(current)) {
    block = renderBaselineContextualDelta(current, baseline, { modality: "text" });
    label = "文字感知：VAD 三维相对他个人基线的差异";
  } else {
    const basetone = renderBaselineBasetone(baseline);
    block = basetone || renderDeviationSignal("unknown");
  }

  const note = String(current.note ?? "").trim();
  if (note && !block.includes("情绪读数：")) {
    block = block ? `${block}\n情绪读数：${note}` : `情绪读数：${note}`;
  }
  if (label && block) return `${label}\n${block}`;
  return block;
}

/**
 * Python `recent_text_affect_band` — median VAD of the last `window` text
 * readings plus a valence direction over the window halves (threshold ±0.1).
 */
export function recentTextAffectBand(
  scope: { agentId: number; userId: string },
  window = 10,
): RecentTextAffectBand | null {
  const limit = Math.max(1, Math.trunc(window));
  const rows = getDb()
    .prepare(
      `SELECT valence, arousal, dominance, note, created_at
       FROM hippocampus_affect_points
       WHERE agent_id = ? AND user_id = ? AND channel = 'text'
         AND valence IS NOT NULL AND arousal IS NOT NULL AND dominance IS NOT NULL
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, limit) as {
    valence: number;
    arousal: number;
    dominance: number;
    note: string | null;
    created_at: string;
  }[];
  if (!rows.length) return null;

  // Reverse to chronological order so the direction math reads left-to-right.
  rows.reverse();
  const values = rows.map((row) => [
    Number(row.valence),
    Number(row.arousal),
    Number(row.dominance),
  ]);
  const valsV = values.map((row) => row[0]);

  let direction: "up" | "down" | "flat" | null = null;
  if (rows.length >= 4) {
    const half = Math.floor(rows.length / 2);
    const diff = median(valsV.slice(half)) - median(valsV.slice(0, half));
    if (diff >= 0.1) direction = "up";
    else if (diff <= -0.1) direction = "down";
    else direction = "flat";
  }

  let note: string | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = String(rows[index].note || "").trim();
    if (candidate) {
      note = candidate;
      break;
    }
  }

  return {
    median: [median(values.map((row) => row[0])), median(values.map((row) => row[1])), median(values.map((row) => row[2]))],
    direction,
    note,
    sampleCount: rows.length,
  };
}

/** Python `render_recent_text_affect_band` — "近来文字里的他". */
export function renderRecentTextAffectBand(
  band: RecentTextAffectBand | null | undefined,
  baseline: BaselineState,
): string {
  if (!band) return "";
  if (baseline.sampleCount < BASELINE_WARMING_THRESHOLD) return "";
  const base = baseline.textAffect || {};
  const iqrMap = baseline.textIqr || {};
  const dims = ["valence", "arousal", "dominance"] as const;

  const clauses: string[] = [];
  for (let index = 0; index < dims.length; index += 1) {
    const key = dims[index];
    const baseValue = toFinite(base[key]);
    const currentValue = toFinite(band.median[index]);
    if (currentValue === null || baseValue === null) continue;
    clauses.push(formatVadDeltaClause(key, currentValue - baseValue, toFinite(iqrMap[key])));
  }

  const head = `近来文字里的他（最近${band.sampleCount}段读数中位，非此刻实时）：`;
  let body: string;
  if (!clauses.length || clauses.every((clause) => clause.includes("与平时持平"))) {
    body = head + "与平时持平";
  } else {
    body = head + clauses.join("；");
  }

  if (band.direction === "down") body += "；近几段在往下沉";
  else if (band.direction === "up") body += "；近几段在回暖";

  const note = String(band.note || "").trim();
  if (note) body += `\n近况一句：${note}`;
  body += "\n（此刻文字情绪请你自己读当前消息，这只是近况参照）";
  return body;
}

// ─── Cold-start acquaintance gate (Python self_state.py) ────────────────────

export function loadAcquaintanceSignals(
  scope: { agentId: number; userId: string },
  baselineSampleCount?: number,
): AcquaintanceSignals {
  const db = getDb();
  const sampleCount = baselineSampleCount ?? readBaseline(scope).sampleCount;
  const factRow = db
    .prepare(
      `SELECT count(f.id) AS count
       FROM hippocampus_facts f
       JOIN hippocampus_entities src ON f.from_entity_id = src.id
       WHERE src.agent_id = ? AND src.user_id = ?
         AND f.agent_id = ? AND f.user_id = ?
         AND src.name IN ('Me', 'Self')
         AND f.status = 'current'`,
    )
    .get(scope.agentId, scope.userId, scope.agentId, scope.userId) as { count?: number } | undefined;
  const streamRow = db
    .prepare(
      `SELECT count(*) AS count
       FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND archived = 0
         AND COALESCE(origin_scope, '') <> 'group_public'`,
    )
    .get(scope.agentId, scope.userId) as { count?: number } | undefined;
  return {
    sampleCount,
    factCount: Number(factRow?.count || 0),
    streamCount: Number(streamRow?.count || 0),
  };
}

export function isColdStartAcquaintance(signals: AcquaintanceSignals): boolean {
  return (
    signals.sampleCount <= COLD_START_MAX_SAMPLE_COUNT &&
    signals.factCount <= COLD_START_MAX_FACT_COUNT &&
    signals.streamCount <= COLD_START_MAX_STREAM_COUNT
  );
}

export function renderColdStartAttention(): string {
  return COLD_START_STAGE_ATTENTION;
}

// ─── Self state ─────────────────────────────────────────────────────────────

export function deriveSelfState(scope: { agentId: number; userId: string }) {
  const db = getDb();
  const baseline = readBaseline(scope);
  const closeness = 1 - Math.exp(-((baseline.sampleCount * SAMPLES_PER_DEPTH) / CLOSENESS_SCALE));
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const aged = db
    .prepare(
      `SELECT closeness FROM hippocampus_self_state
       WHERE agent_id = ? AND user_id = ? AND created_at <= ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(scope.agentId, scope.userId, cutoff) as { closeness: number } | undefined;
  let baselineCloseness: number | null = aged ? Number(aged.closeness) : null;
  if (baselineCloseness == null) {
    const offset = db
      .prepare(
        `SELECT closeness FROM hippocampus_self_state
         WHERE agent_id = ? AND user_id = ?
         ORDER BY created_at DESC LIMIT 1 OFFSET 10`,
      )
      .get(scope.agentId, scope.userId) as { closeness: number } | undefined;
    baselineCloseness = offset ? Number(offset.closeness) : null;
  }
  const closenessTrend = baselineCloseness == null ? 0 : closeness - baselineCloseness;
  const intimacyTier =
    closeness >= 0.75
      ? "unreserved"
      : closeness >= 0.5
        ? "heart"
        : closeness >= 0.25
          ? "testing"
          : "surface";

  const recent = db
    .prepare(
      `SELECT content FROM chat_messages
       WHERE agent_id = ? AND user_id = ? AND role = 'assistant'
       ORDER BY id DESC LIMIT 3`,
    )
    .all(scope.agentId, scope.userId) as { content: string }[];
  let templateRisk = 0;
  if (recent.length >= 3) {
    const texts = recent.map((row) => String(row.content || "").trim()).filter(Boolean);
    const sims: number[] = [];
    for (let index = 0; index < texts.length - 1; index += 1) {
      const left = new Set(texts[index]);
      const right = new Set(texts[index + 1]);
      const union = new Set([...left, ...right]).size;
      let overlap = 0;
      for (const char of left) if (right.has(char)) overlap += 1;
      sims.push(union ? overlap / union : 0);
    }
    templateRisk = sims.length ? sims.reduce((sum, value) => sum + value, 0) / sims.length : 0;
  }

  return {
    closeness,
    closenessTrend,
    intimacyTier,
    templateRisk,
    trendState:
      closenessTrend >= TREND_THRESHOLD ? "closer" : closenessTrend <= -TREND_THRESHOLD ? "farther" : "steady",
  };
}

export function persistSelfStateSnapshot(
  scope: { agentId: number; userId: string },
  options: { trigger?: string; turnId?: number | null } = {},
) {
  const derived = deriveSelfState(scope);
  getDb()
    .prepare(
      `INSERT INTO hippocampus_self_state
        (agent_id, user_id, trigger, turn_id, closeness, closeness_trend, intimacy_tier,
         template_risk, granularity, sample_count, period, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'turn', ?, NULL, ?)`,
    )
    .run(
      scope.agentId,
      scope.userId,
      options.trigger || "digest",
      options.turnId ?? null,
      derived.closeness,
      derived.closenessTrend,
      derived.intimacyTier,
      derived.templateRisk,
      readBaseline(scope).sampleCount,
      new Date().toISOString(),
    );
  return derived;
}

// ─── Affect timeline ────────────────────────────────────────────────────────

function completeAffectRow(row: Record<string, unknown>): boolean {
  return (
    toFinite(row.valence) !== null &&
    toFinite(row.arousal) !== null &&
    toFinite(row.dominance) !== null
  );
}

function parseAffectPoint(row: any) {
  return {
    kind: "turn",
    granularity: "turn",
    channel: row.channel,
    turnId: row.turn_id == null ? null : String(row.turn_id),
    createdAt: row.created_at,
    affect: {
      valence: Number(row.valence),
      arousal: Number(row.arousal),
      dominance: Number(row.dominance),
    },
    note: row.note ?? undefined,
  };
}

function aggregatePoints(points: any[], granularity: string, channel: string) {
  if (granularity === "turn") return points;
  const groups = new Map<string, any[]>();
  for (const point of points) {
    const date = new Date(point.createdAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = affectPeriodKey(date, granularity);
    const list = groups.get(key) || [];
    list.push(point);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([period, group]) => ({
      kind: "aggregate",
      granularity,
      channel,
      period,
      createdAt: group[0]?.createdAt ?? null,
      sampleCount: group.reduce((sum, item) => sum + Number(item.sampleCount || 1), 0),
      affect: {
        valence: median(group.map((item) => Number(item.affect.valence))),
        arousal: median(group.map((item) => Number(item.affect.arousal))),
        dominance: median(group.map((item) => Number(item.affect.dominance))),
      },
    }));
}

function mergeAffectDailyPoints(
  scope: { agentId: number; userId: string },
  rawPoints: any[],
  granularity: string,
  channel: string,
  limit: number,
) {
  if (granularity === "turn") {
    return aggregatePoints(rawPoints, "turn", channel).slice(-limit);
  }
  const rawDaily = aggregatePoints(rawPoints, "day", channel);
  const storedDaily = readAffectDailyPoints(
    scope,
    channel,
    Math.max(500, Math.min(limit * 40, 20000)),
  );
  const byPeriod = new Map<string, any>(storedDaily.map((point) => [point.period, point]));
  for (const point of rawDaily) {
    byPeriod.set(String(point.period), point);
  }
  const merged = [...byPeriod.values()].sort((left, right) =>
    String(left.period).localeCompare(String(right.period)),
  );
  if (granularity === "day") return merged.slice(-limit);
  return aggregatePoints(merged, granularity, channel).slice(-limit);
}

export function readAffectTimeline(
  scope: { agentId: number; userId: string },
  limit = 200,
  granularity = "turn",
) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_affect_points
       WHERE agent_id = ? AND user_id = ?
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, Math.max(1, Math.min(limit * 40, 20000))) as any[];
  // Incomplete VAD rows are dropped rather than rendered as zeros.
  const completeRows = rows.filter(completeAffectRow);
  const textPoints = mergeAffectDailyPoints(
    scope,
    completeRows.filter((row) => row.channel === "text").map(parseAffectPoint),
    granularity,
    "text",
    limit,
  );
  const voicePoints = mergeAffectDailyPoints(
    scope,
    completeRows.filter((row) => row.channel === "voice").map(parseAffectPoint),
    granularity,
    "voice",
    limit,
  );

  const touchpoints: any[] = [];
  const touchRows = (
    db
      .prepare(
        `SELECT * FROM hippocampus_touchpoints
         WHERE agent_id = ? AND user_id = ?
         ORDER BY created_at DESC LIMIT 500`,
      )
      .all(scope.agentId, scope.userId) as any[]
  ).reverse();
  for (const row of touchRows) {
    const affect = parseJson<Record<string, unknown>>(row.affect_json, {});
    if (!completeAffectRow(affect)) continue;
    touchpoints.push({
      kind: "touchpoint",
      channel: "text",
      touchpointId: row.id,
      threadId: row.thread_id,
      episodeRef: row.episode_ref,
      grip: row.grip,
      createdAt: row.created_at,
      affect: {
        valence: Number(affect.valence),
        arousal: Number(affect.arousal),
        dominance: Number(affect.dominance),
      },
    });
  }

  const baseline = readBaseline(scope);
  return {
    granularity,
    baseline: {
      text: baseline.textAffect,
      voice: baseline.voiceAffect,
      textIqr: baseline.textIqr,
      voiceIqr: baseline.voiceIqr,
      sampleCount: baseline.sampleCount,
      textSampleCount: baseline.textSamples.length || baseline.textSampleCount,
      voiceSampleCount: baseline.voiceSamples.length || baseline.voiceSampleCount,
    },
    turnPoints: [...textPoints].reverse(),
    textTurnPoints: textPoints,
    voiceTurnPoints: voicePoints,
    touchpoints,
  };
}
