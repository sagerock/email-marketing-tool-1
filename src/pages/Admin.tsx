import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useClient } from '../context/ClientContext'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import { Shield, UserPlus, Trash2, AlertCircle } from 'lucide-react'

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
  const { isSuperAdmin, user, refreshAdminStatus } = useAuth()
  const { clients } = useClient()
  const [admins, setAdmins] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'super_admin' | 'admin' | 'client_admin'>('admin')
  const [selectedClientId, setSelectedClientId] = useState<string>('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchAdmins()
  }, [])

  const fetchAdmins = async () => {
    try {
      const { data, error } = await supabase
        .from('admin_users')
        .select(`
          *,
          clients (
            name
          )
        `)
        .order('created_at', { ascending: false })

      if (error) throw error

      const adminsWithClientNames = data.map((admin: any) => ({
        ...admin,
        client_name: admin.clients?.name || null,
      }))

      setAdmins(adminsWithClientNames)
    } catch (err) {
      console.error('Error fetching admins:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleAddAdminWithUserId = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSubmitting(true)

    try {
      // Check if user exists and get their ID
      const { data: authData } = await supabase.auth.admin.listUsers()
      const targetUser = authData?.users?.find((u) => u.email === email.toLowerCase())

      if (!targetUser) {
        setError('User not found. They must sign up first at /signup')
        setSubmitting(false)
        return
      }

      // Check if already an admin
      const { data: existing } = await supabase
        .from('admin_users')
        .select('id')
        .eq('user_id', targetUser.id)
        .single()

      if (existing) {
        setError('This user is already an admin')
        setSubmitting(false)
        return
      }

      // Add as admin
      const insertData: any = {
        user_id: targetUser.id,
        email: targetUser.email,
        role,
        created_by: user?.id,
      }

      if (role === 'client_admin' && selectedClientId) {
        insertData.client_id = selectedClientId
      } else {
        insertData.client_id = null
      }

      const { error: insertError } = await supabase.from('admin_users').insert(insertData)

      if (insertError) throw insertError

      setSuccess(`Successfully added ${email} as ${role.replace('_', ' ')}`)
      setEmail('')
      setRole('admin')
      setSelectedClientId('')
      fetchAdmins()
      refreshAdminStatus()

      setTimeout(() => setSuccess(''), 3000)
    } catch (err: any) {
      setError(err.message || 'Failed to add admin')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemoveAdmin = async (adminId: string, adminEmail: string) => {
    if (!confirm(`Remove admin access for ${adminEmail}?`)) return

    try {
      const { error } = await supabase.from('admin_users').delete().eq('id', adminId)

      if (error) throw error

      setSuccess(`Removed admin access for ${adminEmail}`)
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
          Manage administrative access to the system
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

      {/* Add Admin Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Add New Admin
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAddAdminWithUserId} className="space-y-4">
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900">
              <strong>Note:</strong> The user must sign up at{' '}
              <code className="bg-blue-100 px-1 py-0.5 rounded">/signup</code> before you can
              add them as an admin.
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
                <option value="super_admin">Super Admin - Full system access</option>
                <option value="admin">Admin - All clients access</option>
                <option value="client_admin">Client Admin - Single client access</option>
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
              {submitting ? 'Adding...' : 'Add Admin'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Admin List */}
      <Card>
        <CardHeader>
          <CardTitle>Current Admins ({admins.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading admins...</div>
          ) : admins.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No admins found</div>
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
