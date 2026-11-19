/**
 * Native chat contract — desktop mirror of the APP's single source of truth.
 *
 * Source of truth (do not edit by hand):
 *   lingshu-app-local/shared/native-chat/source.mjs
 *   META.version = 50
 *
 * Seed activation, stream/state recall thresholds, relationship math and the
 * private-prompt section copy are re-exported from a byte-for-byte copy in
 * `generated/nativeChatSource.generated.ts`. Prompt text and section titles
 * must stay verbatim: the native assemblers and the APP's stored prompt tails
 * are compared/replayed by exact text.
 *
 * Scope: this mirror covers the chat/recall contract. The APP file also holds
 * `LINGJING`, `LINGJING_SPEECH`, `LINGJING_SCENE_BACKDROP` and
 * `LINGJING_MEMORY` — the 灵境 subsystem is a separate runtime and is
 * deliberately not mirrored here.
 *
 * Sync: see ./README.md (or run `node scripts/sync-native-contracts.mjs`).
 */

import {
  CALL as APP_CALL,
  EMBEDDING as APP_EMBEDDING,
  MEMORY_SEARCH as APP_MEMORY_SEARCH,
  META as APP_META,
  NEAR_WINDOW as APP_NEAR_WINDOW,
  PROMPT as APP_PROMPT,
  RELATIONSHIP as APP_RELATIONSHIP,
  SEED as APP_SEED,
  STATE as APP_STATE,
  STREAM as APP_STREAM,
  THEATER as APP_THEATER,
  TIANJI_TOOLS as APP_TIANJI_TOOLS,
} from "./generated/nativeChatSource.generated.js";

export interface NativeChatSourceMeta {
  /** APP `META.version` — bump in APP when the chat contract changes. */
  readonly version: number;
}

export const META: NativeChatSourceMeta = APP_META;

export interface NativeTianjiTools {
  readonly IDS: readonly string[];
  readonly WEB_BRIDGE_TIMEOUT_SECONDS: number;
}

export const TIANJI_TOOLS: NativeTianjiTools = APP_TIANJI_TOOLS;

/** Seed activation — mirrors Python personality_seed_activation.py. */
export interface NativeSeedConstants {
  readonly CANDIDATE_FLOOR: number;
  readonly INFLUENCE_FLOOR: number;
  readonly ACTIVE_THRESHOLD: number;
  readonly SUPPRESSED_FLOOR: number;
  readonly CANDIDATE_POOL_SIZE: number;
  readonly FIELD_BOOST_CAP: number;
  readonly FIELD_GUARD_CAP: number;
  readonly FIELD_PENALTY_CAP: number;
  readonly CROSS_BOOST_CAP: number;
  readonly CROSS_SUPPRESS_CAP: number;
  readonly CROSS_BOOST_SUM_CAP: number;
  readonly CROSS_SUPPRESS_SUM_CAP: number;
  readonly PROMPT_MAX_L2: number;
  readonly PROMPT_SEED_LIMIT: number;
}

export const SEED: NativeSeedConstants = APP_SEED;

/**
 * Stream recall. Direct recall is split into two independent pools:
 * private (private_dyadic) → DIRECT_LIMIT; public (group_public/theater) →
 * PUBLIC_LIMIT. TOTAL_CAP = DIRECT_LIMIT + PUBLIC_LIMIT + AKIN reserve.
 */
export interface NativeStreamRecallConstants {
  readonly RANK1_FLOOR: number;
  readonly TAIL_FLOOR: number;
  readonly DIRECT_LIMIT: number;
  readonly PUBLIC_LIMIT: number;
  readonly PUBLIC_FLOOR_BOOST: number;
  readonly TOTAL_CAP: number;
  readonly RELATED_SEED_ANCHORS: number;
  readonly RELATED_SLICE_FLOOR: number;
  readonly RELATED_LIMIT: number;
  readonly EXPANDED_QUERY_FLOOR: number;
  readonly AKIN_HOP_LIMIT: number;
  readonly AKIN_FIRST_HOP_LIMIT: number;
  readonly AKIN_SECOND_HOP_PER_NODE: number;
  /** @deprecated in APP — prefer DIRECT_LIMIT. */
  readonly DEFAULT_LIMIT: number;
  /** @deprecated in APP — prefer TOTAL_CAP - DIRECT_LIMIT room. */
  readonly VECTOR_EXTRA: number;
  readonly CURRENT_MESSAGE_BOOST: number;
}

