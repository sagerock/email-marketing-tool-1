// "Stock photos": Adobe Stock search ideas for each photo in the email. Adobe's
// API is Enterprise-only, so searches open on stock.adobe.com; the user licenses
// there and drops the downloaded file into the chat. "Use a new photo here"
// selects that image so the swap stays inside it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Loader2, MousePointerClick, Search, X } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { adobeStockUrl, emailImages, type Orientation } from '../../lib/stockPhotos'

interface Ideas {
  images: { index: number; skip: boolean; searches: string[]; orientation: Orientation }[]
  extra: { idea: string; searches: string[]; orientation: Orientation }[]
}

interface Props {
  open: boolean
  onClose: () => void
  clientId: string
  html: string
  subject: string
  /** Select the n-th image in the preview and get the chat ready for the new file. */
  onReplace: (imageIndex: number, label: string) => void
}

// Ideas are kept per email so reopening the panel doesn't ask again.
const cache = new Map<string, Ideas>()

function SearchLinks({ searches, orientation }: { searches: string[]; orientation: Orientation }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {searches.map(q => (
        <a key={q} href={adobeStockUrl(q, orientation)} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 hover:border-red-300 hover:text-red-700">
          <Search className="h-3 w-3" />{q}
        </a>
      ))}
    </div>
  )
}

export default function StockPhotosPanel({ open, onClose, clientId, html, subject, onReplace }: Props) {
  const { images, text } = useMemo(() => (open ? emailImages(html) : { images: [], text: '' }), [open, html])
  const key = `${clientId}:${subject}:${html.length}:${images.map(i => i.src).join('|')}`
  const [ideas, setIdeas] = useState<Ideas | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const cached = cache.get(key)
    if (cached) { setIdeas(cached); setError(''); return }
    let cancelled = false
    setIdeas(null)
    setError('')
    setLoading(true)
    apiFetch('/api/email-builder/stock-ideas', { method: 'POST', body: JSON.stringify({ clientId, subject, text, images }) })
      .then(async res => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || 'Photo ideas aren’t available right now. You can still search Adobe Stock above.')
        cache.set(key, body)
        if (!cancelled) setIdeas(body)
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Photo ideas aren’t available right now.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // `key` covers the email content; images/text are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const photos = ideas?.images.filter(i => !i.skip) || []
  const skipped = ideas ? ideas.images.length - photos.length : 0

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6" onMouseDown={e => { if (!panelRef.current?.contains(e.target as Node)) onClose() }}>
      <div ref={panelRef} role="dialog" aria-label="Stock photos" className="mt-8 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Find photos on Adobe Stock</h2>
            <p className="mt-1 text-sm text-gray-600">Searches open Adobe Stock in a new tab. License the photo there, download it, then drop it into the chat.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (search.trim()) window.open(adobeStockUrl(search.trim()), '_blank', 'noopener') }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search Adobe Stock for…" aria-label="Search Adobe Stock"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <button type="submit" disabled={!search.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:bg-gray-300">
              Search <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </form>

          {loading && <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Looking at your email for photo ideas…</p>}
          {error && <p role="alert" className="text-sm text-amber-800">{error}</p>}

          {photos.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Photos in this email</h3>
              {photos.map(p => {
                const img = images[p.index]
                const label = img?.alt ? `Image: "${img.alt.length > 40 ? `${img.alt.slice(0, 39)}…` : img.alt}"` : `Image ${p.index + 1}`
                return (
                  <div key={p.index} className="flex gap-3 rounded-md border border-gray-200 p-3">
                    {img?.src.startsWith('https://')
                      ? <img src={img.src} alt="" className="h-16 w-24 flex-shrink-0 rounded object-cover bg-gray-100" />
                      : <div className="h-16 w-24 flex-shrink-0 rounded bg-gray-100" />}
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-sm font-medium text-gray-800" title={img?.alt}>{img?.alt || `Image ${p.index + 1}`}</p>
                        <button type="button" onClick={() => onReplace(p.index, label)}
                          className="inline-flex flex-shrink-0 items-center gap-1 text-xs font-medium text-purple-700 hover:text-purple-900"
                          title="Select this image, then drop the new photo into the chat">
                          <MousePointerClick className="h-3.5 w-3.5" /> Use a new photo here
                        </button>
                      </div>
                      <SearchLinks searches={p.searches} orientation={p.orientation} />
                    </div>
                  </div>
                )
              })}
              {skipped > 0 && <p className="text-xs text-gray-500">Skipped {skipped} logo{skipped === 1 ? '' : 's'}, icon{skipped === 1 ? '' : 's'} or graphic{skipped === 1 ? '' : 's'} that shouldn’t come from stock.</p>}
            </div>
          )}

          {ideas && ideas.extra.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Ideas for new photos</h3>
              {ideas.extra.map(e => (
                <div key={e.idea} className="space-y-2 rounded-md border border-dashed border-gray-300 p-3">
                  <p className="text-sm text-gray-800">{e.idea}</p>
                  <SearchLinks searches={e.searches} orientation={e.orientation} />
                </div>
              ))}
            </div>
          )}

          {ideas && !photos.length && !ideas.extra.length && (
            <p className="text-sm text-gray-600">No photo spots in this email. Use the search above to look for something.</p>
          )}
        </div>
      </div>
    </div>
  )
}
