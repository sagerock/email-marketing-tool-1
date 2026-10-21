import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { invalidateMfaState, loadMfaState, qrDataUrl } from '../../lib/mfa'
import Button from '../ui/Button'
import Input from '../ui/Input'

interface Pending { factorId: string; qr: string; secret: string }

// Enrolls a TOTP factor: starts enrollment on mount, shows the QR code and secret, and
// verifies the first code. Abandoned (unverified) factors from earlier attempts are removed
// first so the account doesn't fill up with half-finished entries.
export default function MfaEnroll({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      try {
        const state = await loadMfaState({ force: true })
        for (const f of state.unverifiedFactors) {
          await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => undefined)
        }
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
        const { data, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: 'totp',
          friendlyName: `Authenticator app (${stamp})`,
        })
        if (enrollError) throw enrollError
        setPending({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start two-factor setup')
      }
    })()
  }, [])

  const verify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pending) return
    setBusy(true)
    setError('')
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: pending.factorId })
      if (challengeError) throw challengeError
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: pending.factorId,
        challengeId: challenge.id,
        code: code.trim(),
      })
      if (verifyError) throw verifyError
      invalidateMfaState()
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code did not work. Try the next one.')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (pending) await supabase.auth.mfa.unenroll({ factorId: pending.factorId }).catch(() => undefined)
    invalidateMfaState()
    onCancel?.()
  }

  return (
    <form onSubmit={verify} className="space-y-5" data-testid="mfa-enroll">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}
      <ol className="text-sm text-slate-700 space-y-1 list-decimal list-inside">
        <li>Open an authenticator app (1Password, Google Authenticator, Authy, Microsoft Authenticator).</li>
        <li>Scan this code, or type the key below into the app.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {!pending ? (
        <div className="flex items-center justify-center py-8 text-slate-500 text-sm">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Preparing your code…
        </div>
      ) : (
        <>
          <div className="flex justify-center">
            <img
              src={qrDataUrl(pending.qr)}
              alt="QR code for your authenticator app"
              className="h-48 w-48 border border-slate-200 rounded-lg bg-white"
              data-testid="mfa-qr"
            />
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-1">Can't scan? Enter this key by hand:</p>
            <code className="block text-sm font-mono bg-slate-100 rounded px-3 py-2 break-all select-all" data-testid="mfa-secret">
              {pending.secret}
            </code>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">6-digit code</label>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              disabled={busy}
              autoFocus
              data-testid="mfa-code"
            />
          </div>
          <div className="flex gap-3">
            <Button type="submit" className="flex-1 bg-amber-500 hover:bg-amber-600 text-white focus-visible:ring-amber-500" disabled={busy || code.length !== 6}>
              {busy ? 'Checking…' : 'Turn on two-factor'}
            </Button>
            {onCancel && (
              <Button type="button" variant="outline" onClick={cancel} disabled={busy}>Cancel</Button>
            )}
          </div>
        </>
      )}
    </form>
  )
}
