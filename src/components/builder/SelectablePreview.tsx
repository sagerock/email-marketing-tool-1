import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { annotateHtml, applyTextEdit, describeElement, isTextEditable, scanElements, snapshotText, type ScannedElement, type SourceSpan } from '../../lib/emailSections'

export interface PreviewSelection extends SourceSpan {
  label: string
}

interface Props {
  html: string
  selection: PreviewSelection | null
  onSelect: (selection: PreviewSelection | null) => void
  /** Changes when the preview width changes, so overlays are redrawn. */
  layoutKey: string
  /** Called after the user types over text in the preview: the updated email,
   *  or null when that text couldn't be written back safely. */
  onTextEdit?: (html: string | null) => void
}

const OVERLAY_CSS = `
#sr-hover, #sr-selected { position: absolute; pointer-events: none; z-index: 2147483646; box-sizing: border-box; border-radius: 3px; }
#sr-hover { outline: 2px dashed rgba(124, 58, 237, .7); outline-offset: -2px; }
#sr-selected { outline: 2px solid #7c3aed; outline-offset: -2px; background: rgba(124, 58, 237, .06); }
#sr-hover span, #sr-selected span { position: absolute; left: 0; top: -20px; font: 600 11px/18px -apple-system, Segoe UI, sans-serif;
  color: #fff; background: #7c3aed; padding: 0 6px; border-radius: 3px; white-space: nowrap; max-width: 520px; overflow: hidden; text-overflow: ellipsis; }
#sr-hover span { background: rgba(124, 58, 237, .75); }
#sr-hover.below span, #sr-selected.below span { top: auto; bottom: -20px; }
[contenteditable] { outline: 2px solid #2563eb !important; outline-offset: 2px; cursor: text; caret-color: #2563eb; }
`

// The email's main body: the widest element no wider than a typical email,
// e.g. the 600px content table. Sections live inside it.
function findContainer(doc: Document): Element {
  let best: Element | null = null
  let bestArea = 0
  doc.querySelectorAll('[data-sr]').forEach(el => {
    const r = el.getBoundingClientRect()
    if (r.width >= 280 && r.width <= 720 && r.width * r.height > bestArea) {
      best = el
      bestArea = r.width * r.height
    }
  })
  return best || doc.body
}

// Selectable ancestors of `target`, innermost first, stopping below `container`.
function chainFor(target: Element, container: Element): Element[] {
  const chain: Element[] = []
  for (let el: Element | null = target; el && el !== container; el = el.parentElement) {
    if (el.hasAttribute('data-sr')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) chain.push(el)
    }
  }
  return container.contains(target) ? chain : []
}

// First click: the section, i.e. the outermost block under the container that
// is clearly smaller than the whole email. Wrappers that fill the body are skipped.
function sectionOf(chain: Element[], container: Element): Element | undefined {
  const total = container.getBoundingClientRect().height
  const outerFirst = [...chain].reverse()
  return outerFirst.find(el => el.getBoundingClientRect().height < total * 0.6) || chain[0]
}

// Next click inside the selection: the next meaningfully smaller piece inward.
function drillDown(chain: Element[], current: Element): Element | undefined {
  const idx = chain.indexOf(current)
  if (idx <= 0) return undefined
  const r = current.getBoundingClientRect()
  const area = r.width * r.height
  for (let i = idx - 1; i >= 0; i--) {
    const c = chain[i].getBoundingClientRect()
    if (c.width * c.height < area * 0.85) return chain[i]
  }
  return undefined
}

