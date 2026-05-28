import { supabase } from './supabase'

const API_URL = import.meta.env.VITE_API_URL || ''

export async function apiFetch(path: string, options: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const isFormData = options.body instanceof FormData
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers as Record<string, string>),
  }
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`
  }
  const url = path.startsWith('http') ? path : `${API_URL}${path}`
  return fetch(url, { ...options, headers })
}
