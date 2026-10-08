// "Stock photos": search ideas for each photo in the email. Free photos come
// from Unsplash or Pixabay right here (click one to swap it in; Pixabay photos
// are saved to the media library first, per its rules); Adobe Stock searches open
// on stock.adobe.com, since Adobe's API is Enterprise-only, and the licensed
// file is dropped into the chat. "Use a new photo here" selects that image so
// the swap stays inside it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Loader2, MousePointerClick, Search, X } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { adobeStockUrl, emailImages, type Orientation } from '../../lib/stockPhotos'

interface Ideas {
  images: { index: number; skip: boolean; searches: string[]; orientation: Orientation }[]
  extra: { idea: string; searches: string[]; orientation: Orientation }[]
}

export interface FreePhoto {
  id: string
  alt: string
  thumb: string
  color: string | null
  photographer: string
  photographer_url: string
  source_url: string
}

export type FreeSource = 'unsplash' | 'pixabay'
const SOURCE_LABEL: Record<FreeSource, string> = { unsplash: 'Unsplash', pixabay: 'Pixabay' }

/** A photo chosen in the panel, ready for the email. */
export interface ChosenPhoto {
  url: string
  alt: string
  photographer: string
  source: FreeSource
}

export type PhotoTarget = { type: 'image'; index: number } | { type: 'idea'; idea: string } | { type: 'free' }

interface Props {
  open: boolean
  onClose: () => void
  clientId: string
  html: string
  subject: string
  /** Select the n-th image in the preview and get the chat ready for the new file. */
  onReplace: (imageIndex: number, label: string) => void
  /** A free photo was picked: swap it into that image, or hand it to the chat. */
  onUsePhoto: (target: PhotoTarget, photo: ChosenPhoto) => void
}

const UNSPLASH_HOME = 'https://unsplash.com/?utm_source=sagerock_email_tool&utm_medium=referral'

interface FreeContext {
  source: FreeSource
  clientId: string
  onUse: Props['onUsePhoto']
}

