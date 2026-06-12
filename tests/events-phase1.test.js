import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestPhase1Event } from '../app.js'
import {
  buildAssignmentEvent,
  buildPhase1EventRecord,
  normalizePhase1EventPayload
} from '../packages/analytics/src/event-spine.js'
import { createMockSupabase } from './helpers/mock-supabase.js'

test('phase 1 session flow stores canonical events and dedupes by event_id', async () => {
  const supabase = createMockSupabase()
  const analyticsOptions = { supabase }
  const tinybirdCalls = []
  const fetchImpl = async (_url, options = {}) => {
    tinybirdCalls.push(options)
    return {
      ok: true,
      status: 202,
      text: async () => 'accepted'
    }
  }

  const assignment = buildAssignmentEvent({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess_phase1',
    visitorId: 'visitor_phase1',
    experimentVariant: 'variant',
    pageUrl: 'https://alpha.myshopify.com/products/widget',
    referrer: 'https://google.com/search?q=widget',
    eventId: 'assign_alpha_sess_phase1',
    clientTimestamp: '2026-05-19T12:00:00.000Z',
    metadata: {
      experiment_name: 'agency_revenue_lift_14_day',
      source: 'test'
    }
  })

  const assignmentResult = await ingestPhase1Event({
    env: {
      TINYBIRD_TOKEN: 'tinybird-token',
      TINYBIRD_EVENTS_API_URL: 'https://api.tinybird.test/v0/events?name=raw_events'
    },
    analyticsOptions,
    eventRecord: assignment,
    legacyAssignmentMirrorEnabled: true,
    authMode: 'test',
    fetchImpl
  })

  assert.equal(assignmentResult.duplicate, false)

  const sequence = [
    'page_view',
    'product_view',
    'product_dwell_12s',
    'add_to_cart',
    'begin_checkout'
  ]

  for (let index = 0; index < sequence.length; index += 1) {
    const result = await ingestPhase1Event({
      env: {
        TINYBIRD_TOKEN: 'tinybird-token',
        TINYBIRD_EVENTS_API_URL: 'https://api.tinybird.test/v0/events?name=raw_events'
      },
      analyticsOptions,
      legacyAssignmentMirrorEnabled: true,
      authMode: 'test',
      fetchImpl,
      eventRecord: buildPhase1EventRecord({
        event_name: sequence[index],
        shop_domain: 'alpha.myshopify.com',
        session_id: 'sess_phase1',
        visitor_id: 'visitor_phase1',
        experiment_variant: 'variant',
        page_url: 'https://alpha.myshopify.com/products/widget',
        referrer: 'https://google.com/search?q=widget',
        client_timestamp: `2026-05-19T12:00:0${index + 1}.000Z`,
        event_id: `evt_phase1_${index}`,
        metadata: {
          source: 'test',
          product_id: 'gid://shopify/Product/1',
          product_handle: 'widget',
          ordinal: index + 1
        }
      })
    })

    assert.equal(result.duplicate, false)
    assert.equal(typeof result.record.server_timestamp, 'string')
  }

  const duplicate = await ingestPhase1Event({
    env: {
      TINYBIRD_TOKEN: 'tinybird-token',
      TINYBIRD_EVENTS_API_URL: 'https://api.tinybird.test/v0/events?name=raw_events'
    },
    analyticsOptions,
    legacyAssignmentMirrorEnabled: true,
    authMode: 'test',
    fetchImpl,
    eventRecord: buildPhase1EventRecord({
      event_name: 'begin_checkout',
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess_phase1',
      visitor_id: 'visitor_phase1',
      experiment_variant: 'variant',
      page_url: 'https://alpha.myshopify.com/products/widget',
      referrer: 'https://google.com/search?q=widget',
      client_timestamp: '2026-05-19T12:00:09.000Z',
      event_id: 'evt_phase1_4',
      metadata: {
        source: 'test'
      }
    })
  })

  assert.equal(duplicate.duplicate, true)
  assert.equal(tinybirdCalls.length, 6)
  assert.equal(supabase._store.tables.experiment_sessions.length, 1)
  assert.equal(supabase._store.tables.events.length, 0)
  assert.match(String(tinybirdCalls[0].headers['Content-Type']), /application\/x-ndjson/)
})

test('phase 1 payload validation rejects invalid event names and malformed metadata', () => {
  assert.throws(
    () => normalizePhase1EventPayload({
      event_name: 'totally_unknown',
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess_invalid',
      visitor_id: 'visitor_invalid',
      experiment_variant: 'control',
      page_url: 'https://alpha.myshopify.com/',
      referrer: null,
      client_timestamp: '2026-05-19T12:00:01.000Z',
      event_id: 'evt_invalid_name',
      metadata: {}
    }),
    /event_name must be one of/
  )

  assert.throws(
    () => normalizePhase1EventPayload({
      event_name: 'page_view',
      shop_domain: 'alpha.myshopify.com',
      session_id: 'sess_invalid',
      visitor_id: 'visitor_invalid',
      experiment_variant: 'control',
      page_url: 'https://alpha.myshopify.com/',
      referrer: null,
      client_timestamp: '2026-05-19T12:00:01.000Z',
      event_id: 'evt_invalid_metadata',
      metadata: 'not-an-object'
    }),
    /metadata must be an object/
  )
})

test('phase 1 payload validation accepts canonical session_frame telemetry', () => {
  const payload = normalizePhase1EventPayload({
    event_name: 'session_frame',
    shop_domain: 'alpha.myshopify.com',
    session_id: 'sess_frame',
    visitor_id: 'visitor_frame',
    experiment_variant: 'control',
    page_url: 'https://alpha.myshopify.com/products/widget',
    referrer: 'https://google.com/',
    client_timestamp: '2026-05-19T12:00:01.000Z',
    event_id: 'evt_session_frame',
    metadata: {
      page_type: 'product',
      journey_stage: 'decision',
      active_zone: 'add_to_cart_zone',
      t_seconds: 4,
      mouse_velocity_avg: 0.04,
      mouse_velocity_max: 0.2,
      mouse_acceleration_avg: 0.01,
      mouse_distance: 44,
      scroll_depth: 0.6,
      scroll_velocity: 0.02,
      cursor_idle_seconds: 0.4,
      hover_cta_seconds: 1.2,
      hover_price_seconds: 0.5,
      hover_policy_seconds: 0.1,
      hover_reviews_seconds: 0.3,
      cta_distance: 88,
      click_count: 1,
      rage_click_count: 0,
      dead_click_count: 0,
      intent_score: 0.7,
      friction_score: 0.2,
      hesitation_score: 0.5,
      policy_anxiety_score: 0.1,
      cart_commitment_score: 0.65,
      abandonment_risk_score: 0.25
    }
  })

  assert.equal(payload.event_name, 'session_frame')
  assert.equal(payload.metadata.active_zone, 'add_to_cart_zone')
  assert.equal(payload.metadata.intent_score, 0.7)
})
