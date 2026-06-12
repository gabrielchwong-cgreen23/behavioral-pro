import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSessionFrameCounterDeltas,
  buildSessionFrameSignalUpdates,
  sanitizeSessionFrameMetadata
} from '../packages/analytics/src/session-frame.js'

function createFrame(overrides = {}) {
  return {
    shop_domain: 'alpha.myshopify.com',
    path: '/products/widget',
    page_url: 'https://alpha.myshopify.com/products/widget',
    page_type: 'product',
    journey_stage: 'decision',
    active_zone: 'add_to_cart_zone',
    t_seconds: 12,
    mouse_velocity_avg: 0.04,
    mouse_velocity_max: 0.11,
    mouse_acceleration_avg: -0.01,
    mouse_distance: 142.5,
    scroll_depth: 0.72,
    scroll_velocity: 0.02,
    cursor_idle_seconds: 1.8,
    hover_cta_seconds: 1.4,
    hover_price_seconds: 0.4,
    hover_policy_seconds: 0.2,
    hover_reviews_seconds: 0.1,
    cta_distance: 84,
    click_count: 1,
    rage_click_count: 1,
    dead_click_count: 0,
    intent_score: 0.73,
    friction_score: 0.79,
    hesitation_score: 0.81,
    policy_anxiety_score: 0.18,
    cart_commitment_score: 0.65,
    abandonment_risk_score: 0.43,
    ...overrides
  }
}

test('session_frame metadata sanitization keeps only safe fields and normalizes scores', () => {
  const frame = sanitizeSessionFrameMetadata(createFrame({
    intent_score: '0.73456',
    unknown_field: 'ignored'
  }))

  assert.equal(frame.page_type, 'product')
  assert.equal(frame.active_zone, 'add_to_cart_zone')
  assert.equal(frame.intent_score, 0.7346)
  assert.equal(Object.hasOwn(frame, 'unknown_field'), false)
})

test('session_frame sanitization rejects sensitive fields', () => {
  assert.throws(
    () => sanitizeSessionFrameMetadata(createFrame({
      email: 'customer@example.com'
    })),
    /not allowed/
  )
})

test('session_frame signal updates expose immediate decision inputs', () => {
  const signals = buildSessionFrameSignalUpdates(createFrame())
  const counters = buildSessionFrameCounterDeltas(createFrame())

  assert.equal(signals.current_friction_score, 0.79)
  assert.equal(signals.current_hesitation_score, 0.81)
  assert.equal(signals.hover_cta_seconds_recent, 1.4)
  assert.equal(signals.cursor_idle_seconds_recent, 1.8)
  assert.equal(signals.frame_rage_click_count_recent, 1)
  assert.equal(signals.frame_dead_click_count_recent, 0)
  assert.equal(signals.near_cta, 1)
  assert.equal(signals.mouse_velocity_drop_near_cta, 1)
  assert.equal(signals.rage_click_recent, 1)
  assert.equal(signals.idle_near_cta, 1)
  assert.equal(signals.page_type, 'product')
  assert.equal(counters.session_frame_count, 1)
  assert.equal(counters.frame_rage_click_count, 1)
})
