import 'dotenv/config'
import assert from 'node:assert/strict'

const BACKEND_BASE = String(
  process.env.BEHAVIORALPRO_BACKEND_BASE ||
  process.env.BACKEND_BASE ||
  'http://127.0.0.1:3001'
).replace(/\/+$/, '')
const SHOP_DOMAIN = process.env.BEHAVIORALPRO_SHOP_DOMAIN || 'behavior-test-store.myshopify.com'

function requireEnv(name, value) {
  if (value) return value
  throw new Error(`Missing required env var: ${name}`)
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  const json = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`POST ${url} failed with status ${response.status}: ${JSON.stringify(json)}`)
  }

  return json
}

async function getJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  })

  const json = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`GET ${url} failed with status ${response.status}: ${JSON.stringify(json)}`)
  }

  return json
}

function buildSessionPayloads() {
  const seed = Date.now()

  return {
    sessionId: `decision_validation_${seed}`,
    visitorId: `decision_visitor_${seed}`,
    pagePath: '/products/validator',
    events: [
      ['page_view', 0, {}],
      ['product_view', 2, { product_handle: 'validator-product' }],
      ['add_to_cart', 4, { product_handle: 'validator-product', cart_value: 79 }],
      ['begin_checkout', 8, { cart_value: 79 }]
    ]
  }
}

async function assignVariant(sessionId, visitorId, pageUrl) {
  const result = await postJson(`${BACKEND_BASE}/api/assign-variant`, {
    shop_domain: SHOP_DOMAIN,
    session_id: sessionId,
    visitor_id: visitorId,
    page_url: pageUrl,
    referrer: 'https://www.google.com/'
  })

  assert.equal(result.success, true)
  return result.data
}

async function sendEvents(session, experimentVariant) {
  const startedAt = Date.now()
  for (const [eventName, offsetSeconds, metadata] of session.events) {
    const result = await postJson(`${BACKEND_BASE}/api/events`, {
      anonymous_id: session.visitorId,
      session_id: session.sessionId,
      event_name: eventName,
      timestamp: Math.floor((startedAt + (offsetSeconds * 1000)) / 1000),
      properties: {
        shop_domain: SHOP_DOMAIN,
        path: session.pagePath,
        referrer: 'https://www.google.com/',
        experiment_variant: experimentVariant,
        source: 'live_intervention_validation',
        ...metadata
      }
    })

    assert.equal(result.success, true)
  }
}

async function fetchDecision(sessionId) {
  const result = await postJson(`${BACKEND_BASE}/api/intervention-decision`, {
    shop_domain: SHOP_DOMAIN,
    session_id: sessionId
  })

  return result
}

async function fetchStorefrontConfig() {
  const result = await getJson(
    `${BACKEND_BASE}/api/public-storefront-config/${encodeURIComponent(SHOP_DOMAIN)}`
  )

  assert.equal(result.success, true)
  return result.data?.config || {}
}

async function main() {
  requireEnv('BEHAVIORALPRO_BACKEND_BASE or BACKEND_BASE', BACKEND_BASE)

  const session = buildSessionPayloads()
  const pageUrl = `https://${SHOP_DOMAIN}${session.pagePath}`

  console.log(`Running live intervention validation against ${BACKEND_BASE} for ${SHOP_DOMAIN}`)

  const assignment = await assignVariant(session.sessionId, session.visitorId, pageUrl)
  console.log(`Assigned ${session.sessionId} to variant=${assignment.variant} store_id=${assignment.store_id || ''}`)

  await sendEvents(session, assignment.variant)
  console.log(`Forwarded ${session.events.length} events for ${session.sessionId}`)

  const decision = await fetchDecision(session.sessionId)
  const storefrontConfig = await fetchStorefrontConfig()

  console.log('Decision response:')
  console.table([{
    decision: Boolean(decision.decision),
    strategy: decision.strategy || '',
    intervention_type: decision.intervention_type || '',
    message_id: decision.message_id || '',
    shadow_mode: Boolean(decision.shadow_mode)
  }])

  console.log('Storefront delivery config:')
  console.table([{
    tidio_enabled: storefrontConfig.tidio_enabled !== false,
    tidio_project_id: storefrontConfig.tidio_project_id || '',
    shadow_mode: storefrontConfig.shadow_mode === true,
    interventions_enabled: storefrontConfig.interventions_enabled !== false
  }])

  if (!decision.decision) {
    console.log('Decision layer did not approve an intervention. This is fail-closed behavior unless your live data or store config should have produced a yes.')
    return
  }

  assert.notEqual(String(decision.message_id || '').trim(), '')
  console.log('Backend approved an intervention. The remaining live check is opening the storefront and confirming Tidio uses this message_id:', decision.message_id)
}

main().catch((error) => {
  console.error('validate-live-intervention failed:', error.message || error)
  process.exitCode = 1
})
