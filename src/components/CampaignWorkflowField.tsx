import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import Button from './ui/Button'

type Tracker = {
  id: string
  stage: string
  updated_at: string
  approval: { note: string; recorded_at: string } | null
}

const stages = [
  ['started', 'Started'],
  ['drafted', 'Drafted'],
  ['waiting_approval', 'Waiting for approval'],
  ['approved', 'Approved'],
]
const message = (error: unknown) => error && typeof error === 'object' && 'message' in error
  ? String(error.message) : 'Unable to update the workflow stage.'

export default function CampaignWorkflowField({ clientId, campaignId, deliveryStatus, hasUnsavedChanges }: {
  clientId: string
  campaignId?: string
  deliveryStatus?: string
  hasUnsavedChanges: boolean
}) {
  const [tracker, setTracker] = useState<Tracker | null>(null)
  const [stage, setStage] = useState('drafted')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(Boolean(campaignId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const automatic = ['scheduled', 'sending', 'sent'].includes(deliveryStatus || '')

  const load = useCallback(async () => {
    if (!campaignId) return
    setLoading(true); setError('')
    try {
      const result = await supabase.from('email_tracker_items')
        .select('id,stage,updated_at,approval').eq('client_id', clientId)
        .eq('campaign_id', campaignId).eq('is_legacy', false).single()
      if (result.error) throw result.error
      setTracker(result.data); setStage(result.data.stage)
    } catch (e) { setError(message(e)) }
    finally { setLoading(false) }
  }, [campaignId, clientId])

  useEffect(() => { void load() }, [load])

  async function save() {
    if (!tracker || saving || loading || automatic || hasUnsavedChanges || stage === tracker.stage) return
    setSaving(true); setError(''); setSaved(false)
    try {
      const result = await supabase.rpc('email_tracker_change', {
        p_client_id: clientId, p_action: 'stage', p_item_id: tracker.id,
        p_value: stage, p_note: note, p_expected_at: tracker.updated_at,
      })
      if (result.error) throw result.error
      // The stage was committed. Refresh its timestamp before another edit.
      setTracker(null)
      setNote(''); setSaved(true)
      await load()
    } catch (e) { setError(message(e)) }
    finally { setSaving(false) }
  }

  return <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
    <label htmlFor="campaign-workflow-stage" className="block text-sm font-medium text-gray-700">Workflow stage</label>
    <select id="campaign-workflow-stage" className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm disabled:text-gray-500"
      value={loading ? 'loading' : automatic ? deliveryStatus : stage}
      disabled={!campaignId || loading || saving || automatic || !tracker || hasUnsavedChanges}
      onChange={e => { setStage(e.target.value); setSaved(false) }}>
      {loading && <option value="loading">Loading workflow stage…</option>}
      {stages.map(([value, label]) => <option key={value} value={value}
        disabled={value === 'approved' && tracker?.stage !== 'waiting_approval' && tracker?.stage !== 'approved'}>{label}</option>)}
      {automatic && <option value={deliveryStatus}>{deliveryStatus === 'sent' ? 'Sent' : deliveryStatus === 'sending' ? 'Sending' : 'Scheduled'}</option>}
    </select>
    {!campaignId ? <p className="text-xs text-gray-600">New campaigns start at Drafted. Create the campaign to change its workflow stage.</p>
      : automatic ? <p className="text-xs text-gray-600">{deliveryStatus === 'scheduled' ? 'This stage follows the campaign’s delivery status automatically. To change preparation stages, first cancel its schedule and save.' : 'This stage follows the campaign’s delivery status automatically.'}</p>
        : hasUnsavedChanges ? <p className="text-xs text-gray-600">Save your campaign edits before changing its workflow stage, so approval covers the saved email.</p>
          : <p className="text-xs text-gray-600">Choose a stage and click Update stage. To approve, first save Waiting for approval. Stage changes do not send emails.</p>}
    {tracker?.approval && <p className="text-xs text-green-800">Approval: {tracker.approval.note}</p>}
    {campaignId && !automatic && tracker && stage !== tracker.stage && <>
      <label htmlFor="campaign-workflow-note" className="block text-sm font-medium text-gray-700">{stage === 'approved' ? 'Who approved it, and their approval note *' : 'Stage note (optional)'}</label>
      <textarea id="campaign-workflow-note" rows={2} value={note} onChange={e => setNote(e.target.value)}
        disabled={saving || hasUnsavedChanges} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
      <Button type="button" size="sm" disabled={loading || saving || hasUnsavedChanges || (stage === 'approved' && !note.trim())} onClick={() => void save()}>{saving ? 'Updating…' : 'Update stage'}</Button>
    </>}
    {error && <div role="alert" className="text-sm text-red-700">{error} <Button type="button" size="sm" variant="ghost" disabled={loading || saving} onClick={() => void load()}>Reload stage</Button></div>}
    {saved && !error && <p role="status" className="text-xs text-green-800">Workflow stage saved to the tracker history.</p>}
    {campaignId && <Link className="inline-block text-xs text-blue-700 underline" to={`/email-tracker?campaign=${campaignId}`}>View full tracker history</Link>}
  </div>
}
