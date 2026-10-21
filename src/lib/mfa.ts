// Two-factor authentication (TOTP via Supabase Auth MFA), 2026-10-21.
//
// Decision rules, shared with the server (api/mfa.js):
//   - anyone with a verified factor must verify it each session (AAL2) before using the app
//   - super admins must have a factor; until they do, they only see the setup screen
// The database-level RLS helpers deliberately do NOT require AAL2 yet: the schools app queries
// this project as the signed-in user through the same helpers and has no step-up prompt.
import type { Factor } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type AdminRole = 'super_admin' | 'admin' | 'client_admin'
export type AssuranceLevel = 'aal1' | 'aal2'

export interface MfaState {
  verifiedFactors: Factor[]
  unverifiedFactors: Factor[]
  currentLevel: AssuranceLevel | null
  nextLevel: AssuranceLevel | null
}

export type MfaDecision = 'ok' | 'verify' | 'enroll'

export function mfaRequiredForRole(role: AdminRole | null | undefined): boolean {
  return role === 'super_admin'
}

export function needsStepUp(state: MfaState): boolean {
  return state.verifiedFactors.length > 0 && state.currentLevel !== 'aal2'
}

export function mfaDecision(role: AdminRole | null | undefined, state: MfaState): MfaDecision {
  if (needsStepUp(state)) return 'verify'
  if (mfaRequiredForRole(role) && state.verifiedFactors.length === 0) return 'enroll'
  return 'ok'
}

// The enroll response's qr_code is SVG markup. supabase-js already prepends
// `data:image/svg+xml;utf-8,` but leaves the SVG raw, and raw SVG contains '#' (fill colors)
// which ends a URL, so the markup is percent-encoded here either way.
const SVG_DATA_PREFIX = 'data:image/svg+xml;utf-8,'
export function qrDataUrl(qrCode: string): string {
  const svg = qrCode.startsWith(SVG_DATA_PREFIX) ? qrCode.slice(SVG_DATA_PREFIX.length) : qrCode
  if (!svg.includes('<')) return qrCode // already encoded or some other data URL
  return SVG_DATA_PREFIX + encodeURIComponent(svg)
}

export const MFA_CHANGED_EVENT = 'sagerock:mfa-changed'

// Cached per access token so the gate (mounted on every protected route) doesn't call
// /auth/v1/user on each navigation. Enrolling, verifying or unenrolling invalidates it.
let cached: { token: string; state: MfaState } | null = null

export function peekMfaState(token: string | undefined): MfaState | null {
  return cached && token && cached.token === token ? cached.state : null
}

export function invalidateMfaState() {
  cached = null
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MFA_CHANGED_EVENT))
}

export async function loadMfaState(opts: { force?: boolean } = {}): Promise<MfaState> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token ?? ''
  if (!opts.force && cached && cached.token === token) return cached.state
  const [factors, aal] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ])
  if (factors.error) throw factors.error
  if (aal.error) throw aal.error
  const all = factors.data?.all ?? []
  const state: MfaState = {
    verifiedFactors: all.filter((f) => f.status === 'verified'),
    unverifiedFactors: all.filter((f) => f.status !== 'verified'),
    currentLevel: aal.data?.currentLevel ?? null,
    nextLevel: aal.data?.nextLevel ?? null,
  }
  cached = { token, state }
  return state
}
