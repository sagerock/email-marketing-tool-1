// "Ready to send?" checks for the email builder. Pure functions over the HTML
// source, so they run instantly on every change. Each issue carries the source
// span of the element involved (for click-to-select) and how to fix it.

import { scanElements, type SourceSpan } from './emailSections'

export type IssueSeverity = 'error' | 'warning'

export interface EmailIssue {
  id: string
  severity: IssueSeverity
  title: string
  detail: string
  span?: SourceSpan
  /** Sent to the AI as-is with the span selected. */
  fixPrompt?: string
  /** Put in the chat box for the user to finish (e.g. a missing URL). */
  fixDraft?: string
}

// Merge tags the send pipeline fills in; anything else in {{ }} is left over.
const MERGE_TAGS = new Set(['first_name', 'last_name', 'email', 'mailing_address', 'campaign_name', 'unsubscribe_url', 'industry_link'])
const URL_MERGE_TAGS = new Set(['unsubscribe_url', 'industry_link'])
const GMAIL_CLIP_BYTES = 102 * 1024
const PLACEHOLDER_HOSTS = /(^|\.)(example\.(com|org|net)|yourdomain\.com|yourwebsite\.com|domain\.com|website\.com|placeholder\.com)$/i
const PLACEHOLDER_TEXT = /\b(lorem ipsum|insert [a-z ]{2,30} here|your (?:link|url|text) here|tbd|xx\/xx)\b|\[(?:insert|add|your|link|url|date|name)[^\]]{0,40}\]/i

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!m) return null
  return m[2] ?? m[3] ?? m[4] ?? ''
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', larr: '←', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', bull: '•' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTITIES[code.toLowerCase()] ?? m
  })
}

function visibleText(html: string): string {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
}