export const STREAM: NativeStreamRecallConstants = APP_STREAM;

/** State channel — the second recall path (state-only utterances). */
export interface NativeStateChannelConstants {
  readonly MAX_CHARS: number;
  readonly WINDOW_HOURS: number;
  readonly MIN_WEIGHT: number;
  readonly LIMIT: number;
  readonly COOLDOWN_MINUTES: number;
  readonly NEUTRAL_INTERJECTIONS: string;
  readonly SIGH_INTERJECTIONS: string;
  readonly STATE_WORDS: readonly string[];
  readonly SIGH_NARRATIVE_FORMS: readonly string[];
}

export const STATE: NativeStateChannelConstants = APP_STATE;

/** Near-window recall framing — speaker attribution only. */
export interface NativeNearWindowConstants {
  readonly SPEAKER_INFIX: string;
  readonly SELF_SPEAKER: string;
  readonly USER_FALLBACK_LABEL: string;
  readonly COMBINED_SEPARATOR: string;
  readonly USER_LIMIT: number;
  readonly ASSISTANT_LIMIT: number;
}

export const NEAR_WINDOW: NativeNearWindowConstants = APP_NEAR_WINDOW;

/** Chinese BGE text contract (query instruction vs stored document). */
export interface NativeEmbeddingContract {
  readonly CONTRACT: string;
  readonly QUERY_PREFIX: string;
  readonly DOCUMENT_PREFIX: string;
}

export const EMBEDDING: NativeEmbeddingContract = APP_EMBEDDING;

/** search_memory tool — time-scoped recall over streams + same-day messages. */
export interface NativeMemorySearchConstants {
  readonly WINDOW_SLACK_MS: number;
  readonly STREAM_SCAN_CAP: number;
  readonly MESSAGE_SCAN_CAP: number;
  readonly STREAM_RESULT_LIMIT: number;
  readonly MESSAGE_RESULT_LIMIT: number;
  readonly RRF_K: number;
  readonly BM25_K1: number;
  readonly BM25_B: number;
  readonly STREAM_PREVIEW_CHARS: number;
  readonly MESSAGE_PREVIEW_CHARS: number;
}

export const MEMORY_SEARCH: NativeMemorySearchConstants = APP_MEMORY_SEARCH;

/** Relationship / intimacy. */
export interface NativeRelationshipConstants {
  readonly CLOSENESS_SCALE: number;
  readonly SAMPLES_PER_DEPTH: number;
  readonly TREND_THRESHOLD: number;
  readonly COLD_START_MAX_TURNS: number;
  readonly COLD_START_MAX_FACTS: number;
  readonly COLD_START_MAX_STREAMS: number;
  readonly TIER_UNRESERVED: number;
  readonly TIER_HEART: number;
  readonly TIER_TESTING: number;
}

export const RELATIONSHIP: NativeRelationshipConstants = APP_RELATIONSHIP;

/**
 * Private-chat prompt section titles and copy. Every field is the exact string
 * the APP injects; `SECTION_*` constants are headings, the rest are body text.
 */
