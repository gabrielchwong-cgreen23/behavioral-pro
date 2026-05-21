import test from 'node:test'
import assert from 'node:assert/strict'
import { mapStorefrontSignalToBehavioralEvent } from '../packages/analytics/src/behavioral-event-contract.js'

test('mapStorefrontSignalToBehavioralEvent returns the strict immutable payload', () => {
  const payload = mapStorefrontSignalToBehavioralEvent({
    anonymous_id: 'usr_x92f81k1',
    session_id: 'sess_3910a2aa',
    event_name: 'product_dwell_12s',
    timestamp: 1716157376,
    properties: {
      path: '/products/leather-jacket',
      shop_domain: 'store.myshopify.com',
      source: 'mousemove',
      details: {}
    }
  })

  assert.deepEqual(payload, {
    anonymous_id: 'usr_x92f81k1',
    session_id: 'sess_3910a2aa',
    event_name: 'product_dwell_12s',
    timestamp: 1716157376,
    properties: {
      path: '/products/leather-jacket',
      shop_domain: 'store.myshopify.com',
      source: 'mousemove',
      details: {}
    }
  })
})

test('mapStorefrontSignalToBehavioralEvent rejects malformed contract keys', () => {
  assert.throws(
    () => mapStorefrontSignalToBehavioralEvent({
      anonymousId: 'usr_x92f81k1',
      session_id: 'sess_3910a2aa',
      event_name: 'product_dwell_12s',
      timestamp: 1716157376,
      properties: {}
    }),
    /anonymous_id must be a non-empty UUID\/hash string/
  )
})
