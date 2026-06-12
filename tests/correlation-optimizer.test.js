import test from 'node:test'
import assert from 'node:assert/strict'

import { createMockSupabase } from './helpers/mock-supabase.js'
import {
  BASELINE_DYNAMIC_MULTIPLIERS
} from '../packages/analytics/src/intervention-decision.js'
import {
  MIN_CORRELATION_SESSION_COUNT,
  computePointBiserialCorrelation,
  optimizeDynamicMultipliersFromRows,
  runCorrelationOptimizer
} from '../packages/analytics/src/workers/correlation-optimizer.js'

function buildOptimizerRows(count = MIN_CORRELATION_SESSION_COUNT) {
  return Array.from({ length: count }, (_, index) => {
    const abandoned = index < count / 2 ? 1 : 0
    const purchased = abandoned ? 0 : 1

    return {
      shop_domain: 'alpha.myshopify.com',
      session_id: `sess-${index + 1}`,
      peak_frame_rage_click_count: abandoned ? 2 : 0,
      peak_frame_dead_click_count: abandoned ? 3 : 0,
      peak_hover_policy_seconds: abandoned ? 1.4 : 0.2,
      peak_hover_cta_seconds: abandoned ? 1.1 : 0.4,
      peak_cursor_idle_seconds: abandoned ? 1.8 : 0.5,
      peak_near_cta: abandoned ? 1 : 0,
      peak_active_zone_policy: abandoned ? 1 : 0,
      peak_policy_page: abandoned ? 1 : 0,
      purchased,
      did_intervene: 0,
      abandoned
    }
  })
}

test('computePointBiserialCorrelation returns a positive coefficient for abandonment-linked features', () => {
  const rows = buildOptimizerRows(20)
  const correlation = computePointBiserialCorrelation(
    rows,
    'peak_frame_dead_click_count',
    'abandoned'
  )

  assert.ok(correlation > 0)
})

test('optimizeDynamicMultipliersFromRows falls back to baseline under low sample counts', () => {
  const rows = buildOptimizerRows(50)
  const result = optimizeDynamicMultipliersFromRows(rows, {
    logger: {
      warn() {}
    }
  })

  assert.equal(result.used_baseline, true)
  assert.deepEqual(result.dynamic_multipliers, BASELINE_DYNAMIC_MULTIPLIERS)
})

test('runCorrelationOptimizer persists updated dynamic multipliers per store', async () => {
  const supabase = createMockSupabase({
    stores: [{
      id: 'store_1',
      shop_domain: 'alpha.myshopify.com',
      settings: {
        interventions_enabled: true
      }
    }]
  })

  const rows = buildOptimizerRows()
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({ data: rows })
  })

  const [result] = await runCorrelationOptimizer({
    supabase,
    env: {
      TINYBIRD_API_KEY: 'tinybird-query-token',
      TINYBIRD_API_URL: 'https://api.tinybird.test'
    },
    fetchImpl,
    logger: {
      info() {},
      warn() {}
    }
  })

  assert.equal(result.shop_domain, 'alpha.myshopify.com')
  assert.equal(result.used_baseline, false)
  assert.ok(result.dynamic_multipliers.dead_click > BASELINE_DYNAMIC_MULTIPLIERS.dead_click)

  const updatedStore = supabase._store.tables.stores.find(
    (row) => row.shop_domain === 'alpha.myshopify.com'
  )
  assert.ok(updatedStore)
  assert.ok(
    updatedStore.settings.dynamic_multipliers.dead_click >
      BASELINE_DYNAMIC_MULTIPLIERS.dead_click
  )
})
