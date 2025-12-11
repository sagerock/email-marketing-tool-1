import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useEffect, useState } from 'react'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const [showTimeout, setShowTimeout] = useState(false)

  useEffect(() => {
    console.log('ProtectedRoute - loading:', loading, 'user:', user?.email)

    // Show timeout message if loading takes more than 10 seconds
    const timeout = setTimeout(() => {
      if (loading) {
        setShowTimeout(true)
      }
    }, 10000)

    return () => clearTimeout(timeout)
  }, [loading, user])

  if (loading) {
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
    console.log('ProtectedRoute - No user, redirecting to landing page')
    return <Navigate to="/welcome" replace />
  }

  console.log('ProtectedRoute - User authenticated, rendering children')
  return <>{children}</>
}
