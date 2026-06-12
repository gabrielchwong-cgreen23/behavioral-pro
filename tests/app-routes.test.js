import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMetricsPayload,
  buildSessionFeaturesHealthReport,
  createApp,
  getSessionTimeline,
  getShopDomainFromRequestBody,
  normalizeShop,
  scheduleInterventionDecisionPerformanceLog
} from '../app.js'
import { createMockSupabase } from './helpers/mock-supabase.js'

async function withTestServer({ supabase, fetchImpl, env = {} }, callback) {
  const app = createApp({
    env: {
      SHOPIFY_API_KEY: 'api-key',
      SHOPIFY_API_SECRET: 'secret',
      ANALYTICS_OWNER_TOKEN: 'owner-token',
      TINYBIRD_API_KEY: 'tinybird-query-token',
      TINYBIRD_API_URL: 'https://api.tinybird.test',
      ...env
    },
    supabase,
    fetchImpl
  })

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })

  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    if (!server.listening) {
      return
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

test('createApp fails fast with a clear Supabase env error', () => {
  assert.throws(
    () => createApp({
      env: {
        SHOPIFY_API_KEY: 'api-key',
        SHOPIFY_API_SECRET: 'secret'
      }
    }),
    /Missing SUPABASE_URL/
  )
})

test('createApp accepts an injected Supabase client for local testing', () => {
  const app = createApp({
    env: {
      SHOPIFY_API_KEY: 'api-key',
      SHOPIFY_API_SECRET: 'secret'
    },
    supabase: createMockSupabase()
  })

  assert.equal(typeof app, 'function')
  assert.equal(typeof app.get, 'function')
})

test('normalizeShop appends the myshopify suffix when needed', () => {
  assert.equal(normalizeShop('alpha'), 'alpha.myshopify.com')
  assert.equal(normalizeShop('alpha.myshopify.com'), 'alpha.myshopify.com')
  assert.equal(normalizeShop(''), null)
})

test('getShopDomainFromRequestBody supports both legacy and canonical event payloads', () => {
  assert.equal(
    getShopDomainFromRequestBody({ shop_domain: 'alpha.myshopify.com' }),
    'alpha.myshopify.com'
  )
  assert.equal(
    getShopDomainFromRequestBody({
      properties: {
        shop_domain: 'alpha.myshopify.com'
      }
    }),
    'alpha.myshopify.com'
  )
  assert.equal(getShopDomainFromRequestBody({}), null)
})

test('buildMetricsPayload keeps lift at zero when control revenue per session is zero', () => {
  const payload = buildMetricsPayload('alpha.myshopify.com', {
    sessionTable: [
      {
        session_id: 'sess-1',
        shop_domain: 'alpha.myshopify.com',
        variant: 'control',
        converted: false,
        revenue: 0,
        messages_shown: []
      },
      {
        session_id: 'sess-2',
        shop_domain: 'alpha.myshopify.com',
        variant: 'variant',
        converted: true,
        revenue: 125,
        messages_shown: ['reassurance_assist']
      }
    ],
    totals: {
      sessions: 2,
      convertedSessions: 1,
      revenue: 125,
      triggerCount: 1,
      messageCount: 1,
      rawEventCount: 4,
      conversionRate: 0.5
    }
  })

  assert.equal(payload.shop_domain, 'alpha.myshopify.com')
  assert.equal(payload.control.revenue_per_session, 0)
  assert.equal(payload.variant.revenue_per_session, 125)
  assert.equal(payload.lift_percent, 0)
  assert.equal(payload.exposed.sessions, 1)
  assert.equal(payload.unexposed.sessions, 1)
  assert.equal(payload.exposure_rate, 0.5)
  assert.equal(payload.incremental_revenue_estimate, 125)
})

test('session features health report builds Tinybird-backed diagnostics', async () => {
  const fetchImpl = async (_url, options = {}) => {
    const body = new URLSearchParams(String(options.body || ''))
    const sql = body.get('q') || ''

    if (sql.includes('total_sessions_processed')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{
            total_sessions_processed: 2,
            unique_stores_represented: 1,
            sessions_missing_store_id: 1,
            total_purchases: 1,
            total_reached_checkout: 1,
            total_provisional_abandoned_carts: 0,
            total_provisional_abandoned_checkouts: 1,
            total_had_intervention: 1,
            rows_missing_visitor_id: 0,
            rows_missing_experiment_variant: 0,
            malformed_metadata_count: 1,
            latest_session_seen_at: '2026-05-19 18:05:40.000',
            oldest_session_seen_at: '2026-05-19 18:00:00.000'
          }]
        })
      }
    }

    if (sql.includes('FROM session_features') && sql.includes('GROUP BY store_id')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{ store_id: 'store_1', sessions: 1 }]
        })
      }
    }

    if (sql.includes('FROM session_features') && sql.includes('GROUP BY shop_domain')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{ shop_domain: 'fallback.myshopify.com', sessions: 1 }]
        })
      }
    }

    return {
      ok: true,
      text: async () => JSON.stringify({
        data: [{
          rows_missing_session_id: 0,
          raw_rows_missing_visitor_id: 0,
          raw_rows_missing_experiment_variant: 0,
          duplicate_event_id_count: 2,
          malformed_metadata_count: 1
        }]
      })
    }
  }

  const json = await buildSessionFeaturesHealthReport({
    env: {
      ANALYTICS_OWNER_TOKEN: 'owner-token',
      TINYBIRD_API_KEY: 'tinybird-query-token',
      TINYBIRD_API_URL: 'https://api.tinybird.test'
    },
    fetchImpl
  })

  assert.equal(json.ok, true)
  assert.equal(json.total_sessions_processed, 2)
  assert.equal(json.unique_stores_represented, 1)
  assert.equal(json.sessions_missing_store_id, 1)
  assert.equal(json.conversion_metrics.total_purchases, 1)
  assert.equal(json.data_quality.duplicate_event_id_count, 2)
  assert.deepEqual(json.sessions_by_store_id, [{ store_id: 'store_1', sessions: 1 }])
  assert.deepEqual(json.fallback_sessions_by_shop_domain, [
    { shop_domain: 'fallback.myshopify.com', sessions: 1 }
  ])
})

