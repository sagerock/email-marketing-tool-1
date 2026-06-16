/**
 * SendGrid suppression / deliverability lookup for a single email address.
 *
 * Answers "why didn't this contact get our email?" by checking every SendGrid
 * suppression bucket (bounces, blocks, invalid emails, spam reports, unsubscribes).
 * A hard bounce, a Mimecast/Proofpoint 554 block, an invalid address, and a spam
 * complaint all suppress future sends but live in *different* lists — this checks
 * all of them and prints the verbatim reason SendGrid recorded.
 *
 * Our analytics_events table only stores the event *type* (e.g. "bounce"), not the
 * SMTP reason, so this is the way to get the actual cause.
 *
 * Usage:
 *   node api/sendgrid-lookup.js dmiller@spectrumchemical.com
 *
 * Requires SENDGRID_LOOKUP_API_KEY in .env (an account key with suppression.read).
 */

require('dotenv').config()

const API_KEY = process.env.SENDGRID_LOOKUP_API_KEY
const BASE = 'https://api.sendgrid.com/v3'
const LISTS = ['bounces', 'blocks', 'invalid_emails', 'spam_reports', 'unsubscribes']

async function getList(list, email) {
  const res = await fetch(`${BASE}/suppression/${list}/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!res.ok) {
    return { error: `${res.status} ${res.statusText}` }
  }
  return { rows: await res.json() }
}

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: node api/sendgrid-lookup.js <email>')
    process.exit(1)
  }
  if (!API_KEY) {
    console.error('Missing SENDGRID_LOOKUP_API_KEY in .env')
    process.exit(1)
  }

  console.log(`\nSendGrid suppression lookup for: ${email}\n`)
  let found = false

  for (const list of LISTS) {
    const { rows, error } = await getList(list, email)
    if (error) {
      console.log(`  ${list.padEnd(15)} ⚠️  ${error}`)
      continue
    }
    if (!rows || rows.length === 0) {
      console.log(`  ${list.padEnd(15)} —`)
      continue
    }
    found = true
    for (const r of rows) {
      const when = r.created ? new Date(r.created * 1000).toISOString() : 'unknown date'
      console.log(`  ${list.padEnd(15)} 🚫 [${r.status || '—'}] ${when}`)
      console.log(`  ${' '.repeat(15)}    ${r.reason || '(no reason given)'}`)
    }
  }

  if (!found) {
    console.log('\n✅ Not in any suppression list — SendGrid would attempt delivery.\n')
  } else {
    console.log('\nNote: presence in a list means SendGrid suppresses future sends to this address until removed.\n')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
