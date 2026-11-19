import twemoji from 'twemoji'
import { emojiCodes, emojiMap } from './data'
import { emojiCodeToUnicode } from './mappings'
import { getTwemojiAssetUrl } from './twemojiConfig'

/** 从表情库 [方括号]→Unicode 主映射自动推导反向表，保证库内表情不漏映射 */
function buildReverseMapFromLibrary(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [code, unicode] of Object.entries(emojiCodeToUnicode)) {
    if (!map[unicode]) map[unicode] = code
  }
  return map
}

/** LLM 常输出的 Unicode 变体 / 同义字符，覆盖自动推导的默认项 */
const UNICODE_EMOJI_OVERRIDES: Record<string, string> = {
  '😳': '[脸红]',
  '😛': '[调皮]',
  '😜': '[调皮]',
  '😝': '[调皮]',
  '😊': '[害羞]',
  '🙂': '[微笑]',
  '😍': '[色]',
  '😭': '[大哭]',
  '😴': '[睡]',
  '😅': '[尴尬]',
  '😡': '[发怒]',
  '😠': '[发怒]',
  '😁': '[呲牙]',
  '😱': '[惊讶]',
  '😔': '[难过]',
  '🥺': '[委屈]',
  '🤮': '[吐]',
  '🤢': '[吐]',
  '🙄': '[翻白眼]',
  '🤔': '[Emm]',
  '😑': '[无语]',
  '😐': '[无语]',
  '😂': '[破涕为笑]',
  '👍': '[强]',
  '👎': '[弱]',
  '❤️': '[爱心]',
  '💔': '[心碎]',
  '🤗': '[拥抱]',
  '👌': '[OK]',
  '✌️': '[胜利]',
  '🙏': '[合十]',
  '🌹': '[玫瑰]',
  '🥀': '[凋谢]',
  '💩': '[便便]',
  '🎉': '[庆祝]',
  '🎁': '[礼物]',
  '🐷': '[猪头]',
  '😩': '[抓狂]',
  '😫': '[抓狂]',
  '🤤': '[色]',
  '😎': '[悠闲]',
  '😷': '[生病]',
  '🤐': '[闭嘴]',
  '🤭': '[偷笑]',
  '🤦': '[捂脸]',
  '💪': '[加油]',
  '👀': '[让我看看]',
  '🍉': '[吃瓜]',
  '🤡': '[打脸]',
  '🤩': '[哇]',
  '☕': '[咖啡]',
  '🍺': '[啤酒]',
  '🎂': '[蛋糕]',
  '💣': '[炸弹]',
  '👋': '[再见]',
  '😤': '[右哼哼]',
  '😌': '[悠闲]',
  '😄': '[愉快]',
  '😆': '[憨笑]',
  '😨': '[惊恐]',
  '😰': '[惊恐]',
  '😧': '[惊恐]',
  '😢': '[流泪]',
  '😥': '[汗]',
  '😓': '[冷汗]',
  '💦': '[汗]',
  '😮': '[惊讶]',
  '😯': '[惊讶]',
  '😲': '[惊讶]',
  '🤣': '[破涕为笑]',
  '🥲': '[苦涩]',
  '😿': '[可怜]',
  '😾': '[发怒]',
  '🙃': '[调皮]',
  '😏': '[阴险]',
  '😒': '[鄙视]',
  '😕': '[委屈]',
  '😖': '[抓狂]',
  '😣': '[快哭了]',
  '😞': '[失望]',
  '😟': '[皱眉]',
  '😦': '[惊恐]',
  '😬': '[尴尬]',
  '🤧': '[生病]',
  '🥱': '[困]',
  '😪': '[困]',
  '🤒': '[生病]',
  '🤕': '[生病]',
  '👻': '[骷髅]',
  '💀': '[骷髅]',
  '☠️': '[骷髅]',
  '🌙': '[月亮]',
  '☀️': '[太阳]',
  '🌞': '[太阳]',
  '🍻': '[啤酒]',
  '🥂': '[庆祝]',
  '🍰': '[蛋糕]',
  '🔪': '[菜刀]',
  '✊': '[拳头]',
  '🤝': '[握手]',
  '🙌': '[鼓掌]',
  '👏': '[鼓掌]',
  '🤞': '[合十]',
  '💋': '[嘴唇]',
  '🖐️': '[再见]',
  '✋': '[再见]',
  '🫶': '[拥抱]',
}

export const unicodeToEmojiCodeMap: Record<string, string> = {
  ...buildReverseMapFromLibrary(),
  ...UNICODE_EMOJI_OVERRIDES,
}

const escapedKeys = Object.keys(unicodeToEmojiCodeMap)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'))
const unicodeEmojiRegex = new RegExp(escapedKeys.join('|'), 'g')

