/**
 * Inline `[]` emotion / paralinguistic tags — TTS-only visibility.
 *
 * Node port of Python `backend/core/tts/fish_tags.py`.
 *
 * The model writes inline cues such as `[兴奋]` / `[小声]` / `[whispering]`.
 * Those cues are *never* shown in the UI and *never* persisted; only Fish
 * Audio and Xiaomi MiMo receive them on the TTS wire, and only while their
 * emotion mode is on. Every other provider must receive the text without the
 * tags, otherwise the tags would be read out loud.
 */

/** Descriptive tags (tone + ambience) often exceed short labels like [兴奋]. */
export const FISH_TAG_INNER_MAX = 120;
/** '[' + inner (+ waiting for ']') */
export const FISH_TAG_PENDING_MAX = FISH_TAG_INNER_MAX + 2;

/** `[label]` — the negative lookahead keeps markdown links (`[text](url)`) intact. */
export const FISH_TAG_RE = /\[[^\[\]\n]{1,120}\](?!\()/;

/** Same as {@link FISH_TAG_RE} but also eats one trailing space/tab. */
const FISH_TAG_STRIP_RE = /\[[^\[\]\n]{1,120}\](?!\()[ \t]?/g;

const COMPLETE_TAG_RE = /^\[[^\[\]\n]{1,120}\]$/;

export interface DisplayAndTts {
  /** Text for the UI / DB / LLM history — always tag-free. */
  display: string;
  /** Text for the TTS wire — only set when it differs from `display`. */
  tts: string | null;
}

export interface TagStreamPieces {
  display: string;
  tts: string;
}

/** Fullwidth / CJK brackets are normalized to the halfwidth `[]` form. */
export function normalizeEmotionSquareBrackets(text: string): string {
  if (!text) return text;
  return text
    .replace(/［/g, "[")
    .replace(/］/g, "]")
    .replace(/【/g, "[")
    .replace(/】/g, "]");
}

/** Strip `[]` TTS cues for UI / DB / LLM history. Leaves markdown links alone. */
export function stripFishTags(text: string): string {
  if (!text) return text;
  const normalized = normalizeEmotionSquareBrackets(text);
  let cleaned = normalized.replace(FISH_TAG_STRIP_RE, "");
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  cleaned = cleaned.replace(/ *\n */g, "\n");
  cleaned = cleaned.replace(/\n{2,}/g, "\n");
  return cleaned.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
}

/** Split one blob of model output into its display and TTS variants. */
export function splitDisplayAndTts(text: string, keepTagsForTts: boolean): DisplayAndTts {
  const display = stripFishTags(text);
  if (!keepTagsForTts) return { display, tts: null };
  const tts = normalizeEmotionSquareBrackets(text).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  return { display, tts: tts !== display ? tts : null };
}

/**
 * Python `fish_tags.py::_active_tts_provider`.
 * Accepts the Python nested shape (`settings.tts.active_provider`) and the
 * flat Node settings shape (`settings.ttsActiveProvider`).
 */
export function activeTtsProvider(settings: Record<string, any> | null | undefined): string {
  const tts = settings?.tts;
  if (tts && typeof tts === "object") {
    const name = String(tts.active_provider ?? tts.activeProvider ?? "").trim().toLowerCase();
    if (name === "xiaomi_mimo") return "xiaomo_mimo";
    return name;
  }
  const flat = String(settings?.ttsActiveProvider ?? "").trim().toLowerCase();
  if (flat === "xiaomi_mimo") return "xiaomo_mimo";
  return flat;
}

/**
 * Read a provider-level `emotion_mode` flag. An unset / missing flag defaults
 * to on, so installs that predate the switch keep the behaviour they had.
 *
 * The flat key is what the Node settings store persists; the nested
 * `settings.tts.providers.*` shape is the Python-compatible one.
 */
function readProviderEmotionMode(
  settings: Record<string, any> | null | undefined,
  providerKeys: string[],
  flatKey: string,
): boolean {
  if (!settings) return true;
  const flat = settings[flatKey];
  if (flat !== undefined && flat !== null) return Boolean(flat);
  const tts = settings.tts;
  if (tts && typeof tts === "object") {
    const providers = tts.providers;
    const provider = providers
      ? providerKeys
          .map((key) => providers[key])
          .find((item) => item !== undefined && item !== null)
      : undefined;
    if (provider === undefined || provider === null) return true;
    const raw = provider.emotion_mode ?? provider.emotionMode;
    if (raw === undefined || raw === null) return true;
    return Boolean(raw);
  }
  return true;
}

/** Fish Audio emotion mode flag. Missing flag defaults to on. */
export function fishEmotionModeEnabled(settings: Record<string, any> | null | undefined): boolean {
  return readProviderEmotionMode(settings, ["fish_audio"], "ttsFishAudioEmotionMode");
}

/** Fish Audio consumes `[]` tags on the TTS wire while emotion mode is on. */
export function fishTagsEnabledForActiveProvider(settings: Record<string, any> | null | undefined): boolean {
  return activeTtsProvider(settings) === "fish_audio" && fishEmotionModeEnabled(settings);
}

/**
 * Xiaomi MiMo emotion mode. An unset / missing flag defaults to on
 * (app-local compatible), like the Python implementation.
 */
export function xiaomiEmotionModeEnabled(settings: Record<string, any> | null | undefined): boolean {
  if (activeTtsProvider(settings) !== "xiaomo_mimo") return false;
  return readProviderEmotionMode(
    settings,
    ["xiaomo_mimo", "xiaomi_mimo"],
    "ttsXiaomoMimoEmotionMode",
  );
}

/** Fish and Xiaomi MiMo emotion mode keep `[]` tags on the TTS wire. */
export function keepEmotionTagsForTts(settings: Record<string, any> | null | undefined): boolean {
  return (
    fishTagsEnabledForActiveProvider(settings) || xiaomiEmotionModeEnabled(settings)
  );
}

/**
 * Provider-level counterpart of {@link keepEmotionTagsForTts}, used by the TTS
 * service where only the resolved provider name is known.
 */
export function providerKeepsEmotionTags(
  provider: string | null | undefined,
  settings?: Record<string, any> | null,
): boolean {
  const name = String(provider || "").trim().toLowerCase();
  if (name === "fish_audio") return fishEmotionModeEnabled(settings);
  if (name === "xiaomo_mimo" || name === "xiaomi_mimo") {
    return readProviderEmotionMode(
      settings ?? null,
      ["xiaomo_mimo", "xiaomi_mimo"],
      "ttsXiaomoMimoEmotionMode",
    );
  }
  return false;
}

/**
 * Hold an incomplete `[...]` across chunks; emit display vs TTS pieces.
 * Port of Python `fish_tags.py::FishTagStreamFilter`.
 */
export class FishTagStreamFilter {
  private pending = "";

  /** Feed one raw chunk; returns the display piece and the TTS piece. */
  feed(chunk: string): TagStreamPieces {
    if (!chunk && !this.pending) return { display: "", tts: "" };
    const buf = normalizeEmotionSquareBrackets(this.pending + (chunk || ""));
    this.pending = "";
    const displayParts: string[] = [];
    const ttsParts: string[] = [];
    let i = 0;
    while (i < buf.length) {
      const openIdx = buf.indexOf("[", i);
      if (openIdx < 0) {
        const rest = buf.slice(i);
        displayParts.push(rest);
        ttsParts.push(rest);
        break;
      }
      const prefix = buf.slice(i, openIdx);
      displayParts.push(prefix);
      ttsParts.push(prefix);
      const close = buf.indexOf("]", openIdx + 1);
      if (close === -1) {
        const rest = buf.slice(openIdx);
        if (rest.includes("\n") || rest.length > FISH_TAG_PENDING_MAX) {
          displayParts.push(rest);
          ttsParts.push(rest);
        } else {
          this.pending = rest;
        }
        break;
      }
      // Wait one extra char so `[label]` + `(url)` is not treated as a TTS tag.
      if (close === buf.length - 1) {
        this.pending = buf.slice(openIdx);
        break;
      }
      const candidate = buf.slice(openIdx, close + 1);
      const inner = candidate.slice(1, -1);
      const nextCh = buf[close + 1];
      const isTtsTag =
        inner.length >= 1 &&
        inner.length <= FISH_TAG_INNER_MAX &&
        !inner.includes("[") &&
        !inner.includes("\n") &&
        nextCh !== "(";
      if (isTtsTag) {
        // TTS-only: the tag never reaches the display stream.
        ttsParts.push(candidate);
      } else {
        displayParts.push(candidate);
        ttsParts.push(candidate);
      }
      i = close + 1;
    }
    return { display: displayParts.join(""), tts: ttsParts.join("") };
  }

  /** Flush the leftover buffer at the end of the stream. */
  flush(): TagStreamPieces {
    if (!this.pending) return { display: "", tts: "" };
    const leftover = normalizeEmotionSquareBrackets(this.pending);
    this.pending = "";
    if (COMPLETE_TAG_RE.test(leftover)) return { display: "", tts: leftover };
    return { display: leftover, tts: leftover };
  }
}