export default function SelectablePreview({ html, selection, onSelect, layoutKey, onTextEdit }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const { annotated, elements } = useMemo(() => {
    const els = scanElements(html)
    return { annotated: annotateHtml(html, els), elements: els }
  }, [html])
  const byId = useMemo(() => new Map(elements.map(e => [e.id, e])), [elements])
  // Listeners attached to the preview document read the latest props here.
  const selectionRef = useRef(selection)
  const onSelectRef = useRef(onSelect)
  const onTextEditRef = useRef(onTextEdit)
  const htmlRef = useRef(html)
  useLayoutEffect(() => {
    selectionRef.current = selection
    onSelectRef.current = onSelect
    onTextEditRef.current = onTextEdit
    htmlRef.current = html
  })

  const spanOf = useCallback((el: Element): ScannedElement | undefined =>
    byId.get(Number(el.getAttribute('data-sr'))), [byId])

  const place = (doc: Document, id: string, el: Element | null, label = '') => {
    let box = doc.getElementById(id)
    if (!el) { box?.remove(); return }
    if (!box) {
      box = doc.createElement('div')
      box.id = id
      box.appendChild(doc.createElement('span'))
      doc.body.appendChild(box)
    }
    const r = el.getBoundingClientRect()
    const sx = doc.defaultView?.scrollX || 0
    const sy = doc.defaultView?.scrollY || 0
    Object.assign(box.style, { left: `${r.left + sx}px`, top: `${r.top + sy}px`, width: `${r.width}px`, height: `${r.height}px` })
    box.classList.toggle('below', r.top + sy < 22)
    box.querySelector('span')!.textContent = label
  }

  // Draw the current selection; drop it if it no longer matches an element.
  const drawSelection = useCallback(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc?.body) return
    const sel = selectionRef.current
    if (!sel) { place(doc, 'sr-selected', null); return }
    const match = elements.find(e => e.start === sel.start && e.end === sel.end)
    const el = match ? doc.querySelector(`[data-sr="${match.id}"]`) : null
    if (!el) { place(doc, 'sr-selected', null); onSelectRef.current(null); return }
    place(doc, 'sr-selected', el, sel.label)
  }, [elements])

  const handleLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc?.body) return
    const style = doc.createElement('style')
    style.textContent = OVERLAY_CSS
    doc.head?.appendChild(style)
    const container = findContainer(doc)
    const sectionSet = new Set<Element>()

    const pick = (target: Element, current: Element | null): Element | undefined => {
      const chain = chainFor(target, container)
      if (!chain.length) return undefined
      if (current && chain.includes(current)) return drillDown(chain, current) || current
      const section = sectionOf(chain, container)
      if (section) sectionSet.add(section)
      return section
    }
    const labelFor = (el: Element) => describeElement(el, sectionSet.has(el) || el === sectionOf(chainFor(el, container), container))
    const currentEl = (): Element | null => {
      const sel = selectionRef.current
      const match = sel && elements.find(e => e.start === sel.start && e.end === sel.end)
      return match ? doc.querySelector(`[data-sr="${match.id}"]`) : null
    }

    // Typing over text: double-click starts, Enter or clicking away keeps it, Esc cancels.
    let editing: { el: HTMLElement; scanned: ScannedElement; before: string[]; original: string } | null = null
    const stopEditing = (keep: boolean) => {
      if (!editing) return
      const { el, scanned, before, original } = editing
      editing = null
      if (!keep) { el.innerHTML = original; el.removeAttribute('contenteditable'); return }
      const next = applyTextEdit(htmlRef.current, scanned, before, el)
      el.removeAttribute('contenteditable')
      if (next === null) { el.innerHTML = original; onTextEditRef.current?.(null); return }
      if (next !== htmlRef.current) onTextEditRef.current?.(next)
    }
    doc.addEventListener('dblclick', e => {
      if (!onTextEditRef.current || editing) return
      let target: Element | null = e.target as Element
      for (; target && target !== doc.body; target = target.parentElement) {
        if (target.hasAttribute('data-sr') && isTextEditable(target)) break
      }
      const scanned = target && target !== doc.body ? spanOf(target) : undefined
      if (!target || !scanned) return
      const el = target as HTMLElement
      editing = { el, scanned, before: snapshotText(el), original: el.innerHTML }
      place(doc, 'sr-hover', null)
      el.setAttribute('contenteditable', 'plaintext-only')
      el.focus()
      el.addEventListener('blur', () => stopEditing(true), { once: true })
    })
    doc.addEventListener('keydown', e => {
      if (!editing) return
      if (e.key === 'Enter') { e.preventDefault(); editing.el.blur() }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); const el = editing.el; stopEditing(false); el.blur() }
    })

    doc.addEventListener('mousemove', e => {
      const target = e.target as Element
      if (editing) return
      const el = pick(target, currentEl())
      place(doc, 'sr-hover', el && el !== currentEl() ? el : null, el ? labelFor(el) : '')
    })
    doc.addEventListener('mouseleave', () => place(doc, 'sr-hover', null))
    doc.addEventListener('click', e => {
      e.preventDefault() // links in the preview never navigate
      if (editing?.el.contains(e.target as Node)) return
      const el = pick(e.target as Element, currentEl())
      place(doc, 'sr-hover', null)
      if (!el) { onSelectRef.current(null); return }
      const span = spanOf(el)
      if (!span) return
      onSelectRef.current({ start: span.start, end: span.end, label: labelFor(el) })
    })
    doc.addEventListener('keydown', e => { if (e.key === 'Escape') onSelectRef.current(null) })
    drawSelection()
  }, [elements, spanOf, drawSelection])

  useEffect(() => { drawSelection() }, [selection, drawSelection])
  useEffect(() => {
    const t = setTimeout(drawSelection, 350) // after the width transition
    return () => clearTimeout(t)
  }, [layoutKey, drawSelection])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={annotated}
      onLoad={handleLoad}
      className="w-full border-0"
      style={{ height: '800px' }}
      title="Email preview"
      sandbox="allow-same-origin"
    />
  )
}
