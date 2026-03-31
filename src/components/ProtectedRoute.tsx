import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useEffect, useState } from 'react'
import { ShieldX } from 'lucide-react'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, adminUser, adminLoading } = useAuth()
  const [showTimeout, setShowTimeout] = useState(false)

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (loading || adminLoading) {
        setShowTimeout(true)
      }
    }, 10000)

    return () => clearTimeout(timeout)
  }, [loading, adminLoading])

  if (loading || adminLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
          {showTimeout && (
            <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg max-w-md mx-auto">
              <p className="text-sm text-yellow-800">
                Authentication is taking longer than expected.
                Please check your browser console for errors and ensure your Supabase credentials are correct.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 text-blue-600 hover:text-blue-700 text-sm font-medium"
              >
                Refresh Page
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/welcome" replace />
  }

  // User is authenticated but has no admin record
  if (!adminUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-md">
          <ShieldX className="h-16 w-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Access Denied</h2>
          <p className="text-gray-600 mb-6">
            Your account does not have access to this tool. Please contact your administrator to request access.
          </p>
          <button
            onClick={async () => {
              const { supabase } = await import('../lib/supabase')
              await supabase.auth.signOut()
              window.location.href = '/login'
            }}
            className="text-blue-600 hover:text-blue-700 text-sm font-medium"
          >
            Sign out and try a different account
          </button>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
