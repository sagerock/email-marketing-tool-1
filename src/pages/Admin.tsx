import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useClient } from '../context/ClientContext'
import { apiFetch } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import { Shield, UserPlus, Trash2, AlertCircle, Send } from 'lucide-react'

interface AdminUser {
  id: string
  user_id: string
  email: string
  role: 'super_admin' | 'admin' | 'client_admin'
  client_id: string | null
  created_at: string
  client_name?: string
}

export default function Admin() {
  const { isSuperAdmin, user } = useAuth()
  const { clients } = useClient()
  const [admins, setAdmins] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'super_admin' | 'admin' | 'client_admin'>('client_admin')
  const [selectedClientId, setSelectedClientId] = useState<string>('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchAdmins()
  }, [])

  const fetchAdmins = async () => {
    try {
      const res = await apiFetch('/api/admin/users')
      const data = await res.json()
      if (Array.isArray(data)) setAdmins(data)
    } catch (err) {
      console.error('Error fetching admins:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleInviteUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSubmitting(true)

    try {
      const res = await apiFetch('/api/admin/invite-user', {
        method: 'POST',
        body: JSON.stringify({
          email: email.toLowerCase().trim(),
          role,
          clientId: role === 'client_admin' ? selectedClientId : null,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setSuccess(`Invite sent to ${email}! They'll receive an email to set up their account.`)
      setEmail('')
      setRole('client_admin')
      setSelectedClientId('')
      fetchAdmins()

      setTimeout(() => setSuccess(''), 5000)
    } catch (err: any) {
      setError(err.message || 'Failed to invite user')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemoveAdmin = async (adminId: string, adminEmail: string) => {
    if (!confirm(`Remove access for ${adminEmail}?`)) return

    try {
      const res = await apiFetch(`/api/admin/users/${adminId}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error)
      }

      setSuccess(`Removed access for ${adminEmail}`)
      fetchAdmins()

      setTimeout(() => setSuccess(''), 3000)
    } catch (err: any) {
      setError(err.message || 'Failed to remove admin')
    }
  }

  if (!isSuperAdmin) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Access Denied</h1>
          <p className="mt-1 text-sm text-gray-600">
            You need super admin privileges to access this page.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
          <Shield className="h-8 w-8 text-blue-600" />
          Admin Panel
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage user access to the system
        </p>
      </div>

      {/* Messages */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {success && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-800">{success}</p>
        </div>
      )}

      {/* Invite User Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Invite User
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInviteUser} className="space-y-4">
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900">
              <strong>How it works:</strong> Enter the user's email and select their role. They'll receive an invite email with a link to set up their password and access the tool.
            </div>

            <Input
              label="Email Address"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
              <select
                value={role}
                onChange={(e) =>
                  setRole(e.target.value as 'super_admin' | 'admin' | 'client_admin')
                }
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="client_admin">Client Admin - Access to a single client</option>
                <option value="admin">Admin - Access to all clients</option>
                <option value="super_admin">Super Admin - Full system access</option>
              </select>
            </div>

            {role === 'client_admin' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Assign to Client
                </label>
                <select
                  value={selectedClientId}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="">Select a client...</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <Button type="submit" disabled={submitting}>
              <Send className="h-4 w-4 mr-2" />
              {submitting ? 'Sending invite...' : 'Send Invite'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Admin List */}
      <Card>
        <CardHeader>
          <CardTitle>Users ({admins.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading users...</div>
          ) : admins.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No users found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Email
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Role
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Client
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Added
                    </th>
                    <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {admins.map((admin) => (
                    <tr key={admin.id} className="hover:bg-gray-50">
                      <td className="py-3 px-4 text-sm text-gray-900">{admin.email}</td>
                      <td className="py-3 px-4">
                        <Badge
                          variant={
                            admin.role === 'super_admin'
                              ? 'danger'
                              : admin.role === 'admin'
                                ? 'info'
                                : 'default'
                          }
                        >
                          {admin.role.replace('_', ' ')}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-600">
                        {admin.client_name || '-'}
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-600">
                        {new Date(admin.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveAdmin(admin.id, admin.email)}
                          disabled={admin.user_id === user?.id}
                        >
                          <Trash2 className="h-4 w-4 text-red-600" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