const SUPPORTED_UNICODE_POINTS = new Set(
  Object.values(emojiCodeToUnicode).map((u) =>
    twemoji.convert.toCodePoint(u).toLowerCase().replace(/-/g, '_'),
  ),
)

const TWEMOJI_PARSE_OPTIONS = {
  className: 'emoji twemoji',
  callback: (icon: string) => {
    const normalized = icon.toLowerCase().replace(/-/g, '_')
    if (!SUPPORTED_UNICODE_POINTS.has(normalized)) {
      return false
    }
    return `/noto-emoji/svg/emoji_u${normalized}.svg`
  },
}

export function replaceUnicodeEmoji(text: string): string {
  if (!text) return text
  return text.replace(unicodeEmojiRegex, (match) => unicodeToEmojiCodeMap[match] || match)
}

function buildEmojiImgHtml(
  emojiCode: string,
  emojiName: string,
  emojiSize: number,
  className: string,
): string | null {
  const unicode = emojiCodeToUnicode[emojiCode]
  const src = unicode ? getTwemojiAssetUrl(unicode) : null
  if (!src) return null

  return `<img class="emoji twemoji wechat-emoji ${className}" draggable="false" alt="${emojiCode}" data-emoji-code="${emojiCode}" title="${emojiName}" src="${src}" style="width:${emojiSize}px;height:${emojiSize}px;vertical-align:-0.22em;" />`
}

/**
 * Render WeChat emoji text to HTML string (Twemoji)
 */
export function renderWechatEmoji(
  text: string,
  options: {
    emojiSize?: number
    className?: string
    /** 仅替换 [名称]，不做 Unicode→方括号（用于 marked 之后的 HTML） */
    skipUnicodeReplace?: boolean
  } = {},
): string {
  const {
    emojiSize = 20,
    className = '',
    skipUnicodeReplace = false,
  } = options

  const processedText = skipUnicodeReplace ? text : replaceUnicodeEmoji(text)

  const withBracketEmojis = processedText.replace(/\[([^\]]+)\]/g, (match) => {
    const emoji = emojiMap.get(match)
    if (!emoji) return match

    return buildEmojiImgHtml(match, emoji.name, emojiSize, className) ?? match
  })

  const parsed = twemoji.parse(withBracketEmojis, TWEMOJI_PARSE_OPTIONS)
  // twemoji 输出的 img 无 inline 尺寸，会被 reset.css 的 img { max-width:100%; display:block } 撑满气泡
  return parsed.replace(/<img\b([^>]*\bclass="[^"]*\bemoji twemoji\b[^"]*"[^>]*)>/gi, (match, attrs) => {
    if (/\bstyle\s*=/.test(attrs)) return match
    return `<img${attrs} style="width:${emojiSize}px;height:${emojiSize}px;vertical-align:-0.22em;">`
  })
}

export function getEmojiImageUrl(emojiCode: string): string | null {
  const unicode = emojiCodeToUnicode[emojiCode]
  return unicode ? getTwemojiAssetUrl(unicode) : null
}

let emojiPreloadPromise: Promise<void> | null = null

/**
 * Warm emoji image cache so picker opens instantly.
 */
export function preloadEmojiAssets(): Promise<void> {
  if (emojiPreloadPromise) return emojiPreloadPromise

  const urls = emojiCodes
    .map((code) => getEmojiImageUrl(code))
    .filter((url): url is string => Boolean(url))

  emojiPreloadPromise = Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          const img = new Image()
          img.onload = () => resolve()
          img.onerror = () => resolve()
          img.src = url
        }),
    ),
  ).then(() => undefined)

  return emojiPreloadPromise
}

/** @deprecated 保留兼容，请使用 getEmojiImageUrl */
export function getEmojiStyle(
  emojiCode: string,
  options: { emojiSize?: number } = {},
): Record<string, string> | null {
  const src = getEmojiImageUrl(emojiCode)
  if (!src) return null

  const emojiSize = options.emojiSize ?? 20
  return {
    width: `${emojiSize}px`,
    height: `${emojiSize}px`,
    objectFit: 'contain',
    display: 'inline-block',
    verticalAlign: '-0.22em',
  }
}

export function extractTextFromHtml(html: string): string {
  return html
    .replace(/<img[^>]*data-emoji-code="([^"]*)"[^>]*>/g, (_match, code) => code)
    .replace(/<img[^>]*alt="(\[[^\]]+\])"[^>]*>/g, (_match, code) => code)
    .replace(/<span[^>]*title="([^"]*)"[^>]*><\/span>/g, (match, title) => {
      const emoji = Array.from(emojiMap.values()).find((e) => e.name === title)
      return emoji ? emoji.code : match
    })
}
