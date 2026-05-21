import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMetricsPayload,
  buildSessionFeaturesHealthReport,
  createApp,
  getShopDomainFromRequestBody,
  normalizeShop
} from '../app.js'
import { createMockSupabase } from './helpers/mock-supabase.js'

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
