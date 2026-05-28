// src/components/media/MediaGrid.tsx
import { useState } from 'react'
import type { MediaItem } from '../../hooks/useMediaAssets'

type Props = {
  items: MediaItem[]
  loading?: boolean
  onSelect?: (item: MediaItem) => void   // single-click handler (picker mode)
  onCopyUrl?: (item: MediaItem) => void  // copy button (page mode)
  onDelete?: (item: MediaItem) => void   // delete button (page mode)
}

export default function MediaGrid({ items, loading, onSelect, onCopyUrl, onDelete }: Props) {
  const [search, setSearch] = useState('')
  const [dimsByUrl, setDimsByUrl] = useState<Record<string, { w: number; h: number }>>({})
  const filtered = items.filter((i) => {
    if (!search) return true
    const q = search.toLowerCase()
    return i.filename.toLowerCase().includes(q) || i.key.toLowerCase().includes(q)
  })

  return (
    <div className="space-y-4">
      <input
        type="text"
        placeholder="Search by filename..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {loading ? (
        <div className="text-gray-500 text-sm">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-gray-500 text-sm">No images found.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {filtered.map((item) => (
            <div
              key={item.url}
              className="group relative border border-gray-200 rounded-md overflow-hidden hover:border-blue-500 cursor-pointer bg-white"
              onClick={() => onSelect?.(item)}
              title={item.filename}
            >
              <div className="aspect-square bg-gray-50 flex items-center justify-center">
                <img
                  src={item.url}
                  alt={item.filename}
                  className="max-h-full max-w-full object-contain"
                  loading="lazy"
                  onLoad={(e) => {
                    const img = e.currentTarget
                    if (img.naturalWidth && img.naturalHeight) {
                      setDimsByUrl((prev) =>
                        prev[item.url] ? prev : { ...prev, [item.url]: { w: img.naturalWidth, h: img.naturalHeight } },
                      )
                    }
                  }}
                />
              </div>
              <div className="p-2 text-xs">
                <div className="truncate font-medium">{item.filename}</div>
                <div className="flex items-center justify-between mt-1 text-gray-500">
                  <span>
                    {item.size != null ? `${Math.round(item.size / 1024)} KB` : '—'}
                    {dimsByUrl[item.url] && (
                      <span className="ml-1">· {dimsByUrl[item.url].w}×{dimsByUrl[item.url].h}</span>
                    )}
                  </span>
                  <span className={item.source === 's3' ? 'text-blue-600' : 'text-amber-600'}>
                    {item.source === 's3' ? 'S3' : 'Discovered'}
                  </span>
                </div>
              </div>
              {(onCopyUrl || onDelete) && (
                <div className="absolute inset-x-0 bottom-0 p-2 bg-white/95 border-t border-gray-200 hidden group-hover:flex gap-2">
                  {onCopyUrl && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onCopyUrl(item) }}
                      className="flex-1 text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                    >
                      Copy URL
                    </button>
                  )}
                  {onDelete && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(item) }}
                      disabled={item.source === 'discovered'}
                      className="flex-1 text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                      title={item.source === 'discovered' ? 'Cannot delete discovered URLs' : 'Delete'}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
