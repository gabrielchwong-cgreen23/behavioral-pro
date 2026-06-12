import 'dotenv/config'

import { createClient } from '@supabase/supabase-js'

import {
  getAnalyticsOverview
} from '../packages/analytics/src/index.js'
import {
  getInterventionDecision
} from '../packages/analytics/src/intervention-decision.js'

const LIVE_BASE = String(
  process.env.BEHAVIORALPRO_BACKEND_BASE ||
  process.env.BACKEND_BASE ||
  'https://behavioral-pro-production.up.railway.app'
).replace(/\/+$/, '')
const SHOP = process.env.BEHAVIORALPRO_SHOP_DOMAIN || 'behavior-test-store.myshopify.com'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function post(path, body) {
  const started = Date.now()
  const response = await fetch(`${LIVE_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  const json = await response.json().catch(() => null)
  return {
    ok: response.ok,
    status: response.status,
    json,
    duration_ms: Date.now() - started
  }
}

async function getJson(path) {
  const started = Date.now()
  const response = await fetch(`${LIVE_BASE}${path}`)
  const json = await response.json().catch(() => null)
  return {
    ok: response.ok,
    status: response.status,
    json,
    duration_ms: Date.now() - started
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function assignSession(label) {
  const seed = Date.now() + Math.floor(Math.random() * 1000)
  const sessionId = `${label}_${seed}`
  const visitorId = `${label}_visitor_${seed}`
  const pagePath = '/products/validator'
  const assignment = await post('/api/assign-variant', {
    shop_domain: SHOP,
    session_id: sessionId,
    visitor_id: visitorId,
    page_url: `https://${SHOP}${pagePath}`,
    referrer: 'https://www.google.com/'
  })

  assert(assignment.ok && assignment.json?.success, `assign failed for ${label}`)

  return {
    sessionId,
    visitorId,
    pagePath,
    variant: assignment.json?.data?.variant || 'control',
    assign: assignment
  }
}

async function sendEvents(session, events, source) {
  const baseTs = Math.floor(Date.now() / 1000)
  const results = []

  for (const [eventName, offsetSeconds, metadata] of events) {
    const response = await post('/api/events', {
      anonymous_id: session.visitorId,
      session_id: session.sessionId,
      event_name: eventName,
      timestamp: baseTs + offsetSeconds,
      properties: {
        shop_domain: SHOP,
        path: session.pagePath,
        referrer: 'https://www.google.com/',
        experiment_variant: session.variant,
        source,
        ...metadata
      }
    })
    results.push({
      event_name: eventName,
      status: response.status,
      ok: response.ok,
      duration_ms: response.duration_ms
    })
  }

  return results
}

async function fetchDecision(sessionId) {
  return post('/api/intervention-decision', {
    shop_domain: SHOP,
    session_id: sessionId
  })
}

async function fetchPublicStorefrontConfig() {
  return getJson(`/api/public-storefront-config/${encodeURIComponent(SHOP)}`)
}

async function fetchSessionState(sessionId) {
  const { data, error } = await supabase
    .from('session_state')
    .select('*')
    .eq('shop_domain', SHOP)
    .eq('session_id', sessionId)
    .maybeSingle()

  return { data, error }
}

async function fetchOverview() {
  return getAnalyticsOverview({ shopDomain: SHOP }, { supabase })
}

async function fetchStoreRecord() {
  const { data, error } = await supabase
    .from('stores')
    .select('*')
    .eq('shop_domain', SHOP)
    .maybeSingle()

  if (error) throw error
  return data
}

async function updateStoreSettings(nextSettings) {
  const existing = await fetchStoreRecord()
  const merged = {
    ...(existing?.settings || {}),
    ...nextSettings
  }

  const { data, error } = await supabase
    .from('stores')
    .update({ settings: merged })
    .eq('shop_domain', SHOP)
    .select('*')
    .maybeSingle()

  if (error) throw error

  return {
    before: existing?.settings || {},
    after: data?.settings || merged
  }
}

