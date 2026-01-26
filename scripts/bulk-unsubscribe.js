#!/usr/bin/env node
/**
 * Bulk unsubscribe contacts by email
 * Usage: node scripts/bulk-unsubscribe.js
 */

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

const emailsToUnsubscribe = [
  'jr.humbert@incogbiopharma.com',
  'cforeman@biologicsconsulting.com',
  'rhiggins@aircarbon.com',
  'matt@cometobask.com',
  'jschramm@anchordanly.com',
  'cholmes@caltech.edu',
  'kenny@johnsonsupplyco.com',
  'Gertraud.Stift@ist.ac.at',
  'Steve.Picker@xiros.co.uk',
  'Tim.Kent@pfizer.com',
  'lsrl@novonordisk.com',
  'nigel.beeby@kembla.com.au',
  'lisa.mcfadyen@orano.group',
  'M.Anderson@CelLBxHealth.com',
  'Sean.Scott@materion.com',
  'CMatthews.richmond@fareva.com',
  'savvas.ioannou@biogena-api.com',
  'KDiehl@bethlehem-pa.gov',
  'brian.strong@novartis.com',
  'panayiotis.tsiatinis@medochemie.com',
  'Sean.Nichols@mcgc.com',
  'leena.hwangbo@kohyoung.com',
  'lvolpini@cbccusa.com',
  'jtoma@actalentservices.com',
  'ladmin@us.effecto.com',
  'Guillaume.Wetzel@conteneurs-cms.fr',
  'Eoin.Croke@simplesciencellc.com',
  'umasankar.ramasamy@eywapharma.com',
  'Connor.Fox@fphcare.co.nz',
  'riversr@ebsi.com',
  'l-efland-mag@morinaga.com',
  'James.Morrison@resmed.com.au',
  'brad.dejohn@qualityfinishingsystems.com',
  'mdoke@senga-eng.com',
  'MAStier@austinchemical.com',
  'JLippincott@njwsa.org',
  'bennett67@llnl.gov',
  'AHaddach@DINSMORE.COM',
  'njqcmgr@asbury.com',
  'jrendon@spectrumchemical.com',
  'aperez@engis.com',
  'BBerg@churchs.com',
  'SRoy@nantworks.com',
  'michele@ncwatersewer.com',
  'nglum@aurorium.com',
  'norman@globalbrandstt.com',
  'asafaee@hfsgc.ca',
  'garrett.reed@baycable.com',
  'alf@fedegariusa.com',
  'julian.rehr@mk-versuchsanlagen.de',
  'SPriester@metplas.com',
  'jennellp@toojays.com',
  'martin.extern@hochschule-bc.de',
  'sft4sv@eservices.virginia.edu',
  'javaid@jncair.com',
  'jenkinsj@ebsi.com',
  'VanBergenH@ebsi.com',
  'wsilva@rcdcomponents.com',
  'chillebrand@ebfusion.com',
  'Randy.Peterson@chemicosystems.com',
  'terry.toth@tieronemachining.com',
  'Daniela.Moreno@partnertx.com',
]

async function bulkUnsubscribe() {
  // Deduplicate and lowercase
  const uniqueEmails = [...new Set(emailsToUnsubscribe.map(e => e.toLowerCase()))]

  console.log(`\nUnsubscribing ${uniqueEmails.length} contacts...\n`)

  let updated = 0
  let notFound = 0
  let alreadyUnsubscribed = 0

  for (const email of uniqueEmails) {
    // Check if contact exists
    const { data: contacts, error: findError } = await supabase
      .from('contacts')
      .select('id, email, unsubscribed')
      .ilike('email', email)

    if (findError) {
      console.error(`Error finding ${email}:`, findError.message)
      continue
    }

    if (!contacts || contacts.length === 0) {
      console.log(`  ✗ Not found: ${email}`)
      notFound++
      continue
    }

    for (const contact of contacts) {
      if (contact.unsubscribed) {
        console.log(`  - Already unsubscribed: ${contact.email}`)
        alreadyUnsubscribed++
        continue
      }

      const { error: updateError } = await supabase
        .from('contacts')
        .update({
          unsubscribed: true,
          unsubscribed_at: new Date().toISOString(),
        })
        .eq('id', contact.id)

      if (updateError) {
        console.error(`  Error updating ${contact.email}:`, updateError.message)
      } else {
        console.log(`  ✓ Unsubscribed: ${contact.email}`)
        updated++
      }
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`Unsubscribed: ${updated}`)
  console.log(`Already unsubscribed: ${alreadyUnsubscribed}`)
  console.log(`Not found in database: ${notFound}`)
}

bulkUnsubscribe().catch(console.error)
