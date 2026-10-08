// "Describe who should get this": plain words in, the campaign form's
// recipient filters out (POST /api/campaigns/audience-from-text). It only
// fills the filters below it; the user still sees them and the live count,
// and nothing is saved or sent from here.
import { useState } from 'react'
import { Loader2, Sparkles, Undo2 } from 'lucide-react'
import { apiFetch } from '../lib/api'

export interface AudienceFilters {
  filter_tags: string[]
  audience_filter: string[]
  salesforce_campaign_id: string
  purchase_filter: {
    min_spend: string
    min_orders: string
    recency_mode: 'any' | 'within' | 'lapsed'
    recency_days: string
    product_mode: 'any' | 'purchased' | 'not_purchased'
    product_skus: string[]
  }
}

interface Result {
  explanation: string
  not_possible: string
  ignored: string[]
}

interface Props {
  clientId: string
  products: { sku: string; name: string }[]
  current: AudienceFilters
  onApply: (filters: AudienceFilters) => void
}

export default function AudienceFromText({ clientId, products, current, onApply }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [previous, setPrevious] = useState<AudienceFilters | null>(null)

  const run = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await apiFetch('/api/campaigns/audience-from-text', {
        method: 'POST',
        body: JSON.stringify({ clientId, text, products: products.map(p => ({ sku: p.sku, name: p.name })) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'That didn’t work. Try again, or set the filters below by hand.')
      setPrevious(current)
      onApply(body.filters)
      setResult({ explanation: body.explanation, not_possible: body.not_possible, ignored: body.ignored || [] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work. Try again, or set the filters below by hand.')
    } finally {
      setBusy(false)
    }
  }

  const undo = () => {
    if (!previous) return
    onApply(previous)
    setPrevious(null)
    setResult(null)
  }

  return (
    <div className="rounded-md border border-blue-200 bg-blue-50/60 p-3">
      <label htmlFor="audience-text" className="block text-sm font-medium text-gray-800 mb-1">
        Describe who should get this
      </label>
      <div className="flex gap-2">
        <input
          id="audience-text"
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void run() } }}
          placeholder="e.g. customers we met at Pittcon, or people who downloaded the handbook"
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          maxLength={1000}
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={!text.trim() || busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Set filters
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      {result && (
        <div role="status" className="mt-2 space-y-1.5 text-sm">
          <p className="text-gray-800">{result.explanation} <span className="text-gray-500">Check the filters and count below before saving.</span></p>
          {result.not_possible && (
            <p className="rounded bg-amber-100 px-2 py-1.5 text-amber-900"><strong>Not included:</strong> {result.not_possible}</p>
          )}
          {result.ignored.length > 0 && (
            <p className="text-xs text-gray-500">Left out because they don’t exist here: {result.ignored.join(', ')}</p>
          )}
          {previous && (
            <button type="button" onClick={undo} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900">
              <Undo2 className="h-3.5 w-3.5" /> Put the filters back the way they were
            </button>
          )}
        </div>
      )}
    </div>
  )
}
