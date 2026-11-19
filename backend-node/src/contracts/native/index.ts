/**
 * Native contract layer (M0).
 *
 * Two mirrors of the APP's shared native sources:
 *   - nativeDigestContract: digest prompts, closed sets, response schemas,
 *     thresholds and prompt templates (`shared/native-digest/source.mjs`).
 *   - nativeChatContract: seed activation, stream/state recall, relationship
 *     math and private-prompt section copy (`shared/native-chat/source.mjs`).
 *
 * Both modules are re-exported as namespaces because each source has its own
 * `META` export. Consumers that only need one side can import the module
 * directly; this barrel exists so new memory code has a single entry point.
 */

export * as nativeDigest from "./nativeDigestContract.js";
export * as nativeChat from "./nativeChatContract.js";

export {
  CONSTANTS as DIGEST_CONSTANTS,
  META as DIGEST_META,
  PRIVATE_DIGEST_STEPS,
  PROMPTS as DIGEST_PROMPTS,
  RESPONSE_SCHEMAS as DIGEST_RESPONSE_SCHEMAS,
  SETS as DIGEST_SETS,
  TEMPLATES as DIGEST_TEMPLATES,
  DIGEST_CONTRACT_SOURCE,
} from "./nativeDigestContract.js";

export {
  CALL as CHAT_CALL,
  EMBEDDING as CHAT_EMBEDDING,
  MEMORY_SEARCH as CHAT_MEMORY_SEARCH,
  META as CHAT_META,
  NEAR_WINDOW as CHAT_NEAR_WINDOW,
  PROMPT as CHAT_PROMPT,
  RELATIONSHIP as CHAT_RELATIONSHIP,
  SEED as CHAT_SEED,
  STATE as CHAT_STATE,
  STREAM as CHAT_STREAM,
  THEATER as CHAT_THEATER,
  TIANJI_TOOLS as CHAT_TIANJI_TOOLS,
  CHAT_CONTRACT_SOURCE,
} from "./nativeChatContract.js";

export type {
  NativeDigestConstants,
  NativeDigestPrompts,
  NativeDigestResponseSchemas,
  NativeDigestSchemaKey,
  NativeDigestSets,
  NativeDigestSourceMeta,
  NativeDigestTemplates,
  NativeJsonSchema,
  NativeResponseSchema,
} from "./nativeDigestContract.js";

export type {
  NativeCallContract,
  NativeChatPrompt,
  NativeChatPromptKey,
  NativeChatSourceMeta,
  NativeEmbeddingContract,
  NativeMemorySearchConstants,
  NativeNearWindowConstants,
  NativeRelationshipConstants,
  NativeSeedConstants,
  NativeStateChannelConstants,
  NativeStreamRecallConstants,
  NativeTheaterContract,
  NativeTianjiTools,
} from "./nativeChatContract.js";
