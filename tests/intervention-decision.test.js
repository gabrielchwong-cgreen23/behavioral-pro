import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BASELINE_DYNAMIC_MULTIPLIERS,
  applyEventToLiveSessionState,
  buildSessionFeaturesFromLiveState,
  buildSessionFeaturesFromSessionStateRow,
  evaluateInterventionDecision,
  fetchStoreInterventionBenchmarks,
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
  const supabase = createMockSupabase({
    store_benchmarks: [{
      id: 1,
      store_id: 'store_1',
      shop_domain: 'alpha.myshopify.com',
      historical_session_count: 0,
      p75_rage_click_count: 0,
      p75_cta_idle_15s_count: 0,
      p75_policy_page_view_count: 0,
      reached_checkout_rate: 0,
      purchase_rate: 0
    }]
  })

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

  let unexpectedFetches = 0
  const fetchImpl = async () => {
    unexpectedFetches += 1
    throw new Error('Unexpected Tinybird read')
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
    supabase,
    liveSessionState: liveState,
    fetchImpl
  })

  assert.equal(unexpectedFetches, 0)
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
    },
    p_signal_updates: {
      current_friction_score: 0.84,
      hover_cta_seconds_recent: 1.5
    }
  })

  assert.equal(error, null)
  assert.equal(updatedRow.counters.page_views, 1)
  assert.equal(updatedRow.counters.rage_click_count, 2)
  assert.equal(updatedRow.counters.cta_idle_15s_count, 2)
  assert.equal(updatedRow.signals.current_friction_score, 0.84)
  assert.equal(updatedRow.signals.hover_cta_seconds_recent, 1.5)

  const session = buildSessionFeaturesFromSessionStateRow(updatedRow)
  assert.equal(session.rage_click_count, 2)
  assert.equal(session.cta_idle_15s_count, 2)
  assert.equal(session.current_friction_score, 0.84)
})

