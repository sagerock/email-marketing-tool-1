/**
 * Send ONE existing campaign to ONE contact, replicating the exact personalization
 * logic of the main /api/send-campaign path in server.js (substitutions, UTM params,
 * List-Unsubscribe headers, campaign-<id> category for analytics attribution).
 *
 * Use for recovery sends after a contact was unblocked/recovered — e.g. re-delivering
 * an eblast to a contact who was added late or previously bounced.
 *
 * Usage:
 *   node api/send-one-recovery.js <campaignId> <email>
 *
 * Reads SENDGRID_LOOKUP_API_KEY (Alconox account key), VITE_SUPABASE_URL,
 * SUPABASE_SERVICE_KEY from .env.
 */

require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const sgClient = require('@sendgrid/client')

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE_URL = process.env.BASE_URL || 'https://mail.sagerock.com'
const DEFAULT_INDUSTRY_URL = 'https://alconox.com/industries/'

const appendUtmParams = (html, params) => {
  if (!params) return html
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
    if (url.includes('unsubscribe')) return match
    const sep = url.includes('?') ? '&' : '?'
    return `href="${url}${sep}${params}"`
  })
}
const appendUtmToUrl = (url, params) => {
  if (!params || !url) return url
  if (url.includes('unsubscribe')) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}${params}`
}

async function main() {
  const [campaignId, email] = process.argv.slice(2)
  if (!campaignId || !email) {
    console.error('Usage: node api/send-one-recovery.js <campaignId> <email>')
    process.exit(1)
  }
  if (!process.env.SENDGRID_LOOKUP_API_KEY) {
    console.error('Missing SENDGRID_LOOKUP_API_KEY in .env')
    process.exit(1)
  }

  // Campaign
  const { data: campaign, error: cErr } = await supabase
    .from('campaigns').select('*').eq('id', campaignId).single()
  if (cErr || !campaign) throw new Error(`Campaign not found: ${cErr?.message}`)

  // Client (mailing address + ip pool)
  const { data: client, error: clErr } = await supabase
    .from('clients').select('mailing_address, ip_pool').eq('id', campaign.client_id).single()
  if (clErr || !client) throw new Error(`Client not found: ${clErr?.message}`)

  // Template
  let htmlContent = ''
  if (campaign.template_id) {
    const { data: tpl, error: tErr } = await supabase
      .from('templates').select('html_content').eq('id', campaign.template_id).single()
    if (tErr) throw new Error(`Template fetch error: ${tErr.message}`)
    htmlContent = tpl?.html_content || ''
  }
  if (!htmlContent.trim()) throw new Error('Template has no HTML content — aborting.')

  // Contact (must be eligible: not unsubscribed, not hard-bounced)
  const { data: contact, error: ctErr } = await supabase
    .from('contacts')
    .select('id, email, first_name, last_name, unsubscribe_token, industry, unsubscribed, bounce_status')
    .eq('client_id', campaign.client_id)
    .ilike('email', email)
    .single()
  if (ctErr || !contact) throw new Error(`Contact not found: ${ctErr?.message}`)
  if (contact.unsubscribed) throw new Error('Contact is unsubscribed — refusing to send.')
  if (contact.bounce_status === 'hard') throw new Error('Contact is hard-bounced — recover first.')

  // SF campaign name merge tag
  let sfCampaignName = ''
  if (campaign.salesforce_campaign_id) {
    const { data: sf } = await supabase
      .from('salesforce_campaigns').select('name').eq('id', campaign.salesforce_campaign_id).single()
    sfCampaignName = sf?.name || ''
  }

  // Industry links
  const { data: industryLinks } = await supabase
    .from('industry_links').select('industry, link_url').eq('client_id', campaign.client_id)
  const industryLinkMap = new Map((industryLinks || []).map(il => [il.industry, il.link_url]))

  const utmParams = campaign.utm_params || ''
  const mailingAddress = client.mailing_address || 'No mailing address configured'

  // Shared template processing (matches server.js)
  let processedTemplate = htmlContent
    .replace(/{{mailing_address}}/gi, mailingAddress)
    .replace(/{{campaign_name}}/gi, sfCampaignName)
  processedTemplate = appendUtmParams(processedTemplate, utmParams)

  // Per-contact personalization
  const unsubscribeUrl = `${BASE_URL}/unsubscribe?token=${contact.unsubscribe_token}&campaign_id=${campaignId}`
  const rawIndustryLink = contact.industry
    ? (industryLinkMap.get(contact.industry) || DEFAULT_INDUSTRY_URL)
    : DEFAULT_INDUSTRY_URL
  const industryLink = appendUtmToUrl(rawIndustryLink, utmParams)

  const requestBody = {
    personalizations: [{
      to: [{ email: contact.email }],
      substitutions: {
        '{{email}}': contact.email,
        '{{first_name}}': contact.first_name || '',
        '{{last_name}}': contact.last_name || '',
        '{{unsubscribe_url}}': unsubscribeUrl,
        '{{industry_link}}': industryLink,
      },
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }],
    from: { email: campaign.from_email, name: campaign.from_name },
    subject: campaign.subject,
    content: [{ type: 'text/html', value: processedTemplate }],
    categories: [`campaign-${campaignId}`],
    custom_args: { campaign_id: campaignId },
  }
  if (campaign.reply_to) requestBody.reply_to = { email: campaign.reply_to }
  if (client.ip_pool) requestBody.ip_pool_name = client.ip_pool

  console.log('About to send:')
  console.log('  campaign :', campaign.name)
  console.log('  subject  :', campaign.subject)
  console.log('  from     :', `${campaign.from_name} <${campaign.from_email}>`)
  console.log('  reply_to :', campaign.reply_to || '(none)')
  console.log('  ip_pool  :', client.ip_pool || '(none)')
  console.log('  to       :', contact.email, `(${contact.first_name} ${contact.last_name})`)
  console.log('  category :', `campaign-${campaignId}`)

  if (process.env.DRY_RUN === '1') {
    console.log('\nDRY_RUN=1 — not sending. Personalized unsubscribe URL:', unsubscribeUrl)
    return
  }

  sgClient.setApiKey(process.env.SENDGRID_LOOKUP_API_KEY)
  const [resp] = await sgClient.request({ method: 'POST', url: '/v3/mail/send', body: requestBody })
  console.log(`\n✅ Sent. SendGrid status ${resp.statusCode}, message id: ${resp.headers['x-message-id'] || '(none)'}`)
}

main().catch((e) => { console.error('❌', e.message || e); process.exit(1) })
