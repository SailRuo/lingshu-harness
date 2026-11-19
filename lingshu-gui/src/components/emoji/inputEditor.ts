import { renderWechatEmoji, replaceUnicodeEmoji } from './render'

export const EMOJI_INPUT_SIZE = 20

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function plainTextToEditorHtml(text: string): string {
  const normalized = replaceUnicodeEmoji(text || '')
  if (!normalized) return ''

  return normalized
    .split('\n')
    .map((line) => {
      const rendered = renderWechatEmoji(escapeHtml(line), {
        emojiSize: EMOJI_INPUT_SIZE,
        skipUnicodeReplace: true,
        className: 'input-emoji',
      })
      return rendered || '\u200b'
    })
    .join('<br>')
}

export function extractPlainTextFromEditor(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('img.twemoji[data-emoji-code], .wechat-emoji[data-emoji-code]').forEach((el) => {
    const code = el.getAttribute('data-emoji-code')
      || (el.getAttribute('title') ? `[${el.getAttribute('title')}]` : '')
    el.replaceWith(document.createTextNode(code))
  })

  return (clone.innerText || '')
    .replace(/\u200b/g, '')
    .replace(/\u00a0/g, ' ')
}

export function renderEmojiInsertHtml(emojiCode: string): string {
  return renderWechatEmoji(emojiCode, {
    emojiSize: EMOJI_INPUT_SIZE,
    skipUnicodeReplace: true,
    className: 'input-emoji',
  })
}

export function ensureEditorSelection(editor: HTMLElement) {
  editor.focus()

  if (!editor.innerHTML.trim()) {
    editor.innerHTML = ''
  }

  if (!selectionInEditor(editor)) {
    placeCaretAtEnd(editor)
  }
}

export function insertHtmlAtCaret(html: string): boolean {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false

  const range = selection.getRangeAt(0)
  range.deleteContents()

  const template = document.createElement('template')
  template.innerHTML = html
  const fragment = template.content
  const lastNode = fragment.lastChild
  if (!lastNode) return false

  range.insertNode(fragment)
  range.setStartAfter(lastNode)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

export function placeCaretAtEnd(el: HTMLElement) {
  const selection = window.getSelection()
  if (!selection) return

  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function selectionInEditor(editor: HTMLElement): boolean {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false
  const anchor = selection.anchorNode
  return !!anchor && editor.contains(anchor)
}
