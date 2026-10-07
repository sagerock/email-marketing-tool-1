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
- The note must describe only what your block actually changes. If you mention a change, include the edit for it.

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
- The block must open with \`\`\`edits on its own line (not \`\`\`html) and close with \`\`\`.
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
SELECTED PART:
- When a <selected_part> follows the <current_email>, the user clicked that part of the preview. "This", "it" and "here" mean that part.
- Change only what is inside it: use targeted edits whose FIND text is copied from inside <selected_part>. Never return the full email while a part is selected.
- If the request clearly needs changes outside the selected part (for example the whole email's font), make no edits; say so briefly and suggest clearing the selection.
- Earlier assistant turns may show "[email design output omitted]". That's expected: the latest version is always the <current_email> attached to the newest message, and your edits apply to it.`

const attr = v => String(v || '').replace(/"/g, '&quot;')

function currentEmailBlock(email, selection = null) {
  if (!email?.html_content) return ''
  const block = `<current_email subject="${attr(email.subject)}" preview_text="${attr(email.preview_text)}">\n${email.html_content}\n</current_email>`
  if (!selection) return block
  const part = email.html_content.slice(selection.start, selection.end)
  return `${block}\n<selected_part label="${attr(selection.label)}">\n${part}\n</selected_part>`
}

// A clicked span of the current email: { start, end, label } with integer
// offsets inside the HTML. Anything else is ignored rather than trusted.
function normalizeSelection(input, email) {
  if (!input || !email) return null
  const { start, end } = input
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || end <= start || end > email.html_content.length) return null
  const label = typeof input.label === 'string' ? input.label.slice(0, 120) : 'Selected part'
  return { start, end, label }
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

// Fenced code blocks, including one cut off before its closing fence.
const FENCE = /```([a-z]*)[^\n]*\n([\s\S]*?)(?:\n```[ \t]*(?=\n|$)|$)/g
const PAIR = /<<<<<<< FIND\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g

// The edits region: the ```edits block if there is one. Models sometimes
// label it ```html or drop the fence entirely, so any fenced block holding
// FIND markers counts too, and bare markers in the text as a last resort.
function editRegions(text) {
  const blocks = [...text.replace(/\r\n/g, '\n').matchAll(FENCE)]
    .filter(b => b[1] === 'edits' || b[2].includes('<<<<<<< FIND'))
    .map(b => b[2])
  if (blocks.length) return { bodies: blocks, fenced: true }
  return text.includes('<<<<<<< FIND') ? { bodies: [text.replace(/\r\n/g, '\n')], fenced: false } : null
}

function parseEditBlock(text) {
  const regions = editRegions(text)
  if (!regions) return null
  const edits = []
  let subject, preview
  for (const body of regions.bodies) {
    for (const m of body.matchAll(PAIR)) edits.push({ find: m[1], replace: m[2] })
    // SUBJECT/PREVIEW lines are only trusted inside a fenced block, never
    // picked out of the conversational note.
    if (regions.fenced) {
      const header = body.split('<<<<<<< FIND')[0]
      subject ??= header.match(/^SUBJECT:[ \t]*(.+)$/m)?.[1]?.trim()
      preview ??= header.match(/^PREVIEW:[ \t]*(.+)$/m)?.[1]?.trim()
    }
  }
  if (!edits.length && !subject && !preview) return null
  return { edits, subject, preview_text: preview }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Locate `find` in `html` exactly once. Exact match first; then a match that
// ignores differences in whitespace (indentation, CRLF, wrapped lines), which
// is the most common way a correct FIND fails to match verbatim.
function locate(fullHtml, find, range = null) {
  // With a range, search only inside it; offsets stay relative to fullHtml.
  const offset = range ? range.start : 0
  const html = range ? fullHtml.slice(range.start, range.end) : fullHtml
  const found = locateIn(html, find)
  return found.error ? found : { start: found.start + offset, end: found.end + offset }
}

function locateIn(html, find) {
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

// With a range, every FIND must lie inside it, and the range grows or shrinks
// with each replacement so the caller can keep the same part selected.
function applyEdits(html, edits, range = null) {
  let out = html
  const r = range ? { start: range.start, end: range.end } : null
  const where = r ? 'the selected part' : 'the current email'
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i]
    const spot = locate(out, find, r)
    if (spot.error) {
      return { ok: false, failedIndex: i, reason: `Edit ${i + 1}'s FIND text ${spot.error} in ${where}` }
    }
    out = out.slice(0, spot.start) + replace + out.slice(spot.end)
    if (r) r.end += replace.length - (spot.end - spot.start)
  }
  return { ok: true, html: out, range: r }
}

// The model's visible note, without any design block.
function conversationalText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(FENCE, (block, lang, body) =>
      (lang === 'json' || lang === 'edits' || body.includes('<<<<<<< FIND') ? '' : block))
    .replace(PAIR, '')
    .trim()
}

// Resolve a finished model reply into a design update, if it contains one.
// Returns { kind: 'none' } | { kind: 'full', design } | { kind: 'edits', design, count }
// | { kind: 'failed', reason }.
function resolveDesign(text, currentEmail, selection = null) {
  const edits = currentEmail ? parseEditBlock(text) : null
  if (edits) {
    const applied = applyEdits(currentEmail.html_content, edits.edits, selection)
    if (!applied.ok) return { kind: 'failed', reason: applied.reason }
    return {
      kind: 'edits',
      count: edits.edits.length,
      selection: applied.range ? { start: applied.range.start, end: applied.range.end } : undefined,
      design: {
        html_content: applied.html,
        subject: edits.subject ?? currentEmail.subject,
        preview_text: edits.preview_text ?? currentEmail.preview_text,
      },
    }
  }
  const full = extractJsonDesign(text)
  if (full && selection) {
    // A full rewrite is only acceptable if everything outside the selection survived.
    const html = currentEmail.html_content
    const before = html.slice(0, selection.start)
    const after = html.slice(selection.end)
    const out = full.html_content
    if (out.length < before.length + after.length || !out.startsWith(before) || !out.endsWith(after)) {
      return { kind: 'failed', reason: 'The reply rewrote parts of the email outside the selected part' }
    }
    return { kind: 'full', design: full, selection: { start: selection.start, end: out.length - after.length } }
  }
  if (full) return { kind: 'full', design: full }
  return { kind: 'none' }
}

function retrySelectedPrompt(reason) {
  return `${reason}, so nothing was changed. Reply with ONLY a corrected \`\`\`edits block whose FIND text is copied exactly from inside <selected_part>. No other text.`
}

function retryAsFullPrompt(reason) {
  return `${reason}, so those edits couldn't be applied. Reply with ONLY the complete updated email as a \`\`\`json block (subject, preview_text, html_content), making the same changes to <current_email>. No other text.`
}

module.exports = {
  normalizeSelection,
  retrySelectedPrompt,
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
