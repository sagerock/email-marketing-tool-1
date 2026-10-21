'use strict'

// Second-factor enforcement for the backend API (2026-10-21).
//
// Supabase Auth verifies the bearer token in authenticateUser (api/server.js); the verified
// user object carries `factors`, and the token's `aal` claim says whether this session passed
// a second factor. The rules mirror src/lib/mfa.ts:
//   - a verified factor exists and the session is not AAL2  → 403 mfa_step_up_required
//   - super admin with no verified factor                    → 403 mfa_enrollment_required
// Everyone else passes. The database RLS helpers deliberately don't require AAL2 yet (the
// schools app queries as the user through them without a step-up prompt), so this middleware
// plus the browser gate are the enforcement for the email tool's API and UI.

function decodeJwtClaims(token) {
  if (typeof token !== 'string') return {}
  const parts = token.split('.')
  if (parts.length < 2) return {}
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' ? claims : {}
  } catch {
    return {}
  }
}

function countVerifiedFactors(user) {
  const factors = Array.isArray(user?.factors) ? user.factors : []
  return factors.filter((f) => f && f.status === 'verified').length
}

function mfaRequiredForRole(role) {
  return role === 'super_admin'
}

function assuranceDecision({ role, aal, verifiedFactorCount }) {
  if (verifiedFactorCount > 0 && aal !== 'aal2') {
    return {
      ok: false,
      code: 'mfa_step_up_required',
      error: 'Two-factor code required. Reload the app and enter your authenticator code.',
    }
  }
  if (mfaRequiredForRole(role) && verifiedFactorCount === 0) {
    return {
      ok: false,
      code: 'mfa_enrollment_required',
      error: 'Super admin accounts must set up two-factor authentication first (Settings → Your account).',
    }
  }
  return { ok: true }
}

// One call for the middleware: token already verified, user from getUser, adminUser row.
function mfaCheck({ token, user, adminUser }) {
  return assuranceDecision({
    role: adminUser?.role,
    aal: decodeJwtClaims(token).aal,
    verifiedFactorCount: countVerifiedFactors(user),
  })
}

module.exports = { decodeJwtClaims, countVerifiedFactors, mfaRequiredForRole, assuranceDecision, mfaCheck }
