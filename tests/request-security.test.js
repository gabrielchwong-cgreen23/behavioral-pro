import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRateLimitKey,
  createInMemoryRateLimiter,
  validateInterventionDecisionQuery,
  validatePublicEventPayload,
  validateRequestedShopAgainstVerifiedShop
} from '../packages/analytics/src/request-security.js'
import {
  computeBlendWeight,
  evaluateInterventionDecision
} from '../packages/analytics/src/intervention-decision.js'
import {
  getTinybirdIngestToken,
  getTinybirdQueryToken
} from '../packages/analytics/src/tinybird.js'

function createValidEvent(overrides = {}) {
  return {
    anonymous_id: 'usr_security_1234',
    session_id: 'sess_security_1',
    event_name: 'product_dwell_12s',
    timestamp: Math.floor(Date.now() / 1000),
    properties: {
      shop_domain: 'alpha.myshopify.com',
      path: '/products/widget',
      source: 'test'
    },
    ...overrides
  }
}

test('public event payload validation rejects malformed requests safely', () => {
  const missingShop = validatePublicEventPayload(createValidEvent({
    properties: {
      path: '/products/widget'
    }
  }))
  const oversizedMetadata = validatePublicEventPayload(createValidEvent({
    properties: {
      shop_domain: 'alpha.myshopify.com',
      blob: 'x'.repeat(5000)
    }
  }))
  const badTimestamp = validatePublicEventPayload(createValidEvent({
    timestamp: 915148800
  }))
  const extraKey = validatePublicEventPayload(createValidEvent({
    eventType: 'bad_legacy_key'
  }))

  assert.equal(missingShop.status, 400)
  assert.equal(missingShop.body.error, 'properties.shop_domain is required')
  assert.equal(oversizedMetadata.status, 413)
  assert.equal(oversizedMetadata.body.error, 'properties too large')
  assert.equal(badTimestamp.status, 400)
  assert.equal(badTimestamp.body.error, 'timestamp outside allowed range')
  assert.equal(extraKey.status, 400)
  assert.equal(extraKey.body.error, 'Invalid event payload')
})

test('cross-store validation fails when requested shop does not match authenticated shop', () => {
  assert.equal(
    validateRequestedShopAgainstVerifiedShop('alpha.myshopify.com', 'beta.myshopify.com'),
    false
  )
  assert.equal(
    validateRequestedShopAgainstVerifiedShop('alpha.myshopify.com', 'alpha.myshopify.com'),
    true
  )
})

test('intervention query validation rejects malformed public inputs', () => {
  const invalidShop = validateInterventionDecisionQuery({
    shop_domain: 'not a domain',
    session_id: 'sess_security_1'
  })
  const invalidSession = validateInterventionDecisionQuery({
    shop_domain: 'alpha.myshopify.com',
    session_id: '$$$'
  })

  assert.equal(invalidShop.status, 400)
  assert.equal(invalidSession.status, 400)
})

test('rate limiter blocks repeated abuse for public routes', () => {
  const limiter = createInMemoryRateLimiter({
    windowMs: 60_000,
    maxRequests: 2
  })
  const key = buildRateLimitKey(['events', '127.0.0.1', 'alpha.myshopify.com', 'sess_1'])

  assert.equal(limiter.check(key).ok, true)
  assert.equal(limiter.check(key).ok, true)

  const blocked = limiter.check(key)
  assert.equal(blocked.ok, false)
  assert.equal(typeof blocked.retryAfterSeconds, 'number')
})

test('intervention decision stays cold-start static below 100 sessions and disables after purchase', () => {
  assert.equal(computeBlendWeight(50), 0)

  const result = evaluateInterventionDecision({
    session: {
      add_to_cart_count: 1,
      begin_checkout_count: 1,
      purchase_count: 1,
      rage_click_count: 10,
      cta_idle_15s_count: 10,
      policy_page_view_count: 10,
      reached_checkout: 1,
      purchased: 1,
      provisional_abandoned_cart: 0,
      provisional_abandoned_checkout: 0
    },
    cohort: 'mid_tier',
    storeBenchmarks: {
      historical_session_count: 50,
      p75_rage_click_count: 8,
      p75_cta_idle_15s_count: 8,
      p75_policy_page_view_count: 8
    }
  })

  assert.equal(result.strategy, 'cold_start_static')
  assert.equal(result.decision, false)
  assert.equal(result.intervention_type, 'none')
})

test('Tinybird helpers separate ingest and query token usage', () => {
  const env = {
    TINYBIRD_INGEST_TOKEN: 'ingest-only-token',
    TINYBIRD_QUERY_TOKEN: 'query-only-token'
  }

  assert.equal(getTinybirdIngestToken(env), 'ingest-only-token')
  assert.equal(getTinybirdQueryToken(env), 'query-only-token')
})

test('public event validation rejects session_frame payloads with sensitive fields', () => {
  const result = validatePublicEventPayload(createValidEvent({
    event_name: 'session_frame',
    properties: {
      shop_domain: 'alpha.myshopify.com',
      path: '/products/widget',
      page_type: 'product',
      journey_stage: 'decision',
      active_zone: 'add_to_cart_zone',
      t_seconds: 2,
      mouse_velocity_avg: 0.03,
      mouse_velocity_max: 0.08,
      mouse_acceleration_avg: 0.01,
      mouse_distance: 12,
      scroll_depth: 0.5,
      scroll_velocity: 0.02,
      cursor_idle_seconds: 0.4,
      hover_cta_seconds: 1.1,
      hover_price_seconds: 0.2,
      hover_policy_seconds: 0.1,
      hover_reviews_seconds: 0.4,
      cta_distance: 90,
      click_count: 1,
      rage_click_count: 0,
      dead_click_count: 0,
      intent_score: 0.7,
      friction_score: 0.2,
      hesitation_score: 0.5,
      policy_anxiety_score: 0.1,
      cart_commitment_score: 0.6,
      abandonment_risk_score: 0.3,
      email: 'customer@example.com'
    }
  }))

  assert.equal(result.status, 400)
  assert.match(result.body.error, /not allowed/)
})
