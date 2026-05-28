// src/pages/Media.tsx
import { useRef } from 'react'
import { useClient } from '../context/ClientContext'
import {
  useMediaAssets,
  useUploadMedia,
  useDeleteMedia,
  useScanMedia,
  type MediaItem,
} from '../hooks/useMediaAssets'
import MediaGrid from '../components/media/MediaGrid'
import Button from '../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'

export default function Media() {
  const { selectedClient } = useClient()
  const clientId = selectedClient?.id || ''
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data, isLoading } = useMediaAssets(clientId)
  const upload = useUploadMedia(clientId)
  const remove = useDeleteMedia(clientId)
  const scan = useScanMedia(clientId)

  if (!selectedClient) {
    return <div className="p-6 text-gray-500">Select a client to view its media library.</div>
  }
  if (data?.needs_setup) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader><CardTitle>Media library not set up</CardTitle></CardHeader>
          <CardContent>
            <p className="text-gray-600">
              This client has no S3 prefix configured. Ask an admin to set <code>s3_prefix</code> on
              the <code>clients</code> row before uploading images.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const handleCopyUrl = async (item: MediaItem) => {
    await navigator.clipboard.writeText(item.url)
    alert('URL copied to clipboard')
  }
  const handleDelete = async (item: MediaItem) => {
    if (!confirm(`Delete ${item.filename}? This cannot be undone.`)) return
    try { await remove.mutateAsync(item.key) }
    catch (err) { alert(err instanceof Error ? err.message : 'Delete failed') }
  }
  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try { await upload.mutateAsync(file) }
    catch (err) { alert(err instanceof Error ? err.message : 'Upload failed') }
    finally { if (fileInputRef.current) fileInputRef.current.value = '' }
  }
  const handleScan = async () => {
    try {
      const r = await scan.mutateAsync()
      alert(`Scan complete — ${r.discovered} new image URL${r.discovered === 1 ? '' : 's'} discovered.`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Scan failed')
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Media Library</h1>
          <p className="text-sm text-gray-600">
            Images for {selectedClient.name}. Click "Copy URL" to paste into your email HTML.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={handleFileChosen}
            className="hidden"
          />
          <Button onClick={() => fileInputRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? 'Uploading...' : 'Upload'}
          </Button>
          <Button variant="outline" onClick={handleScan} disabled={scan.isPending}>
            {scan.isPending ? 'Scanning...' : 'Scan past emails'}
          </Button>
        </div>
      </div>
      <MediaGrid
        items={data?.items || []}
        loading={isLoading}
        onCopyUrl={handleCopyUrl}
        onDelete={handleDelete}
      />
    </div>
  )
}