// A typed-out US postal address also satisfies CAN-SPAM (e.g. the Alconox
// Scoop footer: "30 Glenn St. Suite #309 White Plains, NY 10603").
const POSTAL_ADDRESS = /\b(\d{1,6}\s+[\w .'#-]{2,60}?\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|hwy|suite)\b|p\.?\s?o\.?\s+box\s+\d+)[\s\S]{0,120}?\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/i

// Same problem on several elements reads as one line with a count.
const GROUPED: Record<string, (n: number) => string> = {
  'img-alt': n => `${n} images have no description`,
  'img-width': n => `${n} images have no width set`,
  'outlook-zero': n => `${n} images may vanish in Outlook`,
  'link-http': n => `${n} links aren\u2019t secure`,
}

function groupRepeats(issues: EmailIssue[]): EmailIssue[] {
  const out: EmailIssue[] = []
  const byKind = new Map<string, EmailIssue[]>()
  for (const issue of issues) {
    const kind = issue.id.replace(/-\d+$/, '')
    if (!GROUPED[kind]) { out.push(issue); continue }
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind)!.push(issue)
  }
  for (const [kind, list] of byKind) {
    if (list.length === 1) { out.push(list[0]); continue }
    const first = list[0]
    out.push({
      ...first,
      id: kind,
      title: GROUPED[kind](list.length),
      detail: first.detail,
      // Fixing all of them at once is a whole-email request.
      span: undefined,
      fixPrompt: first.fixPrompt ? `${first.fixPrompt.replace(/this (image|cell|link)/i, 'every $1 with this problem')}` : undefined,
    })
  }
  return out
}

function quoteLabel(label: string) {
  return /^(Image link|A link)/.test(label) ? label : `"${label}"`
}

function shorten(s: string, max = 50) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function checkEmail(html: string, subject = '', previewText = ''): EmailIssue[] {
  const issues: EmailIssue[] = []
  if (!html.trim()) return issues
  const elements = scanElements(html)

  // Compliance: the footer tags CAN-SPAM requires.
  if (!/\{\{\s*unsubscribe_url\s*\}\}/i.test(html)) {
    issues.push({ id: 'no-unsub', severity: 'error', title: 'No unsubscribe link',
      detail: 'Every marketing email needs one (CAN-SPAM).',
      fixPrompt: 'Add an unsubscribe link using {{unsubscribe_url}} to the footer.' })
  }
  if (!/\{\{\s*mailing_address\s*\}\}/i.test(html) && !POSTAL_ADDRESS.test(visibleText(html))) {
    issues.push({ id: 'no-address', severity: 'error', title: 'No mailing address',
      detail: 'CAN-SPAM requires a physical address in the footer.',
      fixPrompt: 'Add the {{mailing_address}} merge tag to the footer.' })
  }
  if (!subject.trim()) {
    issues.push({ id: 'no-subject', severity: 'error', title: 'No subject line', detail: 'Add a subject before saving or sending.',
      fixPrompt: 'Write a subject line for this email.' })
  }
  if (!previewText.trim()) {
    issues.push({ id: 'no-preview', severity: 'warning', title: 'No preview text',
      detail: 'Inboxes will show the first words of the email instead.',
      fixPrompt: 'Write preview text (the inbox teaser line) for this email.' })
  }

  // Links.
  for (const el of elements.filter(e => e.tag === 'a')) {
    const open = html.slice(el.start, el.openEnd)
    const href = attr(open, 'href')
    const inner = html.slice(el.openEnd, el.end)
    const imgAlt = /<img\b[^>]*\balt\s*=\s*["']([^"']+)/i.exec(inner)?.[1]
    const label = shorten(visibleText(inner)) || (imgAlt ? `Image link "${shorten(imgAlt, 30)}"` : 'A link')
    const span = { start: el.start, end: el.end }
    if (href === null) continue // anchors without href are just named targets
    const trimmed = href.trim()
    const tag = /^\{\{\s*([a-z_]+)\s*\}\}$/i.exec(trimmed)?.[1]?.toLowerCase()
    if (tag) {
      if (!URL_MERGE_TAGS.has(tag)) {
        issues.push({ id: `link-tag-${el.id}`, severity: 'error', title: `${quoteLabel(label)} links to {{${tag}}}`,
          detail: 'That merge tag isn’t a web address and won’t work as a link.', span,
          fixDraft: `Change this link to: ` })
      }
      continue
    }
    if (!trimmed || trimmed === '#' || /^javascript:/i.test(trimmed)) {
      issues.push({ id: `link-empty-${el.id}`, severity: 'error', title: `${quoteLabel(label)} doesn’t go anywhere`,
        detail: `Its link is ${trimmed ? `"${trimmed}"` : 'empty'}. Add the real web address.`, span,
        fixDraft: 'Change this link to: ' })
      continue
    }
    if (/^(mailto|tel|sms):/i.test(trimmed) || trimmed.startsWith('#')) continue
    let url: URL | null = null
    try { url = new URL(trimmed) } catch { url = null }
    if (!url || !/^https?:$/.test(url.protocol)) {
      issues.push({ id: `link-bad-${el.id}`, severity: 'error', title: `${quoteLabel(label)} has an unusable link`,
        detail: `"${shorten(trimmed, 60)}" isn’t a full web address (it should start with https://).`, span,
        fixDraft: 'Change this link to: ' })
    } else if (PLACEHOLDER_HOSTS.test(url.hostname)) {
      issues.push({ id: `link-placeholder-${el.id}`, severity: 'error', title: `${quoteLabel(label)} points to a placeholder site`,
        detail: `${url.hostname} is a stand-in address.`, span, fixDraft: 'Change this link to: ' })
    } else if (url.protocol === 'http:') {
      issues.push({ id: `link-http-${el.id}`, severity: 'warning', title: `${quoteLabel(label)} isn’t a secure link`,
        detail: 'It starts with http://. Use https:// if the site supports it.', span,
        fixPrompt: `Change this link from http:// to https://.` })
    }
  }

  // Images.
  for (const el of elements.filter(e => e.tag === 'img')) {
    const tag = html.slice(el.start, el.end)
    const src = (attr(tag, 'src') || '').trim()
    const alt = attr(tag, 'alt')
    // Media uploads are stored as <timestamp>-<name>; show just the name.
    const name = (src.split('/').pop()?.split('?')[0] || 'an image').replace(/^\d{10,}-/, '')
    const span = { start: el.start, end: el.end }
    if (!src) {
      issues.push({ id: `img-nosrc-${el.id}`, severity: 'error', title: 'An image has no picture',
        detail: 'It has no image address, so it will show as a broken box.', span,
        fixPrompt: 'This image has no src. Use a suitable image from the media library, or remove it if nothing fits.' })
      continue
    }
    if (!/^https:\/\//i.test(src)) {
      issues.push({ id: `img-url-${el.id}`, severity: 'error', title: `Image "${shorten(name, 30)}" won’t load`,
        detail: 'Email images need a full https:// address; this one is relative or insecure.', span,
        fixPrompt: 'This image needs a full https:// URL. Use the matching image from the media library.' })
    } else if (/\.webp(\?|$)/i.test(src)) {
      issues.push({ id: `img-webp-${el.id}`, severity: 'warning', title: `Image "${shorten(name, 30)}" is WebP`,
        detail: 'Desktop Outlook can’t show WebP. Upload a JPEG or PNG version in Media.', span })
    }
    if (alt === null) {
      issues.push({ id: `img-alt-${el.id}`, severity: 'warning', title: `Image "${shorten(name, 30)}" has no description`,
        detail: 'Alt text is read aloud by screen readers and shown when images are blocked.', span,
        fixPrompt: 'Add concise, descriptive alt text to this image based on what it shows.' })
    }
    if (attr(tag, 'width') === null) {
      issues.push({ id: `img-width-${el.id}`, severity: 'warning', title: `Image "${shorten(name, 30)}" has no width set`,
        detail: 'Outlook may show it at full size and break the layout.', span,
        fixPrompt: 'Add an explicit width attribute (and matching height, keeping the aspect ratio) to this image, at most 600.' })
    }
  }

  // Outlook-specific problems we know about.
  for (const el of elements.filter(e => e.tag === 'td')) {
    const open = html.slice(el.start, el.openEnd)
    const style = (attr(open, 'style') || '').toLowerCase().replace(/\s+/g, '')
    if (/(^|;)(font-size|line-height):0(px)?(;|$)/.test(style) && /<img\b/i.test(html.slice(el.openEnd, el.end))) {
      issues.push({ id: `outlook-zero-${el.id}`, severity: 'warning', title: 'An image may vanish in Outlook',
        detail: 'Its cell has font-size or line-height 0, which collapses the image in desktop Outlook.',
        span: { start: el.start, end: el.end },
        fixPrompt: 'Remove font-size:0 / line-height:0 from this cell so the image shows in desktop Outlook; keep its spacing with padding instead.' })
    }
  }
  if (/display\s*:\s*(flex|grid)/i.test(html)) {
    issues.push({ id: 'outlook-flex', severity: 'warning', title: 'Layout uses flex or grid',
      detail: 'Desktop Outlook and many email apps ignore these, so columns may stack or collapse.',
      fixPrompt: 'Replace any display:flex or display:grid layout with email-safe tables.' })
  }

  // Leftover template placeholders and filler text.
  const text = visibleText(html)
  const leftover = new Set<string>()
  // Placeholders used as link targets are already reported link by link.
  const linkTargets = new Set([...html.matchAll(/href\s*=\s*["']\s*\{\{\s*([^}]+?)\s*\}\}/gi)].map(m => m[1].toLowerCase()))
  for (const m of html.matchAll(/\{\{\s*([A-Za-z0-9_ /.-]+?)\s*\}\}/g)) {
    const key = m[1].toLowerCase()
    if (!MERGE_TAGS.has(key) && !linkTargets.has(key)) leftover.add(m[1])
  }
  if (leftover.size) {
    const list = [...leftover]
    const first = html.search(new RegExp(`\\{\\{\\s*${list[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    const holder = elements.filter(e => e.start <= first && e.end > first && e.tag !== 'table' && e.tag !== 'tr')
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
    issues.push({ id: 'leftover-tags', severity: 'error',
      title: `${list.length} placeholder${list.length === 1 ? '' : 's'} not filled in`,
      detail: list.slice(0, 6).map(t => `{{${t}}}`).join(', ') + (list.length > 6 ? ` and ${list.length - 6} more` : ''),
      span: holder ? { start: holder.start, end: holder.end } : undefined,
      fixDraft: `Fill in ${list.slice(0, 3).map(t => `{{${t}}}`).join(', ')}${list.length > 3 ? ' and the rest' : ''} with: ` })
  }
  const filler = PLACEHOLDER_TEXT.exec(text)
  if (filler) {
    issues.push({ id: 'filler-text', severity: 'error', title: 'Filler text left in',
      detail: `Found "${shorten(filler[0], 40)}".`,
      fixDraft: `Replace "${shorten(filler[0], 40)}" with: ` })
  }

  // Gmail clips messages over ~102 KB, hiding the rest (often the footer).
  const bytes = new TextEncoder().encode(html).length
  if (bytes > GMAIL_CLIP_BYTES) {
    issues.push({ id: 'gmail-clip', severity: 'warning', title: 'Gmail will clip this email',
      detail: `It’s ${Math.round(bytes / 1024)} KB of code; Gmail hides everything past about 102 KB behind a "View entire message" link, often including the unsubscribe footer.`,
      fixPrompt: 'This email’s HTML is over Gmail’s 102 KB clipping limit. Reduce its size without changing how it looks: remove redundant inline styles, comments, and unused code.' })
  }

  const rank = { error: 0, warning: 1 }
  return groupRepeats(issues).sort((a, b) => rank[a.severity] - rank[b.severity])
}
