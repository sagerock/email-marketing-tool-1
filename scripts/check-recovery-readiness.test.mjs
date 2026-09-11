import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeBackups, compatibleDump } from './check-recovery-readiness.mjs'

const now=Date.parse('2026-09-11T16:00:00Z')
test('uses the latest completed backup, not a newer incomplete attempt',()=>{
  const result=summarizeBackups({walg_enabled:true,pitr_enabled:false,backups:[
    {status:'COMPLETED',inserted_at:'2026-09-10T14:00:00Z'},
    {status:'RUNNING',inserted_at:'2026-09-11T15:00:00Z'},
    {status:'COMPLETED',inserted_at:'2026-09-11T14:00:00Z'},
  ]},now)
  assert.equal(result.age_hours,2)
  assert.equal(result.completed_backups,2)
  assert.equal(result.daily_backup_fresh,true)
  assert.equal(result.physical_backups,true)
  assert.equal(result.pitr_enabled,false)
})
test('missing, malformed, future and stale backups are not fresh',()=>{
  for(const inserted_at of [undefined,'invalid','2026-09-12T00:00:00Z','2026-09-10T09:00:00Z']) {
    assert.equal(summarizeBackups({backups:[{status:'COMPLETED',inserted_at}]},now).daily_backup_fresh,false)
  }
  assert.equal(summarizeBackups({},now).daily_backup_fresh,false)
})
test('an older pg_dump major version cannot back up the server',()=>{
  assert.equal(compatibleDump('pg_dump (PostgreSQL) 16.15',170006),false)
  assert.equal(compatibleDump('pg_dump (PostgreSQL) 17.11',170006),true)
  assert.equal(compatibleDump('pg_dump (PostgreSQL) 18.6',170006),true)
  assert.equal(compatibleDump('unknown',170006),false)
  for (const invalid of [null,undefined,'invalid',0,-1,170000.5]) {
    assert.equal(compatibleDump('pg_dump (PostgreSQL) 17.11',invalid),false)
  }
  assert.equal(compatibleDump(null,170006),false)
})
test('malformed provider responses cannot look like a successful empty inventory',()=>{
  for (const invalid of [null,[],{backups:{}},{backups:[null]},{backups:[[]]}]) {
    assert.throws(()=>summarizeBackups(invalid,now),/Invalid backup/)
  }
  assert.throws(()=>summarizeBackups({},NaN),/Invalid backup/)
})
test('backup freshness cutoff is exact, not based on rounded display age',()=>{
  const inserted_at='2026-09-10T10:00:00Z'
  assert.equal(summarizeBackups({backups:[{status:'COMPLETED',inserted_at}]},now).daily_backup_fresh,true)
  assert.equal(summarizeBackups({backups:[{status:'COMPLETED',inserted_at}]},now+1).daily_backup_fresh,false)
})
