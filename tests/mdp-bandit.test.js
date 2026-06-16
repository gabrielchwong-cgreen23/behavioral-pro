import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'

import { createApp } from '../app.js'
import {
  appendTrajectoryState,
  getMdpInterventionDecision,
  recordBanditReward
} from '../packages/analytics/src/mdp-bandit.js'
import { createMockSupabase } from './helpers/mock-supabase.js'

function buildWebhookHmac(secret, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64')
}

async function withTestServer({ supabase, env = {} }, callback) {
  const app = createApp({
    env: {
      SHOPIFY_API_KEY: 'api-key',
      SHOPIFY_API_SECRET: 'secret',
      ANALYTICS_OWNER_TOKEN: 'owner-token',
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      ...env
    },
    supabase
  })

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })

  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`)
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

test('appendTrajectoryState keeps a compact sequential state string', () => {
  assert.equal(appendTrajectoryState('B', 'H'), 'BH')
  assert.equal(appendTrajectoryState('BH', 'H'), 'BH')
  assert.equal(appendTrajectoryState('BHI', 'C'), 'BHIC')
})

test('getMdpInterventionDecision assigns a trajectory-aware variant session', async () => {
  const supabase = createMockSupabase({
    storefront_intervention_variants: [
      {
        id: 'variant_control',
        shop_domain: 'alpha.myshopify.com',
        cohort_key: 'mdp_default',
        variant_key: 'control',
        variant_label: 'Control',
        is_active: true,
        alpha: 2,
        beta: 4,
        prior_alpha: 1,
        prior_beta: 1,
        priority: 0
      },
      {
        id: 'variant_social_proof',
        shop_domain: 'alpha.myshopify.com',
        cohort_key: 'mdp_default',
        variant_key: 'social_proof',
        variant_label: 'Social proof',
        is_active: true,
        alpha: 6,
        beta: 2,
        prior_alpha: 1,
        prior_beta: 1,
        priority: 10,
        payload: {
          message: 'People like you complete checkout quickly.'
        }
      }
    ],
    storefront_trajectory_bandit_state: [
      {
        id: 1,
        shop_domain: 'alpha.myshopify.com',
        cohort_key: 'mdp_default',
        trajectory_key: 'BHIC',
        variant_id: 'variant_social_proof',
        alpha: 12,
        beta: 2
      }
    ]
  })

  const { result } = await getMdpInterventionDecision({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess_12345678',
    trajectoryKey: 'BHIC',
    supabase
  })

  assert.equal(result.decision, true)
  assert.equal(result.strategy, 'trajectory_thompson_sampling')
  assert.equal(result.variant_id, 'variant_social_proof')
  assert.equal(supabase._store.tables.storefront_intervention_sessions.length, 1)
  assert.equal(
    supabase._store.tables.storefront_intervention_sessions[0].trajectory_key,
    'BHIC'
  )
})

test('control-only benchmarking phase serves the control variant and still records trajectory rewards', async () => {
  const supabase = createMockSupabase({
    storefront_intervention_variants: [
      {
        id: 'variant_control',
        shop_domain: 'alpha.myshopify.com',
        cohort_key: 'mdp_default',
        variant_key: 'control',
        variant_label: 'Control',
        is_control: true,
        is_active: true,
        alpha: 1,
        beta: 1,
        prior_alpha: 1,
        prior_beta: 1,
        priority: 0
      },
      {
        id: 'variant_social_proof',
        shop_domain: 'alpha.myshopify.com',
        cohort_key: 'mdp_default',
        variant_key: 'social_proof',
        variant_label: 'Social proof',
        is_active: true,
        alpha: 20,
        beta: 1,
        prior_alpha: 1,
        prior_beta: 1,
        priority: 10
      }
    ]
  })

  const { result } = await getMdpInterventionDecision({
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess_control_phase',
    trajectoryKey: 'BHIC',
    storeRecord: {
      installed_at: new Date().toISOString(),
      settings: {}
    },
    supabase
  })

  assert.equal(result.decision, true)
  assert.equal(result.strategy, 'control_only_benchmarking')
  assert.equal(result.variant_id, 'variant_control')

  const reward = await recordBanditReward(supabase, {
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess_control_phase',
    variantId: 'variant_control',
    trajectoryKey: 'BHIC',
    wasSuccess: true,
    rewardSource: 'test'
  })

  assert.equal(reward.applied, true)
  assert.equal(supabase._store.tables.storefront_trajectory_bandit_state.length, 1)
  assert.equal(
    supabase._store.tables.storefront_trajectory_bandit_state[0].trajectory_key,
    'BHIC'
  )
  assert.equal(
    supabase._store.tables.storefront_trajectory_bandit_state[0].variant_id,
    'variant_control'
  )
})

test('recordBanditReward increments alpha on a successful conversion', async () => {
  const supabase = createMockSupabase({
    storefront_intervention_variants: [
      {
        id: 'variant_one',
        shop_domain: 'alpha.myshopify.com',
        cohort_key: 'mdp_default',
        variant_key: 'one',
        variant_label: 'One',
        is_active: true,
        alpha: 1,
        beta: 1,
        prior_alpha: 1,
        prior_beta: 1,
        successes_count: 0,
        failures_count: 0
      }
    ],
    storefront_intervention_sessions: [
      {
        id: 1,
        shop_domain: 'alpha.myshopify.com',
        cohort_key: 'mdp_default',
        session_id: 'sess_12345678',
        trajectory_key: 'BHIC',
        variant_id: 'variant_one',
        reward_status: 'pending',
        assigned_at: '2026-06-11T00:00:00.000Z',
        metadata: {}
      }
    ]
  })

  const reward = await recordBanditReward(supabase, {
    shopDomain: 'alpha.myshopify.com',
    sessionId: 'sess_12345678',
    variantId: 'variant_one',
    trajectoryKey: 'BHIC',
    wasSuccess: true,
    rewardSource: 'test'
  })

  assert.equal(reward.applied, true)
  assert.equal(
    supabase._store.tables.storefront_intervention_variants[0].alpha,
    2
  )
  assert.equal(
    supabase._store.tables.storefront_trajectory_bandit_state[0].alpha,
    2
  )
})

test('orders/create webhook reconciles cart attributes into a success reward', async () => {
  const supabase = createMockSupabase({
    storefront_intervention_variants: [
      {
        id: 'variant_checkout',
        shop_domain: 'alpha.myshopify.com',
        cohort_key: 'mdp_default',
        variant_key: 'checkout',
        variant_label: 'Checkout nudge',
        is_active: true,
        alpha: 1,
        beta: 1,
        prior_alpha: 1,
        prior_beta: 1,
        successes_count: 0,
        failures_count: 0
      }
    ],
    storefront_intervention_sessions: [
      {
        id: 1,
        shop_domain: 'alpha.myshopify.com',
        cohort_key: 'mdp_default',
        session_id: 'sess_checkout_1',
        trajectory_key: 'BHIC',
        variant_id: 'variant_checkout',
        reward_status: 'pending',
        assigned_at: '2026-06-11T00:00:00.000Z',
        metadata: {}
      }
    ]
  })

  await withTestServer({ supabase }, async (baseUrl) => {
    const rawBody = JSON.stringify({
      id: 999,
      note_attributes: [
        { name: 'behavioral_pro_session_id', value: 'sess_checkout_1' },
        { name: 'behavioral_pro_variant_id', value: 'variant_checkout' },
        { name: 'behavioral_pro_trajectory', value: 'BHIC' }
      ]
    })

    const response = await fetch(`${baseUrl}/webhooks/orders/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Shop-Domain': 'alpha.myshopify.com',
        'X-Shopify-Hmac-Sha256': buildWebhookHmac('secret', rawBody)
      },
      body: rawBody
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.success, true)
    assert.equal(payload.data.applied, true)
    assert.equal(
      supabase._store.tables.storefront_intervention_sessions[0].reward_status,
      'success'
    )
    assert.equal(
      supabase._store.tables.storefront_intervention_variants[0].alpha,
      2
    )
  })
})
