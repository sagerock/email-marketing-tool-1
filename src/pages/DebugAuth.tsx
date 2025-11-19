import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

export default function DebugAuth() {
  const auth = useAuth()
  const [sessionData, setSessionData] = useState<any>(null)
  const [userData, setUserData] = useState<any>(null)
  const [localStorageData, setLocalStorageData] = useState<any>(null)

  useEffect(() => {
    checkAuth()
  }, [])

  const checkAuth = async () => {
    // Check localStorage
    const stored = localStorage.getItem('supabase.auth.token')
    setLocalStorageData(stored ? JSON.parse(stored) : null)

    // Check session
    const { data: { session } } = await supabase.auth.getSession()
    setSessionData(session)

    // Check user
    const { data: { user } } = await supabase.auth.getUser()
    setUserData(user)
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">🔍 Auth Debug Page</h1>

      <div className="space-y-6">
        {/* Auth Context */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-3">Auth Context</h2>
          <div className="space-y-2 text-sm">
            <p><strong>Loading:</strong> {auth.loading ? '✓ TRUE' : '✗ FALSE'}</p>
            <p><strong>User:</strong> {auth.user?.email || 'None'}</p>
            <p><strong>Session:</strong> {auth.session ? '✓ Active' : '✗ None'}</p>
            <p><strong>Admin User:</strong> {auth.adminUser?.email || 'None'}</p>
          </div>
        </div>

        {/* LocalStorage */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-3">LocalStorage</h2>
          <pre className="bg-gray-100 p-4 rounded text-xs overflow-auto">
            {localStorageData ? JSON.stringify(localStorageData, null, 2) : 'No session in localStorage'}
          </pre>
        </div>

        {/* Session Data */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-3">Session Data</h2>
          <pre className="bg-gray-100 p-4 rounded text-xs overflow-auto">
            {sessionData ? JSON.stringify(sessionData, null, 2) : 'No session'}
          </pre>
        </div>

        {/* User Data */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-3">User Data</h2>
          <pre className="bg-gray-100 p-4 rounded text-xs overflow-auto">
            {userData ? JSON.stringify(userData, null, 2) : 'No user'}
          </pre>
        </div>

        {/* Actions */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-3">Actions</h2>
          <div className="flex gap-3">
            <button
              onClick={checkAuth}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Refresh Data
            </button>
            <button
              onClick={() => {
                localStorage.clear()
                window.location.reload()
              }}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Clear LocalStorage & Reload
            </button>
            <button
              onClick={async () => {
                await supabase.auth.signOut()
                window.location.href = '/login'
              }}
              className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
