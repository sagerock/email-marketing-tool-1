// src/hooks/useMediaAssets.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export type MediaItem = {
  key: string
  url: string
  filename: string
  size: number | null
  last_modified: string | null
  source: 's3' | 'discovered'
}

type MediaResponse = { items: MediaItem[]; needs_setup: boolean }

const API_BASE = import.meta.env.VITE_API_URL || ''

export function useMediaAssets(clientId: string | null | undefined) {
  return useQuery<MediaResponse>({
    queryKey: ['media', clientId],
    enabled: !!clientId,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/media?client_id=${clientId}`)
      if (!res.ok) throw new Error(`Failed to load media: ${res.status}`)
      return res.json()
    },
  })
}

export function useUploadMedia(clientId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('client_id', clientId)
      fd.append('file', file)
      const res = await fetch(`${API_BASE}/api/media/upload`, { method: 'POST', body: fd })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Upload failed: ${res.status}`)
      }
      return res.json() as Promise<{ key: string; url: string }>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['media', clientId] }),
  })
}

export function useDeleteMedia(clientId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(
        `${API_BASE}/api/media?client_id=${clientId}&key=${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Delete failed: ${res.status}`)
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['media', clientId] }),
  })
}

export function useScanMedia(clientId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/api/media/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      })
      if (!res.ok) throw new Error(`Scan failed: ${res.status}`)
      return res.json() as Promise<{ scanned: number; discovered: number }>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['media', clientId] }),
  })
}
