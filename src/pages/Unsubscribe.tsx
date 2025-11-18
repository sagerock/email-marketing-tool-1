import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Card, CardContent } from '../components/ui/Card'
import Button from '../components/ui/Button'
import { CheckCircle, XCircle, Mail } from 'lucide-react'

export default function Unsubscribe() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')

  const [loading, setLoading] = useState(true)
  const [contact, setContact] = useState<{ email: string; unsubscribed: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!token) {
      setError('Invalid unsubscribe link. Missing token.')
      setLoading(false)
      return
    }

    fetchContact()
  }, [token])

  const fetchContact = async () => {
    if (!token) return

    setLoading(true)
    try {
      const { data, error: fetchError } = await supabase
        .from('contacts')
        .select('email, unsubscribed')
        .eq('unsubscribe_token', token)
        .single()

      if (fetchError || !data) {
        setError('Invalid or expired unsubscribe link.')
        return
      }

      setContact(data)
    } catch (err) {
      console.error('Error fetching contact:', err)
      setError('An error occurred. Please try again later.')
    } finally {
      setLoading(false)
    }
  }

  const handleUnsubscribe = async () => {
    if (!token) return

    setProcessing(true)
    try {
      const { error: updateError } = await supabase
        .from('contacts')
        .update({
          unsubscribed: true,
          unsubscribed_at: new Date().toISOString(),
        })
        .eq('unsubscribe_token', token)

      if (updateError) throw updateError

      setSuccess(true)
      setContact((prev) => prev ? { ...prev, unsubscribed: true } : null)
    } catch (err) {
      console.error('Error unsubscribing:', err)
      setError('Failed to unsubscribe. Please try again.')
    } finally {
      setProcessing(false)
    }
  }

  const handleResubscribe = async () => {
    if (!token) return

    setProcessing(true)
    try {
      const { error: updateError } = await supabase
        .from('contacts')
        .update({
          unsubscribed: false,
          unsubscribed_at: null,
        })
        .eq('unsubscribe_token', token)

      if (updateError) throw updateError

      setSuccess(true)
      setContact((prev) => prev ? { ...prev, unsubscribed: false } : null)
    } catch (err) {
      console.error('Error resubscribing:', err)
      setError('Failed to resubscribe. Please try again.')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <Mail className="h-12 w-12 mx-auto text-gray-400 mb-3" />
          <h1 className="text-2xl font-bold text-gray-900">Email Preferences</h1>
        </div>

        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                <p className="mt-4 text-sm text-gray-600">Loading...</p>
              </div>
            ) : error ? (
              <div className="text-center py-8">
                <XCircle className="h-12 w-12 mx-auto text-red-500 mb-4" />
                <p className="text-red-600 font-medium mb-2">Error</p>
                <p className="text-sm text-gray-600">{error}</p>
              </div>
            ) : success ? (
              <div className="text-center py-8">
                <CheckCircle className="h-12 w-12 mx-auto text-green-500 mb-4" />
                <p className="text-green-600 font-medium mb-2">Success!</p>
                <p className="text-sm text-gray-600">
                  {contact?.unsubscribed
                    ? 'You have been unsubscribed from our emails.'
                    : 'You have been resubscribed to our emails.'}
                </p>
              </div>
            ) : contact ? (
              <div className="space-y-6">
                <div className="text-center">
                  <p className="text-sm text-gray-600 mb-2">Email Address</p>
                  <p className="font-medium text-gray-900">{contact.email}</p>
                </div>

                {contact.unsubscribed ? (
                  <div>
                    <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 mb-4">
                      <p className="text-sm text-yellow-800">
                        You are currently unsubscribed from our emails.
                      </p>
                    </div>
                    <Button
                      onClick={handleResubscribe}
                      disabled={processing}
                      className="w-full"
                      variant="outline"
                    >
                      {processing ? 'Processing...' : 'Resubscribe to Emails'}
                    </Button>
                  </div>
                ) : (
                  <div>
                    <div className="bg-blue-50 border border-blue-200 rounded-md p-4 mb-4">
                      <p className="text-sm text-blue-800 mb-2">
                        Are you sure you want to unsubscribe?
                      </p>
                      <p className="text-xs text-blue-700">
                        You will no longer receive emails from us.
                      </p>
                    </div>
                    <Button
                      onClick={handleUnsubscribe}
                      disabled={processing}
                      className="w-full"
                      variant="outline"
                    >
                      {processing ? 'Processing...' : 'Unsubscribe from Emails'}
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-gray-500 mt-6">
          This link is unique to your email address and should not be shared.
        </p>
      </div>
    </div>
  )
}
