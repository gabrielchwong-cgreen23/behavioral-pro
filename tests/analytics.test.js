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
