import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldOff, Loader2 } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { invalidateMfaState, loadMfaState, mfaRequiredForRole, type MfaState } from '../../lib/mfa'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card'
import Button from '../ui/Button'
import Badge from '../ui/Badge'
import MfaEnroll from './MfaEnroll'

// Settings → "Your account": shows whether two-factor is on and lets the user turn it on or off.
export default function SecurityCard() {
  const { user, adminUser } = useAuth()
  const [state, setState] = useState<MfaState | null>(null)
  const [mode, setMode] = useState<'view' | 'enroll'>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const required = mfaRequiredForRole(adminUser?.role)

  const reload = async () => {
    try {
      setState(await loadMfaState({ force: true }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load two-factor status')
    }
  }

  useEffect(() => { reload() }, [])

  const turnOff = async (factorId: string) => {
    const note = required ? ' You will be asked to set it up again right away, because super admins must have it.' : ''
    if (!window.confirm(`Turn off two-factor authentication for ${user?.email}?${note}`)) return
    setBusy(true)
    setError('')
    try {
      const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId })
      if (unenrollError) throw unenrollError
      invalidateMfaState()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn off two-factor authentication')
    } finally {
      setBusy(false)
    }
  }

  const on = (state?.verifiedFactors.length ?? 0) > 0

  return (
    <Card data-testid="security-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {on ? <ShieldCheck className="h-5 w-5 text-green-600" /> : <ShieldOff className="h-5 w-5 text-gray-400" />}
          Your account
          <span className="text-sm font-normal text-gray-500">({user?.email})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-red-700 mb-3">{error}</p>}
        {!state ? (
          <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        ) : mode === 'enroll' ? (
          <div className="max-w-md">
            <MfaEnroll onDone={() => { setMode('view'); reload() }} onCancel={() => setMode('view')} />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-900">Two-factor authentication</span>
              {on ? <Badge variant="success">On</Badge> : <Badge>Off</Badge>}
              {required && <span className="text-xs text-gray-500">Required for super admins</span>}
            </div>
            {on ? (
              <ul className="space-y-2">
                {state.verifiedFactors.map((f) => (
                  <li key={f.id} className="flex items-center justify-between text-sm border border-gray-200 rounded-lg px-3 py-2">
                    <span>
                      <span className="text-gray-900">{f.friendly_name || 'Authenticator app'}</span>
                      <span className="text-gray-500"> · added {new Date(f.created_at).toLocaleDateString()}</span>
                    </span>
                    <Button variant="outline" size="sm" onClick={() => turnOff(f.id)} disabled={busy}>Turn off</Button>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p className="text-sm text-gray-600">
                  Add an authenticator app so a stolen password alone can't open your account.
                </p>
                <Button onClick={() => setMode('enroll')} disabled={busy}>Set up two-factor</Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
