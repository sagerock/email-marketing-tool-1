'use strict'

// Run with: node --test api/mfa.test.js   (never bare `node --test` in api/)
const test = require('node:test')
const assert = require('node:assert/strict')
const { decodeJwtClaims, countVerifiedFactors, assuranceDecision, mfaCheck } = require('./mfa')

const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

test('decodeJwtClaims reads the payload and tolerates garbage', () => {
  assert.equal(decodeJwtClaims(jwt({ sub: 'u1', aal: 'aal2' })).aal, 'aal2')
  assert.deepEqual(decodeJwtClaims('not-a-token'), {})
  assert.deepEqual(decodeJwtClaims(null), {})
  assert.deepEqual(decodeJwtClaims('a.!!!.c'), {})
})

test('countVerifiedFactors counts only verified factors', () => {
  assert.equal(countVerifiedFactors({}), 0)
  assert.equal(countVerifiedFactors({ factors: null }), 0)
  assert.equal(countVerifiedFactors({ factors: [{ status: 'unverified' }, { status: 'verified' }, { status: 'verified' }] }), 2)
})

test('enrolled user at AAL1 is told to step up, whatever the role', () => {
  for (const role of ['super_admin', 'admin', 'client_admin']) {
    const d = assuranceDecision({ role, aal: 'aal1', verifiedFactorCount: 1 })
    assert.equal(d.ok, false)
    assert.equal(d.code, 'mfa_step_up_required')
  }
})

test('enrolled user at AAL2 passes', () => {
  assert.deepEqual(assuranceDecision({ role: 'client_admin', aal: 'aal2', verifiedFactorCount: 1 }), { ok: true })
  assert.deepEqual(assuranceDecision({ role: 'super_admin', aal: 'aal2', verifiedFactorCount: 2 }), { ok: true })
})

test('super admin without a factor must enroll; other roles need not', () => {
  const d = assuranceDecision({ role: 'super_admin', aal: 'aal1', verifiedFactorCount: 0 })
  assert.equal(d.ok, false)
  assert.equal(d.code, 'mfa_enrollment_required')
  assert.deepEqual(assuranceDecision({ role: 'admin', aal: 'aal1', verifiedFactorCount: 0 }), { ok: true })
  assert.deepEqual(assuranceDecision({ role: 'client_admin', aal: 'aal1', verifiedFactorCount: 0 }), { ok: true })
  assert.deepEqual(assuranceDecision({ role: 'client_admin', aal: undefined, verifiedFactorCount: 0 }), { ok: true },
    'tokens without an aal claim still work for users with no factor')
})

test('mfaCheck ties the pieces together from the verified user and token', () => {
  const user = { id: 'u1', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] }
  assert.equal(mfaCheck({ token: jwt({ sub: 'u1', aal: 'aal1' }), user, adminUser: { role: 'admin' } }).code, 'mfa_step_up_required')
  assert.equal(mfaCheck({ token: jwt({ sub: 'u1', aal: 'aal2' }), user, adminUser: { role: 'admin' } }).ok, true)
  assert.equal(mfaCheck({ token: jwt({ sub: 'u1', aal: 'aal1' }), user: { id: 'u1' }, adminUser: { role: 'super_admin' } }).code, 'mfa_enrollment_required')
  assert.equal(mfaCheck({ token: jwt({ sub: 'u1', aal: 'aal1' }), user: { id: 'u1' }, adminUser: { role: 'client_admin' } }).ok, true)
})
