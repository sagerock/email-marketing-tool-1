const test = require('node:test')
const assert = require('node:assert/strict')
const mount = require('./bounce-report')
const { suggestDomain, domainExists, buildBounceReport, toXlsx } = mount

test('suggestDomain fixes obvious top-level typos first', () => {
  assert.equal(suggestDomain('usdoj.gob'), 'usdoj.gov')
  assert.equal(suggestDomain('acme.con'), 'acme.com')
})

test('suggestDomain picks the closest delivering domain, then the most used', () => {
  const cands = [
    { candidate: 'kesselmedical.com', n: 4, dist: 2 },
    { candidate: 'kesselmedica.com', n: 1, dist: 2 },
  ]
  assert.equal(suggestDomain('kesselmeidcal.com', cands), 'kesselmedical.com')
  assert.equal(suggestDomain('gmial.com', [{ candidate: 'gmail.com', n: 9000, dist: 2 }]), null) // short: 1 edit max
  assert.equal(suggestDomain('gmal.com', [{ candidate: 'gmail.com', n: 9000, dist: 1 }]), 'gmail.com')
  assert.equal(suggestDomain('nowhere.com', []), null)
})

test('domainExists separates missing domains from DNS trouble', async () => {
  const err = code => Object.assign(new Error(code), { code })
  const dns = {
    resolveMx: async d => { if (d === 'real.com') return [{ exchange: 'mx.real.com' }]; if (d === 'flaky.com') throw err('ETIMEOUT'); throw err('ENOTFOUND') },
    resolve4: async d => { if (d === 'aonly.com') return ['1.2.3.4']; throw err('ENOTFOUND') },
  }
  assert.equal(await domainExists('real.com', dns), true)
  assert.equal(await domainExists('aonly.com', dns), true)
  assert.equal(await domainExists('kesselmeidcal.com', dns), false)
  assert.equal(await domainExists('flaky.com', dns), null)
})

test('the report groups typos, missing domains, gone mailboxes, and false bounces', () => {
  const r = {
    client: { name: 'Alconox' }, days: 7, total: 4,
    typos: [{ email: 'rob@styker.com', suggested: 'rob@stryker.com', twin: true, first_name: 'Rob', company: 'Stryker', link: 'https://sf/x' }],
    noDomain: [{ email: 'x@nowhere-typo.example', bounced_at: '2026-09-28T00:00:00Z' }],
    gone: [{ email: 'left@realco.com', bounced_at: '2026-09-28T00:00:00Z' }],
    maybeFalse: [{ email: 'y@medtronic.com', last_engaged_at: '2026-09-29T00:00:00Z' }],
  }
  const out = buildBounceReport(r, { subject_suffix: 'Alconox, LLC' })
  assert.equal(out.subject, '3 bad emails to clean up — Alconox, LLC')
  assert.match(out.text, /rob@styker\.com -> rob@stryker\.com \(already on file\)/)
  assert.match(out.text, /Domain doesn't exist \(1\)/)
  assert.match(out.text, /Mailbox no longer works \(1\)/)
  assert.match(out.text, /Possible false bounces, don't delete \(1\)/)
  assert.match(out.text, /Jax, Sage’s assistant\n$/)
  assert.equal(out.csv.trim().split('\n').length, 5)
})

test('the Excel attachment has an All tab and one tab per non-empty group', async () => {
  const ExcelJS = require('exceljs')
  const r = {
    typos: [{ email: 'rob@styker.com', suggested: 'rob@stryker.com', twin: true, salesforce_id: '003A' }],
    moved: [], noDomain: [],
    gone: [{ email: 'left@realco.com', salesforce_id: '00QB', record_type: 'lead', bounced_at: '2026-09-28T00:00:00Z' },
      { email: 'gone@realco.com', salesforce_id: '00QC' }],
    maybeFalse: [],
  }
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await toXlsx(r))
  assert.deepEqual(wb.worksheets.map(w => w.name), ['All', 'Likely typos (1)', 'Mailbox no longer works (2)'])
  const gone = wb.getWorksheet('Mailbox no longer works (2)')
  assert.equal(gone.getRow(1).getCell(8).value, 'salesforce_id')
  assert.equal(gone.getRow(2).getCell(8).value, '00QB')
  assert.equal(gone.getRow(2).getCell(9).value, '2026-09-28')
  assert.equal(wb.getWorksheet('All').rowCount, 4)
})

test('the cron registers only on the scheduler service', () => {
  const scheduled = []
  const cron = { schedule: e => scheduled.push(e) }
  mount({}, { supabase: {}, decryptClient: x => x, cron, schedulerEnabled: false })
  assert.deepEqual(scheduled, [])
  mount({}, { supabase: {}, decryptClient: x => x, cron, schedulerEnabled: true })
  assert.deepEqual(scheduled, ['0 13 * * 1'])
})
