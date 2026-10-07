import { Fragment, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

// Lightweight markdown for AI chat replies: headings, paragraphs, bullet and
// numbered lists (one level of nesting), code blocks, rules, and inline
// bold/italic/code/links. Builds React elements only, never raw HTML.

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_|\[[^\]\n]+\]\([^)\s]+\))/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`
    if (!part) return null
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return <code key={key} className="rounded bg-gray-200/70 px-1 py-0.5 font-mono text-[0.85em]">{part.slice(1, -1)}</code>
    }
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      if (part.length > 4) return <strong key={key} className="font-semibold text-gray-900">{renderInline(part.slice(2, -2), key)}</strong>
    }
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      if (part.length > 2) return <em key={key}>{renderInline(part.slice(1, -1), key)}</em>
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
    if (link) {
      const href = /^(https?:|mailto:)/i.test(link[2]) ? link[2] : undefined
      return href
        ? <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">{link[1]}</a>
        : <Fragment key={key}>{link[1]}</Fragment>
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

interface ListItem { text: string; children: string[] }
type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'code'; text: string }
  | { type: 'rule' }

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

function parse(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ type: 'rule' }); continue }

    const item = line.match(LIST_ITEM)
    if (item) {
      flush()
      const ordered = /\d/.test(item[2])
      const baseIndent = item[1].length
      const list: Block & { type: 'list' } = { type: 'list', ordered, start: ordered ? parseInt(item[2], 10) : 1, items: [] }
      // Consume this list: top-level items at baseIndent, deeper items/continuations as children.
      for (; i < lines.length; i++) {
        const l = lines[i]
        if (!l.trim()) {
          const next = lines[i + 1]?.match(LIST_ITEM)
          if (next && next[1].length >= baseIndent) continue
          break
        }
        const m = l.match(LIST_ITEM)
        if (m && m[1].length <= baseIndent) {
          if (/\d/.test(m[2]) !== ordered) break
          list.items.push({ text: m[3], children: [] })
        } else if (m || /^\s+/.test(l)) {
          const last = list.items[list.items.length - 1]
          if (m) last.children.push(m[3])
          else if (last.children.length) last.children[last.children.length - 1] += ' ' + l.trim()
          else last.text += '\n' + l.trim()
        } else {
          break
        }
      }
      i--
      blocks.push(list)
      continue
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

const HEADING_CLASS = ['text-base font-semibold', 'text-base font-semibold', 'text-sm font-semibold', 'text-sm font-semibold']

export default function ChatMarkdown({ content, className }: { content: string; className?: string }) {
  const blocks = parse(content)
  return (
    <div className={cn('space-y-2 break-words', className)}>
      {blocks.map((block, b) => {
        const key = `b${b}`
        switch (block.type) {
          case 'heading':
            return <p key={key} className={cn('text-gray-900', HEADING_CLASS[Math.min(block.level, 4) - 1])}>{renderInline(block.text, key)}</p>
          case 'paragraph':
            return <p key={key} className="whitespace-pre-wrap">{renderInline(block.text, key)}</p>
          case 'code':
            return <pre key={key} className="overflow-x-auto rounded bg-gray-200/70 p-2 font-mono text-xs">{block.text}</pre>
          case 'rule':
            return <hr key={key} className="border-gray-200" />
          case 'list': {
            const ListTag = block.ordered ? 'ol' : 'ul'
            return (
              <ListTag key={key} start={block.ordered ? block.start : undefined} className={cn('space-y-1 pl-5', block.ordered ? 'list-decimal' : 'list-disc')}>
                {block.items.map((item, n) => (
                  <li key={n} className="whitespace-pre-wrap">
                    {renderInline(item.text, `${key}-${n}`)}
                    {item.children.length > 0 && (
                      <ul className="mt-1 list-[circle] space-y-0.5 pl-5">
                        {item.children.map((child, c) => <li key={c}>{renderInline(child, `${key}-${n}-${c}`)}</li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ListTag>
            )
          }
        }
      })}
    </div>
  )
}
