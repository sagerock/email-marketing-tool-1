#!/usr/bin/env node
// Prints a template's html_content to stdout with merge tags filled with
// preview placeholder data (mirrors /api/send-test-email's substitutions).
// Usage: node scripts/fetch-template-html.cjs <template-uuid>
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].trim()
}

const { createClient } = require(path.join(ROOT, 'api', 'node_modules', '@supabase/supabase-js'))

const templateId = process.argv[2]
if (!templateId) {
  console.error('usage: fetch-template-html.cjs <template-uuid>')
  process.exit(1)
}

async function main() {
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { data, error } = await supabase
    .from('templates')
    .select('html_content')
    .eq('id', templateId)
    .single()
  if (error) throw new Error(error.message)

  const html = data.html_content
    .replace(/{{email}}/gi, 'preview@example.com')
    .replace(/{{first_name}}/gi, 'John')
    .replace(/{{last_name}}/gi, 'Doe')
    .replace(/{{unsubscribe_url}}/gi, 'https://mail.sagerock.com/unsubscribe?token=PREVIEW')
    .replace(/{{mailing_address}}/gi, '30 Glenn St, Suite 309, White Plains, NY 10603')
    .replace(/{{campaign_name}}/gi, 'Preview')
    .replace(/{{industry_link}}/gi, 'https://alconox.com/industries/')

  process.stdout.write(html)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