async function runScenario(name, events, {
  source = name,
  delays = [0, 250, 500, 1000],
  expectDecision = null
} = {}) {
  const session = await assignSession(name)
  const sentEvents = await sendEvents(session, events, source)
  const checks = []

  for (const delay of delays) {
    if (delay) await sleep(delay)
    const decision = await fetchDecision(session.sessionId)
    checks.push({
      checked_after_ms: delay,
      status: decision.status,
      duration_ms: decision.duration_ms,
      body: decision.json
    })

    if (decision.json?.decision) {
      break
    }
  }

  const sessionState = await fetchSessionState(session.sessionId)
  const overview = await fetchOverview()
  const overviewSession = overview.sessionTable.find((row) => row.session_id === session.sessionId) || null
  const latestDecision = checks[checks.length - 1]?.body || null

  if (expectDecision === true) {
    assert(checks.some((item) => item.body?.decision === true), `${name} never returned a positive decision`)
  }

  if (expectDecision === false) {
    assert(checks.every((item) => item.body?.decision === false), `${name} unexpectedly returned a positive decision`)
  }

  return {
    sessionId: session.sessionId,
    variant: session.variant,
    assign_ms: session.assign.duration_ms,
    events: sentEvents,
    checks,
    session_state: sessionState.data
      ? {
          counters: sessionState.data.counters,
          updated_at: sessionState.data.updated_at,
          last_seen_at: sessionState.data.last_seen_at
        }
      : null,
    overview_session: overviewSession,
    latest_decision: latestDecision,
    totals_snapshot: overview.totals
  }
}

async function runControlToggleScenario() {
  const original = await fetchStoreRecord()
  const originalSettings = clone(original?.settings || {})
  const result = {}

  try {
    await updateStoreSettings({ interventions_enabled: false, shadow_mode: false })
    const disabled = await runScenario('controls_disabled', [
      ['page_view', 0, {}],
      ['product_view', 1, { product_handle: 'validator-product' }],
      ['rage_click', 2, {}],
      ['rage_click', 3, {}]
    ], { delays: [0, 250, 500], expectDecision: false })
    result.interventions_disabled = disabled.latest_decision

    await updateStoreSettings({ interventions_enabled: true, shadow_mode: true })
    const shadowed = await runScenario('controls_shadow', [
      ['page_view', 0, {}],
      ['product_view', 1, { product_handle: 'validator-product' }],
      ['rage_click', 2, {}],
      ['rage_click', 3, {}]
    ], { delays: [0, 250, 500, 1000], expectDecision: true })
    result.shadow_mode = shadowed.latest_decision

    await updateStoreSettings({ interventions_enabled: true, shadow_mode: false, tidio_enabled: false })
    const publicConfig = await fetchPublicStorefrontConfig()
    result.tidio_disabled_config = publicConfig.json?.data?.config || null
  } finally {
    await updateStoreSettings(originalSettings)
  }

  return result
}

async function runCooldownScenario() {
  const session = await assignSession('cooldown')
  await sendEvents(session, [
    ['page_view', 0, {}],
    ['product_view', 1, { product_handle: 'validator-product' }],
    ['rage_click', 2, {}],
    ['rage_click', 3, {}]
  ], 'cooldown_test')

  const firstDecision = await fetchDecision(session.sessionId)
  assert(firstDecision.json?.decision === true, 'cooldown first decision was not positive')

  await post('/api/events', {
    anonymous_id: session.visitorId,
    session_id: session.sessionId,
    event_name: 'intervention_triggered',
    timestamp: Math.floor(Date.now() / 1000),
    properties: {
      shop_domain: SHOP,
      path: session.pagePath,
      referrer: 'https://www.google.com/',
      experiment_variant: session.variant,
      source: 'cooldown_test'
    }
  })

  const secondDecision = await fetchDecision(session.sessionId)

  return {
    sessionId: session.sessionId,
    first: firstDecision.json,
    second: secondDecision.json
  }
}

