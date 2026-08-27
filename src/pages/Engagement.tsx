import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useClient } from '../context/ClientContext'
import { apiFetch } from '../lib/api'
import { Card, CardContent } from '../components/ui/Card'
import Badge from '../components/ui/Badge'
import { cn } from '../lib/utils'
import {
  Inbox, MessageSquare, Clock, Flame, Briefcase, AlertTriangle, Loader2, RefreshCw,
} from 'lucide-react'

// One page that answers: who came in (and from where), who replied, who is waiting
// on a human, what's in the Salesforce pipeline, and who is most engaged.
// Data: GET /api/engagement/overview (SQL fn engagement_overview, migration 083).

type Totals = {
  arrivals: number; replies: number; engaged: number
  form_leads: number; form_leads_uncontacted: number; form_leads_replied: number; form_leads_contacted: number; form_leads_auto: number; form_leads_new: number; form_submissions: number
  open_opps: number; stalled: number; opps_synced_at: string | null; contacts_synced_at: string | null
}
type FormLead = Person & {
  last_form: string; forms: string; last_form_on: string; first_form_on: string; forms_in_window: number
  opens_since_form: number; clicks_since_form: number; our_reply_at: string | null; sf_touched: boolean; open_opps: number
  auto_followups: number; last_auto_followup_at: string | null
  status: 'replied, no response' | 'not contacted' | 'auto follow-up only' | 'new' | 'contacted'
}
type Person = {
  id: string; email: string; first_name: string | null; last_name: string | null; company: string | null
  source_code: string | null; record_type?: string; industry?: string | null
  salesforce_created_date?: string | null; salesforce_last_activity_date?: string | null; salesforce_lead_status?: string | null
  last_engaged_at?: string | null; last_replied_at?: string | null
  engagement_score?: number; total_opens?: number; total_clicks?: number
  reason?: string; last_inbound?: string; last_our_reply?: string | null
}
type Reply = {
  id: string; created_at: string; subject: string | null; body: string; contact_id: string | null
  email: string; first_name: string | null; last_name: string | null; company: string | null
  source_code: string | null; salesforce_last_activity_date: string | null; answered_at: string | null
}
type Opp = {
  salesforce_id: string; name: string; stage: string; owner_name: string | null; contact_email: string | null
  sf_created_date: string | null; last_stage_change: string | null; last_activity_date: string | null
  sample_shipped_at: string | null; last_touch: string | null
}
type Overview = {
  days: number; totals: Totals
  sources: { source: string; n: number }[]
  forms: { form: string; n: number; people: number }[]
  form_leads: FormLead[]
  arrivals: Person[]; replies: Reply[]
  pipeline: { stage: string; n: number }[]; stalled: Opp[]; engaged: Person[]
}

type Tab = 'forms' | 'replies' | 'arrivals' | 'pipeline' | 'engaged'

const DAY_OPTIONS = [7, 14, 30, 60, 90]

