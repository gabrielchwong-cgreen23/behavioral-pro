import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getAnalyticsOverview,
  trackBehavioralEvent,
  trackSessionStarted
} from '../packages/analytics/src/index.js'
import { buildMetricsPayload } from '../app.js'
import { createMockSupabase } from './helpers/mock-supabase.js'

test('stress harness covers multi-store concurrency with shared analytics storage', async () => {
  const supabase = createMockSupabase()
  const options = { supabase }
  const stores = Array.from({ length: 8 }, (_, index) => `stress-${index}.myshopify.com`)
  const sessionsPerStore = 40
  const tasks = []

  for (const [storeIndex, shopDomain] of stores.entries()) {
    for (let sessionIndex = 0; sessionIndex < sessionsPerStore; sessionIndex += 1) {
      const sessionId = `sess-${storeIndex}-${sessionIndex}`
      const variant = sessionIndex % 2 === 0 ? 'control' : 'variant'
      const shouldConvert = sessionIndex % 4 === 0

      tasks.push((async () => {
        await trackSessionStarted({
          eventType: 'experiment_assignment',
          shopDomain,
          sessionId,
          variant,
          occurredAt: `2026-05-05T00:${String(storeIndex).padStart(2, '0')}:${String(sessionIndex).padStart(2, '0')}.000Z`
        }, options)

        await trackBehavioralEvent({
          eventType: sessionIndex % 3 === 0 ? 'product_page_view' : 'add_to_cart_click',
          shopDomain,
          sessionId,
          variant,
          occurredAt: `2026-05-05T01:${String(storeIndex).padStart(2, '0')}:${String(sessionIndex).padStart(2, '0')}.000Z`
        }, options)

        if (shouldConvert) {
          await trackBehavioralEvent({
            eventType: 'purchase',
            shopDomain,
            sessionId,
            variant,
            value: 50 + sessionIndex,
            occurredAt: `2026-05-05T02:${String(storeIndex).padStart(2, '0')}:${String(sessionIndex).padStart(2, '0')}.000Z`
          }, options)
        } else {
          await trackBehavioralEvent({
            eventType: 'session_ended',
            shopDomain,
            sessionId,
            variant,
            occurredAt: `2026-05-05T02:${String(storeIndex).padStart(2, '0')}:${String(sessionIndex).padStart(2, '0')}.500Z`
          }, options)
        }
      })())
    }
  }

  await Promise.all(tasks)

  const overview = await getAnalyticsOverview({ shopDomain: stores[0] }, options)
  const payload = buildMetricsPayload(stores[0], overview)
  const totalStoreSessions = stores.length * sessionsPerStore

  assert.equal(supabase._store.tables.experiment_sessions.length, totalStoreSessions)
  assert.equal(overview.totals.sessions, sessionsPerStore)
  assert.equal(overview.totals.convertedSessions, 10)
  assert.equal(payload.control.sessions + payload.variant.sessions, sessionsPerStore)
  assert.equal(payload.control.purchases + payload.variant.purchases, 10)
})
