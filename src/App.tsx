import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { ClientProvider } from './context/ClientContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/auth/Login'
import Signup from './pages/auth/Signup'
import Contacts from './pages/Contacts'
import Templates from './pages/Templates'
import Campaigns from './pages/Campaigns'
import Automations from './pages/Automations'
import Analytics from './pages/Analytics'
import Settings from './pages/Settings'
import Unsubscribe from './pages/Unsubscribe'
import Admin from './pages/Admin'
import DebugAuth from './pages/DebugAuth'

function App() {
  return (
    <AuthProvider>
      <ClientProvider>
        <Router>
          <Routes>
            {/* Public routes - no authentication required */}
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/unsubscribe" element={<Unsubscribe />} />
            <Route path="/debug" element={<DebugAuth />} />

            {/* Protected routes - authentication required */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Contacts />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/templates"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Templates />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/campaigns"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Campaigns />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/automations"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Automations />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/analytics"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Analytics />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Settings />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Admin />
                  </Layout>
                </ProtectedRoute>
              }
            />
          </Routes>
        </Router>
      </ClientProvider>
    </AuthProvider>
  )
}

export default App
