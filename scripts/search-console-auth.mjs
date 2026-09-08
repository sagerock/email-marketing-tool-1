import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../api/package.json', import.meta.url))
require('dotenv').config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })
const { createClient } = require('@supabase/supabase-js')
const { encrypt } = require('../api/crypto-utils')

const CLIENT_CONFIG_PATH = process.env.GOOGLE_OAUTH_CLIENT_PATH || path.join(os.homedir(), '.gmail-mcp', 'gcp-oauth.keys.json')
const STATE_PATH = path.join(os.homedir(), '.config', 'sagerock', 'search-console-oauth-state.json')
const LOCAL_CREDENTIAL_PATH = path.join(os.homedir(), '.config', 'sagerock', 'search-console-credentials.json')
const REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:19876/mcp/oauth/callback'
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/webmasters.readonly',
]

function oauthClient() {
  const parsed = JSON.parse(fs.readFileSync(CLIENT_CONFIG_PATH, 'utf8'))
  const client = parsed.installed || parsed.web
  if (!client?.client_id || !client?.client_secret) throw new Error('Invalid Google OAuth client file')
  return client
}

function base64url(buffer) {
  return buffer.toString('base64url')
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

function parseCode(value) {
  if (!value) throw new Error('Provide the authorization code or full callback URL')
  if (!value.startsWith('http')) return value
  return new URL(value).searchParams.get('code')
}

async function installCredential(credentials, accountEmail) {
  if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.ENCRYPTION_KEY) {
    throw new Error('VITE_SUPABASE_URL, SUPABASE_SERVICE_KEY, and ENCRYPTION_KEY are required')
  }
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('id')
    .eq('name', 'Center for Orthopedics')
    .single()
  if (clientError) throw new Error(`Could not find Center for Orthopedics tenant: ${clientError.message}`)

  const encrypted = encrypt(JSON.stringify(credentials), process.env.ENCRYPTION_KEY)
  const { error } = await supabase.from('search_console_credentials').upsert({
    client_id: client.id,
    encrypted_credentials: encrypted,
    google_account_email: accountEmail,
    scopes: SCOPES,
  }, { onConflict: 'client_id' })
  if (error) throw new Error(`Could not install encrypted credential: ${error.message}`)
  console.log(`Installed an encrypted Search Console credential for Center for Orthopedics (${accountEmail}).`)
}

const command = process.argv[2]
if (command === 'url') {
  const client = oauthClient()
  const verifier = base64url(crypto.randomBytes(48))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  const state = base64url(crypto.randomBytes(24))
  writePrivateJson(STATE_PATH, { verifier, state, created_at: new Date().toISOString(), redirect_uri: REDIRECT_URI })

  const url = new URL(client.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString()
  console.log(url.toString())
} else if (command === 'code') {
  const code = parseCode(process.argv[3])
  const stateData = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  if (process.argv[3]?.startsWith('http')) {
    const callbackState = new URL(process.argv[3]).searchParams.get('state')
    if (callbackState !== stateData.state) throw new Error('OAuth state did not match')
  }
  const client = oauthClient()
  const response = await fetch(client.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: stateData.redirect_uri,
      grant_type: 'authorization_code',
      code_verifier: stateData.verifier,
    }),
    signal: AbortSignal.timeout(60000),
  })
  const token = await response.json()
  if (!response.ok) throw new Error(`Token exchange failed (${response.status}): ${token.error_description || token.error}`)
  if (!token.refresh_token) throw new Error('Google did not return a refresh token; run the URL step again with consent')
  const grantedScopes = new Set(String(token.scope || '').split(/\s+/).filter(Boolean))
  if (!grantedScopes.has('https://www.googleapis.com/auth/webmasters.readonly')) {
    throw new Error(`Google did not grant Search Console read-only access (granted: ${[...grantedScopes].join(', ') || 'none'})`)
  }

  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(30000),
  })
  const profile = await profileResponse.json()
  if (!profileResponse.ok) throw new Error('Could not identify the authorized Google account')

  const credentials = {
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: token.refresh_token,
    token_uri: client.token_uri || 'https://oauth2.googleapis.com/token',
  }
  writePrivateJson(LOCAL_CREDENTIAL_PATH, { ...credentials, account_email: profile.email, scopes: [...grantedScopes] })
  console.log(`Saved a local Search Console-only credential for ${profile.email}.`)
  if (process.argv.includes('--install')) {
    await installCredential(credentials, profile.email)
    fs.rmSync(LOCAL_CREDENTIAL_PATH, { force: true })
    fs.rmSync(STATE_PATH, { force: true })
    console.log('Removed the temporary local credential and OAuth state after installation.')
  }
} else {
  console.log('Usage:')
  console.log('  node scripts/search-console-auth.mjs url')
  console.log('  node scripts/search-console-auth.mjs code <code-or-callback-url> --install')
}
