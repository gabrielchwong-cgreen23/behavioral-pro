import 'dotenv/config'

const baseUrl = String(
  process.env.BEHAVIORALPRO_BACKEND_URL ||
  process.env.SHOPIFY_APP_URL ||
  'http://127.0.0.1:3001'
).replace(/\/+$/, '')

const ownerToken = String(process.env.ANALYTICS_OWNER_TOKEN || '').trim()

if (!ownerToken) {
  throw new Error('Missing ANALYTICS_OWNER_TOKEN')
}

const response = await fetch(`${baseUrl}/api/internal/trajectory-watchdog`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${ownerToken}`,
    Accept: 'application/json'
  }
})

const payload = await response.text()

if (!response.ok) {
  throw new Error(`Trajectory watchdog failed with status ${response.status}: ${payload}`)
}

console.log(payload)
