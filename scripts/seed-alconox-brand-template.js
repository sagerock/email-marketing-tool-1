#!/usr/bin/env node
/**
 * Seed the Alconox 2026 brand reference template into the templates table
 * and point the Alconox client's brand_reference_template_id at it.
 *
 * Idempotent: re-running updates the existing template's HTML in place.
 *
 * Usage: node scripts/seed-alconox-brand-template.js
 * Requires: SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_KEY in env.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const TEMPLATE_NAME = 'Alconox Brand Reference 2026'
const TEMPLATE_SUBJECT = 'Alconox brand reference (used by AI Email Builder)'
const CLIENT_NAME_MATCH = 'alconox' // case-insensitive ilike

const __dirname = dirname(fileURLToPath(import.meta.url))
const HTML_PATH = resolve(__dirname, '..', 'docs', 'templates', 'alconox-template-2026.html')

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_KEY env var.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function main() {
  const html = readFileSync(HTML_PATH, 'utf8')
  console.log(`Loaded template HTML: ${html.length} chars from ${HTML_PATH}`)

  const { data: clients, error: clientErr } = await supabase
    .from('clients')
    .select('id, name, brand_reference_template_id')
    .ilike('name', `%${CLIENT_NAME_MATCH}%`)

  if (clientErr) throw clientErr
  if (!clients || clients.length === 0) {
    console.error(`No client found matching "%${CLIENT_NAME_MATCH}%".`)
    process.exit(1)
  }
  if (clients.length > 1) {
    console.error(`Multiple clients matched: ${clients.map(c => c.name).join(', ')}. Refusing to guess.`)
    process.exit(1)
  }
  const client = clients[0]
  console.log(`Found client: ${client.name} (${client.id})`)

  const { data: existing } = await supabase
    .from('templates')
    .select('id')
    .eq('client_id', client.id)
    .eq('name', TEMPLATE_NAME)
    .maybeSingle()

  let templateId
  if (existing) {
    const { error: upErr } = await supabase
      .from('templates')
      .update({
        html_content: html,
        subject: TEMPLATE_SUBJECT,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
    if (upErr) throw upErr
    templateId = existing.id
    console.log(`Updated existing template ${templateId}`)
  } else {
    const { data: created, error: insErr } = await supabase
      .from('templates')
      .insert({
        name: TEMPLATE_NAME,
        subject: TEMPLATE_SUBJECT,
        html_content: html,
        client_id: client.id,
      })
      .select('id')
      .single()
    if (insErr) throw insErr
    templateId = created.id
    console.log(`Created template ${templateId}`)
  }

  if (client.brand_reference_template_id !== templateId) {
    const { error: clientUpErr } = await supabase
      .from('clients')
      .update({ brand_reference_template_id: templateId })
      .eq('id', client.id)
    if (clientUpErr) throw clientUpErr
    console.log(`Set ${client.name}.brand_reference_template_id = ${templateId}`)
  } else {
    console.log(`Client already points at template ${templateId}`)
  }

  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
