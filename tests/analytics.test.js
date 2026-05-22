import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getAnalyticsOverview,
  getTriggerConversionRates,
  trackBehavioralEvent,
  trackSessionStarted
} from '../packages/analytics/src/index.js'
import { buildMetricsPayload } from '../app.js'
import { createMockSupabase } from './helpers/mock-supabase.js'

test('shared analytics stays session-based and dedupes duplicate purchases', async () => {
  const supabase = createMockSupabase()
  const options = { supabase }

  await trackSessionStarted({
    eventType: 'experiment_assignment',
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-1',
    variant: 'control',
    occurredAt: '2026-05-05T00:00:00.000Z'
  }, options)

  await trackBehavioralEvent({
    eventType: 'product_page_view',
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-1',
    variant: 'control',
    occurredAt: '2026-05-05T00:00:10.000Z'
  }, options)

  await trackBehavioralEvent({
    eventType: 'message_shown',
    messageName: 'free-shipping',
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-1',
    variant: 'control',
    occurredAt: '2026-05-05T00:00:12.000Z'
  }, options)

  await trackBehavioralEvent({
    eventType: 'purchase',
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-1',
    variant: 'control',
    value: 125,
    occurredAt: '2026-05-05T00:00:20.000Z'
  }, options)

  await trackBehavioralEvent({
    eventType: 'purchase',
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess-1',
    variant: 'control',
    value: 125,
    occurredAt: '2026-05-05T00:00:21.000Z'
  }, options)

  await trackSessionStarted({
    eventType: 'experiment_assignment',
    shopDomain: 'beta.myshopify.com',
    sessionId: 'sess-2',
    variant: 'variant',
    occurredAt: '2026-05-05T00:01:00.000Z'
  }, options)

  await trackBehavioralEvent({
    eventType: 'add_to_cart_click',
    shopDomain: 'beta.myshopify.com',
    sessionId: 'sess-2',
    variant: 'variant',
    occurredAt: '2026-05-05T00:01:05.000Z'
  }, options)

  const overview = await getAnalyticsOverview({ shopDomain: 'alpha.myshopify.com' }, options)
  const payload = buildMetricsPayload('alpha.myshopify.com', overview)
  const rates = await getTriggerConversionRates({ shopDomain: 'alpha.myshopify.com' }, options)

  assert.equal(overview.totals.sessions, 1)
  assert.equal(overview.totals.convertedSessions, 1)
  assert.equal(overview.totals.revenue, 125)
  assert.equal(overview.totals.rawEventCount, 4)
  assert.deepEqual(overview.sessionTable[0].triggers_fired, ['product_page_view'])
  assert.deepEqual(overview.sessionTable[0].messages_shown, ['free-shipping'])
  assert.equal(payload.control.purchases, 1)
  assert.equal(payload.control.revenue, 125)
  assert.equal(payload.control.conversion_rate, 1)
  assert.equal(rates.length, 1)
  assert.equal(rates[0].triggerType, 'product_page_view')
  assert.equal(rates[0].conversionRate, 1)
})

test('analytics overview supplements session_state-backed sessions when events table is empty', async () => {
  const supabase = createMockSupabase({
    experiment_sessions: [{
      id: 1,
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess-hot-dashboard',
      variant: 'variant',
      created_at: '2026-05-21T17:35:50.985Z'
    }],
    session_state: [{
      id: 1,
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess-hot-dashboard',
      experiment_variant: 'variant',
      counters: {
        page_views: 1,
        product_views: 1,
        rage_click_count: 2,
        intervention_triggered_count: 1
      },
      first_seen_at: '2026-05-21T17:35:50.985Z',
      last_seen_at: '2026-05-21T17:35:56.422Z',
      updated_at: '2026-05-21T17:35:56.422Z'
    }]
  })

  const overview = await getAnalyticsOverview({ shopDomain: 'alpha.myshopify.com' }, { supabase })
  const session = overview.sessionTable.find((row) => row.session_id === 'sess-hot-dashboard')

  assert.equal(overview.totals.sessions, 1)
  assert.equal(overview.totals.rawEventCount, 6)
  assert.ok(session)
  assert.deepEqual(session.triggers_fired, ['product_view', 'rage_click', 'rage_click'])
  assert.deepEqual(session.messages_shown, ['intervention_triggered'])
})

test('analytics overview carries purchase revenue from session_state-backed sessions', async () => {
  const supabase = createMockSupabase({
    experiment_sessions: [{
      id: 1,
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess-hot-purchase',
      variant: 'variant',
      created_at: '2026-05-21T17:40:00.000Z'
    }],
    session_state: [{
      id: 2,
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess-hot-purchase',
      experiment_variant: 'variant',
      counters: {
        page_views: 1,
        product_views: 1,
        add_to_cart_count: 1,
        begin_checkout_count: 1,
        purchase_count: 1,
        purchase_revenue_total: 79
      },
      first_seen_at: '2026-05-21T17:40:00.000Z',
      last_seen_at: '2026-05-21T17:40:06.000Z',
      updated_at: '2026-05-21T17:40:06.000Z'
    }]
  })

  const overview = await getAnalyticsOverview({ shopDomain: 'alpha.myshopify.com' }, { supabase })
  const session = overview.sessionTable.find((row) => row.session_id === 'sess-hot-purchase')

  assert.ok(session)
  assert.equal(session.converted, true)
  assert.equal(session.revenue, 79)
})