export default function Engagement() {
  const { selectedClient } = useClient()
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('forms')

  const load = async () => {
    if (!selectedClient) return
    setLoading(true); setError(null)
    try {
      const res = await apiFetch(`/api/engagement/overview?clientId=${selectedClient.id}&days=${days}`)
      if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      setData(await res.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [selectedClient, days]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!selectedClient) return <div className="p-8 text-gray-500">Select a client.</div>

  const t = data?.totals

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Engagement</h1>
          <p className="text-sm text-gray-500 mt-1">
            Who came in, where from, who replied, and who is waiting on a person.
            {t?.contacts_synced_at && <> Salesforce synced {relTime(t.contacts_synced_at)}.</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {DAY_OPTIONS.map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={cn('px-3 py-1.5 text-sm', d === days ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50')}>
                {d}d
              </button>
            ))}
          </div>
          <button onClick={load} className="p-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50" title="Refresh">
            <RefreshCw className={cn('h-4 w-4 text-gray-600', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Stat icon={<Clock className="h-5 w-5 text-amber-600" />} label={`Form leads, ${days}d`} value={t?.form_leads ?? '–'} sub={t ? `${t.form_leads_uncontacted} not contacted · ${t.form_leads_auto} auto only${t.form_leads_replied ? ` · ${t.form_leads_replied} replied, no response` : ''}` : undefined} active={tab === 'forms'} onClick={() => setTab('forms')} />
        <Stat icon={<MessageSquare className="h-5 w-5 text-blue-600" />} label={`Replies, ${days}d`} value={t?.replies ?? '–'} active={tab === 'replies'} onClick={() => setTab('replies')} />
        <Stat icon={<Inbox className="h-5 w-5 text-green-600" />} label={`New contacts, ${days}d`} value={t?.arrivals ?? '–'} active={tab === 'arrivals'} onClick={() => setTab('arrivals')} />
        <Stat icon={<Briefcase className="h-5 w-5 text-purple-600" />} label="Open opportunities" value={t?.open_opps ?? '–'} sub={t?.stalled ? `${t.stalled} stalled 14d+` : undefined} active={tab === 'pipeline'} onClick={() => setTab('pipeline')} />
        <Stat icon={<Flame className="h-5 w-5 text-red-600" />} label={`Engaged, ${days}d`} value={t?.engaged ?? '–'} active={tab === 'engaged'} onClick={() => setTab('engaged')} />
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 text-gray-500 p-8"><Loader2 className="h-5 w-5 animate-spin" /> Loading…</div>
      ) : data && (
        <>
          {tab === 'forms' && <FormLeadsTab rows={data.form_leads} forms={data.forms} totals={data.totals} />}
          {tab === 'replies' && <RepliesTab rows={data.replies} />}
          {tab === 'arrivals' && <ArrivalsTab rows={data.arrivals} sources={data.sources} />}
          {tab === 'pipeline' && <PipelineTab pipeline={data.pipeline} stalled={data.stalled} syncedAt={data.totals.opps_synced_at} />}
          {tab === 'engaged' && <EngagedTab rows={data.engaged} />}
        </>
      )}
    </div>
  )
}

// ---------- tabs ----------

type LeadFilter = 'all' | 'not contacted' | 'auto follow-up only' | 'replied, no response' | 'new' | 'contacted'

function FormLeadsTab({ rows, forms, totals }: { rows: FormLead[]; forms: { form: string; n: number; people: number }[]; totals: Totals }) {
  const [filter, setFilter] = useState<LeadFilter>('all')
  const [formFilter, setFormFilter] = useState<string | null>(null)
  const shown = rows
    .filter(r => filter === 'all' || r.status === filter)
    .filter(r => !formFilter || r.forms.split(', ').includes(formFilter))
  const chips: { key: LeadFilter; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: totals.form_leads },
    { key: 'not contacted', label: 'Not contacted', n: totals.form_leads_uncontacted },
    { key: 'auto follow-up only', label: 'Auto follow-up only', n: totals.form_leads_auto },
    { key: 'replied, no response', label: 'Replied, no response', n: totals.form_leads_replied },
    { key: 'new', label: 'New (last few days)', n: totals.form_leads_new },
    { key: 'contacted', label: 'Contacted', n: totals.form_leads_contacted },
  ]
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Form submissions <span className="text-gray-400 font-normal">({totals.form_submissions} from {totals.form_leads} people)</span></h3>
          <div className="flex flex-wrap gap-2">
            {forms.map(f => {
              const active = formFilter === f.form
              return (
                <button key={f.form} onClick={() => setFormFilter(active ? null : f.form)} title={active ? 'Show all forms' : `Show only ${f.form}`}
                  className={cn('flex items-center gap-2 rounded-lg px-3 py-1.5 border transition', active ? 'bg-gray-900 border-gray-900' : 'bg-gray-50 border-transparent hover:border-gray-300')}>
                  <span className={cn('text-sm', active ? 'text-white' : 'text-gray-800')}>{f.form}</span>
                  <span className={cn('text-sm font-semibold', active ? 'text-white' : 'text-gray-900')}>{f.n}</span>
                  {f.people !== f.n && <span className={cn('text-xs', active ? 'text-gray-300' : 'text-gray-400')}>{f.people} people</span>}
                </button>
              )
            })}
            {formFilter && (
              <button onClick={() => setFormFilter(null)} className="text-xs text-gray-500 underline px-1">show all forms</button>
            )}
          </div>
        </CardContent>
      </Card>
      <Section
        title="People who filled out a form"
        blurb="Each person's latest form, what they did with our emails since, and whether anyone at the company has logged activity on them in Salesforce since the form. 'Auto follow-up only' = our automated email went out but no person has touched them. Urgent first, then most engaged."
        empty="No form submissions in this window."
        count={shown.length}
        controls={
          <div className="flex flex-wrap gap-1">
            {chips.map(c => (
              <button key={c.key} onClick={() => setFilter(c.key)}
                className={cn('px-2.5 py-1 rounded-full text-xs border', filter === c.key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50')}>
                {c.label} <span className={filter === c.key ? 'text-gray-300' : 'text-gray-400'}>{c.n}</span>
              </button>
            ))}
          </div>
        }
      >
        <Table head={['Person', 'Form', 'Filled out', 'Status', 'Since the form', 'Salesforce touch', 'Open opps']}>
          {shown.map(r => (
            <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
              <td className="py-2.5 px-4"><PersonCell p={r} /></td>
              <td className="py-2.5 px-4 text-sm text-gray-800">
                {r.last_form}
                {r.forms_in_window > 1 && <div className="text-xs text-gray-400">{r.forms_in_window} submissions: {r.forms}</div>}
              </td>
              <td className="py-2.5 px-4 text-sm text-gray-900 whitespace-nowrap">{fmtDate(r.last_form_on)} <span className="text-gray-400">({relTime(r.last_form_on)})</span></td>
              <td className="py-2.5 px-4"><StatusBadge status={r.status} /></td>
              <td className="py-2.5 px-4 text-sm text-gray-600 whitespace-nowrap">
                {r.opens_since_form} opens · {r.clicks_since_form} clicks{r.last_replied_at && r.last_replied_at >= r.last_form_on ? ' · replied' : ''}
                {r.auto_followups > 0 && <div className="text-xs text-gray-400">{r.auto_followups} auto follow-up{r.auto_followups === 1 ? '' : 's'} sent, last {relTime(r.last_auto_followup_at)}</div>}
              </td>
              <td className="py-2.5 px-4 text-sm text-gray-600 whitespace-nowrap">
                {r.salesforce_last_activity_date ? fmtDate(r.salesforce_last_activity_date) : 'never'}
                {r.our_reply_at && <div className="text-xs text-gray-400">we replied {relTime(r.our_reply_at)}</div>}
              </td>
              <td className="py-2.5 px-4 text-sm text-gray-600">{r.open_opps || '–'}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  )
}

function StatusBadge({ status }: { status: FormLead['status'] }) {
  const v = status === 'replied, no response' ? 'danger' : status === 'not contacted' ? 'warning' : status === 'auto follow-up only' ? 'default' : status === 'new' ? 'info' : 'success'
  return <Badge variant={v}>{status}</Badge>
}

function RepliesTab({ rows }: { rows: Reply[] }) {
  return (
    <Section title="Replies" blurb="Inbound email replies to campaigns, newest first." empty="No replies in this window." count={rows.length}>
      <div className="divide-y divide-gray-100">
        {rows.map(r => (
          <div key={r.id} className="py-3 px-4 flex gap-4">
            <div className="w-56 shrink-0">
              {r.contact_id
                ? <Link to={`/contacts/${r.contact_id}`} className="text-sm font-medium text-blue-700 hover:underline">{name(r) || r.email}</Link>
                : <span className="text-sm font-medium text-gray-900">{r.email || '(unknown sender)'}</span>}
              {r.company && <div className="text-xs text-gray-500">{r.company}</div>}
              <div className="text-xs text-gray-400 mt-1">{relTime(r.created_at)}</div>
              <div className="mt-1">
                {r.answered_at
                  ? <Badge variant="success">answered</Badge>
                  : r.salesforce_last_activity_date && r.salesforce_last_activity_date >= r.created_at.slice(0, 10)
                    ? <Badge variant="info">Salesforce activity</Badge>
                    : <Badge variant="danger">unanswered</Badge>}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{r.subject || '(no subject)'}</div>
              <div className="text-sm text-gray-600 mt-1 whitespace-pre-line line-clamp-4">{stripMeta(r.body)}</div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function ArrivalsTab({ rows, sources }: { rows: Person[]; sources: { source: string; n: number }[] }) {
  const total = sources.reduce((a, s) => a + s.n, 0) || 1
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Where they came from</h3>
          <div className="flex flex-wrap gap-2">
            {sources.map(s => (
              <div key={s.source} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-1.5">
                <span className="text-sm text-gray-800">{s.source}</span>
                <span className="text-sm font-semibold text-gray-900">{s.n}</span>
                <span className="text-xs text-gray-400">{Math.round(100 * s.n / total)}%</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Section title="New contacts" blurb="By Salesforce created date, newest first. Source = Salesforce source code." empty="No new contacts in this window." count={rows.length}>
        <Table head={['Person', 'Source', 'Arrived', 'Type', 'Opens / clicks', 'Last engaged', 'Last Salesforce touch']}>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
              <td className="py-2.5 px-4"><PersonCell p={r} /></td>
              <td className="py-2.5 px-4 text-sm text-gray-800">{r.source_code || <span className="text-gray-400">none</span>}</td>
              <td className="py-2.5 px-4 text-sm text-gray-900 whitespace-nowrap">{fmtDate(r.salesforce_created_date)}</td>
              <td className="py-2.5 px-4 text-sm text-gray-600">{r.record_type}{r.salesforce_lead_status ? ` · ${r.salesforce_lead_status}` : ''}</td>
              <td className="py-2.5 px-4 text-sm text-gray-600">{r.total_opens ?? 0} / {r.total_clicks ?? 0}</td>
              <td className="py-2.5 px-4 text-sm text-gray-600 whitespace-nowrap">{r.last_engaged_at ? relTime(r.last_engaged_at) : '–'}</td>
              <td className="py-2.5 px-4 text-sm text-gray-600 whitespace-nowrap">{r.salesforce_last_activity_date ? fmtDate(r.salesforce_last_activity_date) : 'never'}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  )
}

function PipelineTab({ pipeline, stalled, syncedAt }: { pipeline: { stage: string; n: number }[]; stalled: Opp[]; syncedAt: string | null }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900">Open opportunities by stage</h3>
            <span className="text-xs text-gray-400">{syncedAt ? `Salesforce opps synced ${relTime(syncedAt)}` : 'Opportunities not synced yet'}</span>
          </div>
          {pipeline.length === 0 ? <p className="text-sm text-gray-500">Nothing open.</p> : (
            <div className="flex flex-wrap gap-2">
              {pipeline.map(p => (
                <div key={p.stage} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-1.5">
                  <span className="text-sm text-gray-800">{p.stage}</span>
                  <span className="text-sm font-semibold text-gray-900">{p.n}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Section title="Stalled opportunities" blurb="Open in Salesforce with no activity or stage change in 14+ days. Newest first." empty="No stalled opportunities." count={stalled.length}>
        <Table head={['Opportunity', 'Stage', 'Owner', 'Contact', 'Last touch', 'Sample shipped']}>
          {stalled.map(o => (
            <tr key={o.salesforce_id} className="border-t border-gray-100 hover:bg-gray-50">
              <td className="py-2.5 px-4 text-sm text-gray-900">{o.name}</td>
              <td className="py-2.5 px-4"><Badge>{o.stage}</Badge></td>
              <td className="py-2.5 px-4 text-sm text-gray-600">{o.owner_name || '–'}</td>
              <td className="py-2.5 px-4 text-sm text-gray-600">{o.contact_email || '–'}</td>
              <td className="py-2.5 px-4 text-sm text-gray-900 whitespace-nowrap">{o.last_touch ? `${fmtDate(o.last_touch)} (${relTime(o.last_touch)})` : '–'}</td>
              <td className="py-2.5 px-4 text-sm text-gray-600 whitespace-nowrap">{o.sample_shipped_at ? fmtDate(o.sample_shipped_at) : '–'}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  )
}

function EngagedTab({ rows }: { rows: Person[] }) {
  return (
    <Section title="Most engaged" blurb="Opens + 2×clicks, among people who engaged in this window." empty="No engagement in this window." count={rows.length}>
      <Table head={['Person', 'Score', 'Opens', 'Clicks', 'Last engaged', 'Replied', 'Source', 'Last Salesforce touch']}>
        {rows.map(r => (
          <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
            <td className="py-2.5 px-4"><PersonCell p={r} /></td>
            <td className="py-2.5 px-4 text-sm font-semibold text-gray-900">{r.engagement_score}</td>
            <td className="py-2.5 px-4 text-sm text-gray-600">{r.total_opens}</td>
            <td className="py-2.5 px-4 text-sm text-gray-600">{r.total_clicks}</td>
            <td className="py-2.5 px-4 text-sm text-gray-600 whitespace-nowrap">{relTime(r.last_engaged_at)}</td>
            <td className="py-2.5 px-4 text-sm text-gray-600 whitespace-nowrap">{r.last_replied_at ? relTime(r.last_replied_at) : '–'}</td>
            <td className="py-2.5 px-4 text-sm text-gray-600">{r.source_code || '–'}</td>
            <td className="py-2.5 px-4 text-sm text-gray-600 whitespace-nowrap">{r.salesforce_last_activity_date ? fmtDate(r.salesforce_last_activity_date) : 'never'}</td>
          </tr>
        ))}
      </Table>
    </Section>
  )
}

// ---------- bits ----------

function Stat({ icon, label, value, sub, active, onClick }: { icon: React.ReactNode; label: string; value: string | number; sub?: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn('text-left rounded-xl border bg-white p-4 flex items-center gap-3 transition', active ? 'border-blue-500 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300')}>
      <div className="p-2 bg-gray-50 rounded-lg">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 uppercase tracking-wide truncate">{label}</p>
        <p className="text-lg font-semibold text-gray-900">{value}</p>
        {sub && <p className="text-xs text-amber-600">{sub}</p>}
      </div>
    </button>
  )
}

function Section({ title, blurb, empty, count, controls, children }: { title: string; blurb: string; empty: string; count: number; controls?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{title} <span className="text-gray-400 font-normal">({count})</span></h3>
            <p className="text-xs text-gray-500 mt-0.5">{blurb}</p>
          </div>
          {controls}
        </div>
        {count === 0 ? <p className="p-6 text-sm text-gray-500">{empty}</p> : <div className="overflow-x-auto">{children}</div>}
      </CardContent>
    </Card>
  )
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full">
      <thead className="bg-gray-50">
        <tr>{head.map(h => <th key={h} className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide py-2 px-4 whitespace-nowrap">{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

function PersonCell({ p }: { p: Person }) {
  return (
    <div>
      <Link to={`/contacts/${p.id}`} className="text-sm font-medium text-blue-700 hover:underline">{name(p) || p.email}</Link>
      <div className="text-xs text-gray-500">{[p.company, name(p) ? p.email : null].filter(Boolean).join(' · ')}</div>
    </div>
  )
}

function name(p: { first_name: string | null; last_name: string | null }) {
  return [p.first_name, p.last_name].filter(Boolean).join(' ')
}

function stripMeta(body: string) {
  // campaign-replies.js prefixes "[ref:…] [message-id:…]" lines; hide them here
  return body.replace(/^(\[[^\]]+\]\s*)+\n*/, '')
}

function fmtDate(s?: string | null) {
  if (!s) return '–'
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function relTime(s?: string | null) {
  if (!s) return '–'
  const ms = Date.now() - new Date(s).getTime()
  if (isNaN(ms)) return s
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 60) return `${d}d ago`
  return `${Math.round(d / 30)}mo ago`
}
