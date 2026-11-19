/**
 * Inline `[]` emotion / paralinguistic tags — TTS-only visibility.
 *
 * Mirrors `backend-node/src/services/ttsTags.ts` (a port of Python
 * `backend/core/tts/fish_tags.py`).
 *
 * The model may write cues such as `[兴奋]` / `[小声]` / `[whispering]`.
 * They steer the voice only: the bubble text and the persisted message must
 * never show them, while Fish Audio / Xiaomi MiMo receive them on the TTS wire.
 *
 * This helper is the client-side safety net for history that was persisted
 * before the tags were stripped on the server.
 */

/** Descriptive tags (tone + ambience) often exceed short labels like [兴奋]. */
export const TTS_EMOTION_TAG_INNER_MAX = 120;

/** `[label]` — the negative lookahead keeps markdown links (`[text](url)`) intact. */
export const TTS_EMOTION_TAG_RE = /\[[^\[\]\n]{1,120}\](?!\()/;

/** Same as {@link TTS_EMOTION_TAG_RE} but also eats one trailing space/tab. */
const TTS_EMOTION_TAG_STRIP_RE = /\[[^\[\]\n]{1,120}\](?!\()[ \t]?/g;

/** Fullwidth / CJK brackets are normalized to the halfwidth `[]` form. */
export function normalizeTtsEmotionBrackets(text: string): string {
  if (!text) return text;
  return text
    .replace(/［/g, '[')
    .replace(/］/g, ']')
    .replace(/【/g, '[')
    .replace(/】/g, ']');
}

/** True when the text carries at least one `[]` TTS cue. */
export function hasTtsEmotionTags(text: string): boolean {
  if (!text) return false;
  return TTS_EMOTION_TAG_RE.test(normalizeTtsEmotionBrackets(text));
}

/** Strip `[]` TTS cues for UI / DB. Leaves markdown links alone. */
export function stripTtsEmotionTags(text: string): string {
  if (!text) return text;
  const normalized = normalizeTtsEmotionBrackets(text);
  let cleaned = normalized.replace(TTS_EMOTION_TAG_STRIP_RE, '');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  cleaned = cleaned.replace(/ *\n */g, '\n');
  cleaned = cleaned.replace(/\n{2,}/g, '\n');
  return cleaned.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}

/**
 * Split one blob into its display variant (tags removed) and its TTS variant
 * (tags kept). `tts` is `null` when it is identical to `display`.
 */
export function splitTtsEmotionText(text: string): { display: string; tts: string | null } {
  const display = stripTtsEmotionTags(text);
  const tts = normalizeTtsEmotionBrackets(text).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { display, tts: tts !== display ? tts : null };
}