test('intervention decision performance metrics logging is scheduled asynchronously', async () => {
  let loggerStarted = false
  let loggerFinished = false
  let loggedPayload = null

  scheduleInterventionDecisionPerformanceLog({
    logger: async (payload) => {
      loggerStarted = true
      loggedPayload = payload
      await new Promise(resolve => setTimeout(resolve, 75))
      loggerFinished = true
    },
    payload: {
      route_name: '/api/intervention-decision',
      shopDomain: 'alpha.myshopify.com'
    }
  })

  assert.equal(loggerStarted, false)
  assert.equal(loggerFinished, false)

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loggerStarted, true)
  assert.equal(loggerFinished, false)
  assert.deepEqual(loggedPayload, {
    route_name: '/api/intervention-decision',
    shopDomain: 'alpha.myshopify.com'
  })

  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(loggerFinished, true)
})

test('session timeline maps session_frame rows and event markers into graph-ready data', async () => {
  const fetchImpl = async (_url, options = {}) => {
    const body = new URLSearchParams(String(options.body || ''))
    const sql = body.get('q') || ''

    assert.match(sql, /SESSION TIMELINE|raw_events/)

    return {
      ok: true,
      text: async () => JSON.stringify({
        data: [
          {
            event_id: 'evt_1',
            event_name: 'product_view',
            event_ts: '2026-06-04 12:00:00.000',
            metadata: '{}'
          },
          {
            event_id: 'evt_2',
            event_name: 'session_frame',
            event_ts: '2026-06-04 12:00:02.000',
            metadata: JSON.stringify({
              page_type: 'product',
              journey_stage: 'decision',
              active_zone: 'add_to_cart_zone',
              t_seconds: 2,
              mouse_velocity_avg: 0.04,
              mouse_velocity_max: 0.1,
              mouse_acceleration_avg: 0.01,
              mouse_distance: 42,
              scroll_depth: 0.58,
              scroll_velocity: 0.02,
              cursor_idle_seconds: 0.2,
              hover_cta_seconds: 1.1,
              hover_price_seconds: 0.4,
              hover_policy_seconds: 0.1,
              hover_reviews_seconds: 0.3,
              cta_distance: 88,
              click_count: 1,
              rage_click_count: 0,
              dead_click_count: 0,
              intent_score: 0.74,
              friction_score: 0.21,
              hesitation_score: 0.46,
              policy_anxiety_score: 0.1,
              cart_commitment_score: 0.62,
              abandonment_risk_score: 0.19
            })
          },
          {
            event_id: 'evt_3',
            event_name: 'add_to_cart',
            event_ts: '2026-06-04 12:00:02.500',
            metadata: '{}'
          }
        ]
      })
    }
  }

  const timeline = await getSessionTimeline({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-timeline-1',
    env: {
      TINYBIRD_API_KEY: 'tinybird-query-token',
      TINYBIRD_API_URL: 'https://api.tinybird.test'
    },
    fetchImpl
  })

  assert.equal(timeline.length, 2)
  assert.equal(timeline[0].t_seconds, 0)
  assert.deepEqual(timeline[0].event_markers, ['product_view'])
  assert.equal(timeline[1].t_seconds, 2)
  assert.equal(timeline[1].active_zone, 'add_to_cart_zone')
  assert.deepEqual(timeline[1].event_markers.sort(), ['add_to_cart'])
})

test('session timeline endpoint returns owner-scoped graph data', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      data: [{
        event_id: 'evt_1',
        event_name: 'session_frame',
        event_ts: '2026-06-04 12:00:02.000',
        metadata: JSON.stringify({
          page_type: 'product',
          journey_stage: 'decision',
          active_zone: 'add_to_cart_zone',
          t_seconds: 2,
          mouse_velocity_avg: 0.04,
          mouse_velocity_max: 0.1,
          mouse_acceleration_avg: 0.01,
          mouse_distance: 42,
          scroll_depth: 0.58,
          scroll_velocity: 0.02,
          cursor_idle_seconds: 0.2,
          hover_cta_seconds: 1.1,
          hover_price_seconds: 0.4,
          hover_policy_seconds: 0.1,
          hover_reviews_seconds: 0.3,
          cta_distance: 88,
          click_count: 1,
          rage_click_count: 0,
          dead_click_count: 0,
          intent_score: 0.74,
          friction_score: 0.21,
          hesitation_score: 0.46,
          policy_anxiety_score: 0.1,
          cart_commitment_score: 0.62,
          abandonment_risk_score: 0.19
        })
      }]
    })
  })

  await withTestServer({
    supabase: createMockSupabase(),
    fetchImpl
  }, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/sessions/sess-timeline-1/timeline?shop_domain=${encodeURIComponent('alpha.myshopify.com')}`,
      {
        headers: {
          'x-analytics-token': 'owner-token'
        }
      }
    )

    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(body.data.session_id, 'sess-timeline-1')
    assert.equal(body.data.timeline[0].t_seconds, 2)
  })
})
