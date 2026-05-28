// src/components/media/MediaPicker.tsx
import { useMediaAssets, type MediaItem } from '../../hooks/useMediaAssets'
import MediaGrid from './MediaGrid'

type Props = {
  open: boolean
  onClose: () => void
  clientId: string
  onSelect?: (url: string) => void
}

export default function MediaPicker({ open, onClose, clientId, onSelect }: Props) {
  const { data, isLoading } = useMediaAssets(open ? clientId : null)
  if (!open) return null

  const handleSelect = async (item: MediaItem) => {
    await navigator.clipboard.writeText(item.url)
    onSelect?.(item.url)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-5xl w-full max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Pick an image</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">✕</button>
        </div>
        <div className="p-4 overflow-y-auto flex-1">
          {data?.needs_setup ? (
            <p className="text-sm text-gray-600">Media library not set up for this client.</p>
          ) : (
            <MediaGrid
              items={data?.items || []}
              loading={isLoading}
              onSelect={handleSelect}
            />
          )}
        </div>
        <div className="p-3 border-t border-gray-200 text-xs text-gray-500">
          Clicking an image copies its URL to your clipboard so you can paste it into your HTML.
        </div>
      </div>
    </div>
  )
}