export interface NativeChatPrompt {
  readonly SECTION_WHO: string;
  readonly SECTION_RIPPLES: string;
  readonly SECTION_STREAMS: string;
  readonly SECTION_STATE_RECALL: string;
  readonly SECTION_FACTS: string;
  readonly SECTION_PORTRAIT: string;
  readonly SECTION_PORTRAIT_HISTORY: string;
  readonly SECTION_PORTRAIT_HISTORY_LEGACY: string;
  readonly SECTION_PREFERENCES: string;
  readonly SECTION_RELATIONSHIP: string;
  readonly SECTION_SELF_PORTRAIT: string;
  readonly SELF_PORTRAIT_INTRO: string;
  readonly SECTION_COLD_START: string;
  readonly SECTION_APPOINTMENTS: string;
  readonly SECTION_GOALS: string;
  readonly SECTION_TOOL_CONTRACT: string;
  readonly SECTION_STYLE: string;
  readonly SECTION_PERSONA_DIMENSIONS: string;
  readonly SECTION_EXPRESSION: string;
  readonly SECTION_DIALOGUE_STRATEGY: string;
  readonly SECTION_HARD_DONTS: string;
  readonly SECTION_LAST_SEEN: string;
  readonly SECTION_DIALOGUE_TIME: string;
  readonly SECTION_GROUP_PRIVATE: string;
  readonly SECTION_STICKERS: string;
  readonly SECTION_STICKERS_LEGACY: string;
  readonly STICKER_CATALOG_INTRO: string;
  readonly EMPTY_STREAMS: string;
  readonly EMPTY_FACTS: string;
  readonly EMPTY_RIPPLES: string;
  readonly RIPPLE_INTRO: string;
  readonly STATE_RECALL_INTRO: string;
  readonly PREFERENCE_INTRO: string;
  readonly DIALOGUE_STRATEGY: string;
  readonly FORBID_PARENTHESES_OUTPUT: string;
  readonly STAGE_PARENTHESES_OUTPUT: string;
  readonly LEGACY_STAGE_PARENTHESES_OUTPUT_V4: string;
  readonly LEGACY_STAGE_PARENTHESES_OUTPUT: string;
  readonly LEGACY_STAGE_PARENTHESES_OUTPUT_V2: string;
  readonly LEGACY_STAGE_PARENTHESES_OUTPUT_V3: string;
  readonly COLD_START_STAGE_ATTENTION: string;
  readonly GOALS_GUIDE: string;
  readonly MEMORY_GUIDANCE_1: string;
  readonly MEMORY_GUIDANCE_2: string;
  readonly HARD_DONTS: readonly string[];
  readonly TIER_LABELS: {
    readonly surface: string;
    readonly testing: string;
    readonly heart: string;
    readonly unreserved: string;
  };
  readonly TREND_WARMING: string;
  readonly TREND_COOLING: string;
  readonly TREND_STABLE: string;
  readonly TREND_UNKNOWN: string;
  readonly KNOW_LITTLE: string;
  readonly KNOW_SOME: string;
  readonly KNOW_MORE: string;
  readonly COLD_START_STAGE_LINE: string;
  readonly MULTI_REPLY_MARKER: string;
  readonly MULTI_REPLY_MAX_CONTINUATIONS: number;
  readonly MULTI_REPLY_CONTINUE_DELAY_MS: number;
  readonly MULTI_REPLY_PROMPT: string;
  readonly MULTI_REPLY_CONTINUE_CUE: string;
  readonly MANAGE_ALARM_IMPLICIT_TOOL_INSTRUCTIONS: readonly string[];
  readonly MANAGE_GOAL_TOOL_INSTRUCTIONS: readonly string[];
  readonly TIANJI_IMPLICIT_TOOL_INSTRUCTIONS: string;
}

export const PROMPT: NativeChatPrompt = APP_PROMPT;

export type NativeChatPromptKey = keyof NativeChatPrompt;

/** Call-opening prompts and skill catalog copy. */
export interface NativeCallContract {
  readonly OPENING_PROMPT: string;
  readonly OPENING_FALLBACK: string;
  readonly INBOUND_OPENING_PROMPT: string;
  readonly INBOUND_OPENING_FALLBACK: string;
  readonly CONNECTED_BODY: string;
  readonly RECALL_USES_LAST_USER: boolean;
  readonly NEVER_EMBED_OPENING_CUE: boolean;
  readonly SKILL_CATALOG_TITLE: string;
  readonly SKILL_CATALOG_INTRO: string;
  readonly READ_SKILL_TOOL_NAME: string;
}

export const CALL: NativeCallContract = APP_CALL;

/** Only the memory-facing theater label is part of this contract. */
export interface NativeTheaterContract {
  readonly PROVENANCE_LABEL: string;
}

export const THEATER: NativeTheaterContract = APP_THEATER;

/** Provenance of the copied source, for drift review and reports. */
export const CHAT_CONTRACT_SOURCE = {
  appFile: "shared/native-chat/source.mjs",
  appRepoRevision: "e0e85f4",
  sha256: "1e686aa30eaf99e78db3805f6736e1c8e4a1cabb3383838e87e534f8a57fb783",
  syncedAt: "2026-11-15",
} as const;

/** Full APP export list, including the deliberately unmirrored 灵境 block. */
export const APP_ONLY_EXPORTS = [
  "LINGJING",
  "LINGJING_SPEECH",
  "LINGJING_SCENE_BACKDROP",
  "LINGJING_MEMORY",
] as const;
