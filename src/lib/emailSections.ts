// Click-to-edit support for the email builder preview. Scans the email's HTML
// source for selectable elements and records where each one starts and ends,
// so a click in the preview maps back to an exact span of the source. Only the
// preview gets the data-sr markers; the saved email never does.

export interface SourceSpan {
  start: number
  end: number
}

export interface ScannedElement extends SourceSpan {
  id: number
  tag: string
  /** Index just past the opening tag's '>' */
  openEnd: number
}

const SELECTABLE = new Set([
  'table', 'tr', 'td', 'th', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'center', 'section', 'header', 'footer',
])
const VOID = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'area', 'base', 'col', 'embed', 'source', 'wbr'])
const RAW_TEXT = new Set(['style', 'script', 'title', 'textarea'])
// Opening one of these implicitly closes an open <p>, as browsers do.
const CLOSES_P = new Set(['table', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'center', 'section', 'header', 'footer'])

const TAG_START = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/

// Index just past the '>' that ends a tag starting at `from`, honoring quotes.
function tagEnd(html: string, from: number): number {
  let quote = ''
  for (let j = from; j < html.length; j++) {
    const c = html[j]
    if (quote) { if (c === quote) quote = '' }
    else if (c === '"' || c === "'") quote = c
    else if (c === '>') return j + 1
  }
  return html.length
}

export function scanElements(html: string): ScannedElement[] {
  const out: ScannedElement[] = []
  const stack: { tag: string; el?: ScannedElement }[] = []
  const close = (index: number, at: number) => {
    // Pop down to `index`; unclosed elements in between end where this one closes.
    while (stack.length > index) {
      const top = stack.pop()!
      if (top.el && top.el.end < 0) top.el.end = at
    }
  }
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    if (html.startsWith('<!--', lt)) {
      // Comments, including Outlook conditional comments; browsers ignore their contents.
      const endComment = html.indexOf('-->', lt + 4)
      i = endComment === -1 ? html.length : endComment + 3
      continue
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { i = tagEnd(html, lt); continue }
    const m = TAG_START.exec(html.slice(lt, lt + 80))
    if (!m) { i = lt + 1; continue }
    const end = tagEnd(html, lt + m[0].length)
    const tag = m[2].toLowerCase()

    if (m[1]) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === tag) {
          const el = stack[k].el
          close(k + 1, lt)
          stack.pop()
          if (el) el.end = end
          break
        }
      }
      i = end
      continue
    }

    if (CLOSES_P.has(tag)) {
      const top = stack[stack.length - 1]
      if (top?.tag === 'p') { stack.pop(); if (top.el) top.el.end = lt }
    }

    if (RAW_TEXT.has(tag)) {
      const closeAt = html.toLowerCase().indexOf(`</${tag}`, end)
      i = closeAt === -1 ? html.length : tagEnd(html, closeAt)
      continue
    }

    const selfClosing = html[end - 2] === '/'
    const el = SELECTABLE.has(tag) ? { id: out.length, tag, start: lt, openEnd: end, end: -1 } : undefined
    if (el) out.push(el)
    if (VOID.has(tag) || selfClosing) {
      if (el) el.end = end
    } else {
      stack.push({ tag, el })
    }
    i = end
  }
  close(0, html.length)
  return out
}

// The preview copy: every selectable element carries data-sr="<id>".
export function annotateHtml(html: string, elements: ScannedElement[]): string {
  let out = html
  for (const el of [...elements].sort((a, b) => b.openEnd - a.openEnd)) {
    const at = html[el.openEnd - 2] === '/' ? el.openEnd - 2 : el.openEnd - 1
    out = out.slice(0, at) + ` data-sr="${el.id}"` + out.slice(at)
  }
  return out
}

function shorten(text: string, max = 40) {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// A short human label for a preview element, e.g. Button: "Save Your Spot".
export function describeElement(el: Element, isSection: boolean): string {
  const tag = el.tagName.toLowerCase()
  const text = (el as HTMLElement).innerText || el.textContent || ''
  if (tag === 'img') {
    const alt = el.getAttribute('alt')
    return alt ? `Image: "${shorten(alt)}"` : 'Image'
  }
  if (tag === 'a') {
    const style = (el.getAttribute('style') || '').toLowerCase()
    const looksLikeButton = /background|padding|border-radius/.test(style)
    return `${looksLikeButton ? 'Button' : 'Link'}: "${shorten(text) || 'link'}"`
  }
  if (/^h[1-6]$/.test(tag)) return `Heading: "${shorten(text)}"`
  if (tag === 'p' || tag === 'li') return `Text: "${shorten(text)}"`
  if (tag === 'ul' || tag === 'ol') return 'List'
  const html = el.innerHTML
  if (/\{\{\s*unsubscribe_url\s*\}\}|\{\{\s*mailing_address\s*\}\}/.test(html)) return 'Footer'
  const heading = el.querySelector('h1, h2, h3, h4, h5, h6')
  const label = isSection ? 'Section' : 'Block'
  if (heading?.textContent?.trim()) return `${label}: "${shorten(heading.textContent)}"`
  if (!text.trim() && el.querySelector('img')) {
    const alt = el.querySelector('img')?.getAttribute('alt')
    return alt ? `${label}: image "${shorten(alt)}"` : `${label}: image`
  }
  return text.trim() ? `${label}: "${shorten(text)}"` : label
}
