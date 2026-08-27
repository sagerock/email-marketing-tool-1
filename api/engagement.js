// ============ ENGAGEMENT API ============
// Backs the Engagement page: "who came in, from where, who replied, who's waiting
// on a human, what's in the Salesforce pipeline." All aggregation is in the
// engagement_overview() SQL function (migration 083); this is a thin, client-scoped
// wrapper. Routes live under /api so authenticateUser + validateClientAccess apply
// automatically (client_admin users are force-scoped to their own client).

module.exports = function mountEngagement(app, { supabase }) {
  // GET /api/engagement/overview?clientId=&days=30&waitDays=3
  app.get('/api/engagement/overview', async (req, res) => {
    try {
      const clientId = req.query.clientId
      if (!clientId) return res.status(400).json({ error: 'clientId required' })
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365)
      const waitDays = Math.min(Math.max(parseInt(req.query.waitDays, 10) || 3, 0), 60)
      const { data, error } = await supabase.rpc('engagement_overview', {
        p_client_id: clientId, p_days: days, p_wait_days: waitDays,
      })
      if (error) throw error
      res.json(data)
    } catch (err) {
      console.error('❌ engagement/overview:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/engagement/contact/:id?clientId=  — full timeline for one contact
  app.get('/api/engagement/contact/:id', async (req, res) => {
    try {
      const clientId = req.query.clientId
      if (!clientId) return res.status(400).json({ error: 'clientId required' })
      const { data: contact, error: cErr } = await supabase
        .from('contacts').select('*').eq('id', req.params.id).eq('client_id', clientId).single()
      if (cErr || !contact) return res.status(404).json({ error: 'contact not found' })

      const [events, conversations, opps] = await Promise.all([
        supabase.from('analytics_events')
          .select('event_type, timestamp, url, campaign_id, campaign:campaigns!inner(name, client_id)')
          .eq('email', contact.email).eq('campaign.client_id', clientId)
          .order('timestamp', { ascending: false }).limit(300),
        supabase.from('email_conversations')
          .select('id, direction, subject, body, ai_generated, created_at')
          .eq('contact_id', contact.id).order('created_at', { ascending: false }).limit(100),
        supabase.from('salesforce_opportunities')
          .select('salesforce_id, name, stage, is_closed, owner_name, sf_created_date, close_date, last_stage_change, last_activity_date, sample_shipped_at')
          .eq('client_id', clientId)
          .or(contact.salesforce_id ? `sf_contact_id.eq.${contact.salesforce_id},contact_email.eq.${contact.email}` : `contact_email.eq.${contact.email}`)
          .order('sf_created_date', { ascending: false }),
      ])

      const timeline = []
      for (const e of events.data || []) timeline.push({ at: e.timestamp, kind: e.event_type, label: e.campaign?.name || null, detail: e.url || null })
      for (const c of conversations.data || []) timeline.push({ at: c.created_at, kind: c.direction === 'inbound' ? 'reply' : (c.ai_generated ? 'ai_sent' : 'sent_by_us'), label: c.subject, detail: (c.body || '').slice(0, 400) })
      for (const o of opps.data || []) {
        timeline.push({ at: o.sf_created_date, kind: 'opportunity', label: `${o.name} (${o.stage})`, detail: o.owner_name })
        if (o.sample_shipped_at) timeline.push({ at: o.sample_shipped_at, kind: 'sample_shipped', label: o.name, detail: o.owner_name })
      }
      if (contact.salesforce_created_date) timeline.push({ at: contact.salesforce_created_date, kind: 'arrived', label: contact.source_code || '(no source code)', detail: contact.record_type })
      if (contact.salesforce_last_activity_date) timeline.push({ at: contact.salesforce_last_activity_date, kind: 'sf_activity', label: 'Last Salesforce activity', detail: null })
      timeline.sort((a, b) => new Date(b.at) - new Date(a.at))

      // Source-code history: "CODE @ timestamp" lines from Salesforce
      const history = String(contact.source_code_history || '')
        .split(/\r?\n/).map(l => l.trim()).filter(Boolean)
        .map(l => { const [code, at] = l.split(' @ '); return { code: (code || '').trim(), at: (at || '').trim() || null } })

      res.json({ contact, timeline, sourceHistory: history, opportunities: opps.data || [] })
    } catch (err) {
      console.error('❌ engagement/contact:', err.message)
      res.status(500).json({ error: err.message })
    }
  })
}
