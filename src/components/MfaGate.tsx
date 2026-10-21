import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { MFA_CHANGED_EVENT, loadMfaState, mfaDecision, peekMfaState, type MfaState } from '../lib/mfa'
import AuthShell from './mfa/AuthShell'
import MfaEnroll from './mfa/MfaEnroll'
import MfaVerify from './mfa/MfaVerify'
import Button from './ui/Button'

// Sits inside ProtectedRoute once the admin record is known. Shows the code prompt to anyone
// with a verified factor whose session is still AAL1, and the setup screen to super admins
// with no factor. Everyone else passes straight through. State is cached per access token
// (src/lib/mfa.ts) and kept during token refreshes so open pages are not unmounted.
export default function MfaGate({ children }: { children: React.ReactNode }) {
  const { session, adminUser } = useAuth()
  const token = session?.access_token
  const [state, setState] = useState<MfaState | null>(() => peekMfaState(token))
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    window.addEventListener(MFA_CHANGED_EVENT, bump)
    return () => window.removeEventListener(MFA_CHANGED_EVENT, bump)
  }, [])

  useEffect(() => {
    let active = true
    loadMfaState()
      .then((s) => { if (active) { setState(s); setError('') } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Could not check two-factor status') })
    return () => { active = false }
  }, [token, tick])

  if (error && !state) {
    return (
      <AuthShell title="Something went wrong" subtitle={error}>
        <Button className="w-full" onClick={() => setTick((t) => t + 1)}>Try again</Button>
      </AuthShell>
    )
  }

  if (!state) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    )
  }

  const decision = mfaDecision(adminUser?.role, state)
  const reload = () => setTick((t) => t + 1)

  if (decision === 'verify') {
    return (
      <AuthShell title="Enter your code" subtitle="Open your authenticator app and enter the 6-digit code.">
        <MfaVerify factorId={state.verifiedFactors[0].id} onDone={reload} />
      </AuthShell>
    )
  }

  if (decision === 'enroll') {
    return (
      <AuthShell
        title="Set up two-factor authentication"
        subtitle="Super admin accounts can see every client's data, so they need an authenticator app before continuing."
      >
        <MfaEnroll onDone={reload} />
      </AuthShell>
    )
  }

  return <>{children}</>
}
