import { Link } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

// Full-page frame for the two-factor screens, styled like the sign-in page.
export default function AuthShell({ title, subtitle, children }: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  const { user, signOut } = useAuth()
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap');
        .auth-page { font-family: 'DM Sans', sans-serif; }
        .auth-page h1 { font-family: 'DM Serif Display', serif; }
      `}</style>
      <div className="auth-page min-h-screen bg-slate-900 flex flex-col" data-testid="mfa-shell">
        <header className="w-full border-b border-white/5">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <Link to="/welcome">
                <img src="/sagerock-logo.png" alt="SageRock" className="h-9 w-auto" />
              </Link>
            </div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="text-center mb-8">
              <ShieldCheck className="h-12 w-12 text-amber-400 mx-auto mb-4" />
              <h1 className="text-3xl text-white mb-2">{title}</h1>
              {subtitle && <p className="text-slate-400">{subtitle}</p>}
            </div>
            <div className="bg-white rounded-xl shadow-2xl p-8">{children}</div>
            <p className="mt-6 text-center text-sm text-slate-400">
              Signed in as {user?.email}.{' '}
              <button
                type="button"
                onClick={async () => {
                  try { await signOut() } catch { /* already signed out */ }
                  window.location.assign('/login')
                }}
                className="text-amber-400 hover:text-amber-300 font-medium"
              >
                Sign out
              </button>
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
