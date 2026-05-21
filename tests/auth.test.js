import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  createIngestSignature,
  verifyShopifySessionToken,
  verifySignedIngestRequest
} from '../app.js'

function base64url(value) {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function createSessionToken({ shop, apiKey, apiSecret, sub = 'user-1' }) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url({ alg: 'HS256', typ: 'JWT' })
  const payload = base64url({
    aud: apiKey,
    dest: `https://${shop}/admin`,
    exp: now + 300,
    nbf: now - 30,
    iat: now,
    iss: 'https://shopify.dev/session-token',
    sub
  })
  const signed = `${header}.${payload}`
  const signature = crypto.createHmac('sha256', apiSecret).update(signed).digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `${signed}.${signature}`
}

test('verifyShopifySessionToken binds token to the destination shop', () => {
  const env = {
    SHOPIFY_API_KEY: 'api-key',
    SHOPIFY_API_SECRET: 'secret'
  }
  const token = createSessionToken({
    shop: 'alpha.myshopify.com',
    apiKey: env.SHOPIFY_API_KEY,
    apiSecret: env.SHOPIFY_API_SECRET
  })

  const verified = verifyShopifySessionToken(token, env)

  assert.equal(verified.shop, 'alpha.myshopify.com')
  assert.equal(verified.payload.sub, 'user-1')
})

test('verifySignedIngestRequest accepts fresh signatures and rejects expired ones', () => {
  const secret = 'ingest-secret'
  const rawBody = JSON.stringify({
    shop_domain: 'alpha.myshopify.com',
    session_id: 'sess-1',
    event_type: 'purchase'
  })
  const freshTimestamp = String(Date.now())
  const expiredTimestamp = String(Date.now() - 10 * 60 * 1000)

  const freshSignature = createIngestSignature({
    rawBody,
    timestamp: freshTimestamp,
    secret
  })
  const expiredSignature = createIngestSignature({
    rawBody,
    timestamp: expiredTimestamp,
    secret
  })

  const accepted = verifySignedIngestRequest({
    rawBody,
    headers: {
      'x-behavioralpro-timestamp': freshTimestamp,
      'x-behavioralpro-signature': freshSignature
    },
    secret
  })
  const rejected = verifySignedIngestRequest({
    rawBody,
    headers: {
      'x-behavioralpro-timestamp': expiredTimestamp,
      'x-behavioralpro-signature': expiredSignature
    },
    secret
  })

  assert.equal(accepted.ok, true)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'Expired ingest signature')
})
