const { test } = require('node:test')
const assert = require('node:assert/strict')
const { scopeKnowledgeQuery, findOwnedKnowledge } = require('./knowledge-security')

function store(rows) {
  const filters = []
  const query = {
    select() { return query },
    eq(key, value) { filters.push([key, value]); return query },
    async maybeSingle() { return { data: rows.find(row => filters.every(([k, v]) => row[k] === v)) || null } },
  }
  return { filters, query, from() { return query } }
}
const rows = [{ id: 'a', client_id: 'A' }, { id: 'b', client_id: 'B' }]
test('client admin query is always bound to assigned tenant', () => {
  const s = store(rows)
  scopeKnowledgeQuery(s.query, { role: 'client_admin', client_id: 'A' })
  assert.deepEqual(s.filters, [['client_id', 'A']])
})
test('missing role or missing tenant fails closed', () => {
  for (const user of [undefined, {}, { role: 'client_admin' }, { role: 'viewer' }]) {
    assert.throws(() => scopeKnowledgeQuery(store(rows).query, user), { status: 403 })
  }
})
test('client admin cannot resolve another tenant record by ID', async () => {
  await assert.rejects(findOwnedKnowledge(store(rows), 'b', { role: 'client_admin', client_id: 'A' }), { status: 404 })
})
test('own tenant record resolves', async () => {
  assert.deepEqual(await findOwnedKnowledge(store(rows), 'a', { role: 'client_admin', client_id: 'A' }), rows[0])
})
test('existing internal roles retain cross-client access', async () => {
  for (const role of ['admin', 'super_admin']) {
    assert.deepEqual(await findOwnedKnowledge(store(rows), 'b', { role }), rows[1])
  }
})
test('missing record does not resolve even for internal staff', async () => {
  await assert.rejects(findOwnedKnowledge(store(rows), 'missing', { role: 'admin' }), { status: 404 })
})

// Exercise the actual registered handlers without starting servers, schedulers,
// provider clients, or email delivery. The global middleware is tested separately
// by live anonymous-denial probes; these tests supply its authenticated identity.
function handlers() {
  const fs = require('node:fs')
  const vm = require('node:vm')
  const source = fs.readFileSync(require.resolve('./server'), 'utf8')
  const section = source.slice(source.indexOf("const { scopeKnowledgeQuery, findOwnedKnowledge }"), source.indexOf('// AI Follow-up Agent Endpoints'))
  const registered = {}
  const calls = []
  const records = rows.map(row => ({ ...row, is_active: true }))
  const app = Object.fromEntries(['get','post','put','delete'].map(method => [method, (url, handler) => { registered[method] = handler }]))
  const supabase = {
    from() {
      let action = 'select', values
      const filters = []
      const execute = () => {
        const matched = records.filter(row => filters.every(([k,v,not]) => not ? row[k] !== v : row[k] === v))
        if (action !== 'select') calls.push({ action, filters: [...filters] })
        if (action === 'update') matched.forEach(row => Object.assign(row, values))
        if (action === 'delete') matched.forEach(row => records.splice(records.indexOf(row), 1))
        return { data: matched[0] || null, error: null }
      }
      const query = {
        select() { return query }, eq(k,v) { filters.push([k,v,false]); return query },
        neq(k,v) { filters.push([k,v,true]); return query },
        update(v) { action='update'; values=v; return query }, delete() { action='delete'; return query },
        maybeSingle: async () => execute(), single: async () => execute(),
        then(resolve,reject) { return Promise.resolve(execute()).then(resolve,reject) },
      }
      return query
    },
  }
  vm.runInNewContext(section, { app, supabase, require, console: { error() {} } })
  async function invoke(method,id,body={},adminUser={role:'client_admin',client_id:'A'}) {
    const res = { statusCode:200, status(n) { this.statusCode=n; return this }, json(data) { this.body=data; return this } }
    await registered[method]({ params:{id},body,adminUser },res)
    return res
  }
  return { invoke,calls,records }
}
test('actual PUT rejects foreign ID before deactivating any knowledge', async () => {
  const h=handlers()
  assert.equal((await h.invoke('put','b',{clientId:'A',is_active:true,content:'attack'})).statusCode,404)
  assert.equal(h.calls.length,0)
  assert.ok(h.records.every(row=>row.is_active))
})
test('actual DELETE rejects foreign ID without deleting', async () => {
  const h=handlers()
  assert.equal((await h.invoke('delete','b')).statusCode,404)
  assert.equal(h.calls.length,0)
  assert.equal(h.records.length,2)
})
test('actual PUT scopes every mutation and preserves foreign content', async () => {
  const h=handlers()
  assert.equal((await h.invoke('put','a',{is_active:true,content:'owned'})).statusCode,200)
  assert.equal(h.records[0].content,'owned')
  assert.equal(h.records[1].content,undefined)
  assert.ok(h.calls.every(call=>call.filters.some(([k,v,not])=>k==='client_id'&&v==='A'&&!not)))
})
test('actual DELETE removes only owned row', async () => {
  const h=handlers()
  assert.equal((await h.invoke('delete','a')).statusCode,200)
  assert.deepEqual(h.records.map(row=>row.id),['b'])
})
test('actual PUT rejects mismatched activation tenant even for staff', async () => {
  const h=handlers()
  assert.equal((await h.invoke('put','b',{clientId:'A',is_active:true},{role:'admin'})).statusCode,404)
  assert.equal(h.calls.length,0)
})