// Free photo results for one search; click one to use it.
function FreePhotos({ query, orientation, size, target, free }: {
  query: string
  orientation?: Orientation
  size: { width: number | null; height: number | null }
  target: PhotoTarget
  free: FreeContext
}) {
  const { source, clientId, onUse } = free
  const [photos, setPhotos] = useState<FreePhoto[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [using, setUsing] = useState('')

  // A new source starts over at page 1.
  const [loadedFor, setLoadedFor] = useState(source)
  if (loadedFor !== source) { setLoadedFor(source); setPage(1); setPhotos([]) }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    apiFetch(`/api/stock/${source}/search`, { method: 'POST', body: JSON.stringify({ query, orientation, page }) })
      .then(async res => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || 'Free photo search isn’t working right now.')
        if (cancelled) return
        setPhotos(prev => (page === 1 ? body.photos : [...prev, ...body.photos]))
        setPages(body.total_pages || 0)
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Free photo search isn’t working right now.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [source, query, orientation, page])

  const use = async (photo: FreePhoto) => {
    setUsing(photo.id)
    setError('')
    try {
      const res = await apiFetch(`/api/stock/${source}/use`, { method: 'POST', body: JSON.stringify({ id: photo.id, clientId, ...size }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'That photo couldn’t be added right now.')
      onUse(target, { url: body.url, alt: body.alt || photo.alt, photographer: body.photographer, source })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That photo couldn’t be added right now.')
    } finally {
      setUsing('')
    }
  }

  return (
    <div className="space-y-2" aria-label={`Free photos for ${query}`}>
      {error && <p role="alert" className="text-xs text-amber-800">{error}</p>}
      {photos.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {photos.map(p => (
            <figure key={p.id} className="space-y-1">
              <button type="button" onClick={() => void use(p)} disabled={Boolean(using)} title={p.alt ? `Use: ${p.alt}` : 'Use this photo'}
                className="relative block aspect-[4/3] w-full overflow-hidden rounded border border-gray-200 hover:ring-2 hover:ring-blue-500 disabled:opacity-60"
                style={{ backgroundColor: p.color || '#f3f4f6' }}>
                <img src={p.thumb} alt={p.alt} className="h-full w-full object-cover" loading="lazy" />
                {using === p.id && <span className="absolute inset-0 flex items-center justify-center bg-white/60"><Loader2 className="h-5 w-5 animate-spin" /></span>}
              </button>
              <figcaption className="truncate text-[11px] text-gray-500">
                <a href={p.photographer_url} target="_blank" rel="noreferrer" className="hover:underline">{p.photographer}</a>
                {' · '}<a href={p.source_url} target="_blank" rel="noreferrer" className="hover:underline">{SOURCE_LABEL[source]}</a>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {loading && <p className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding free photos…</p>}
      {!loading && !error && !photos.length && <p className="text-xs text-gray-500">No free photos for “{query}”. Try another search or Adobe Stock.</p>}
      {!loading && page < pages && (
        <button type="button" onClick={() => setPage(p => p + 1)} className="text-xs font-medium text-blue-700 hover:text-blue-900">More photos</button>
      )}
    </div>
  )
}

// One spot's searches: chips show free photos here; Adobe links open in a new tab.
function SearchRow({ searches, orientation, size, target, free }: {
  searches: string[]
  orientation: Orientation
  size: { width: number | null; height: number | null }
  target: PhotoTarget
  free: FreeContext
}) {
  const [active, setActive] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-gray-500">Free photos:</span>
        {searches.map(q => (
          <button key={q} type="button" onClick={() => setActive(a => (a === q ? null : q))} aria-pressed={active === q}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${active === q ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-gray-200 bg-white text-gray-700 hover:border-blue-300'}`}>
            <Search className="h-3 w-3" />{q}
          </button>
        ))}
      </div>
      {active && <FreePhotos query={active} orientation={orientation} size={size} target={target} free={free} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-gray-500">Adobe Stock:</span>
        {searches.map(q => (
          <a key={q} href={adobeStockUrl(q, orientation)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-gray-600 hover:text-red-700">
            {q}<ExternalLink className="h-3 w-3" />
          </a>
        ))}
      </div>
    </div>
  )
}

// Ideas are kept per email so reopening the panel doesn't ask again.
const cache = new Map<string, Ideas>()

export default function StockPhotosPanel({ open, onClose, clientId, html, subject, onReplace, onUsePhoto }: Props) {
  const { images, text } = useMemo(() => (open ? emailImages(html) : { images: [], text: '' }), [open, html])
  const key = `${clientId}:${subject}:${html.length}:${images.map(i => i.src).join('|')}`
  const [ideas, setIdeas] = useState<Ideas | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [freeQuery, setFreeQuery] = useState('')
  const [freeSource, setFreeSource] = useState<FreeSource>('unsplash')
  const free: FreeContext = { source: freeSource, clientId, onUse: onUsePhoto }
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
            <h2 className="text-base font-semibold text-gray-900">Find photos</h2>
            <p className="mt-1 text-sm text-gray-600">Click a free photo to put it in your email. For Adobe Stock, license the photo there, download it, then drop it into the chat.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs" role="group" aria-label="Free photo source">
              <span className="text-gray-500">Free photos from:</span>
              {(['unsplash', 'pixabay'] as const).map(src => (
                <button key={src} type="button" onClick={() => setFreeSource(src)} aria-pressed={freeSource === src}
                  className={`rounded-full border px-2.5 py-0.5 font-medium ${freeSource === src ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                  {SOURCE_LABEL[src]}
                </button>
              ))}
            </div>
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setFreeQuery(search.trim()) }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search for a photo…" aria-label="Search for a photo"
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <button type="submit" disabled={!search.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:bg-gray-300">
                <Search className="h-3.5 w-3.5" /> Free photos
              </button>
              <a href={search.trim() ? adobeStockUrl(search.trim()) : undefined} target="_blank" rel="noreferrer" aria-disabled={!search.trim()}
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium ${search.trim() ? 'border-gray-300 text-gray-800 hover:bg-gray-50' : 'pointer-events-none border-gray-200 text-gray-300'}`}>
                Adobe Stock <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </form>
            {freeQuery && (
              <>
                <p className="text-xs text-gray-500">Click one to add it to the chat, then say where it goes.</p>
                <FreePhotos key={freeQuery} query={freeQuery} size={{ width: 600, height: null }} target={{ type: 'free' }} free={free} />
              </>
            )}
          </div>

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
                      <SearchRow searches={p.searches} orientation={p.orientation} size={{ width: img?.width ?? null, height: img?.height ?? null }}
                        target={{ type: 'image', index: p.index }} free={free} />
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
                  <SearchRow searches={e.searches} orientation={e.orientation} size={{ width: 600, height: null }}
                    target={{ type: 'idea', idea: e.idea }} free={free} />
                </div>
              ))}
            </div>
          )}

          {ideas && !photos.length && !ideas.extra.length && (
            <p className="text-sm text-gray-600">No photo spots in this email. Use the search above to look for something.</p>
          )}
        </div>
        <p className="border-t border-gray-200 px-5 py-2 text-xs text-gray-500">
          Free photos from <a href={UNSPLASH_HOME} target="_blank" rel="noreferrer" className="underline hover:text-gray-800">Unsplash</a> and{' '}
          <a href="https://pixabay.com/" target="_blank" rel="noreferrer" className="underline hover:text-gray-800">Pixabay</a>.
          Unsplash photos load from Unsplash; Pixabay photos are saved to your Media library.
        </p>
      </div>
    </div>
  )
}
