// ============ AI FOLLOW-UPS FROM MEMBER DOWNLOADS ============
// alconox.com's member-download pages no longer post Gravity Forms webhooks.
// Each download instead lands in Salesforce as a Prospect_Activity__c
// (Channel = Resource Download) and is synced into salesforce_prospect_activities.
// This module turns those synced rows into enrollments in the existing AI
// follow-up agents, through the same enroll + generate path the Gravity webhook
// uses, so the email content and cadence are unchanged. Only the trigger moved.
//
// Routing: ai_followup_config.trigger_download_resource is either an exact
// Source_Detail__c value or '*' (catch-all for anything without a specific
// agent). Nothing enrolls until download_trigger_since is set on the agent, and
// only activities after that cutover are eligible (no backfill).
//
// Idempotency: every Resource Download row is processed exactly once and the
// outcome is written back to the row (followup_processed_at plus either the
// enrollment id or a skip reason). The (config, contact) UNIQUE constraint on
// ai_followup_contacts still guarantees one sequence per person per agent.

const DOWNLOAD_CHANNEL = 'Resource Download'
const CATCH_ALL = '*'
const INTERNAL_TAG = 'Alconox Internal'
const INTERNAL_DOMAINS = ['alconox.com']
const SPACING_HOURS = 72
const DEFAULT_LEASE_SECONDS = 900
const BATCH = 200

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim()
}

function isInternalEmail(email) {
  const domain = normalizeEmail(email).split('@')[1] || ''
  return INTERNAL_DOMAINS.includes(domain)
}

// Pick the agent for a resource name: exact match first, then the catch-all.
function routeResource(configs, sourceDetail) {
  const detail = String(sourceDetail || '').trim()
  const exact = detail && configs.find(c => c.trigger_download_resource && c.trigger_download_resource !== CATCH_ALL
    && c.trigger_download_resource.trim().toLowerCase() === detail.toLowerCase())
  return exact || configs.find(c => c.trigger_download_resource === CATCH_ALL) || null
}

// The form-submission shape the generate endpoint already reads for context.
function downloadSubmission(activity) {
  const fields = {}
  if (activity.source_detail) fields.Resource = activity.source_detail
  if (activity.web_page) fields.Page = activity.web_page
  return {
    form_name: 'Member Download',
    submitted_at: activity.touchpoint_at || new Date().toISOString(),
    source: 'salesforce_prospect_activity',
    salesforce_activity_id: activity.salesforce_id,
    fields,
  }
}

async function loadDownloadConfigs(supabase, clientId) {
  const { data, error } = await supabase
    .from('ai_followup_config')
    .select('id, name, enabled, trigger_download_resource, download_trigger_since, followup_delays')
    .eq('client_id', clientId)
    .not('trigger_download_resource', 'is', null)
  if (error) throw new Error(`Download-trigger config lookup failed: ${error.message}`)
  return data || []
}