async function runLocalFallbackTests() {
  const fallbackPositive = await getInterventionDecision({
    shopDomain: SHOP,
    sessionId: 'fallback_positive',
    storeRecord: {
      settings: {
        aov_cohort: 'mid_tier',
        interventions_enabled: true,
        is_active: true
      }
    },
    supabase: {
      from(table) {
        return {
          table,
          select() { return this },
          eq(column, value) {
            this[column] = value
            return this
          },
          async maybeSingle() {
            if (this.table === 'session_state') {
              return { data: null, error: { message: 'session_state unavailable' } }
            }
            if (this.table === 'store_benchmarks' && (this.store_id === 'store_1' || this.shop_domain === SHOP)) {
              return {
                data: {
                  historical_session_count: 0,
                  p75_rage_click_count: 0,
                  p75_cta_idle_15s_count: 0,
                  p75_policy_page_view_count: 0,
                  reached_checkout_rate: 0,
                  purchase_rate: 0
                },
                error: null
              }
            }
            return { data: null, error: null }
          }
        }
      }
    },
    env: {
      TINYBIRD_HOST: 'https://api.tinybird.test',
      TINYBIRD_QUERY_TOKEN: 'query-token'
    },
    fetchImpl: async (_url, options = {}) => {
      const body = new URLSearchParams(String(options.body || ''))
      const sql = body.get('q') || ''

      if (sql.includes('FROM raw_events') && sql.includes('session_id')) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: [{
              store_id: 'store_1',
              shop_domain: SHOP,
              session_id: 'fallback_positive',
              visitor_id: 'visitor_fallback',
              experiment_variant: 'variant',
              rage_click_count: 2,
              cta_idle_15s_count: 0,
              policy_page_view_count: 0,
              add_to_cart_count: 0,
              begin_checkout_count: 0,
              purchase_count: 0,
              intervention_triggered_count: 0,
              reached_checkout: 0,
              purchased: 0,
              provisional_abandoned_cart: 0,
              provisional_abandoned_checkout: 0
            }]
          })
        }
      }

      throw new Error(`Unexpected fallback fetch SQL: ${sql}`)
    }
  })

  const noData = await getInterventionDecision({
    shopDomain: SHOP,
    sessionId: 'fallback_none',
    storeRecord: {
      settings: {
        aov_cohort: 'mid_tier',
        interventions_enabled: true,
        is_active: true
      }
    },
    supabase: {
      from(table) {
        return {
          table,
          select() { return this },
          eq(column, value) {
            this[column] = value
            return this
          },
          async maybeSingle() {
            if (this.table === 'session_state') {
              return { data: null, error: { message: 'session_state unavailable' } }
            }
            if (this.table === 'store_benchmarks' && this.shop_domain === SHOP) {
              return {
                data: {
                  historical_session_count: 0,
                  p75_rage_click_count: 0,
                  p75_cta_idle_15s_count: 0,
                  p75_policy_page_view_count: 0,
                  reached_checkout_rate: 0,
                  purchase_rate: 0
                },
                error: null
              }
            }
            return { data: null, error: null }
          }
        }
      }
    },
    env: {
      TINYBIRD_HOST: 'https://api.tinybird.test',
      TINYBIRD_QUERY_TOKEN: 'query-token'
    },
    fetchImpl: async (url, options = {}) => {
      const body = new URLSearchParams(String(options.body || ''))
      const sql = body.get('q') || ''

      if (sql.includes('FROM raw_events') && sql.includes('session_id')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ data: [] })
        }
      }

      if (String(url).includes('/v0/pipes/')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ data: [] })
        }
      }

      throw new Error(`Unexpected noData fetch SQL: ${sql}`)
    }
  }).catch((error) => ({ error: error.message }))

  return {
    fallbackPositive: fallbackPositive.result,
    noData
  }
}

async function main() {
  const report = {
    live: {},
    controls: {},
    localFallback: {}
  }

  report.live.negative_flow = await runScenario('negative_flow', [
    ['page_view', 0, {}],
    ['product_view', 1, { product_handle: 'validator-product' }]
  ], { expectDecision: false, delays: [0, 250, 500] })

  report.live.friction_flow = await runScenario('friction_flow', [
    ['page_view', 0, {}],
    ['product_view', 1, { product_handle: 'validator-product' }],
    ['rage_click', 2, {}],
    ['rage_click', 3, {}],
    ['cta_idle_15s', 4, {}],
    ['cta_idle_15s', 5, {}],
    ['policy_page_view', 6, {}]
  ], { expectDecision: true })

  report.live.checkout_flow = await runScenario('checkout_flow', [
    ['page_view', 0, {}],
    ['product_view', 1, { product_handle: 'validator-product' }],
    ['add_to_cart', 2, { cart_value: 79 }],
    ['begin_checkout', 3, { cart_value: 79 }]
  ], { expectDecision: true })

  report.live.cart_flow = await runScenario('cart_flow', [
    ['page_view', 0, {}],
    ['product_view', 1, { product_handle: 'validator-product' }],
    ['add_to_cart', 2, { cart_value: 79 }]
  ], { expectDecision: true })

  report.live.trust_flow = await runScenario('trust_flow', [
    ['page_view', 0, {}],
    ['product_view', 1, { product_handle: 'validator-product' }],
    ['policy_page_view', 2, {}]
  ], { expectDecision: true })

  report.live.cta_flow = await runScenario('cta_flow', [
    ['page_view', 0, {}],
    ['product_view', 1, { product_handle: 'validator-product' }],
    ['cta_idle_15s', 2, {}],
    ['cta_idle_15s', 3, {}]
  ], { expectDecision: true })

  report.live.purchase_flow = await runScenario('purchase_flow', [
    ['page_view', 0, {}],
    ['product_view', 1, { product_handle: 'validator-product' }],
    ['add_to_cart', 2, { cart_value: 79 }],
    ['begin_checkout', 3, { cart_value: 79 }],
    ['purchase', 4, { cart_value: 79, value: 79 }]
  ], { expectDecision: false, delays: [0, 250, 500] })

  report.controls = await runControlToggleScenario()
  report.cooldown = await runCooldownScenario()
  report.localFallback = await runLocalFallbackTests()

  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
  console.error('run-launch-validation failed:', error.message || error)
  process.exitCode = 1
})
