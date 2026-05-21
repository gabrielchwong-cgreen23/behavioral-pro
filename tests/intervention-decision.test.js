import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyEventToLiveSessionState,
  buildSessionFeaturesFromLiveState,
  buildSessionFeaturesFromSessionStateRow,
  getInterventionDecision,
  seedLiveSessionState
} from '../packages/analytics/src/intervention-decision.js'
import { createMockSupabase } from './helpers/mock-supabase.js'

test('live session state tracks counters for immediate decisioning', () => {
  let state = seedLiveSessionState({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-1',
    storeId: 'store_1',
    visitorId: 'visitor_1',
    experimentVariant: 'variant',
    pageUrl: 'https://alpha.myshopify.com/products/example',
    referrer: 'https://google.com/',
    seenAt: '2026-05-20T00:00:00.000Z'
  })

  for (const eventName of [
    'product_view',
    'rage_click',
    'rage_click',
    'cta_idle_15s',
    'policy_page_view'
  ]) {
    state = applyEventToLiveSessionState(state, {
      store_id: 'store_1',
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess-1',
      visitor_id: 'visitor_1',
      experiment_variant: 'variant',
      page_url: 'https://alpha.myshopify.com/products/example',
      referrer: 'https://google.com/',
      event_name: eventName,
      server_timestamp: '2026-05-20T00:00:05.000Z'
    })
  }

  const session = buildSessionFeaturesFromLiveState(state)
  assert.equal(session.product_views, 1)
  assert.equal(session.rage_click_count, 2)
  assert.equal(session.cta_idle_15s_count, 1)
  assert.equal(session.policy_page_view_count, 1)
})

test('getInterventionDecision prefers live session state before Tinybird session reads', async () => {
  let liveState = seedLiveSessionState({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-2',
    storeId: 'store_1',
    visitorId: 'visitor_2',
    experimentVariant: 'variant',
    pageUrl: 'https://alpha.myshopify.com/products/example',
    seenAt: '2026-05-20T00:00:00.000Z'
  })

  for (const eventName of ['product_view', 'rage_click', 'rage_click']) {
    liveState = applyEventToLiveSessionState(liveState, {
      store_id: 'store_1',
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess-2',
      visitor_id: 'visitor_2',
      experiment_variant: 'variant',
      page_url: 'https://alpha.myshopify.com/products/example',
      event_name: eventName,
      server_timestamp: '2026-05-20T00:00:05.000Z'
    })
  }

  let benchmarkQueries = 0
  let unexpectedSessionQueries = 0
  const fetchImpl = async (_url, options = {}) => {
    const body = new URLSearchParams(String(options.body || ''))
    const sql = body.get('q') || ''

    if (sql.includes('historical_session_count')) {
      benchmarkQueries += 1
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{
            historical_session_count: 0,
            p75_rage_click_count: 0,
            p75_cta_idle_15s_count: 0,
            p75_policy_page_view_count: 0,
            reached_checkout_rate: 0,
            purchase_rate: 0
          }]
        })
      }
    }

    unexpectedSessionQueries += 1
    throw new Error('Unexpected current-session Tinybird read')
  }

  const { session, result } = await getInterventionDecision({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-2',
    storeRecord: {
      id: 'store_1',
      shop_domain: 'alpha.myshopify.com',
      settings: {
        aov_cohort: 'mid_tier',
        interventions_enabled: true,
        is_active: true
      }
    },
    liveSessionState: liveState,
    env: {
      TINYBIRD_HOST: 'https://api.tinybird.test',
      TINYBIRD_QUERY_TOKEN: 'query-token'
    },
    fetchImpl
  })

  assert.equal(benchmarkQueries, 1)
  assert.equal(unexpectedSessionQueries, 0)
  assert.equal(session.rage_click_count, 2)
  assert.equal(result.decision, true)
  assert.equal(result.intervention_type, 'friction_assistance')
  assert.equal(result.message_id, 'tidio_friction_assistance_v1')
})

test('session_state rpc merges counters atomically for hot-session reads', async () => {
  const supabase = createMockSupabase()

  await supabase.rpc('upsert_session_state_counters', {
    p_shop_domain: 'alpha.myshopify.com',
    p_session_id: 'sess-hot-1',
    p_store_id: 'store_1',
    p_visitor_id: 'visitor_3',
    p_experiment_variant: 'variant',
    p_page_url: 'https://alpha.myshopify.com/products/example',
    p_seen_at: '2026-05-20T00:00:00.000Z',
    p_counter_deltas: {
      page_views: 1,
      rage_click_count: 1
    }
  })

  const { data: updatedRow, error } = await supabase.rpc('upsert_session_state_counters', {
    p_shop_domain: 'alpha.myshopify.com',
    p_session_id: 'sess-hot-1',
    p_store_id: 'store_1',
    p_visitor_id: 'visitor_3',
    p_experiment_variant: 'variant',
    p_page_url: 'https://alpha.myshopify.com/products/example',
    p_seen_at: '2026-05-20T00:00:01.000Z',
    p_counter_deltas: {
      rage_click_count: 1,
      cta_idle_15s_count: 2
    }
  })

  assert.equal(error, null)
  assert.equal(updatedRow.counters.page_views, 1)
  assert.equal(updatedRow.counters.rage_click_count, 2)
  assert.equal(updatedRow.counters.cta_idle_15s_count, 2)

  const session = buildSessionFeaturesFromSessionStateRow(updatedRow)
  assert.equal(session.rage_click_count, 2)
  assert.equal(session.cta_idle_15s_count, 2)
})

test('getInterventionDecision uses session_state as current-session source of truth', async () => {
  const supabase = createMockSupabase({
    session_state: [{
      id: 1,
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess-hot-2',
      store_id: 'store_1',
      visitor_id: 'visitor_4',
      experiment_variant: 'variant',
      page_url: 'https://alpha.myshopify.com/products/example',
      referrer: 'https://google.com/',
      counters: {
        product_views: 1,
        rage_click_count: 2
      },
      first_seen_at: '2026-05-20T00:00:00.000Z',
      last_seen_at: '2026-05-20T00:00:02.000Z',
      updated_at: '2026-05-20T00:00:02.000Z'
    }]
  })

  let benchmarkQueries = 0
  let unexpectedSessionQueries = 0
  const fetchImpl = async (_url, options = {}) => {
    const body = new URLSearchParams(String(options.body || ''))
    const sql = body.get('q') || ''

    if (sql.includes('historical_session_count')) {
      benchmarkQueries += 1
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{
            historical_session_count: 0,
            p75_rage_click_count: 0,
            p75_cta_idle_15s_count: 0,
            p75_policy_page_view_count: 0,
            reached_checkout_rate: 0,
            purchase_rate: 0
          }]
        })
      }
    }

    unexpectedSessionQueries += 1
    throw new Error('Unexpected Tinybird current-session read')
  }

  const { session, result } = await getInterventionDecision({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-hot-2',
    storeRecord: {
      id: 'store_1',
      shop_domain: 'alpha.myshopify.com',
      settings: {
        aov_cohort: 'mid_tier',
        interventions_enabled: true,
        is_active: true
      }
    },
    supabase,
    env: {
      TINYBIRD_HOST: 'https://api.tinybird.test',
      TINYBIRD_QUERY_TOKEN: 'query-token'
    },
    fetchImpl
  })

  assert.equal(benchmarkQueries, 1)
  assert.equal(unexpectedSessionQueries, 0)
  assert.equal(session.rage_click_count, 2)
  assert.equal(result.decision, true)
  assert.equal(result.intervention_type, 'friction_assistance')
})
