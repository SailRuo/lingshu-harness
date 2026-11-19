/**
 * Native digest contract — desktop mirror of the APP's single source of truth.
 *
 * Source of truth (do not edit by hand):
 *   lingshu-app-local/shared/native-digest/source.mjs
 *   META.version = 2
 *
 * The prompt text, closed sets and thresholds below are re-exported from a
 * byte-for-byte copy in `generated/nativeDigestSource.generated.ts`. Do not
 * rewrite, re-wrap or "fix" the strings here: APP output parsing depends on
 * them verbatim. Only TypeScript annotations live in this file.
 *
 * Sync: see ./README.md (or run `node scripts/sync-native-contracts.mjs`).
 */

import {
  CONSTANTS as APP_CONSTANTS,
  META as APP_META,
  PRIVATE_DIGEST_STEPS as APP_PRIVATE_DIGEST_STEPS,
  PROMPTS as APP_PROMPTS,
  RESPONSE_SCHEMAS as APP_RESPONSE_SCHEMAS,
  SETS as APP_SETS,
  TEMPLATES as APP_TEMPLATES,
} from "./generated/nativeDigestSource.generated.js";

export interface NativeDigestSourceMeta {
  /** APP `META.version` — bump in APP when the digest contract changes. */
  readonly version: number;
  readonly note: string;
}

export const META: NativeDigestSourceMeta = APP_META;

/** Idle worker + LLM + AKIN + diary thresholds (APP DIGEST CONSTANTS). */
export interface NativeDigestConstants {
  readonly IDLE_MS: number;
  readonly STARTUP_RECOVERY_WINDOW_MS: number;
  readonly LLM_TIMEOUT_MS: number;
  readonly AKIN_LINK_MAX_L2: number;
  readonly AKIN_LINK_TOPK: number;
  readonly AKIN_TEMPORAL_NEIGHBOR_LIMIT: number;
  readonly AKIN_CANDIDATE_TOTAL_CAP: number;
  readonly DIGEST_LOOKBACK_DAYS: number;
  readonly DIGEST_MAX_INPUT_TOKENS: number;
  readonly DIGEST_MAX_CHUNKS_PER_RUN: number;
  readonly DIGEST_BATCH_ROW_CAP: number;
  readonly DIARY_CUTOVER_HOUR: number;
  readonly DIARY_MIN_MESSAGES: number;
  readonly DIARY_MIN_CHARS: number;
  readonly DIARY_MAX_CHARS: number;
  readonly DIARY_MIN_PARAGRAPHS: number;
  readonly DIARY_MAX_PARAGRAPHS: number;
  readonly DIARY_TIMEZONE: string;
  readonly DEBUG_DIARY_ID_PREFIX: string;
  readonly SPEAKER_LABEL_MAX_LEN: number;
  readonly SIGNIFICANCE_DEFAULT: number;
  readonly SIGNIFICANCE_MIN: number;
  readonly SIGNIFICANCE_MAX: number;
  readonly ENTITY_NAME_MAX_LEN: number;
  readonly FACT_CONFIDENCE_DEFAULT: number;
  readonly FACT_PROMPT_SIMILARITY_FLOOR: number;
}

export const CONSTANTS: NativeDigestConstants = APP_CONSTANTS;

/** Closed sets used by the extractor prompt and its JSON schema. */
export interface NativeDigestSets {
  readonly FACT_RELATIONS: readonly string[];
  readonly PLACEHOLDER_ENTITIES: readonly string[];
  readonly EXTERNAL_ABOUT: readonly string[];
  readonly SELF_ABOUT: readonly string[];
  readonly ME_SUBJECTS: readonly string[];
  readonly SELF_SUBJECTS: readonly string[];
}

export const SETS: NativeDigestSets = APP_SETS;

/** Private digest step order (documentation + optional logging). */
export const PRIVATE_DIGEST_STEPS: readonly string[] = APP_PRIVATE_DIGEST_STEPS;

/** A provider-agnostic JSON Schema document; passed through to the LLM as-is. */
export type NativeJsonSchema = Record<string, unknown>;

export interface NativeResponseSchema {
  readonly name: string;
  readonly schema: NativeJsonSchema;
}

export type NativeDigestSchemaKey =
  | "EXTRACTOR"
  | "WRITE_FIELD"
  | "SEED_REVIEW"
  | "AKIN_JUDGE"
  | "AKIN_JUDGE_SINGLE"
  | "PORTRAIT"
  | "PORTRAIT_REVIEW"
  | "PORTRAIT_REWRITE"
  | "CONVERSATION_ANCHOR"
  | "DAILY_REFLECTION"
  | "DAILY_REVIEW"
  | "GROUP_PRESENCE";

export type NativeDigestResponseSchemas = Readonly<
  Record<NativeDigestSchemaKey, NativeResponseSchema>
>;

export const RESPONSE_SCHEMAS: NativeDigestResponseSchemas = APP_RESPONSE_SCHEMAS;

/** Static prompts (no placeholders). Wording is the APP's, verbatim. */
export interface NativeDigestPrompts {
  readonly DAILY_REVIEW_WRITING_RULES: string;
  readonly WRITE_FIELD: string;
  readonly SELF_EVOLUTION: string;
  readonly AKIN_JUDGE: string;
  readonly CONVERSATION_ANCHOR_SUMMARY: string;
  readonly SELF_PORTRAIT: string;
  readonly CONVERSATION_ANCHOR_JSON_TAIL: string;
  readonly JSON_ONLY_SYSTEM: string;
}

export const PROMPTS: NativeDigestPrompts = APP_PROMPTS;

/**
 * Prompt templates. Placeholders used by the APP:
 * {{user}} {{agent}} {{agentName}} {{roleBlock}} {{speakingStyleBlock}}
 * {{orientationBlock}} {{userReference}} {{diaryTitle}} {{transcript}}
 * {{charCount}} {{paragraphCount}}
 */
export interface NativeDigestTemplates {
  readonly DIGEST_EXTRACTOR_PERSONA: string;
  readonly DIGEST_EXTRACTOR_RULES: string;
  readonly DIGEST_ROLE_CONTEXT: string;
  readonly INNER_LETTER_SYSTEM: string;
  readonly INNER_LETTER_USER: string;
  readonly INNER_LETTER_RETRY: string;
}

export const TEMPLATES: NativeDigestTemplates = APP_TEMPLATES;

/** Provenance of the copied source, for drift review and reports. */
export const DIGEST_CONTRACT_SOURCE = {
  appFile: "shared/native-digest/source.mjs",
  appRepoRevision: "e0e85f4",
  sha256: "38a122afdd8f4c5248654069a4239a02ea1163fe7c377eccbd84097862234f4e",
  syncedAt: "2026-11-15",
} as const;
