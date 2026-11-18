'use strict'

// Second-factor enforcement for the backend API (2026-10-21).
//
// Supabase Auth verifies the bearer token in authenticateUser (api/server.js); the verified
// user object carries `factors`, and the token's `aal` claim says whether this session passed
// a second factor. The rules mirror src/lib/mfa.ts:
//   - a verified factor exists and the session is not AAL2  → 403 mfa_step_up_required
//   - super_admin or admin (every-client roles) with no factor → 403 mfa_enrollment_required
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

// Roles with access to every client (2026-11-18). Cross-client access follows the role alone:
// can_access_client / is_internal_staff and validateClientAccess grant every client to
// role IN ('super_admin','admin') whatever admin_users.client_id says. client_admin stays opt-in.
// Keep in step with src/lib/mfa.ts.
const CROSS_CLIENT_ROLES = ['super_admin', 'admin']

function mfaRequiredForRole(role) {
  return CROSS_CLIENT_ROLES.includes(role)
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
      error: 'Accounts with access to every client must set up two-factor authentication first. Reload the app to set it up.',
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

module.exports = { CROSS_CLIENT_ROLES, decodeJwtClaims, countVerifiedFactors, mfaRequiredForRole, assuranceDecision, mfaCheck }
