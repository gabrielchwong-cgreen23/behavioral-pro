import 'dotenv/config'
import assert from 'node:assert/strict'
import {
  getTinybirdHost,
  getTinybirdQueryToken,
  queryTinybirdSql,
  toTinybirdSqlString
} from '../packages/analytics/src/tinybird.js'
import { buildSessionFeaturesSelectSql } from '../packages/analytics/src/session-features-sql.js'

const BACKEND_BASE = process.env.BEHAVIORALPRO_BACKEND_BASE || 'http://127.0.0.1:3001'
const SHOP_DOMAIN = process.env.BEHAVIORALPRO_SHOP_DOMAIN || 'phase2-validation.myshopify.com'
const POLL_TIMEOUT_MS = Number(process.env.BEHAVIORALPRO_VALIDATION_TIMEOUT_MS || 90000)
const POLL_INTERVAL_MS = Number(process.env.BEHAVIORALPRO_VALIDATION_POLL_MS || 4000)

function requireTinybirdEnv() {
  if (!getTinybirdQueryToken(process.env)) {
    throw new Error('Missing Tinybird query token env var')
  }

  if (!process.env.TINYBIRD_API_URL && !process.env.TINYBIRD_HOST) {
    throw new Error('Missing TINYBIRD_API_URL or TINYBIRD_HOST')
  }
}

function createSessionPayloads() {
  const seed = Date.now()
  const session1 = `phase2_sess1_${seed}`
  const session2 = `phase2_sess2_${seed}`

  return [
    {
      sessionId: session1,
      visitorId: `phase2_visitor1_${seed}`,
      events: [
        ['page_view', '2026-05-19T18:00:00.000Z', {}],
        ['product_view', '2026-05-19T18:00:03.000Z', { product_handle: 'widget-1' }],
        ['product_dwell_12s', '2026-05-19T18:00:15.000Z', { product_handle: 'widget-1' }],
        ['add_to_cart', '2026-05-19T18:00:17.000Z', { product_handle: 'widget-1', cart_value: 59 }],
        ['begin_checkout', '2026-05-19T18:00:28.000Z', { cart_value: 59 }]
      ]
    },
    {
      sessionId: session2,
      visitorId: `phase2_visitor2_${seed}`,
      events: [
        ['page_view', '2026-05-19T18:05:00.000Z', {}],
        ['product_view', '2026-05-19T18:05:04.000Z', { product_handle: 'widget-2' }],
        ['policy_page_view', '2026-05-19T18:05:09.000Z', { page_kind: 'shipping-policy' }],
        ['cta_idle_15s', '2026-05-19T18:05:24.000Z', { cta_id: 'buy-now' }],
        ['intervention_triggered', '2026-05-19T18:05:26.000Z', { intervention_type: 'shipping_reassurance' }],
        ['purchase', '2026-05-19T18:05:40.000Z', { value: 89 }]
      ]
    }
  ]
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  const json = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`POST ${url} failed with status ${response.status}: ${JSON.stringify(json)}`)
  }

  return json
}

async function assignVariant(sessionId, visitorId) {
  return postJson(`${BACKEND_BASE}/api/assign-variant`, {
    shop_domain: SHOP_DOMAIN,
    session_id: sessionId,
    visitor_id: visitorId,
    page_url: `https://${SHOP_DOMAIN}/products/validator`,
    referrer: 'https://www.google.com/'
  })
}

async function sendEvents(session) {
  for (let index = 0; index < session.events.length; index += 1) {
    const [eventName, timestamp, metadata] = session.events[index]
    const response = await postJson(`${BACKEND_BASE}/api/events`, {
      anonymous_id: session.visitorId,
      session_id: session.sessionId,
      event_name: eventName,
      timestamp: Math.floor(new Date(timestamp).getTime() / 1000),
      properties: {
        shop_domain: SHOP_DOMAIN,
        path: '/products/validator',
        referrer: 'https://www.google.com/',
        ...metadata
      }
    })

    console.log(`Forwarded ${eventName} for ${session.sessionId}: duplicate=${Boolean(response?.data?.duplicate)}`)
  }
}

async function fetchSessionFeatureRows(sessionIds) {
  const quotedSessionIds = sessionIds.map((value) => toTinybirdSqlString(value)).join(', ')
  const sql = buildSessionFeaturesSelectSql({
    whereClause: `shop_domain = ${toTinybirdSqlString(SHOP_DOMAIN)} AND session_id IN (${quotedSessionIds})`,
    orderBy: 'session_id ASC',
    limit: sessionIds.length
  })

  const result = await queryTinybirdSql({
    env: process.env,
    logLabel: 'VALIDATE SESSION FEATURES FETCH',
    sql
  })

  return result.data || []
}

async function pollForRows(sessionIds) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const rows = await fetchSessionFeatureRows(sessionIds)
    console.log(`Polled Tinybird at ${getTinybirdHost(process.env)} and found ${rows.length} session row(s)`)
    if (rows.length >= sessionIds.length) {
      return rows
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new Error(`Timed out waiting for ${sessionIds.length} session features row(s) after ${POLL_TIMEOUT_MS}ms`)
}

function assertSession1(row) {
  assert.ok(row, 'Missing session 1 features row')
  assert.equal(Number(row.page_views), 1)
  assert.equal(Number(row.product_views), 1)
  assert.equal(Number(row.product_dwell_12s_count), 1)
  assert.equal(Number(row.add_to_cart_count), 1)
  assert.equal(Number(row.begin_checkout_count), 1)
  assert.equal(Boolean(row.reached_checkout), true)
  assert.equal(Boolean(row.purchased), false)
  assert.equal(Boolean(row.provisional_abandoned_checkout), true)
  assert.equal(Boolean(row.had_intervention), false)
}

function assertSession2(row) {
  assert.ok(row, 'Missing session 2 features row')
  assert.equal(Number(row.page_views), 1)
  assert.equal(Number(row.product_views), 1)
  assert.equal(Number(row.policy_page_view_count), 1)
  assert.equal(Number(row.cta_idle_15s_count), 1)
  assert.equal(Number(row.intervention_triggered_count), 1)
  assert.equal(Number(row.purchase_count), 1)
  assert.equal(Boolean(row.purchased), true)
  assert.equal(Boolean(row.had_intervention), true)
  assert.equal(Boolean(row.provisional_abandoned_checkout), false)
  assert.equal(Number(row.time_from_first_intervention_to_purchase_seconds), 14)
}

async function main() {
  requireTinybirdEnv()

  const sessions = createSessionPayloads()
  console.log(`Starting Phase 2 validation against ${BACKEND_BASE} for ${SHOP_DOMAIN}`)

  for (const session of sessions) {
    await assignVariant(session.sessionId, session.visitorId)
    await sendEvents(session)
  }

  const rows = await pollForRows(sessions.map((session) => session.sessionId))
  const bySessionId = new Map(rows.map((row) => [row.session_id, row]))

  assertSession1(bySessionId.get(sessions[0].sessionId))
  assertSession2(bySessionId.get(sessions[1].sessionId))

  console.log('Phase 2 validation passed.')
  console.table(rows.map((row) => ({
    session_id: row.session_id,
    store_id: row.store_id || '',
    purchased: row.purchased,
    reached_checkout: row.reached_checkout,
    events: row.total_events,
    last_seen_at: row.last_seen_at
  })))
}

main().catch((error) => {
  console.error('validate:session-features failed:', error.message || error)
  process.exitCode = 1
})
