'use strict'

// Targeted edits for the interactive email builder. Instead of rewriting the
// whole email for every tweak, the model returns FIND/REPLACE pairs that are
// applied to the current HTML here. Full rewrites remain for new emails and
// redesigns. If an edit can't be applied unambiguously the caller asks the
// model for the complete email instead, so a bad edit never corrupts a design.

const MAX_CURRENT_HTML_CHARS = 500000

const OUTPUT_FORMAT_PROMPT = `OUTPUT FORMAT:
- For conversational responses (questions, suggestions, no HTML changes): just respond normally with helpful text.
- Whenever you change the email, write a short note about what you changed FIRST, then exactly ONE of the two blocks below. Never both.

A) TARGETED EDITS — the default whenever a <current_email> is provided and the request changes part of it
(copy, colors, fonts, a button, an image, links, spacing, adding/removing/moving a section):
\`\`\`edits
SUBJECT: new subject line (only if it changes; omit otherwise)
PREVIEW: new preview text (only if it changes; omit otherwise)
<<<<<<< FIND
exact text copied from <current_email>
=======
replacement text
>>>>>>> REPLACE
\`\`\`
Rules for edits:
- Copy each FIND character for character from <current_email>, including indentation and attribute order. Never paraphrase, abbreviate, or use "..." inside FIND.
- Keep each FIND small but unique in the document: usually 1–6 lines. Add a neighboring line if the text appears more than once.
- Use as many FIND/REPLACE pairs as needed. They apply top to bottom and must not overlap.
- To delete something, leave the replacement empty. To insert, FIND the line before the insertion point and repeat it in the replacement followed by the new content.
- A change to a repeated style (e.g. every button's color) needs one pair per occurrence; if that's more than about a dozen, use the full format instead.

B) FULL EMAIL — for a brand-new email, when no <current_email> is provided, or when the change touches most of the email (a redesign, new layout, restyling everything):
\`\`\`json
{
  "subject": "the email subject line",
  "preview_text": "preview text for email clients (1-2 sentences)",
  "html_content": "the complete HTML email from <!DOCTYPE to </html>"
}
\`\`\`
- html_content is always the complete document from <!DOCTYPE> to </html>.
- Earlier assistant turns may show "[email design output omitted]". That's expected: the latest version is always the <current_email> attached to the newest message, and your edits apply to it.`

function currentEmailBlock(email) {
  if (!email?.html_content) return ''
  const attr = v => String(v || '').replace(/"/g, '&quot;')
  return `<current_email subject="${attr(email.subject)}" preview_text="${attr(email.preview_text)}">\n${email.html_content}\n</current_email>`
}

function normalizeCurrentEmail(input) {
  if (!input || typeof input !== 'object') return null
  const html = typeof input.html_content === 'string' ? input.html_content : ''
  if (!html.trim()) return null
  if (html.length > MAX_CURRENT_HTML_CHARS) return null
  return {
    html_content: html,
    subject: typeof input.subject === 'string' ? input.subject.slice(0, 500) : '',
    preview_text: typeof input.preview_text === 'string' ? input.preview_text.slice(0, 1000) : '',
  }
}

function extractJsonDesign(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/)
  if (!match) return null
  try {
    const data = JSON.parse(match[1])
    return data && typeof data.html_content === 'string' && data.html_content.trim() ? data : null
  } catch {
    return null
  }
}

function parseEditBlock(text) {
  const block = text.match(/```edits[^\n]*\n([\s\S]*?)(?:\n```[ \t]*(?:\n|$)|$)/)
  if (!block) return null
  const body = block[1].replace(/\r\n/g, '\n')
  const edits = []
  const pair = /<<<<<<< FIND\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g
  let m
  while ((m = pair.exec(body))) edits.push({ find: m[1], replace: m[2] })

  const header = body.split('<<<<<<< FIND')[0]
  const subject = header.match(/^SUBJECT:[ \t]*(.+)$/m)?.[1]?.trim()
  const preview = header.match(/^PREVIEW:[ \t]*(.+)$/m)?.[1]?.trim()
  if (!edits.length && !subject && !preview) return null
  return { edits, subject, preview_text: preview }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Locate `find` in `html` exactly once. Exact match first; then a match that
// ignores differences in whitespace (indentation, CRLF, wrapped lines), which
// is the most common way a correct FIND fails to match verbatim.
function locate(html, find) {
  const first = html.indexOf(find)
  if (first !== -1) {
    if (html.indexOf(find, first + 1) !== -1) return { error: 'appears more than once' }
    return { start: first, end: first + find.length }
  }
  const trimmed = find.trim()
  if (!trimmed) return { error: 'is empty' }
  const pattern = new RegExp(trimmed.split(/\s+/).map(escapeRegExp).join('\\s+'), 'g')
  const matches = [...html.matchAll(pattern)]
  if (matches.length === 0) return { error: 'was not found' }
  if (matches.length > 1) return { error: 'appears more than once' }
  return { start: matches[0].index, end: matches[0].index + matches[0][0].length }
}

function applyEdits(html, edits) {
  let out = html
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i]
    const spot = locate(out, find)
    if (spot.error) {
      return { ok: false, failedIndex: i, reason: `Edit ${i + 1}'s FIND text ${spot.error} in the current email` }
    }
    out = out.slice(0, spot.start) + replace + out.slice(spot.end)
  }
  return { ok: true, html: out }
}

// The model's visible note, without any design block.
function conversationalText(text) {
  return text
    .replace(/```json\s*[\s\S]*?```/, '')
    .replace(/```edits[^\n]*\n[\s\S]*?(?:\n```[ \t]*(?:\n|$)|$)/, '')
    .trim()
}

// Resolve a finished model reply into a design update, if it contains one.
// Returns { kind: 'none' } | { kind: 'full', design } | { kind: 'edits', design, count }
// | { kind: 'failed', reason }.
function resolveDesign(text, currentEmail) {
  const edits = currentEmail ? parseEditBlock(text) : null
  if (edits) {
    const applied = applyEdits(currentEmail.html_content, edits.edits)
    if (!applied.ok) return { kind: 'failed', reason: applied.reason }
    return {
      kind: 'edits',
      count: edits.edits.length,
      design: {
        html_content: applied.html,
        subject: edits.subject ?? currentEmail.subject,
        preview_text: edits.preview_text ?? currentEmail.preview_text,
      },
    }
  }
  const full = extractJsonDesign(text)
  if (full) return { kind: 'full', design: full }
  return { kind: 'none' }
}

function retryAsFullPrompt(reason) {
  return `${reason}, so those edits couldn't be applied. Reply with ONLY the complete updated email as a \`\`\`json block (subject, preview_text, html_content), making the same changes to <current_email>. No other text.`
}

module.exports = {
  OUTPUT_FORMAT_PROMPT,
  MAX_CURRENT_HTML_CHARS,
  currentEmailBlock,
  normalizeCurrentEmail,
  extractJsonDesign,
  parseEditBlock,
  applyEdits,
  conversationalText,
  resolveDesign,
  retryAsFullPrompt,
}
