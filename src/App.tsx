import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { ClientProvider } from './context/ClientContext'
import Layout from './components/Layout'
import Contacts from './pages/Contacts'
import Templates from './pages/Templates'
import Campaigns from './pages/Campaigns'
import Analytics from './pages/Analytics'
import Settings from './pages/Settings'
import Unsubscribe from './pages/Unsubscribe'

function App() {
  return (
    <ClientProvider>
      <Router>
        <Routes>
          {/* Public route - no layout */}
          <Route path="/unsubscribe" element={<Unsubscribe />} />

          {/* Authenticated routes with layout */}
          <Route path="/" element={<Layout><Contacts /></Layout>} />
          <Route path="/templates" element={<Layout><Templates /></Layout>} />
          <Route path="/campaigns" element={<Layout><Campaigns /></Layout>} />
          <Route path="/analytics" element={<Layout><Analytics /></Layout>} />
          <Route path="/settings" element={<Layout><Settings /></Layout>} />
        </Routes>
      </Router>
    </ClientProvider>
  )
}

export default App
