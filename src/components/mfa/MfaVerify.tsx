import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { invalidateMfaState } from '../../lib/mfa'
import Button from '../ui/Button'
import Input from '../ui/Input'

// Step-up prompt: the user already has a verified factor and this session is still AAL1.
export default function MfaVerify({ factorId, onDone }: { factorId: string; onDone: () => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
      if (verifyError) throw verifyError
      invalidateMfaState()
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code did not work. Try the next one.')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5" data-testid="mfa-verify">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}
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
      <Button type="submit" className="w-full bg-amber-500 hover:bg-amber-600 text-white focus-visible:ring-amber-500" disabled={busy || code.length !== 6}>
        {busy ? 'Checking…' : 'Continue'}
      </Button>
    </form>
  )
}