async function loadPendingDownloads(supabase, clientId, limit) {
  const { data, error } = await supabase
    .from('salesforce_prospect_activities')
    .select('id, salesforce_id, source_detail, web_page, touchpoint_at, email, sf_lead_id, sf_contact_id')
    .eq('client_id', clientId)
    .eq('channel', DOWNLOAD_CHANNEL)
    .is('followup_processed_at', null)
    .order('touchpoint_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`Pending download lookup failed: ${error.message}`)
  return data || []
}

async function loadContact(supabase, clientId, email) {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, email, unsubscribed, bounce_status, tags, form_submissions')
    .eq('client_id', clientId)
    .eq('email', email)
    .maybeSingle()
  if (error) throw new Error(`Contact lookup failed: ${error.message}`)
  return data || null
}

// True when this person already has AI email traffic that the scheduler's
// spacing rules would hold back: a send in the last 72 hours or another live
// enrollment holding a lease. In that case the new enrollment is left due now
// and the scheduler (which enforces spacing) sends step 1 instead of us.
async function contactNeedsSpacing(supabase, clientId, contactId, leaseSeconds) {
  const sinceIso = new Date(Date.now() - SPACING_HOURS * 3600 * 1000).toISOString()
  const { data: recent, error: recentError } = await supabase
    .from('ai_followup_drafts')
    .select('id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .eq('status', 'sent')
    .gt('sent_at', sinceIso)
    .limit(1)
  if (recentError) throw new Error(`Spacing lookup failed: ${recentError.message}`)
  if (recent && recent.length) return true

  const nowIso = new Date().toISOString()
  const horizonIso = new Date(Date.now() + leaseSeconds * 1000).toISOString()
  const { data: leased, error: leasedError } = await supabase
    .from('ai_followup_contacts')
    .select('id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .eq('status', 'in_progress')
    .gt('next_followup_at', nowIso)
    .lte('next_followup_at', horizonIso)
    .limit(1)
  if (leasedError) throw new Error(`Lease lookup failed: ${leasedError.message}`)
  return Boolean(leased && leased.length)
}

async function markProcessed(supabase, activityId, patch) {
  const { error } = await supabase
    .from('salesforce_prospect_activities')
    .update({ followup_processed_at: new Date().toISOString(), ...patch })
    .eq('id', activityId)
    .is('followup_processed_at', null)
  if (error) throw new Error(`Activity update failed: ${error.message}`)
}

// Decide what should happen to one download. Pure: no writes.
function decide(activity, configs, contact, now = new Date()) {
  const config = routeResource(configs, activity.source_detail)
  if (!config) return { action: 'skip', reason: 'no_agent_for_resource' }
  if (!config.enabled) return { action: 'skip', reason: 'agent_disabled', config }
  if (!config.download_trigger_since) return { action: 'hold', reason: 'trigger_not_enabled', config }
  const touch = activity.touchpoint_at ? new Date(activity.touchpoint_at) : null
  if (!touch || Number.isNaN(touch.getTime())) return { action: 'skip', reason: 'no_touchpoint', config }
  if (touch <= new Date(config.download_trigger_since)) return { action: 'skip', reason: 'before_cutover', config }
  if (touch > now) return { action: 'hold', reason: 'touchpoint_in_future', config }
  const email = normalizeEmail(activity.email)
  if (!email) return { action: 'skip', reason: 'no_email', config }
  if (isInternalEmail(email)) return { action: 'skip', reason: 'internal_domain', config }
  if (!contact) return { action: 'hold', reason: 'contact_not_synced_yet', config }
  if ((contact.tags || []).includes(INTERNAL_TAG)) return { action: 'skip', reason: 'internal_tag', config }
  if (contact.unsubscribed) return { action: 'skip', reason: 'unsubscribed', config }
  if (contact.bounce_status === 'hard') return { action: 'skip', reason: 'hard_bounced', config }
  return { action: 'enroll', config, contact }
}

/**
 * Enroll new Resource Download activities into their AI follow-up agents.
 *
 * @param {{supabase, generateDraft?: (contactId:string, configId:string) => Promise<void>, leaseSeconds?: number, now?: Date}} deps
 * @param {string} clientId
 * @param {{dryRun?: boolean, limit?: number, simulateCutover?: string}} [options]
 *   simulateCutover (dry run only): pretend every routed agent's cutover is this
 *   ISO timestamp, to preview decisions before enabling for real.
 * @returns {Promise<{enrolled: Array, skipped: Array, held: Array, configs: number}>}
 */
async function enrollDownloadFollowups(deps, clientId, options = {}) {
  const { supabase, generateDraft } = deps
  const leaseSeconds = deps.leaseSeconds || DEFAULT_LEASE_SECONDS
  const now = deps.now || new Date()
  const dryRun = Boolean(options.dryRun)
  const summary = { enrolled: [], skipped: [], held: [], configs: 0 }

  let configs = await loadDownloadConfigs(supabase, clientId)
  if (dryRun && options.simulateCutover) {
    configs = configs.map(c => ({ ...c, download_trigger_since: c.download_trigger_since || options.simulateCutover }))
  }
  summary.configs = configs.length
  if (!configs.length) return summary

  const activities = await loadPendingDownloads(supabase, clientId, options.limit || BATCH)
  for (const activity of activities) {
    const email = normalizeEmail(activity.email)
    const contact = email && !isInternalEmail(email) ? await loadContact(supabase, clientId, email) : null
    const decision = decide(activity, configs, contact, now)
    const record = {
      activity_id: activity.id, salesforce_id: activity.salesforce_id, email,
      resource: activity.source_detail, touchpoint_at: activity.touchpoint_at,
      agent: decision.config?.name || null, reason: decision.reason || null,
    }

    if (decision.action === 'hold') {
      // Leave the row unprocessed so a later run can pick it up.
      summary.held.push(record)
      continue
    }
    if (decision.action === 'skip') {
      summary.skipped.push(record)
      if (!dryRun) await markProcessed(supabase, activity.id, { followup_skip_reason: decision.reason })
      continue
    }

    const { config } = decision
    if (dryRun) {
      summary.enrolled.push({ ...record, dry_run: true })
      continue
    }

    // Keep the download as the source submission for this sequence's context.
    const submissions = [...(contact.form_submissions || []), downloadSubmission(activity)]
    const { error: subError } = await supabase
      .from('contacts')
      .update({ form_submissions: submissions })
      .eq('id', contact.id)
    if (subError) throw new Error(`Contact submission update failed: ${subError.message}`)

    const spaced = await contactNeedsSpacing(supabase, clientId, contact.id, leaseSeconds)
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString()
    const { data: enrollment, error: enrollError } = await supabase
      .from('ai_followup_contacts')
      .insert({
        config_id: config.id,
        contact_id: contact.id,
        client_id: clientId,
        status: 'in_progress',
        current_step: 0,
        // Lease while we generate immediately; otherwise due now for the scheduler.
        next_followup_at: spaced ? now.toISOString() : leaseUntil,
        source_activity_id: activity.id,
        resource_url: activity.web_page || null,
      })
      .select('id')
      .single()

    if (enrollError) {
      if (enrollError.code === '23505') {
        // Already in this agent (a second download of the same kind, or the old
        // form path). One sequence per person per agent; never start a second.
        summary.skipped.push({ ...record, reason: 'already_enrolled' })
        await markProcessed(supabase, activity.id, { followup_skip_reason: 'already_enrolled' })
        continue
      }
      throw new Error(`Enrollment insert failed: ${enrollError.message}`)
    }

    await markProcessed(supabase, activity.id, { followup_enrollment_id: enrollment.id })
    summary.enrolled.push({ ...record, enrollment_id: enrollment.id, immediate: !spaced })
    console.log(`🤖 Download follow-up: enrolled ${email} in "${config.name}" (${activity.source_detail})${spaced ? ' — spaced, scheduler will send' : ''}`)

    if (spaced || !generateDraft) continue
    try {
      await generateDraft(contact.id, config.id)
    } catch (genError) {
      console.error(`⚠️ Immediate download follow-up generation failed for ${email}:`, genError.message)
      // Release the lease so the scheduler retries; only if nobody else touched it.
      await supabase
        .from('ai_followup_contacts')
        .update({ next_followup_at: new Date().toISOString() })
        .eq('id', enrollment.id)
        .eq('next_followup_at', leaseUntil)
    }
  }

  if (summary.enrolled.length || summary.skipped.length) {
    console.log(`  📥 Download follow-ups: ${summary.enrolled.length} enrolled, ${summary.skipped.length} skipped, ${summary.held.length} held${dryRun ? ' (dry run)' : ''}`)
  }
  return summary
}

module.exports = {
  enrollDownloadFollowups,
  decide,
  routeResource,
  downloadSubmission,
  isInternalEmail,
  DOWNLOAD_CHANNEL,
}
