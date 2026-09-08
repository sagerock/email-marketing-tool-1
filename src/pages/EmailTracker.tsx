import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useClient } from '../context/ClientContext'
import { supabase } from '../lib/supabase'
import Button from '../components/ui/Button'
import type { Campaign } from '../types'

type Item = {
  id: string; client_id: string; campaign_id: string | null; name: string; stage: string
  brief: string; planned_for: string | null; approval: { note: string; recorded_at: string } | null
  campaign_snapshot: { status: string; scheduled_at?: string; sent_at?: string } | null
  archived_at: string | null; is_legacy: boolean; import_id: string | null; source_period: string | null
  source_comment: string | null; source_author: string | null; source_created_at: string | null
  source_edited_at: string | null; reported_status: string | null; review_needed: boolean; updated_at: string
}
type Event = { id: string; kind: string; actor_label: string; note: string; details: Record<string, unknown>; occurred_at: string }
const stages = [
  ['started', 'Started'], ['drafted', 'Drafted'], ['waiting_approval', 'Waiting for approval'],
  ['approved', 'Approved'], ['scheduled', 'Scheduled'], ['sent', 'Sent'],
] as const
const label = (stage: string) => stages.find(s => s[0] === stage)?.[1] || stage.replaceAll('_', ' ')
const date = (value?: string | null) => value ? new Date(value).toLocaleString() : 'Not recorded'
const errorText = (e: unknown) => e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Unable to load the email tracker'
const fieldClass = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm'
function stageOf(item: Item, campaign?: Campaign) {
  const status = campaign?.status || item.campaign_snapshot?.status
  if (status === 'sent') return 'sent'
  if (status === 'scheduled' || status === 'sending') return 'scheduled'
  return item.stage
}

export default function EmailTracker() {
  const { selectedClient } = useClient()
  return selectedClient ? <TrackerWorkspace key={selectedClient.id} clientId={selectedClient.id} clientName={selectedClient.name} /> : <p>Select a client to see their email tracker.</p>
}

