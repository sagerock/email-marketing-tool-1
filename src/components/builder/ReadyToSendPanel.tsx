import { useEffect, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, Loader2, MousePointerClick, Wand2 } from 'lucide-react'
import type { EmailIssue } from '../../lib/emailChecks'
import { cn } from '../../lib/utils'

interface Props {
  issues: EmailIssue[]
  busy: boolean
  /** Link health is still being fetched. */
  checkingLinks?: boolean
  /** Select the issue's element in the preview. */
  onShow: (issue: EmailIssue) => void
  /** Ask the AI to fix it, or put a starter sentence in the chat box. */
  onFix: (issue: EmailIssue) => void
}

export default function ReadyToSendPanel({ issues, busy, checkingLinks = false, onShow, onFix }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const errors = issues.filter(i => i.severity === 'error').length
  const warnings = issues.length - errors

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const summary = errors
    ? `${errors} to fix${warnings ? `, ${warnings} to review` : ''}`
    : warnings ? `${warnings} to review` : 'Ready to send'

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="Ready to send check"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1.5 rounded px-2 py-1 text-sm font-medium transition-colors',
          errors ? 'bg-red-50 text-red-700 hover:bg-red-100'
            : warnings ? 'bg-amber-50 text-amber-800 hover:bg-amber-100'
              : 'bg-green-50 text-green-700 hover:bg-green-100'
        )}
        title="Checks links, placeholders, images, compliance and Outlook problems"
      >
        {errors ? <AlertCircle className="h-4 w-4" /> : warnings ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        {summary}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[420px] max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 px-3 py-2">
            <p className="text-sm font-semibold text-gray-900">Ready to send?</p>
            <p className="text-xs text-gray-500">Checked on every change. Red items should be fixed before sending.</p>
            {checkingLinks && (
              <p className="mt-1 flex items-center gap-1 text-xs text-gray-500"><Loader2 className="h-3 w-3 animate-spin" /> Checking that links load…</p>
            )}
          </div>
          {issues.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-green-700">
              <CheckCircle2 className="h-4 w-4" /> No problems found: links load, and images, footer and Outlook checks all pass.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {issues.map(issue => (
                <li key={issue.id} className="px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    {issue.severity === 'error'
                      ? <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" />
                      : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">{issue.title}</p>
                      <p className="text-xs text-gray-600">{issue.detail}</p>
                      <div className="mt-1.5 flex gap-2">
                        {issue.span && (
                          <button type="button" onClick={() => { onShow(issue); setOpen(false) }}
                            className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50">
                            <MousePointerClick className="h-3 w-3" /> Show me
                          </button>
                        )}
                        {(issue.fixPrompt || issue.fixDraft) && (
                          <button type="button" disabled={busy} onClick={() => { onFix(issue); setOpen(false) }}
                            className="inline-flex items-center gap-1 rounded border border-purple-200 bg-purple-50 px-2 py-0.5 text-xs text-purple-800 hover:bg-purple-100 disabled:opacity-50">
                            <Wand2 className="h-3 w-3" /> {issue.fixPrompt ? 'Fix it' : 'Fix it…'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
