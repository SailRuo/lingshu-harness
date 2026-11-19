import twemoji from 'twemoji'

/** Noto Emoji assets, served from local public/noto-emoji */
export const TWEMOJI_ASSET_BASE = '/noto-emoji/'

function normalizeTwemojiIcon(icon: string): string {
  return icon.toLowerCase().replace(/-/g, '_')
}

export function getTwemojiAssetUrl(unicode: string): string | null {
  if (!unicode) return null
  const icon = normalizeTwemojiIcon(twemoji.convert.toCodePoint(unicode))
  return `${TWEMOJI_ASSET_BASE}svg/emoji_u${icon}.svg`
}