function TrackerWorkspace({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [params, setParams] = useSearchParams()
  const [items, setItems] = useState<Item[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'board' | 'list' | 'archive'>('board')
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [yearFilter, setYearFilter] = useState('')
  const [newName, setNewName] = useState('')
  const [newBrief, setNewBrief] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [note, setNote] = useState('')
  const [linkId, setLinkId] = useState('')
  const [planned, setPlanned] = useState('')
  const generation = useRef(0)
  const mounted = useRef(true)
  const selected = items.find(i => i.id === params.get('item') || (!params.has('item') && i.campaign_id === params.get('campaign') && !i.is_legacy))
  const selectedId = selected?.id
  const campaign = campaigns.find(c => c.id === selected?.campaign_id)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    try {
      // Range pagination avoids silently dropping older campaigns/archives.
      const rows: Item[] = []
      for (let from = 0; ; from += 500) {
        const result = await supabase.from('email_tracker_items').select('*').eq('client_id', clientId).order('updated_at', { ascending: false }).order('id').range(from, from + 499)
        if (result.error) throw result.error
        rows.push(...result.data)
        if (result.data.length < 500) break
      }
      const sends: Campaign[] = []
      for (let from = 0; ; from += 500) {
        const result = await supabase.from('campaigns').select('id,name,subject,status,template_id,scheduled_at,sent_at,recipient_count,sent_count,failed_count,send_error,filter_tags,created_at,client_id').eq('client_id', clientId).order('created_at', { ascending: false }).order('id').range(from, from + 499)
        if (result.error) throw result.error
        sends.push(...result.data as Campaign[])
        if (result.data.length < 500) break
      }
      if (mounted.current && request === generation.current) { setItems(rows); setCampaigns(sends); setError('') }
    } catch (e) { if (mounted.current && request === generation.current) setError(errorText(e)) }
    finally { if (mounted.current && request === generation.current) setLoading(false) }
  }, [clientId])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 30000)
    return () => { mounted.current = false; window.clearInterval(timer) }
  }, [refresh])
  useEffect(() => {
    setNote(''); setLinkId(''); setPlanned(selected?.planned_for || '')
  }, [selected?.id, selected?.planned_for])
  useEffect(() => {
    let alive = true
    setEvents([])
    if (!selectedId) return
    setHistoryLoading(true)
    void (async () => {
      try {
        const rows: Event[] = []
        for (let from = 0; ; from += 500) {
          const result = await supabase.from('email_tracker_events').select('*').eq('client_id', clientId).eq('item_id', selectedId).order('occurred_at', { ascending: false }).order('id').range(from, from + 499)
          if (result.error) throw result.error
          rows.push(...result.data)
          if (result.data.length < 500) break
        }
        if (alive) setEvents(rows)
      } catch (e) { if (alive) setError(errorText(e)) }
      finally { if (alive) setHistoryLoading(false) }
    })()
    return () => { alive = false }
  }, [selectedId, selected?.updated_at, clientId])

  async function change(action: string, value: string | null = null) {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await supabase.rpc('email_tracker_change', {
        p_client_id: clientId, p_action: action, p_item_id: action === 'create' ? null : selected?.id,
        p_value: value, p_note: action === 'create' ? newBrief : note,
        p_expected_at: action === 'create' ? null : selected?.updated_at,
      })
      if (result.error) throw result.error
      await refresh()
      if (result.data) setParams({ item: result.data })
      setNote(''); setShowCreate(false); setNewName(''); setNewBrief('')
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  async function downloadSource() {
    if (!selected?.import_id) return
    setBusy(true)
    try {
      const result = await supabase.from('email_tracker_imports').select('source_text,source_id').eq('id', selected.import_id).eq('client_id', clientId).single()
      if (result.error) throw result.error
      const url = URL.createObjectURL(new Blob([result.data.source_text], { type: 'application/json' }))
      const a = document.createElement('a'); a.href = url; a.download = `trello-${result.data.source_id}.json`; a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  const filtered = items.filter(i => {
    const archived = i.is_legacy || Boolean(i.archived_at)
    return (view === 'archive' ? archived : !archived)
      && (!stageFilter || stageOf(i, campaigns.find(c => c.id === i.campaign_id)) === stageFilter)
      && (!yearFilter || (i.source_period || i.source_created_at || '').includes(yearFilter))
      && `${i.name} ${i.brief} ${i.source_comment || ''} ${i.source_period || ''}`.toLowerCase().includes(search.toLowerCase())
  })
  const years = [...new Set(items.filter(i => i.is_legacy).map(i => (i.source_period?.match(/20\d{2}/)?.[0] || i.source_created_at?.slice(0, 4))).filter(Boolean))].sort().reverse()
  const open = (id: string) => setParams({ item: id })
  function itemCard(i: Item) {
    const c = campaigns.find(c => c.id === i.campaign_id)
    return <button key={i.id} onClick={() => open(i.id)} className="w-full rounded-lg border border-gray-200 bg-white p-4 text-left shadow-sm hover:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-600">
      <span className="block font-medium text-gray-900 break-words">{i.name}</span>
      <span className="mt-2 block text-xs text-gray-600">{i.is_legacy ? `${i.source_period || 'Historical note'} · ${i.reported_status}` : label(stageOf(i, c))}</span>
      {i.is_legacy && <span className="mt-1 block text-xs text-amber-800">{i.review_needed ? 'Needs review' : 'Reviewed'}</span>}
      {c?.scheduled_at && !i.is_legacy && <span className="mt-1 block text-xs text-gray-600">Scheduled: {date(c.scheduled_at)}</span>}
      {c?.sent_at && !i.is_legacy && <span className="mt-1 block text-xs text-gray-600">Sent: {date(c.sent_at)}</span>}
      {i.planned_for && <span className="mt-1 block text-xs text-gray-600">Target date: {i.planned_for}</span>}
      {(c?.status === 'failed' || (c?.failed_count || 0) > 0) && !i.is_legacy && <span className="mt-1 block text-xs font-medium text-red-700">Delivery issue{c?.failed_count ? ` · ${c.failed_count} failed` : ''}</span>}
    </button>
  }

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-bold text-gray-900">Email Tracker</h1><p className="mt-1 text-sm text-gray-600">{clientName} · Plans, approvals and sending history</p></div>
      <div className="flex gap-2"><Button variant="outline" onClick={() => void refresh()} disabled={busy}>Refresh</Button><Button onClick={() => setShowCreate(!showCreate)}>Start an email</Button></div>
    </div>
    {error && <div role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-800">{error}<Button variant="ghost" size="sm" onClick={() => void refresh()}>Retry</Button></div>}
    {showCreate && <form onSubmit={e => { e.preventDefault(); void change('create', newName) }} className="space-y-3 rounded-lg border bg-white p-5">
      <label className="block text-sm font-medium">Email name<input required maxLength={500} value={newName} onChange={e => setNewName(e.target.value)} className={fieldClass} /></label>
      <label className="block text-sm font-medium">Brief / idea<textarea value={newBrief} onChange={e => setNewBrief(e.target.value)} className={fieldClass} /></label>
      <Button disabled={busy || !newName.trim()} type="submit">Create plan</Button>
    </form>}
    {selected ? <section className="space-y-5 rounded-lg border bg-white p-6" aria-label="Email details">
      <Button variant="ghost" size="sm" onClick={() => setParams({})}>← Back to tracker</Button>
      <div><h2 className="text-xl font-semibold break-words">{selected.name}</h2><p className="mt-1 text-sm text-gray-600">{selected.is_legacy ? `${selected.reported_status} · ${selected.review_needed ? 'Needs review' : 'Reviewed'}` : label(stageOf(selected, campaign))}</p></div>
      {selected.brief && <p className="whitespace-pre-wrap break-words text-sm">{selected.brief}</p>}
      {campaign && <div className="space-y-2 rounded-md bg-gray-50 p-4 text-sm">
        <p className="font-medium">Linked campaign: {campaign.name}</p><p>{campaign.subject}</p>
        <p>Delivery: {campaign.status} · {campaign.recipient_count} recipients</p>
        <p>Scheduled for: {date(campaign.scheduled_at)} · Actual send: {date(campaign.sent_at)}</p>
        <p>Audience: {campaign.filter_tags?.length ? campaign.filter_tags.join(', ') : 'All eligible contacts'}</p>
        {((campaign.failed_count || 0) > 0 || campaign.status === 'failed') && <p className="text-red-700">Delivery issue: {campaign.send_error || `${campaign.failed_count || 0} failed recipients`}</p>}
        <div className="flex flex-wrap gap-4"><Link className="text-blue-700 underline" to={`/campaigns?campaign=${campaign.id}`}>Manage campaign / schedule</Link>{campaign.template_id && <Link className="text-blue-700 underline" to={`/email-builder?templateId=${campaign.template_id}`}>Open email design</Link>}</div>
      </div>}
      {!selected.is_legacy && <div className="space-y-3">
        {selected.approval && <p className="rounded-md bg-green-50 p-3 text-sm text-green-900">Approval recorded {date(selected.approval.recorded_at)}: {selected.approval.note}</p>}
        <label className="block text-sm font-medium">Target date (planning only)<input type="date" value={planned} onChange={e => setPlanned(e.target.value)} className={fieldClass} /></label>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void change('plan', planned)}>Save target date</Button>
      </div>}
      {(selected.is_legacy || !selected.campaign_id) && <div className="space-y-2">
        <label className="block text-sm font-medium">Link an existing campaign<select className={fieldClass} value={linkId} onChange={e => setLinkId(e.target.value)}><option value="">Choose a campaign…</option>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <Button variant="outline" size="sm" disabled={busy || !linkId} onClick={() => void change('link', linkId)}>Link campaign</Button>
        {!selected.is_legacy && <p className="text-sm text-gray-600">Create the design and campaign in the usual tools, then link it here. Your planning history stays available.</p>}
      </div>}
      <label className="block text-sm font-medium">Note / approval details<textarea aria-label="Note or approval details" value={note} onChange={e => setNote(e.target.value)} placeholder="For approval, record who approved it and their message." rows={3} className={fieldClass} /></label>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !note.trim()} onClick={() => void change('note')}>Add note</Button>
        {!selected.is_legacy && !['scheduled','sending','sent'].includes(campaign?.status || '') && <>
          {selected.stage !== 'drafted' && <Button variant="outline" disabled={busy} onClick={() => void change('stage', 'drafted')}>Mark drafted</Button>}
          {selected.stage === 'drafted' && <Button disabled={busy} onClick={() => void change('stage', 'waiting_approval')}>Request approval</Button>}
          {selected.stage === 'waiting_approval' && <Button disabled={busy || !note.trim() || !campaign} onClick={() => void change('stage', 'approved')}>Record approval</Button>}
        </>}
        {selected.is_legacy && selected.review_needed && <Button disabled={busy} onClick={() => void change('review')}>Mark reviewed</Button>}
        {!selected.is_legacy && <Button variant="ghost" disabled={busy || ['scheduled','sending'].includes(campaign?.status || '')} onClick={() => void change('archive', selected.archived_at ? 'restore' : 'archive')}>{selected.archived_at ? 'Restore to tracker' : 'Archive'}</Button>}
      </div>
      {selected.stage === 'waiting_approval' && !selected.is_legacy && <p className="text-xs text-gray-500">Request approval records the workflow stage. It does not send a message. Record an approval received by email or another channel above.</p>}
      {selected.is_legacy && <details className="rounded-md border p-4"><summary className="cursor-pointer font-medium">Original Trello comment</summary><p className="my-3 text-xs text-gray-600">{selected.source_author} · Comment created {date(selected.source_created_at)} · Last edited {date(selected.source_edited_at)}</p><p className="whitespace-pre-wrap break-words text-sm">{selected.source_comment}</p><p className="my-3 text-xs text-gray-600">Dates in the note are historical claims. The comment timestamp is not an approval or send date. Reviewing this entry does not mark a live campaign approved or sent.</p><Button variant="outline" size="sm" disabled={busy} onClick={() => void downloadSource()}>Download original JSON</Button></details>}
      <div><h3 className="mb-3 font-semibold">History</h3>{historyLoading ? <p>Loading history…</p> : events.length ? <ol className="space-y-4 border-l-2 border-gray-200 pl-4">{events.map(e => <li key={e.id} className="text-sm"><p className="font-medium">{label(e.kind)}{e.kind === 'delivery_changed' ? ` → ${String(e.details.status)}` : ''}</p><p className="text-xs text-gray-500">{date(e.occurred_at)} · {e.actor_label}</p>{e.note && <p className="mt-1 whitespace-pre-wrap break-words">{e.note}</p>}{e.details.scheduled_at ? <p>Scheduled for {date(String(e.details.scheduled_at))}</p> : null}{e.details.sent_at ? <p>Sent at {date(String(e.details.sent_at))}</p> : null}{e.details.planned_for ? <p>Target date: {String(e.details.planned_for)}</p> : null}{typeof e.details.plan_id === 'string' && <Link className="text-blue-700 underline" to={`/email-tracker?item=${e.details.plan_id}`}>View original planning history</Link>}{typeof e.details.tracker_id === 'string' && <Link className="text-blue-700 underline" to={`/email-tracker?item=${e.details.tracker_id}`}>View linked tracker</Link>}</li>)}</ol> : <p className="text-sm text-gray-500">{selected.is_legacy ? 'Imported from Trello. Original history is preserved in the source JSON.' : 'No history recorded yet.'}</p>}</div>
    </section> : <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1" aria-label="Tracker view">{(['board','list','archive'] as const).map(v => <Button key={v} size="sm" variant={view === v ? 'primary' : 'outline'} aria-pressed={view === v} onClick={() => { setView(v); setStageFilter(''); setYearFilter('') }}>{v === 'archive' ? 'Archive' : v === 'board' ? 'Board' : 'List'}</Button>)}</div>
        <input type="search" aria-label="Search emails and history" placeholder="Search emails, notes, audiences…" value={search} onChange={e => setSearch(e.target.value)} className={`${fieldClass} max-w-sm`} />
        {view !== 'archive' ? <select aria-label="Filter by stage" value={stageFilter} onChange={e => setStageFilter(e.target.value)} className={`${fieldClass} max-w-xs`}><option value="">All stages</option>{stages.map(([s,l]) => <option key={s} value={s}>{l}</option>)}</select> : <select aria-label="Filter archive by year" value={yearFilter} onChange={e => setYearFilter(e.target.value)} className={`${fieldClass} max-w-xs`}><option value="">All years</option>{years.map(y => <option key={y} value={y}>{y}</option>)}</select>}
      </div>
      {view === 'archive' && <p className="text-sm text-gray-600">Historical Trello notes and archived plans. Imported statuses are reported from the source; review entries before relying on them as confirmed send records.</p>}
      {loading ? <p>Loading tracker…</p> : view === 'board' ? <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{stages.filter(([s]) => !stageFilter || stageFilter === s).map(([s,l]) => { const group = filtered.filter(i => stageOf(i, campaigns.find(c => c.id === i.campaign_id)) === s); return <section key={s} className="min-w-0 rounded-lg bg-gray-100 p-3"><h2 className="mb-3 flex justify-between text-sm font-semibold">{l}<span className="text-gray-500">{group.length}</span></h2><div className="space-y-3">{group.map(itemCard)}{!group.length && <p className="py-3 text-sm text-gray-500">No emails here</p>}</div></section> })}</div> : <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{filtered.map(itemCard)}{!filtered.length && <p className="text-gray-500">No matching emails.</p>}</div>}
      <p className="text-xs text-gray-500">{filtered.length} entries · Delivery status refreshes every 30 seconds. Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
    </>}
  </div>
}
