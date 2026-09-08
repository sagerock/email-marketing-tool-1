import { createHash } from 'node:crypto'

const clean = text => text.replace(/[*_\u200c\u200b]/g, '').trim()
const marker = /^(?:(?:s|d\.?\s*e\.?)\s+)?(?:gtg\b|draft\b|approved\b|sent\s*:)/i

// Conservative extraction: the entire original comment is retained with each
// candidate. Dates and shorthand are reported evidence, never delivery facts.
export function extractArchive(source, clientId) {
  if (!source || Array.isArray(source) || typeof source.id !== 'string' || typeof source.name !== 'string' || !Array.isArray(source.actions)) {
    throw new Error('Expected a Trello card JSON export with id, name and actions')
  }
  const comments = source.actions.filter(a => a.type === 'commentCard' && typeof a.data?.text === 'string')
  const rows = []
  for (const a of comments) {
    const text = a.data.text
    const lines = text.split(/\r?\n/)
    const first = lines.find(l => clean(l)) || ''
    const period = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|April|June|July|May)\b/i.test(clean(first)) ? clean(first) : null
    const starts = lines.flatMap((l, i) => marker.test(clean(l)) ? [i] : [])
    const blocks = starts.length
      ? starts.map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length).join('\n').trim())
      : [text]
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const firstLine = clean(block.split('\n').find(l => clean(l)) || source.name)
      const name = firstLine.replace(/^(?:s\s+)?(?:gtg|draft|approved)\s*:?\s*/i, '') || firstLine
      const reported = /\bsent\s*:/i.test(block) || /\bsent\s+(?:on|\d|January|February|March|April|May|June|July|August|September|October|November|December)/i.test(block)
        ? 'Sent (reported)' : /\bscheduled\b/i.test(block) ? 'Scheduled (reported)' : /\bgtg\b/i.test(block) ? 'GTG (reported)' : /\bdraft\b/i.test(block) ? 'Draft (reported)' : 'Needs interpretation'
      rows.push({client_id:clientId, name:name.slice(0,500), brief:block, is_legacy:true,
        stage:'started', review_needed:true, source_key:`${a.id}:${i}`, source_period:period,
        source_comment:text, source_author:a.memberCreator?.fullName || a.memberCreator?.username || 'Unknown author',
        source_created_at:a.date || null, source_edited_at:a.data.dateLastEdited || null,
        reported_status:reported})
    }
  }
  return {comments:comments.length, actions:source.actions.length, rows}
}

export function sourceDigest(text) { return createHash('sha256').update(text).digest('hex') }

export function matchCampaign(entry, campaigns) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const title = entry.name.replace(/\s+\d{1,2}\/\d{1,2}\/20\d{2}.*$/, '').trim()
  // A year in a monthly heading is stronger evidence than comment creation time.
  const year = entry.source_period?.match(/20\d{2}/)?.[0]
  if (!year) return null
  const matches = campaigns.filter(c => normalize(c.name) === normalize(title)
    && [c.sent_at, c.scheduled_at, c.created_at].some(d => d?.startsWith(year)))
  return matches.length === 1 ? matches[0].id : null
}
