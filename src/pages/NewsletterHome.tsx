import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, FileText, Plus, RefreshCw } from 'lucide-react'
import { useClient } from '../context/ClientContext'
import { supabase } from '../lib/supabase'

type Draft = { id: string; name: string; subject: string; updated_at: string | null; created_at: string }

export default function NewsletterHome() {
  const { selectedClient, loading: clientsLoading } = useClient()
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setDrafts([])
    setError('')
    if (!selectedClient) { setLoading(false); return }
    setLoading(true)
    void (async () => {
      const { data, error } = await supabase.from('templates')
        .select('id, name, subject, updated_at, created_at')
        .eq('client_id', selectedClient.id)
        .order('updated_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false }).limit(8)
      if (cancelled) return
      if (error) setError('We couldn’t load your drafts. Please try again.')
      else setDrafts(data || [])
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [selectedClient?.id, attempt])

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div>
        <p className="text-sm font-medium text-blue-700 mb-2">{selectedClient?.name || 'Your workspace'}</p>
        <h1 className="text-3xl font-semibold text-gray-900">Let’s work on your newsletter</h1>
        <p className="mt-2 text-gray-600">Pick up a saved draft, or describe something new in the email builder.</p>
      </div>
      {!clientsLoading && !selectedClient ? (
        <p className="p-5 bg-amber-50 rounded-xl text-amber-900">No client is available for this account. Check the email shown above, or contact your administrator for access.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Link to="/email-builder" className="block rounded-xl bg-blue-600 p-6 text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
              <Plus className="h-6 w-6 mb-4" />
              <h2 className="text-lg font-semibold">Create newsletter</h2>
              <p className="mt-1 text-blue-100 text-sm">Start a conversation and watch your design take shape.</p>
            </Link>
            {drafts[0] ? (
              <Link to={`/email-builder?templateId=${drafts[0].id}`} className="block rounded-xl border border-gray-200 bg-white p-6 hover:border-blue-400">
                <ArrowRight className="h-6 w-6 mb-4 text-blue-600" />
                <h2 className="text-lg font-semibold text-gray-900">Continue latest draft</h2>
                <p className="mt-1 text-gray-600 text-sm break-words">{drafts[0].name}</p>
              </Link>
            ) : (
              <Link to="/templates" className="block rounded-xl border border-gray-200 bg-white p-6 hover:border-blue-400">
                <FileText className="h-6 w-6 mb-4 text-blue-600" />
                <h2 className="text-lg font-semibold text-gray-900">Browse email designs</h2>
                <p className="mt-1 text-gray-600 text-sm">Find a previous design to use as a starting point.</p>
              </Link>
            )}
          </div>
          <section aria-labelledby="recent-drafts-heading">
            <div className="flex items-center justify-between mb-3">
              <h2 id="recent-drafts-heading" className="text-lg font-semibold text-gray-900">Recently saved</h2>
              <Link to="/templates" className="text-sm font-medium text-blue-700 hover:underline">All email designs</Link>
            </div>
            {loading || clientsLoading ? <p role="status" className="text-gray-500">Loading your drafts…</p> : error ? (
              <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
                <p>{error}</p><button onClick={() => setAttempt(a => a + 1)} className="mt-2 flex gap-2 items-center text-blue-700"><RefreshCw className="h-4 w-4" />Try again</button>
              </div>
            ) : drafts.length ? (
              <div className="divide-y divide-gray-100 border border-gray-200 bg-white rounded-xl overflow-hidden">
                {drafts.map(draft => <Link key={draft.id} to={`/email-builder?templateId=${draft.id}`} className="flex items-center justify-between gap-4 p-5 hover:bg-blue-50">
                  <div className="min-w-0"><p className="font-medium text-gray-900 truncate">{draft.name}</p><p className="text-sm text-gray-500 truncate">{draft.subject || 'No subject yet'}</p></div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-gray-400" />
                </Link>)}
              </div>
            ) : <p className="rounded-xl border border-dashed border-gray-300 p-8 text-gray-500">Your saved newsletters will appear here, including drafts created by email.</p>}
          </section>
        </>
      )}
    </div>
  )
}
