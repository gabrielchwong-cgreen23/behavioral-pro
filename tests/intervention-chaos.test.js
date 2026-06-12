import test from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from '../app.js'
import { getInterventionDecision } from '../packages/analytics/src/intervention-decision.js'
import { createMockSupabase } from './helpers/mock-supabase.js'

function buildStoreRecord() {
  return {
    id: 'store_1',
    shop_domain: 'alpha.myshopify.com',
    settings: {
      aov_cohort: 'mid_tier',
      interventions_enabled: true,
      is_active: true
    }
  }
}

function createBenchmarkForbiddenSupabase() {
  const supabase = createMockSupabase({
    session_state: [{
      id: 1,
      shop_domain: 'alpha.myshopify.com',
      session_id: 'chaos-sess-2',
      store_id: 'store_1',
      visitor_id: 'visitor-chaos',
      experiment_variant: 'variant',
      page_url: 'https://alpha.myshopify.com/products/example',
      counters: {
        product_views: 1,
        rage_click_count: 1
      },
      first_seen_at: '2026-05-22T00:00:00.000Z',
      last_seen_at: '2026-05-22T00:00:01.000Z',
      updated_at: '2026-05-22T00:00:01.000Z'
    }]
  })
  const originalFrom = supabase.from.bind(supabase)

  supabase.from = (table) => {
    if (table === 'store_benchmarks') {
      return {
        select() {
          return this
        },
        eq() {
          return this
        },
        maybeSingle: async () => ({
          data: null,
          error: {
            message: 'Forbidden',
            status: 403
          }
        })
      }
    }

    return originalFrom(table)
  }

  return supabase
}

function createTinybird500Fetch() {
  const calls = []
  const fetchImpl = async (...args) => {
    calls.push(args)
    return {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'tinybird pipeline unavailable' })
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function createDelayedNoDataFetch(delayMs = 2000) {
  const calls = []
  const fetchImpl = async (...args) => {
    calls.push(args)
    await new Promise(resolve => setTimeout(resolve, delayMs))
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] })
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

async function withTestServer({ supabase, fetchImpl }, callback) {
  const app = createApp({
    env: {
      SHOPIFY_API_KEY: 'api-key',
      SHOPIFY_API_SECRET: 'secret',
      TINYBIRD_API_KEY: 'tinybird-query-token',
      TINYBIRD_API_URL: 'https://api.tinybird.test'
    },
    supabase,
    fetchImpl
  })

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })

  try {
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    await callback(baseUrl)
  } finally {
    if (!server.listening) {
      return
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

async function requestDecision(baseUrl, {
  sessionId = 'chaos-sess-1',
  shopDomain = 'alpha.myshopify.com'
} = {}) {
  const response = await fetch(
    `${baseUrl}/api/intervention-decision?shop_domain=${encodeURIComponent(shopDomain)}&session_id=${encodeURIComponent(sessionId)}`,
    {
      headers: {
        origin: 'https://storefront.example'
      }
    }
  )

  const contentType = response.headers.get('content-type') || ''
  const body = await response.json()

  return {
    status: response.status,
    contentType,
    body
  }
}

test('chaos: Tinybird 500 makes getInterventionDecision fail closed', async () => {
  const result = await getInterventionDecision({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'chaos-sess-1',
    storeRecord: buildStoreRecord(),
    supabase: createMockSupabase(),
    env: {
      TINYBIRD_API_KEY: 'tinybird-query-token',
      TINYBIRD_API_URL: 'https://api.tinybird.test'
    },
    fetchImpl: createTinybird500Fetch()
  })

  assert.equal(result.result.decision, false)
  assert.equal(result.result.strategy, 'error_fail_closed')
  assert.deepEqual(result.result.metadata, {
    reason: 'error_fail_closed',
    calculated_threshold: 1
  })
})

test('chaos: Supabase 403 makes getInterventionDecision fail closed', async () => {
  const result = await getInterventionDecision({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'chaos-sess-2',
    storeRecord: buildStoreRecord(),
    supabase: createBenchmarkForbiddenSupabase(),
    env: {
      TINYBIRD_API_KEY: 'tinybird-query-token',
      TINYBIRD_API_URL: 'https://api.tinybird.test'
    },
    fetchImpl: createDelayedNoDataFetch(0)
  })

  assert.equal(result.result.decision, false)
  assert.equal(result.result.strategy, 'error_fail_closed')
  assert.deepEqual(result.result.metadata, {
    reason: 'error_fail_closed',
    calculated_threshold: 1
  })
})

test('chaos: 2-second latency still resolves getInterventionDecision with a closed decision', async () => {
  const fetchImpl = createDelayedNoDataFetch(2000)
  const startedAt = Date.now()
  const result = await getInterventionDecision({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'chaos-sess-3',
    storeRecord: buildStoreRecord(),
    supabase: createMockSupabase(),
    env: {
      TINYBIRD_API_KEY: 'tinybird-query-token',
      TINYBIRD_API_URL: 'https://api.tinybird.test'
    },
    fetchImpl
  })
  const elapsedMs = Date.now() - startedAt

  assert.equal(result.result.decision, false)
  assert.equal(result.result.strategy, 'no_session_data')
  assert.deepEqual(result.result.metadata, {
    reason: 'no_session_data',
    calculated_threshold: 1
  })
  assert.equal(fetchImpl.calls.length, 2)
  assert.ok(elapsedMs >= 3900)
  assert.ok(elapsedMs < 7000)
})

test('chaos route: Tinybird 500 returns valid fail-closed JSON', async () => {
  await withTestServer({
    supabase: createMockSupabase(),
    fetchImpl: createTinybird500Fetch()
  }, async (baseUrl) => {
    const { status, contentType, body } = await requestDecision(baseUrl)

    assert.equal(status, 200)
    assert.match(contentType, /application\/json/)
    assert.equal(body.decision, false)
    assert.equal(body.strategy, 'error_fail_closed')
    assert.deepEqual(body.metadata, {
      reason: 'error_fail_closed',
      calculated_threshold: 1
    })
  })
})

test('chaos route: Supabase 403 returns valid fail-closed JSON', async () => {
  await withTestServer({
    supabase: createBenchmarkForbiddenSupabase(),
    fetchImpl: createDelayedNoDataFetch(0)
  }, async (baseUrl) => {
    const { status, contentType, body } = await requestDecision(baseUrl, {
      sessionId: 'chaos-sess-2'
    })

    assert.equal(status, 200)
    assert.match(contentType, /application\/json/)
    assert.equal(body.decision, false)
    assert.equal(body.strategy, 'error_fail_closed')
    assert.deepEqual(body.metadata, {
      reason: 'error_fail_closed',
      calculated_threshold: 1
    })
  })
})

test('chaos route: 2-second latency returns JSON instead of hanging', async () => {
  const fetchImpl = createDelayedNoDataFetch(2000)
  await withTestServer({
    supabase: createMockSupabase(),
    fetchImpl
  }, async (baseUrl) => {
    const startedAt = Date.now()
    const { status, contentType, body } = await requestDecision(baseUrl, {
      sessionId: 'chaos-sess-3'
    })
    const elapsedMs = Date.now() - startedAt

    assert.equal(status, 200)
    assert.match(contentType, /application\/json/)
    assert.equal(body.decision, false)
    assert.equal(body.strategy, 'no_session_data')
    assert.deepEqual(body.metadata, {
      reason: 'no_session_data',
      calculated_threshold: 1
    })
    assert.equal(fetchImpl.calls.length, 2)
    assert.ok(elapsedMs >= 3900)
    assert.ok(elapsedMs < 7000)
  })
})