test('getInterventionDecision uses session_state as current-session source of truth', async () => {
  const supabase = createMockSupabase({
    store_benchmarks: [{
      id: 1,
      store_id: 'store_1',
      shop_domain: 'alpha.myshopify.com',
      historical_session_count: 0,
      p75_rage_click_count: 0,
      p75_cta_idle_15s_count: 0,
      p75_policy_page_view_count: 0,
      reached_checkout_rate: 0,
      purchase_rate: 0
    }],
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

  let unexpectedFetches = 0
  const fetchImpl = async () => {
    unexpectedFetches += 1
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
    fetchImpl
  })

  assert.equal(unexpectedFetches, 0)
  assert.equal(session.rage_click_count, 2)
  assert.equal(result.decision, true)
  assert.equal(result.intervention_type, 'friction_assistance')
})

test('getInterventionDecision can use session_frame-derived signals from session_state', async () => {
  const supabase = createMockSupabase({
    store_benchmarks: [{
      id: 1,
      store_id: 'store_1',
      shop_domain: 'alpha.myshopify.com',
      historical_session_count: 0,
      p75_rage_click_count: 5,
      p75_cta_idle_15s_count: 5,
      p75_policy_page_view_count: 5,
      reached_checkout_rate: 0,
      purchase_rate: 0
    }],
    session_state: [{
      id: 1,
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess-frame-live-1',
      store_id: 'store_1',
      visitor_id: 'visitor_frame_live',
      experiment_variant: 'variant',
      page_url: 'https://alpha.myshopify.com/products/example',
      counters: {
        product_views: 1,
        session_frame_count: 2
      },
      signals: {
        current_friction_score: 0.82,
        current_hesitation_score: 0.8,
        hover_cta_seconds_recent: 1.4,
        mouse_velocity_drop_near_cta: 1,
        dead_click_recent: 1,
        idle_near_cta: 1
      },
      first_seen_at: '2026-05-20T00:00:00.000Z',
      last_seen_at: '2026-05-20T00:00:02.000Z',
      updated_at: '2026-05-20T00:00:02.000Z'
    }]
  })

  const { session, result } = await getInterventionDecision({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-frame-live-1',
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
    fetchImpl: async () => {
      throw new Error('Unexpected Tinybird read')
    }
  })

  assert.equal(session.current_friction_score, 0.82)
  assert.equal(result.decision, true)
  assert.equal(result.intervention_type, 'friction_assistance')
  assert.deepEqual(result.metadata, {
    reason: 'session_frame_friction_detected',
    calculated_threshold: 0.75
  })
})

test('evaluateInterventionDecision recomputes hesitation from dynamic multipliers when raw frame inputs exist', () => {
  const session = {
    rage_click_count: 0,
    cta_idle_15s_count: 0,
    policy_page_view_count: 0,
    add_to_cart_count: 0,
    reached_checkout: 0,
    purchased: 0,
    provisional_abandoned_cart: 0,
    provisional_abandoned_checkout: 0,
    current_hesitation_score: 0.2,
    current_friction_score: 0,
    current_policy_anxiety_score: 0,
    hover_cta_seconds_recent: 1.2,
    hover_policy_seconds_recent: 0,
    cursor_idle_seconds_recent: 1.2,
    near_cta: 1,
    idle_near_cta: 1,
    frame_rage_click_count_recent: 0,
    frame_dead_click_count_recent: 0,
    mouse_velocity_drop_near_cta: 0,
    rage_click_recent: 0,
    dead_click_recent: 0,
    page_type: 'product',
    active_zone: 'add_to_cart_zone'
  }

  const baselineResult = evaluateInterventionDecision({
    session,
    cohort: 'mid_tier',
    storeBenchmarks: {
      historical_session_count: 0,
      p75_rage_click_count: 8,
      p75_cta_idle_15s_count: 8,
      p75_policy_page_view_count: 8
    },
    storeConfig: {
      is_active: true,
      settings: {
        dynamic_multipliers: BASELINE_DYNAMIC_MULTIPLIERS
      }
    }
  })

  assert.equal(baselineResult.decision, true)
  assert.equal(baselineResult.intervention_type, 'reassurance_assist')
  assert.deepEqual(baselineResult.metadata, {
    reason: 'session_frame_hesitation_detected',
    calculated_threshold: 0.75
  })

  const dampenedResult = evaluateInterventionDecision({
    session,
    cohort: 'mid_tier',
    storeBenchmarks: {
      historical_session_count: 0,
      p75_rage_click_count: 8,
      p75_cta_idle_15s_count: 8,
      p75_policy_page_view_count: 8
    },
    storeConfig: {
      is_active: true,
      settings: {
        dynamic_multipliers: {
          ...BASELINE_DYNAMIC_MULTIPLIERS,
          cta_hover: 0.1,
          cursor_idle: 0.1,
          near_cta: 0.1
        }
      }
    }
  })

  assert.equal(dampenedResult.decision, false)
  assert.equal(dampenedResult.intervention_type, 'none')
  assert.deepEqual(dampenedResult.metadata, {
    reason: 'below_threshold',
    calculated_threshold: 2
  })
})

test('fetchStoreInterventionBenchmarks reads from Supabase once and then serves cached thresholds', async () => {
  const supabase = createMockSupabase({
    store_benchmarks: [{
      id: 1,
      store_id: 'store_1',
      shop_domain: 'alpha.myshopify.com',
      historical_session_count: 250,
      p75_rage_click_count: 4,
      p75_cta_idle_15s_count: 5,
      p75_policy_page_view_count: 2,
      reached_checkout_rate: 0.4,
      purchase_rate: 0.12
    }]
  })

  let queryCount = 0
  const originalFrom = supabase.from.bind(supabase)
  supabase.from = (table) => {
    if (table === 'store_benchmarks') {
      queryCount += 1
    }
    return originalFrom(table)
  }

  const cache = {
    map: new Map(),
    get({ shopDomain = '', storeId = '' } = {}) {
      return this.map.get(`${storeId}::${shopDomain}`) || null
    },
    set({ shopDomain = '', storeId = '' } = {}, value = {}) {
      this.map.set(`${storeId}::${shopDomain}`, value)
      return value
    }
  }

  const first = await fetchStoreInterventionBenchmarks({
    supabase,
    shopDomain: 'alpha.myshopify.com',
    storeId: 'store_1',
    cache
  })

  const second = await fetchStoreInterventionBenchmarks({
    supabase,
    shopDomain: 'alpha.myshopify.com',
    storeId: 'store_1',
    cache
  })

  assert.equal(queryCount, 1)
  assert.deepEqual(first, second)
  assert.equal(first.historical_session_count, 250)
  assert.equal(first.p75_rage_click_count, 4)
  assert.equal(first.p75_cta_idle_15s_count, 5)
  assert.equal(first.p75_policy_page_view_count, 2)
})

test('getInterventionDecision records benchmark and evaluate timings when requested', async () => {
  const supabase = createMockSupabase({
    store_benchmarks: [{
      id: 1,
      store_id: 'store_timing_1',
      shop_domain: 'timing.myshopify.com',
      historical_session_count: 0,
      p75_rage_click_count: 0,
      p75_cta_idle_15s_count: 0,
      p75_policy_page_view_count: 0,
      reached_checkout_rate: 0,
      purchase_rate: 0
    }],
    session_state: [{
      id: 1,
      shop_domain: 'timing.myshopify.com',
      session_id: 'sess-timing-1',
      store_id: 'store_timing_1',
      visitor_id: 'visitor-timing',
      experiment_variant: 'variant',
      page_url: 'https://timing.myshopify.com/products/example',
      counters: {
        product_views: 1,
        rage_click_count: 2
      },
      first_seen_at: '2026-05-20T00:00:00.000Z',
      last_seen_at: '2026-05-20T00:00:02.000Z',
      updated_at: '2026-05-20T00:00:02.000Z'
    }]
  })

  const originalFrom = supabase.from.bind(supabase)
  supabase.from = (table) => {
    const builder = originalFrom(table)
    if (table !== 'store_benchmarks') {
      return builder
    }

    const originalMaybeSingle = builder.maybeSingle.bind(builder)
    builder.maybeSingle = async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      return originalMaybeSingle()
    }
    return builder
  }

  const decisionTiming = {
    fetch_store_intervention_benchmarks_ms: null,
    evaluate_ms: null
  }

  const { result } = await getInterventionDecision({
    shopDomain: 'timing.myshopify.com',
    sessionId: 'sess-timing-1',
    storeRecord: {
      id: 'store_timing_1',
      shop_domain: 'timing.myshopify.com',
      settings: {
        aov_cohort: 'mid_tier',
        interventions_enabled: true,
        is_active: true
      }
    },
    supabase,
    decisionTiming
  })

  assert.equal(result.decision, true)
  assert.ok(Number(decisionTiming.fetch_store_intervention_benchmarks_ms) >= 20)
  assert.ok(Number(decisionTiming.evaluate_ms) >= 0)
})
