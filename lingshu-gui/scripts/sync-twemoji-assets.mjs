import fs from 'node:fs/promises'
import path from 'node:path'
import twemoji from 'twemoji'

const NOTO_EMOJI_REF = 'main'
const REMOTE_BASE = `https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@${NOTO_EMOJI_REF}/svg`
const OUTPUT_DIR = path.resolve('public', 'noto-emoji', 'svg')
const MAPPINGS_FILE = path.resolve('src', 'components', 'emoji', 'mappings.ts')

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function download(url, outputPath) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'lingshu-gui-twemoji-sync' },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }

  const content = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(outputPath, content)
}

function toNotoCodePoints(unicode) {
  const raw = twemoji.convert.toCodePoint(unicode).toLowerCase()
  const compact = raw.replace(/-fe0f/gi, '')
  return [...new Set([raw, compact])]
}

function toNotoFileName(icon) {
  return `emoji_u${icon.replace(/-/g, '_')}.svg`
}

async function downloadWithFallbacks(iconCandidates, outPath) {
  let lastError = null
  for (const icon of iconCandidates) {
    const remote = `${REMOTE_BASE}/emoji_u${icon.replace(/-/g, '_')}.svg`
    try {
      await download(remote, outPath)
      return icon
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function main() {
  await ensureDir(OUTPUT_DIR)

  const mappingsText = await fs.readFile(MAPPINGS_FILE, 'utf8')
  const unicodeList = [...mappingsText.matchAll(/':\s*'([^']+)'/g)].map((match) => match[1])
  const iconSet = new Set(unicodeList.map((unicode) => toNotoCodePoints(unicode)[0]))
  const icons = [...iconSet].sort()
  let downloaded = 0
  let skipped = 0

  for (const icon of icons) {
    const outPath = path.join(OUTPUT_DIR, toNotoFileName(icon))
    try {
      await fs.access(outPath)
      skipped += 1
      continue
    } catch {
      // file missing, continue downloading
    }

    const iconCandidates = [...new Set([icon, icon.replace(/-fe0f/gi, '')])]
    await downloadWithFallbacks(iconCandidates, outPath)
    downloaded += 1
  }

  console.log(
    `Noto Emoji sync done: total=${icons.length}, downloaded=${downloaded}, skipped=${skipped}, dir=${OUTPUT_DIR}`,
  )
}

main().catch((error) => {
  console.error('Failed to sync Noto Emoji assets:', error)
  process.exit(1)
})
