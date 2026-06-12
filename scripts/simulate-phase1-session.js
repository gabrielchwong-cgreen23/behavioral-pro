const backendBase = String(
  process.env.BEHAVIORALPRO_BACKEND_BASE ||
  process.env.BACKEND_BASE ||
  'http://127.0.0.1:3001'
).replace(/\/+$/, '')

const shopDomain = process.env.BEHAVIORALPRO_SHOP_DOMAIN || 'alpha.myshopify.com'
const sessionId = process.env.BEHAVIORALPRO_SESSION_ID || `sess_${Date.now()}`
const visitorId = process.env.BEHAVIORALPRO_VISITOR_ID || `visitor_${Date.now()}`
const pageUrl = process.env.BEHAVIORALPRO_PAGE_URL || `https://${shopDomain}/products/widget`
const referrer = process.env.BEHAVIORALPRO_REFERRER || 'https://google.com/search?q=widget'

async function postJson(path, body) {
  const response = await fetch(`${backendBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  const json = await response.json().catch(() => ({}))

  if (!response.ok || !json.success) {
    throw new Error(`${path} failed: ${json.error || response.status}`)
  }

  return json
}

async function main() {
  const assigned = await postJson('/api/assign-variant', {
    shop_domain: shopDomain,
    session_id: sessionId,
    visitor_id: visitorId,
    page_url: pageUrl,
    referrer
  })

  const experimentVariant = assigned.data.variant
  const eventNames = [
    'page_view',
    'product_view',
    'product_dwell_12s',
    'add_to_cart',
    'begin_checkout'
  ]

  for (let index = 0; index < eventNames.length; index += 1) {
    const eventName = eventNames[index]
    const timestamp = Math.floor((Date.now() + index * 1000) / 1000)

    const json = await postJson('/api/events', {
      anonymous_id: visitorId,
      session_id: sessionId,
      event_name: eventName,
      timestamp,
      properties: {
        shop_domain: shopDomain,
        path: new URL(pageUrl).pathname,
        referrer,
        source: 'phase1_simulation',
        product_id: 'gid://shopify/Product/1',
        product_handle: 'widget',
        ordinal: index + 1,
        experiment_variant: experimentVariant
      }
    })

    console.log(`${eventName}: ${json.data.event_id} duplicate=${json.data.duplicate}`)
  }

  console.log(`session=${sessionId} variant=${experimentVariant}`)
}

main().catch(error => {
  console.error(error.message || error)
  process.exitCode = 1
})
