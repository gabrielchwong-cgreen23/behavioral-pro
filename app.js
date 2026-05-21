import 'dotenv/config'
import cors from 'cors'
import crypto from 'crypto'
import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { pathToFileURL } from 'node:url'
import {
  getAnalyticsOverview,
  getTriggerConversionRates,
  trackBehavioralEvent,
  trackSessionStarted
} from './packages/analytics/src/index.js'
import {
  buildPhase1EventRecord,
  buildAssignmentEvent,
  createPhase1EventId,
  getLegacyEventMirror
} from './packages/analytics/src/event-spine.js'
import {
  getTinybirdEventsApiUrl,
  getTinybirdIngestToken,
  queryTinybirdSql,
  toTinybirdSqlString
} from './packages/analytics/src/tinybird.js'
import {
  buildRateLimitKey,
  createInMemoryRateLimiter,
  getClientIp,
  isBotLikeRequest,
  originMatchesPageUrl,
  validateInterventionDecisionQuery,
  validatePublicEventPayload
} from './packages/analytics/src/request-security.js'
import {
  getInterventionDecision,
  getInterventionMessageId,
  getInterventionStoreConfigFromRecord
} from './packages/analytics/src/intervention-decision.js'
import {
  buildSessionFeaturesBaseCte
} from './packages/analytics/src/session-features-sql.js'
import { registerOwnerAnalyticsRoutes } from './packages/owner-analytics/src/index.js'

const DEFAULT_PORT = 3001
const SIGNATURE_HEADER = 'x-behavioralpro-signature'
const TIMESTAMP_HEADER = 'x-behavioralpro-timestamp'
const SIGNATURE_TTL_MS = 5 * 60 * 1000
const EVENT_DEDUPE_TTL_MS = 15 * 60 * 1000
const recentEventIds = new Map()
const eventIngestLimiter = createInMemoryRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120
})
const interventionDecisionLimiter = createInMemoryRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60
})

function createSupabaseClient(env) {
  if (!env?.SUPABASE_URL) {
    throw new Error('Missing SUPABASE_URL')
  }

  if (!env?.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
  }

  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
}

export function normalizeShop(shop) {
  if (!shop || typeof shop !== 'string') return null
  return shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`
}

export function getShopDomainFromRequestBody(body = {}) {
  return normalizeShop(body?.shop_domain || body?.properties?.shop_domain)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getDeviceTypeFromUserAgent(userAgent) {
  const value = String(userAgent || '').toLowerCase()
  if (!value) return null
  if (value.includes('ipad') || value.includes('tablet')) return 'tablet'
  if (value.includes('mobi') || value.includes('iphone') || value.includes('android')) {
    return 'mobile'
  }

  return 'desktop'
}

function base64UrlDecode(input) {
  let value = String(input).replace(/-/g, '+').replace(/_/g, '/')
  while (value.length % 4 !== 0) {
    value += '='
  }
  return Buffer.from(value, 'base64')
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization
  if (!authHeader || typeof authHeader !== 'string') return null
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : null
}

function verifyShopifyWebhook({ rawBody, hmacHeader, secret }) {
  if (!rawBody || !hmacHeader || !secret) {
    return false
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64')

  const digestBuffer = Buffer.from(digest, 'utf8')
  const headerBuffer = Buffer.from(String(hmacHeader), 'utf8')

  if (digestBuffer.length !== headerBuffer.length) {
    return false
  }

  try {
    return crypto.timingSafeEqual(digestBuffer, headerBuffer)
  } catch {
    return false
  }
}

export function verifyShopifySessionToken(token, env) {
  const apiKey = env.SHOPIFY_API_KEY
  const apiSecret = env.SHOPIFY_API_SECRET

  if (!token) {
    throw new Error('Missing bearer token')
  }

  if (!apiKey || !apiSecret) {
    throw new Error('Missing Shopify API environment variables')
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT structure')
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts
  const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'))
  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'))

  if (header.alg !== 'HS256') {
    throw new Error('Unexpected JWT algorithm')
  }

  const signedPart = `${encodedHeader}.${encodedPayload}`
  const expectedSignature = crypto
    .createHmac('sha256', apiSecret)
    .update(signedPart)
    .digest()
  const actualSignature = base64UrlDecode(encodedSignature)

  if (expectedSignature.length !== actualSignature.length) {
    throw new Error('Invalid JWT signature length')
  }

  if (!crypto.timingSafeEqual(expectedSignature, actualSignature)) {
    throw new Error('Invalid JWT signature')
  }

  const now = Math.floor(Date.now() / 1000)

  if (typeof payload.nbf === 'number' && now < payload.nbf) {
    throw new Error('Token not yet valid')
  }

  if (typeof payload.exp === 'number' && now >= payload.exp) {
    throw new Error('Token expired')
  }

  if (payload.aud !== apiKey) {
    throw new Error('Token audience mismatch')
  }

  if (!payload.dest) {
    throw new Error('Token missing dest')
  }

  const destUrl = new URL(payload.dest)
  const destHost = destUrl.hostname

  if (!destHost.endsWith('.myshopify.com')) {
    throw new Error('Token dest is not a myshopify domain')
  }

  return {
    header,
    payload,
    shop: destHost
  }
}

export function createIngestSignature({ rawBody, timestamp, secret }) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex')
}

export function verifySignedIngestRequest({ rawBody, headers, secret, maxAgeMs = SIGNATURE_TTL_MS }) {
  if (!secret) {
    return {
      ok: false,
      error: 'Missing ingest signing secret'
    }
  }

  const signature = headers?.[SIGNATURE_HEADER] || headers?.[SIGNATURE_HEADER.toLowerCase()]
  const timestamp = headers?.[TIMESTAMP_HEADER] || headers?.[TIMESTAMP_HEADER.toLowerCase()]

  if (!signature || !timestamp) {
    return {
      ok: false,
      error: 'Missing ingest signature headers'
    }
  }

  const timestampMs = Number(timestamp)

  if (!Number.isFinite(timestampMs)) {
    return {
      ok: false,
      error: 'Invalid ingest timestamp'
    }
  }

  if (Math.abs(Date.now() - timestampMs) > maxAgeMs) {
    return {
      ok: false,
      error: 'Expired ingest signature'
    }
  }

  const expected = createIngestSignature({
    rawBody: rawBody || '',
    timestamp: String(timestamp),
    secret
  })

  const providedBuffer = Buffer.from(String(signature), 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')

  if (providedBuffer.length !== expectedBuffer.length) {
    return {
      ok: false,
      error: 'Invalid ingest signature'
    }
  }

  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return {
      ok: false,
      error: 'Invalid ingest signature'
    }
  }

  return {
    ok: true
  }
}

function sendInvalidSessionResponse(res, message) {
  return res
    .status(401)
    .set('X-Shopify-Retry-Invalid-Session-Request', '1')
    .json({
      success: false,
      error: message
    })
}

function getRequestOrigin(req) {
  const origin = req.get('origin')
  if (origin) return origin

  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https'
  const host = req.get('x-forwarded-host') || req.get('host')

  if (!host) {
    return null
  }

  return `${protocol}://${host}`
}

function getRequestPageUrl(req) {
  const explicit = req.body?.page_url || req.body?.page_location
  if (explicit) return explicit

  const origin = getRequestOrigin(req)
  if (!origin) return null

  try {
    return new URL(req.originalUrl || req.url || '/', origin).toString()
  } catch {
    return origin
  }
}

function cleanupRecentEventIds() {
  const cutoff = Date.now() - EVENT_DEDUPE_TTL_MS
  for (const [eventId, timestamp] of recentEventIds.entries()) {
    if (timestamp < cutoff) {
      recentEventIds.delete(eventId)
    }
  }
}

function markOrDetectDuplicateEventId(eventId) {
  cleanupRecentEventIds()

  if (recentEventIds.has(eventId)) {
    return true
  }

  recentEventIds.set(eventId, Date.now())
  return false
}

async function lookupStoreRecord(supabase, shopDomain) {
  if (!shopDomain) return null

  const { data, error } = await supabase
    .from('stores')
    .select('*')
    .eq('shop_domain', shopDomain)
    .maybeSingle()

  if (error) {
    throw new Error(`Store lookup failed: ${error.message || error}`)
  }

  return data || null
}

function normalizeStoreId(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

const DEFAULT_STORE_CONFIG = {
  interventions_enabled: true,
  is_active: true,
  tidio_enabled: true,
  shadow_mode: false,
  tidio_project_id: '63hgfq26munthk1pfvmvz25ryddkjgsf',
  aov_cohort: 'mid_tier',
  cooldown_seconds: 300,
  intervention_threshold: null,
  allowed_intervention_types: [
    'friction_assistance',
    'cart_recovery',
    'checkout_recovery',
    'trust_reassurance',
    'fast_conversion_nudge',
    'reassurance_assist',
    'high_touch_consultation'
  ]
}

function normalizeBooleanFlag(value, fallback = false) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false
  return fallback
}

function normalizePositiveInteger(value, fallback, {
  min = 0,
  max = Number.MAX_SAFE_INTEGER
} = {}) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  const rounded = Math.round(numeric)
  return Math.min(max, Math.max(min, rounded))
}

function normalizeAllowedInterventionTypes(value, fallback = DEFAULT_STORE_CONFIG.allowed_intervention_types) {
  if (!Array.isArray(value)) return [...fallback]
  const unique = new Set()
  for (const item of value) {
    const normalized = String(item || '').trim()
    if (normalized) unique.add(normalized)
  }
  return unique.size ? Array.from(unique) : [...fallback]
}

function normalizeStoreConfig(input = {}) {
  const base = {
    ...DEFAULT_STORE_CONFIG,
    ...(input && typeof input === 'object' ? input : {})
  }

  const cohort = ['impulse', 'mid_tier', 'luxury'].includes(String(base.aov_cohort || ''))
    ? String(base.aov_cohort)
    : DEFAULT_STORE_CONFIG.aov_cohort

  return {
    interventions_enabled: normalizeBooleanFlag(base.interventions_enabled, DEFAULT_STORE_CONFIG.interventions_enabled),
    is_active: normalizeBooleanFlag(
      base.is_active ?? base.interventions_enabled,
      DEFAULT_STORE_CONFIG.is_active
    ),
    tidio_enabled: normalizeBooleanFlag(base.tidio_enabled, DEFAULT_STORE_CONFIG.tidio_enabled),
    shadow_mode: normalizeBooleanFlag(base.shadow_mode, DEFAULT_STORE_CONFIG.shadow_mode),
    tidio_project_id: String(base.tidio_project_id || DEFAULT_STORE_CONFIG.tidio_project_id).trim() || DEFAULT_STORE_CONFIG.tidio_project_id,
    aov_cohort: cohort,
    cooldown_seconds: normalizePositiveInteger(base.cooldown_seconds, DEFAULT_STORE_CONFIG.cooldown_seconds, { min: 30, max: 3600 }),
    intervention_threshold: Number.isFinite(Number(base.intervention_threshold))
      ? Number(base.intervention_threshold)
      : null,
    allowed_intervention_types: normalizeAllowedInterventionTypes(base.allowed_intervention_types)
  }
}

function mergeStoreConfig(existingConfig, patchConfig) {
  return normalizeStoreConfig({
    ...normalizeStoreConfig(existingConfig),
    ...(patchConfig && typeof patchConfig === 'object' ? patchConfig : {})
  })
}

function getStoreConfigFromRecord(storeRecord) {
  return getInterventionStoreConfigFromRecord(storeRecord)
}

function sanitizeStoreConfigForMerchant(config) {
  return normalizeStoreConfig(config)
}

function sanitizeStoreConfigForStorefront(config) {
  const normalized = normalizeStoreConfig(config)
  return {
    interventions_enabled: normalized.interventions_enabled,
    tidio_enabled: normalized.tidio_enabled,
    tidio_project_id: normalized.tidio_project_id,
    shadow_mode: normalized.shadow_mode,
    cooldown_seconds: normalized.cooldown_seconds,
    allowed_intervention_types: normalized.allowed_intervention_types
  }
}

function buildSetupStatus({
  shopDomain,
  storeRecord,
  overview,
  sessionCount,
  rawEventCount
}) {
  const totals = overview?.totals || {}
  const sessions = Number((sessionCount ?? totals.sessions) || 0)
  const events = Number((rawEventCount ?? totals.rawEventCount) || 0)
  const purchases = Number(totals.convertedSessions || 0)
  const triggerCount = Number(totals.triggerCount || 0)
  const messageCount = Number(totals.messageCount || 0)

  let stage = 'install'
  if (sessions > 0) stage = 'collecting'
  if (events > 5 && triggerCount > 0) stage = 'decisioning'
  if (messageCount > 0) stage = 'intervening'
  if (purchases > 0) stage = 'measuring'

  return {
    shop_domain: shopDomain,
    stage,
    checklist: {
      store_registered: Boolean(storeRecord),
      embed_receiving_sessions: sessions > 0,
      events_flowing: events > 0,
      interventions_recorded: messageCount > 0,
      revenue_attributed: purchases > 0
    },
    diagnostics: {
      installed_at: storeRecord?.installed_at || null,
      last_event_at: storeRecord?.last_event_at || null,
      last_decision_at: storeRecord?.last_decision_at || null,
      sessions,
      raw_events: events,
      purchases,
      triggers_fired: triggerCount,
      interventions_shown: messageCount
    }
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`
  }

  return JSON.stringify(value)
}

function buildBehavioralEventId({
  anonymousId,
  sessionId,
  eventName,
  timestamp,
  properties
}) {
  const digest = crypto
    .createHash('sha256')
    .update([
      anonymousId,
      sessionId,
      eventName,
      String(timestamp),
      stableStringify(properties || {})
    ].join('|'), 'utf8')
    .digest('hex')

  return `evt_${digest.slice(0, 32)}`
}

function buildPageUrlFromProperties({ shopDomain, path }) {
  if (!shopDomain) return ''

  try {
    if (path && /^https?:\/\//i.test(path)) {
      return new URL(path).toString()
    }

    const normalizedPath = path && path.startsWith('/') ? path : '/'
    return new URL(normalizedPath, `https://${shopDomain}`).toString()
  } catch {
    return `https://${shopDomain}/`
  }
}

function getCookieValue(req, name) {
  const cookieHeader = req.headers.cookie || req.headers.Cookie
  if (typeof cookieHeader !== 'string' || !cookieHeader) {
    return null
  }

  for (const part of cookieHeader.split(';')) {
    const [cookieName, ...rest] = part.trim().split('=')
    if (cookieName === name) {
      return decodeURIComponent(rest.join('='))
    }
  }

  return null
}

function getOwnerAccessToken(req) {
  const cookieToken = getCookieValue(req, 'behavioralpro_owner_auth')
  if (cookieToken) return cookieToken

  const bearerToken = getBearerToken(req)
  if (bearerToken) return bearerToken

  const headerToken = req.headers['x-analytics-token']
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim()
  }

  if (typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim()
  }

  return null
}

function rejectRateLimited(res, retryAfterSeconds) {
  return res
    .status(429)
    .set('Retry-After', String(retryAfterSeconds))
    .json({
      success: false,
      error: 'Too many requests'
    })
}

function sendSafeServerError(res) {
  return res.status(500).json({
    success: false,
    error: 'Internal server error'
  })
}

function createRequireOwnerAccess(ownerToken) {
  return function requireOwnerAccess(req, res, next) {
    if (!ownerToken) {
      return res.status(500).json({
        success: false,
        error: 'Missing ANALYTICS_OWNER_TOKEN'
      })
    }

    const provided = getOwnerAccessToken(req)
    if (!provided || provided !== ownerToken) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized'
      })
    }

    return next()
  }
}

async function forwardEventToTinybird({
  eventRecord,
  env = process.env,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for Tinybird forwarding')
  }

  const tinybirdToken = getTinybirdIngestToken(env)
  if (!tinybirdToken) {
    throw new Error('Missing Tinybird ingest token')
  }

  const response = await fetchImpl(getTinybirdEventsApiUrl(env), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tinybirdToken}`,
      'Content-Type': 'application/x-ndjson'
    },
    body: `${JSON.stringify({
      ...eventRecord,
      metadata: JSON.stringify(eventRecord.metadata || {})
    })}\n`
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Tinybird ingest failed with status ${response.status}: ${text}`)
  }

  const text = await response.text().catch(() => '')
  return {
    ok: true,
    status: response.status,
    body: text
  }
}

async function mirrorPhase1EventToLegacyAnalytics({
  analyticsOptions,
  eventRecord,
  legacyAssignmentMirrorEnabled,
  supabaseRawEventMirrorEnabled
}) {
  const legacy = getLegacyEventMirror(eventRecord)
  if (!legacy) {
    return { mirrored: false, reason: 'unmapped' }
  }

  if (legacy.kind === 'assignment') {
    if (!legacyAssignmentMirrorEnabled) {
      return { mirrored: false, reason: 'assignment_mirror_disabled' }
    }

    await trackSessionStarted({
      eventId: eventRecord.event_id,
      eventType: legacy.eventType,
      sessionId: eventRecord.session_id,
      shopDomain: eventRecord.shop_domain,
      variant: eventRecord.experiment_variant,
      occurredAt: eventRecord.client_timestamp
    }, analyticsOptions)

    return { mirrored: true, eventType: legacy.eventType }
  }

  if (!supabaseRawEventMirrorEnabled) {
    return { mirrored: false, reason: 'raw_event_mirror_disabled' }
  }

  await trackBehavioralEvent({
    eventId: eventRecord.event_id,
    eventType: legacy.eventType,
    sessionId: eventRecord.session_id,
    shopDomain: eventRecord.shop_domain,
    variant: eventRecord.experiment_variant,
    occurredAt: eventRecord.client_timestamp,
    visitorId: eventRecord.visitor_id,
    pageUrl: eventRecord.page_url,
    referrer: eventRecord.referrer,
    productId: eventRecord.metadata?.product_id,
    productHandle: eventRecord.metadata?.product_handle,
    cartValue: eventRecord.metadata?.cart_value,
    value: eventRecord.metadata?.value ?? 0,
    reason: eventRecord.metadata?.reason,
    triggerType: legacy.triggerType,
    messageName: legacy.messageName,
    metadata: {
      ...eventRecord.metadata,
      source: 'phase1_event_spine'
    }
  }, analyticsOptions)

  return { mirrored: true, eventType: legacy.eventType }
}

async function logShadowInterventionDecision({
  shopDomain,
  sessionId,
  session = null,
  result,
  env = process.env,
  fetchImpl = globalThis.fetch
}) {
  const metadata = {
    strategy: result?.strategy || 'unknown',
    reason: result?.reason || 'unknown',
    decision: Boolean(result?.decision),
    intervention_type: result?.intervention_type || 'none',
    message_id: result?.message_id || getInterventionMessageId(result?.intervention_type || 'none'),
    calculated_threshold: Number(result?.calculated_threshold || 0),
    session_score: Number(result?.session_score || 0)
  }

  const eventRecord = buildPhase1EventRecord({
    store_id: normalizeStoreId(session?.store_id),
    event_name: 'shadow_intervention_logged',
    shop_domain: shopDomain,
    session_id: sessionId,
    visitor_id: String(session?.visitor_id || `shadow_${sessionId}`),
    experiment_variant: String(session?.experiment_variant || 'control'),
    page_url: String(session?.page_url || `https://${shopDomain}/`),
    referrer: session?.referrer || null,
    client_timestamp: new Date().toISOString(),
    event_id: createPhase1EventId('shadow'),
    metadata
  })

  return forwardEventToTinybird({
    eventRecord,
    env,
    fetchImpl
  })
}

export async function ingestPhase1Event({
  env = process.env,
  analyticsOptions,
  eventRecord,
  legacyAssignmentMirrorEnabled = true,
  supabaseRawEventMirrorEnabled = false,
  authMode = null,
  fetchImpl = globalThis.fetch
}) {
  const duplicate = markOrDetectDuplicateEventId(eventRecord.event_id)

  if (duplicate) {
    console.log('PHASE1 EVENT DUPLICATE:', JSON.stringify({
      event_id: eventRecord.event_id,
      event_name: eventRecord.event_name,
      shop_domain: eventRecord.shop_domain,
      session_id: eventRecord.session_id
    }))

    return {
      duplicate: true,
      record: eventRecord,
      tinybird: { forwarded: false, reason: 'duplicate' },
      legacyMirror: { mirrored: false, reason: 'duplicate' }
    }
  }

  const tinybird = await forwardEventToTinybird({
    eventRecord,
    env,
    fetchImpl
  })

  const legacyMirror = await mirrorPhase1EventToLegacyAnalytics({
    analyticsOptions,
    eventRecord,
    legacyAssignmentMirrorEnabled,
    supabaseRawEventMirrorEnabled
  })

  console.log('PHASE1 EVENT FORWARDED:', JSON.stringify({
    event_id: eventRecord.event_id,
    event_name: eventRecord.event_name,
    shop_domain: eventRecord.shop_domain,
    session_id: eventRecord.session_id,
    auth_mode: authMode,
    tinybird_status: tinybird.status,
    legacy_mirrored: legacyMirror.mirrored
  }))

  return {
    duplicate: false,
    record: eventRecord,
    tinybird,
    legacyMirror
  }
}

async function queryTinybirdSingleRow({ sql, env, fetchImpl, logLabel }) {
  const result = await queryTinybirdSql({ sql, env, fetchImpl, logLabel })
  return Array.isArray(result.data) && result.data[0] ? result.data[0] : null
}

export async function buildSessionFeaturesHealthReport({
  env,
  fetchImpl = globalThis.fetch
}) {
  const sessionFeaturesCte = buildSessionFeaturesBaseCte()

  const summary = await queryTinybirdSingleRow({
    env,
    fetchImpl,
    logLabel: 'SESSION FEATURES HEALTH SUMMARY',
    sql: `
      ${sessionFeaturesCte}
      SELECT
        count() AS total_sessions_processed,
        uniqExactIf(store_id, notEmpty(ifNull(store_id, ''))) AS unique_stores_represented,
        countIf(empty(ifNull(store_id, ''))) AS sessions_missing_store_id,
        sum(toUInt64(purchased)) AS total_purchases,
        sum(toUInt64(reached_checkout)) AS total_reached_checkout,
        sum(toUInt64(provisional_abandoned_cart)) AS total_provisional_abandoned_carts,
        sum(toUInt64(provisional_abandoned_checkout)) AS total_provisional_abandoned_checkouts,
        sum(toUInt64(had_intervention)) AS total_had_intervention,
        countIf(empty(ifNull(visitor_id, ''))) AS rows_missing_visitor_id,
        countIf(empty(ifNull(experiment_variant, ''))) AS rows_missing_experiment_variant,
        sum(ifNull(malformed_metadata_count, 0)) AS malformed_metadata_count,
        max(last_seen_at) AS latest_session_seen_at,
        min(first_seen_at) AS oldest_session_seen_at
      FROM session_features
    `
  })

  const sessionsByStore = await queryTinybirdSql({
    env,
    fetchImpl,
    logLabel: 'SESSION FEATURES HEALTH STORES',
    sql: `
      ${sessionFeaturesCte}
      SELECT
        store_id,
        count() AS sessions
      FROM session_features
      WHERE notEmpty(ifNull(store_id, ''))
      GROUP BY store_id
      ORDER BY sessions DESC, store_id ASC
      LIMIT 100
    `
  })

  const fallbackByShop = await queryTinybirdSql({
    env,
    fetchImpl,
    logLabel: 'SESSION FEATURES HEALTH FALLBACK',
    sql: `
      ${sessionFeaturesCte}
      SELECT
        shop_domain,
        count() AS sessions
      FROM session_features
      WHERE empty(ifNull(store_id, ''))
      GROUP BY shop_domain
      ORDER BY sessions DESC, shop_domain ASC
      LIMIT 100
    `
  })

  const rawDataQuality = await queryTinybirdSingleRow({
    env,
    fetchImpl,
    logLabel: 'SESSION FEATURES HEALTH RAW',
    sql: `
      SELECT
        countIf(empty(ifNull(session_id, ''))) AS rows_missing_session_id,
        countIf(empty(ifNull(visitor_id, ''))) AS raw_rows_missing_visitor_id,
        countIf(empty(ifNull(experiment_variant, ''))) AS raw_rows_missing_experiment_variant,
        count() - uniqExact(event_id) AS duplicate_event_id_count,
        countIf(notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata) = 0) AS malformed_metadata_count
      FROM raw_events
    `
  })

  const response = {
    ok: true,
    total_sessions_processed: Number(summary?.total_sessions_processed || 0),
    unique_stores_represented: Number(summary?.unique_stores_represented || 0),
    sessions_missing_store_id: Number(summary?.sessions_missing_store_id || 0),
    sessions_by_store_id: sessionsByStore.data || [],
    fallback_sessions_by_shop_domain: fallbackByShop.data || [],
    conversion_metrics: {
      total_purchases: Number(summary?.total_purchases || 0),
      total_reached_checkout: Number(summary?.total_reached_checkout || 0),
      total_provisional_abandoned_carts: Number(summary?.total_provisional_abandoned_carts || 0),
      total_provisional_abandoned_checkouts: Number(summary?.total_provisional_abandoned_checkouts || 0),
      total_had_intervention: Number(summary?.total_had_intervention || 0)
    },
    data_quality: {
      rows_missing_session_id: Number(rawDataQuality?.rows_missing_session_id || 0),
      rows_missing_visitor_id: Number(summary?.rows_missing_visitor_id || 0),
      rows_missing_experiment_variant: Number(summary?.rows_missing_experiment_variant || 0),
      malformed_metadata_count: rawDataQuality?.malformed_metadata_count != null
        ? Number(rawDataQuality.malformed_metadata_count)
        : null,
      duplicate_event_id_count: rawDataQuality?.duplicate_event_id_count != null
        ? Number(rawDataQuality.duplicate_event_id_count)
        : null
    },
    latest_session_seen_at: summary?.latest_session_seen_at || null,
    oldest_session_seen_at: summary?.oldest_session_seen_at || null
  }

  console.log('SESSION FEATURES HEALTH REPORT:', JSON.stringify({
    total_sessions_processed: response.total_sessions_processed,
    unique_stores_represented: response.unique_stores_represented,
    sessions_missing_store_id: response.sessions_missing_store_id
  }))

  return response
}

export function buildMetricsPayload(shopDomain, overview) {
  const controlSessions = overview.sessionTable.filter(session => session.variant === 'control')
  const variantSessions = overview.sessionTable.filter(session => session.variant === 'variant')
  const exposedSessions = overview.sessionTable.filter(session => Array.isArray(session.messages_shown) && session.messages_shown.length > 0)
  const unexposedSessions = overview.sessionTable.filter(session => !Array.isArray(session.messages_shown) || session.messages_shown.length === 0)

  function summarize(sessions) {
    const purchases = sessions.filter(session => session.converted).length
    const revenue = sessions.reduce((sum, session) => sum + Number(session.revenue || 0), 0)

    return {
      sessions: sessions.length,
      purchases,
      revenue,
      conversion_rate: sessions.length === 0 ? 0 : purchases / sessions.length,
      revenue_per_session: sessions.length === 0 ? 0 : revenue / sessions.length
    }
  }

  const control = summarize(controlSessions)
  const variant = summarize(variantSessions)
  const exposed = summarize(exposedSessions)
  const unexposed = summarize(unexposedSessions)
  const liftPercent = control.revenue_per_session === 0
    ? 0
    : ((variant.revenue_per_session - control.revenue_per_session) / control.revenue_per_session) * 100
  const exposureLiftPercent = unexposed.revenue_per_session === 0
    ? 0
    : ((exposed.revenue_per_session - unexposed.revenue_per_session) / unexposed.revenue_per_session) * 100
  const incrementalRevenueEstimate = Math.max(
    0,
    (variant.revenue_per_session - control.revenue_per_session) * variant.sessions
  )

  return {
    shop_domain: shopDomain,
    control,
    variant,
    exposed,
    unexposed,
    totals: overview.totals || {},
    lift_percent: liftPercent,
    exposure_rate: overview.sessionTable.length === 0 ? 0 : exposed.sessions / overview.sessionTable.length,
    exposure_lift_percent: exposureLiftPercent,
    incremental_revenue_estimate: incrementalRevenueEstimate
  }
}

function buildDashboardPage({ shopDomain, apiKey }) {
  const escapedShop = escapeHtml(shopDomain)
  const escapedApiKey = escapeHtml(apiKey || '')

  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="shopify-api-key" content="${escapedApiKey}" />
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <title>BehavioralPro Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 32px;
      background: #f6f7f8;
      color: #111827;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 {
      font-size: 44px;
      margin: 0 0 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    h2 { font-size: 20px; margin: 0 0 16px; }
    .card {
      background: #ffffff;
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 1px 10px rgba(0, 0, 0, 0.06);
    }
    .muted { color: #6b7280; font-size: 14px; line-height: 1.5; }
    .store-line { font-size: 18px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .analytics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }
    .setup-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px;
    }
    .stat { background: #f9fafb; border-radius: 12px; padding: 14px; }
    .label { font-size: 13px; color: #6b7280; margin-bottom: 6px; }
    .value { font-size: 28px; font-weight: 700; line-height: 1.1; }
    .value.small { font-size: 20px; }
    .checklist { display: grid; gap: 10px; margin-top: 14px; }
    .check-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 12px;
      background: #f9fafb;
      font-size: 14px;
    }
    .check-row strong { font-size: 14px; }
    .check-ok { color: #047857; font-weight: 700; }
    .check-pending { color: #b45309; font-weight: 700; }
    .controls-form {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-top: 14px;
    }
    .field { display: grid; gap: 8px; }
    .field label { font-size: 13px; color: #374151; font-weight: 600; }
    .field input, .field select {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #d1d5db;
      font-size: 14px;
      background: #ffffff;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
    }
    .actions { display: flex; gap: 12px; align-items: center; margin-top: 16px; }
    .button {
      appearance: none;
      border: 0;
      border-radius: 12px;
      padding: 11px 14px;
      background: #111827;
      color: #ffffff;
      font-weight: 600;
      cursor: pointer;
    }
    .pill {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: #eef2ff;
      color: #3730a3;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 10px;
    }
    .instructions ol { margin: 12px 0 0 18px; padding: 0; line-height: 1.7; }
    .analytics-empty {
      color: #6b7280;
      font-size: 14px;
      line-height: 1.5;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.5;
      background: #0f172a;
      color: #e5e7eb;
      padding: 16px;
      border-radius: 12px;
      overflow: auto;
    }
    .error { color: #b91c1c; font-weight: 600; }
    .ok { color: #047857; font-weight: 600; }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
      .setup-grid { grid-template-columns: 1fr; }
      .controls-form { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      body { padding: 18px; }
      h1 { font-size: 32px; }
      .stats-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>BehavioralPro Dashboard</h1>

    <div class="card">
      <div class="store-line"><strong>Store:</strong> <span id="shop-domain">${escapedShop}</span></div>
      <div class="muted" style="margin-top: 8px;">
        Revenue lift test dashboard for this Shopify store.
      </div>
      <div class="muted" style="margin-top: 8px;">
        Embedded auth check: <span id="embedded-auth-status">Checking...</span>
      </div>
    </div>

    <div class="card instructions">
      <div class="pill">Setup</div>
      <h2>How to start the test</h2>
      <div class="muted">
        If data is not appearing yet, make sure the app embed is turned on for this store.
      </div>
      <ol>
        <li>Go to <strong>Online Store → Themes → Customize</strong></li>
        <li>Open <strong>App embeds</strong></li>
        <li>Toggle <strong>BehavioralPro</strong> ON</li>
        <li>Save</li>
      </ol>
    </div>

    <div class="setup-grid">
      <div class="card">
        <div class="pill">Setup Status</div>
        <h2>Store Readiness</h2>
        <div class="muted">This checks whether the store is installed, collecting behavior, and showing interventions.</div>
        <div class="muted" style="margin-top: 8px;">Current stage: <strong id="setup-stage">Loading...</strong></div>
        <div class="checklist" id="setup-checklist"></div>
      </div>

      <div class="card">
        <div class="pill">Controls</div>
        <h2>Intervention Controls</h2>
        <div class="muted">These settings change live storefront behavior without editing theme code.</div>
        <div class="controls-form">
          <div class="toggle"><input type="checkbox" id="cfg-interventions-enabled" /><label for="cfg-interventions-enabled">Enable interventions</label></div>
          <div class="toggle"><input type="checkbox" id="cfg-tidio-enabled" /><label for="cfg-tidio-enabled">Deliver through Tidio</label></div>
          <div class="toggle"><input type="checkbox" id="cfg-shadow-mode" /><label for="cfg-shadow-mode">Shadow mode only</label></div>
          <div class="field">
            <label for="cfg-aov-cohort">AOV cohort</label>
            <select id="cfg-aov-cohort">
              <option value="impulse">Impulse</option>
              <option value="mid_tier">Mid-tier</option>
              <option value="luxury">Luxury</option>
            </select>
          </div>
          <div class="field">
            <label for="cfg-cooldown-seconds">Cooldown seconds</label>
            <input type="number" id="cfg-cooldown-seconds" min="30" max="3600" step="30" />
          </div>
          <div class="field">
            <label for="cfg-tidio-project-id">Tidio project ID</label>
            <input type="text" id="cfg-tidio-project-id" />
          </div>
        </div>
        <div class="actions">
          <button class="button" id="save-controls-button" type="button">Save controls</button>
          <span class="muted" id="controls-save-status">Waiting for settings...</span>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="pill">Control</div>
        <div class="stats-grid">
          <div class="stat"><div class="label">Sessions</div><div class="value" id="control-sessions">—</div></div>
          <div class="stat"><div class="label">Purchases</div><div class="value" id="control-purchases">—</div></div>
          <div class="stat"><div class="label">Revenue</div><div class="value small" id="control-revenue">—</div></div>
          <div class="stat"><div class="label">Conversion Rate</div><div class="value small" id="control-conversion">—</div></div>
          <div class="stat"><div class="label">Revenue / Session</div><div class="value small" id="control-rps">—</div></div>
        </div>
      </div>

      <div class="card">
        <div class="pill">Variant</div>
        <div class="stats-grid">
          <div class="stat"><div class="label">Sessions</div><div class="value" id="variant-sessions">—</div></div>
          <div class="stat"><div class="label">Purchases</div><div class="value" id="variant-purchases">—</div></div>
          <div class="stat"><div class="label">Revenue</div><div class="value small" id="variant-revenue">—</div></div>
          <div class="stat"><div class="label">Conversion Rate</div><div class="value small" id="variant-conversion">—</div></div>
          <div class="stat"><div class="label">Revenue / Session</div><div class="value small" id="variant-rps">—</div></div>
        </div>
      </div>

      <div class="card">
        <div class="pill">Lift</div>
        <div class="stats-grid">
          <div class="stat"><div class="label">Lift %</div><div class="value" id="lift-percent">—</div></div>
          <div class="stat"><div class="label">Current Status</div><div class="value small" id="status-text">Loading...</div></div>
          <div class="stat"><div class="label">Exposure Rate</div><div class="value small" id="exposure-rate">—</div></div>
          <div class="stat"><div class="label">Estimated Incremental Revenue</div><div class="value small" id="incremental-revenue">—</div></div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Debug JSON</h2>
      <pre id="metrics-json">Loading...</pre>
    </div>

    <div class="card">
      <div class="pill">Private Analytics</div>
      <h2>Trigger Conversion Rates</h2>
      <div class="muted" style="margin-bottom: 16px;">
        Visible only after the embedded Shopify session token is validated for this store.
      </div>
      <div class="analytics-grid" id="analytics-rates-grid">
        <div class="analytics-empty" id="analytics-empty-state">
          Waiting for secure analytics data...
        </div>
      </div>
    </div>
  </div>

  <script>
    const shopDomain = ${JSON.stringify(shopDomain)};
    let currentStoreConfig = null;

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function setStatus(id, value, className) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = value;
      el.classList.remove('ok', 'error');
      if (className) el.classList.add(className);
    }

    function formatMoney(value) {
      const num = Number(value || 0);
      return '$' + num.toFixed(2);
    }

    function formatPercent(value) {
      const num = Number(value || 0) * 100;
      return num.toFixed(1) + '%';
    }

    function renderAnalyticsRates(items) {
      const container = document.getElementById('analytics-rates-grid');
      if (!container) return;

      if (!Array.isArray(items) || items.length === 0) {
        container.innerHTML =
          '<div class="analytics-empty">No trigger analytics recorded for this store yet.</div>';
        return;
      }

      container.innerHTML = items
        .map(item => {
          const triggerType = String(item.triggerType || 'unknown');
          const triggerCount = Number(item.triggerCount || 0);
          const checkoutCount = Number(item.checkoutCount || 0);
          const conversionRate = formatPercent(item.conversionRate || 0);

          return [
            '<div class="stat">',
            '<div class="label">Trigger Type</div>',
            '<div class="value small">' + triggerType + '</div>',
            '<div class="label" style="margin-top: 14px;">Triggers Fired</div>',
            '<div class="value small">' + String(triggerCount) + '</div>',
            '<div class="label" style="margin-top: 14px;">Completed Checkouts</div>',
            '<div class="value small">' + String(checkoutCount) + '</div>',
            '<div class="label" style="margin-top: 14px;">Conversion Rate</div>',
            '<div class="value small">' + conversionRate + '</div>',
            '</div>'
          ].join('');
        })
        .join('');
    }

    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)
        )
      ]);
    }

    async function getSessionTokenOrThrow() {
      if (!window.shopify) {
        throw new Error('window.shopify is missing');
      }

      if (typeof window.shopify.idToken !== 'function') {
        throw new Error('shopify.idToken is not available');
      }

      const token = await withTimeout(window.shopify.idToken(), 8000, 'shopify.idToken()');

      if (!token) {
        throw new Error('No session token returned');
      }

      return token;
    }

    async function authedFetch(url, options = {}) {
      const token = await getSessionTokenOrThrow();
      const headers = new Headers(options.headers || {});
      headers.set('Authorization', 'Bearer ' + token);

      return fetch(url, {
        ...options,
        headers,
        credentials: 'same-origin'
      });
    }

    async function authedJson(url, options = {}) {
      const response = await authedFetch(url, options);
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Request failed');
      }
      return json.data;
    }

    function renderSetupStatus(setup) {
      setText('setup-stage', String(setup && setup.stage ? setup.stage : 'unknown'));
      const container = document.getElementById('setup-checklist');
      if (!container) return;

      const checklist = setup && setup.checklist ? setup.checklist : {};
      const rows = [
        ['Store registered', checklist.store_registered],
        ['Sessions received', checklist.embed_receiving_sessions],
        ['Behavioral events flowing', checklist.events_flowing],
        ['Interventions recorded', checklist.interventions_recorded],
        ['Revenue measured', checklist.revenue_attributed]
      ];

      container.innerHTML = rows.map(function (row) {
        const ok = Boolean(row[1]);
        return [
          '<div class="check-row">',
          '<strong>' + row[0] + '</strong>',
          '<span class="' + (ok ? 'check-ok' : 'check-pending') + '">' + (ok ? 'Ready' : 'Pending') + '</span>',
          '</div>'
        ].join('');
      }).join('');
    }

    function applyStoreConfigToForm(config) {
      currentStoreConfig = config || {};
      document.getElementById('cfg-interventions-enabled').checked = currentStoreConfig.interventions_enabled !== false;
      document.getElementById('cfg-tidio-enabled').checked = currentStoreConfig.tidio_enabled !== false;
      document.getElementById('cfg-shadow-mode').checked = currentStoreConfig.shadow_mode === true;
      document.getElementById('cfg-aov-cohort').value = String(currentStoreConfig.aov_cohort || 'mid_tier');
      document.getElementById('cfg-cooldown-seconds').value = String(currentStoreConfig.cooldown_seconds || 300);
      document.getElementById('cfg-tidio-project-id').value = String(currentStoreConfig.tidio_project_id || '');
      setStatus('controls-save-status', 'Settings loaded', 'ok');
    }

    function readStoreConfigFromForm() {
      return {
        interventions_enabled: document.getElementById('cfg-interventions-enabled').checked,
        tidio_enabled: document.getElementById('cfg-tidio-enabled').checked,
        shadow_mode: document.getElementById('cfg-shadow-mode').checked,
        aov_cohort: document.getElementById('cfg-aov-cohort').value,
        cooldown_seconds: Number(document.getElementById('cfg-cooldown-seconds').value || 300),
        tidio_project_id: document.getElementById('cfg-tidio-project-id').value.trim()
      };
    }

    async function verifyEmbeddedAuth() {
      try {
        setStatus('embedded-auth-status', 'Requesting session token...');

        const response = await authedFetch(
          '/api/embedded-check?shop=' + encodeURIComponent(shopDomain),
          { method: 'GET' }
        );

        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(json.error || 'Embedded auth check failed');
        }

        setStatus('embedded-auth-status', 'Session token accepted', 'ok');
        return true;
      } catch (error) {
        console.error('Embedded auth check error:', error);
        setStatus('embedded-auth-status', 'Failed: ' + String(error.message || error), 'error');

        const metricsJson = document.getElementById('metrics-json');
        if (metricsJson) {
          metricsJson.textContent =
            'Embedded auth error:\\n\\n' + String(error.message || error);
        }

        return false;
      }
    }

    async function loadStoreConfig() {
      try {
        const data = await authedJson(
          '/api/store-config/' +
            encodeURIComponent(shopDomain) +
            '?shop=' +
            encodeURIComponent(shopDomain),
          { method: 'GET' }
        );

        applyStoreConfigToForm(data.config || {});
        renderSetupStatus(data.setup || {});
      } catch (error) {
        console.error('Store config error:', error);
        setStatus('controls-save-status', 'Failed to load settings', 'error');
      }
    }

    async function saveStoreConfig() {
      try {
        setStatus('controls-save-status', 'Saving...');
        const data = await authedJson(
          '/api/store-config/' +
            encodeURIComponent(shopDomain) +
            '?shop=' +
            encodeURIComponent(shopDomain),
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              config: readStoreConfigFromForm()
            })
          }
        );

        applyStoreConfigToForm(data.config || {});
        setStatus('controls-save-status', 'Saved', 'ok');
      } catch (error) {
        console.error('Save controls error:', error);
        setStatus('controls-save-status', 'Save failed: ' + String(error.message || error), 'error');
      }
    }

    async function loadMetrics() {
      try {
        const response = await authedFetch(
          '/api/metrics/' +
            encodeURIComponent(shopDomain) +
            '?shop=' +
            encodeURIComponent(shopDomain),
          { method: 'GET' }
        );

        const json = await response.json();

        if (!response.ok || !json.success || !json.data) {
          throw new Error(json.error || 'Metrics response missing data');
        }

        const data = json.data;
        const control = data.control || {};
        const variant = data.variant || {};

        setText('control-sessions', String(control.sessions ?? 0));
        setText('control-purchases', String(control.purchases ?? 0));
        setText('control-revenue', formatMoney(control.revenue));
        setText('control-conversion', formatPercent(control.conversion_rate));
        setText('control-rps', formatMoney(control.revenue_per_session));

        setText('variant-sessions', String(variant.sessions ?? 0));
        setText('variant-purchases', String(variant.purchases ?? 0));
        setText('variant-revenue', formatMoney(variant.revenue));
        setText('variant-conversion', formatPercent(variant.conversion_rate));
        setText('variant-rps', formatMoney(variant.revenue_per_session));

        const lift = Number(data.lift_percent ?? 0);
        setText('lift-percent', lift.toFixed(1) + '%');
        setText('exposure-rate', formatPercent(data.exposure_rate || 0));
        setText('incremental-revenue', formatMoney(data.incremental_revenue_estimate || 0));

        const totalSessions = Number(control.sessions || 0) + Number(variant.sessions || 0);
        const totalPurchases = Number(control.purchases || 0) + Number(variant.purchases || 0);

        let status = 'Running';
        if (totalSessions === 0) status = 'Waiting for traffic';
        else if (totalPurchases === 0) status = 'Collecting data';

        setText('status-text', status);
        setText('metrics-json', JSON.stringify(json, null, 2));
      } catch (error) {
        console.error('Metrics error:', error);
        setStatus('status-text', 'Error', 'error');

        const metricsJson = document.getElementById('metrics-json');
        if (metricsJson) {
          metricsJson.textContent =
            'Error loading dashboard data:\\n\\n' + String(error.message || error);
        }
      }
    }

function renderAbandonmentByVariant(rows) {
  const existing = document.getElementById('abandonment-by-variant-card')
  const card = existing || document.createElement('section')

  card.id = 'abandonment-by-variant-card'
  card.style.border = '1px solid #e5e7eb'
  card.style.borderRadius = '12px'
  card.style.padding = '16px'
  card.style.margin = '16px 0'
  card.style.background = '#ffffff'

  const data = Array.isArray(rows) ? rows : []
  const variantA = data.find((row) => row.variant === 'A') || {}
  const variantB = data.find((row) => row.variant === 'B') || {}

  const rateA = Number(variantA.abandonment_rate_percent || 0)
  const rateB = Number(variantB.abandonment_rate_percent || 0)
  const relativeReduction = rateA > 0 ? ((rateA - rateB) / rateA) * 100 : 0

  card.innerHTML =
    '<h3 style="margin:0 0 8px;font-size:16px;">Abandonment by Variant</h3>' +
    '<p style="margin:0 0 12px;color:#6b7280;font-size:13px;">Tinybird real-time A/B abandonment analytics</p>' +
    '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">' +
      '<div>' +
        '<div style="font-size:12px;color:#6b7280;">Variant A</div>' +
        '<div style="font-size:22px;font-weight:700;">' + rateA.toFixed(2) + '%</div>' +
        '<div style="font-size:12px;color:#6b7280;">' + (variantA.sessions || 0) + ' sessions</div>' +
      '</div>' +
      '<div>' +
        '<div style="font-size:12px;color:#6b7280;">Variant B</div>' +
        '<div style="font-size:22px;font-weight:700;">' + rateB.toFixed(2) + '%</div>' +
        '<div style="font-size:12px;color:#6b7280;">' + (variantB.sessions || 0) + ' sessions</div>' +
      '</div>' +
      '<div>' +
        '<div style="font-size:12px;color:#6b7280;">Relative Reduction</div>' +
        '<div style="font-size:22px;font-weight:700;">' + relativeReduction.toFixed(1) + '%</div>' +
        '<div style="font-size:12px;color:#6b7280;">B vs A</div>' +
      '</div>' +
    '</div>'

  if (!existing) {
    const metricsJson = document.getElementById('metrics-json')
    if (metricsJson && metricsJson.parentNode) {
      metricsJson.parentNode.insertBefore(card, metricsJson)
    } else {
      document.body.appendChild(card)
    }
  }
}

    async function loadAnalyticsRates() {
      try {
        const response = await authedFetch(
          '/api/analytics/conversion-rates/' +
            encodeURIComponent(shopDomain) +
            '?shop=' +
            encodeURIComponent(shopDomain),
          { method: 'GET' }
        );

        const json = await response.json();

        if (!response.ok || !json.success || !json.data) {
          throw new Error(json.error || 'Analytics response missing data');
        }

        renderAnalyticsRates(json.data.conversion_rates || []);
      } catch (error) {
        console.error('Analytics rates error:', error);
        renderAnalyticsRates([]);
      }
    }

    async function boot() {
      const authOk = await verifyEmbeddedAuth();
      if (authOk) {
        await Promise.all([loadStoreConfig(), loadMetrics(), loadAnalyticsRates(), loadAbandonmentByVariant()]);
      } else {
        setStatus('status-text', 'Blocked by auth', 'error');
        renderAnalyticsRates([]);
      }
    }

async function loadAbandonmentByVariant() {
  try {
    const response = await authedFetch('/api/analytics/abandonment-by-variant', {
      method: 'GET'
    })

    const json = await response.json()

    if (!response.ok || !json.success || !json.data) {
      throw new Error(json.error || 'Abandonment response missing data')
    }

    renderAbandonmentByVariant(json.data || [])
  } catch (error) {
    console.error('Abandonment analytics error:', error)
    renderAbandonmentByVariant([])
  }
}

    document.getElementById('save-controls-button').addEventListener('click', saveStoreConfig);
    boot();
  </script>
</body>
</html>`
}

export function createApp({
  env = process.env,
  supabase: providedSupabase,
  fetchImpl = globalThis.fetch
} = {}) {
  const app = express()
  const corsOptions = {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-BehavioralPro-Signature', 'X-BehavioralPro-Timestamp', 'X-Analytics-Token'],
    credentials: false
  }
  const supabase = providedSupabase || createSupabaseClient(env)
  const analyticsOptions = { supabase }
  const ingestSigningSecret = env.INGEST_SIGNING_SECRET || env.SHOPIFY_API_SECRET
  const legacyAssignmentMirrorEnabled = env.BEHAVIORALPRO_ENABLE_LEGACY_ASSIGNMENT_MIRROR !== 'false'
  const supabaseRawEventMirrorEnabled = env.BEHAVIORALPRO_ENABLE_SUPABASE_RAW_EVENT_MIRROR === 'true'
  const requireOwnerAccess = createRequireOwnerAccess(env.ANALYTICS_OWNER_TOKEN)

  if (!env.SHOPIFY_API_KEY) {
    console.warn('Missing SHOPIFY_API_KEY')
  }

  if (!env.SHOPIFY_API_SECRET) {
    console.warn('Missing SHOPIFY_API_SECRET')
  }

  if (!providedSupabase && !env.SUPABASE_URL) {
    console.warn('Missing SUPABASE_URL')
  }

  if (!providedSupabase && !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Missing SUPABASE_SERVICE_ROLE_KEY')
  }

  app.use(cors(corsOptions))
  app.use(express.json({
    limit: env.BEHAVIORALPRO_JSON_LIMIT || '16kb',
    verify(req, _res, buf) {
      req.rawBody = buf.toString('utf8')
    }
  }))
  app.use((req, _res, next) => {
    console.log('INCOMING:', req.method, req.url)
    next()
  })

  for (const route of [
    '/api/events',
    '/api/assign-variant',
    '/api/stores',
    '/api/metrics/:shop_domain',
    '/api/debug/:shop_domain',
    '/api/embedded-check',
    '/api/analytics/conversion-rates/:shop_domain',
    '/api/admin/session-features-health',
    '/api/intervention-decision'
  ]) {
    app.options(route, cors(corsOptions))
  }

  registerOwnerAnalyticsRoutes({
    app,
    supabase,
    ownerToken: env.ANALYTICS_OWNER_TOKEN,
    analyticsOptions
  })

  function requireShopifySessionToken(req, res, next) {
    try {
      const token = getBearerToken(req)
      const verified = verifyShopifySessionToken(token, env)
      const requestedShop =
        normalizeShop(req.query.shop) ||
        normalizeShop(req.params.shop_domain) ||
        normalizeShop(req.body?.shop_domain)

      if (requestedShop && requestedShop !== verified.shop) {
        return sendInvalidSessionResponse(res, 'Shop mismatch')
      }

      req.shopifySession = verified
      return next()
    } catch (error) {
      console.log('SESSION TOKEN ERROR:', error.message)
      return sendInvalidSessionResponse(res, error.message)
    }
  }

  function requireSignedIngestOrSession(req, res, next) {
    const requestedShop =
      normalizeShop(req.query.shop) ||
      normalizeShop(req.params.shop_domain) ||
      getShopDomainFromRequestBody(req.body)

    try {
      const token = getBearerToken(req)
      if (token) {
        const verified = verifyShopifySessionToken(token, env)
        if (requestedShop && requestedShop !== verified.shop) {
          return sendInvalidSessionResponse(res, 'Shop mismatch')
        }
        req.shopifySession = verified
        req.ingestAuth = { mode: 'session-token' }
        return next()
      }
    } catch (error) {
      console.log('SESSION TOKEN ERROR:', error.message)
    }

    const signed = verifySignedIngestRequest({
      rawBody: req.rawBody || '',
      headers: req.headers,
      secret: ingestSigningSecret
    })

    if (!signed.ok) {
      return res.status(401).json({
        success: false,
        error: signed.error
      })
    }

    req.ingestAuth = { mode: 'signed-ingest' }
    return next()
  }

  function requireEventIngestAuth(req, res, next) {
    const requestedShop = getShopDomainFromRequestBody(req.body)

    try {
      const token = getBearerToken(req)
      if (token) {
        const verified = verifyShopifySessionToken(token, env)
        if (requestedShop && requestedShop !== verified.shop) {
          return sendInvalidSessionResponse(res, 'Shop mismatch')
        }
        req.shopifySession = verified
        req.ingestAuth = { mode: 'session-token' }
        return next()
      }
    } catch (error) {
      console.log('SESSION TOKEN ERROR:', error.message)
    }

    const signed = verifySignedIngestRequest({
      rawBody: req.rawBody || '',
      headers: req.headers,
      secret: ingestSigningSecret
    })

    if (signed.ok) {
      req.ingestAuth = { mode: 'signed-ingest' }
      return next()
    }

    // Theme app extensions run in the storefront and cannot hold server secrets.
    // Allow unsigned ingest here so the live storefront experiment can still assign
    // variants and emit events, while keeping store registration protected.
    if (requestedShop && req.body?.session_id) {
      req.ingestAuth = { mode: 'storefront-unsigned' }
      return next()
    }

    return res.status(401).json({
      success: false,
      error: signed.error
    })
  }

  function verifyWebhookRequest(req) {
    return verifyShopifyWebhook({
      rawBody: req.rawBody || '',
      hmacHeader: req.get('X-Shopify-Hmac-Sha256'),
      secret: env.SHOPIFY_API_SECRET
    })
  }

  app.post('/api/stores', requireSignedIngestOrSession, async (req, res) => {
    try {
      const shop_domain = normalizeShop(req.body?.shop_domain)
      const { access_token = null, scope = null } = req.body || {}

      if (!shop_domain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const row = {
        shop_domain,
        access_token,
        scope,
        installed_at: new Date().toISOString(),
        settings: normalizeStoreConfig(req.body?.settings || {})
      }

      const { data, error } = await supabase
        .from('stores')
        .upsert([row], { onConflict: 'shop_domain' })
        .select()

      if (error) {
        console.log('STORE UPSERT ERROR:', error)
        return sendSafeServerError(res)
      }

      return res.json({
        success: true,
        data: (data || []).map((row) => ({
          shop_domain: row.shop_domain,
          installed_at: row.installed_at,
          scope: row.scope || null,
          settings: sanitizeStoreConfigForMerchant(row.settings || {})
        }))
      })
    } catch (error) {
      console.log('STORE ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.get('/api/public-storefront-config/:shop_domain', async (req, res) => {
    try {
      const shopDomain = normalizeShop(req.params.shop_domain)
      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const storeRecord = await lookupStoreRecord(supabase, shopDomain)
      const config = getStoreConfigFromRecord(storeRecord)

      return res.json({
        success: true,
        data: {
          shop_domain: shopDomain,
          config: sanitizeStoreConfigForStorefront(config)
        }
      })
    } catch (error) {
      console.log('PUBLIC STOREFRONT CONFIG ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.get('/api/store-config/:shop_domain', requireShopifySessionToken, async (req, res) => {
    try {
      const shopDomain = normalizeShop(req.params.shop_domain)
      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const [storeRecord, overview, sessions, events] = await Promise.all([
        lookupStoreRecord(supabase, shopDomain),
        getAnalyticsOverview({ shopDomain }, analyticsOptions),
        supabase.from('experiment_sessions').select('*').eq('shop_domain', shopDomain),
        supabase.from('events').select('*').eq('shop_domain', shopDomain)
      ])

      const setup = buildSetupStatus({
        shopDomain,
        storeRecord,
        overview,
        sessionCount: sessions.data?.length || 0,
        rawEventCount: events.data?.length || 0
      })

      return res.json({
        success: true,
        data: {
          shop_domain: shopDomain,
          config: sanitizeStoreConfigForMerchant(getStoreConfigFromRecord(storeRecord)),
          setup
        }
      })
    } catch (error) {
      console.log('STORE CONFIG GET ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.put('/api/store-config/:shop_domain', requireShopifySessionToken, async (req, res) => {
    try {
      const shopDomain = normalizeShop(req.params.shop_domain)
      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const existing = await lookupStoreRecord(supabase, shopDomain)
      const mergedConfig = mergeStoreConfig(existing?.settings || {}, req.body?.config || req.body || {})

      const { data, error } = await supabase
        .from('stores')
        .upsert([{
          shop_domain: shopDomain,
          settings: mergedConfig
        }], { onConflict: 'shop_domain' })
        .select()

      if (error) {
        console.log('STORE CONFIG UPSERT ERROR:', error)
        return sendSafeServerError(res)
      }

      return res.json({
        success: true,
        data: {
          shop_domain: shopDomain,
          config: sanitizeStoreConfigForMerchant(getStoreConfigFromRecord(data?.[0]))
        }
      })
    } catch (error) {
      console.log('STORE CONFIG PUT ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.post('/api/assign-variant', requireEventIngestAuth, async (req, res) => {
    try {
      const shop_domain = normalizeShop(req.body?.shop_domain)
      const { session_id } = req.body || {}

      if (!shop_domain || !session_id) {
        return res.status(400).json({
          success: false,
          error: 'missing fields'
        })
      }

      const [existingResult, storeRecord] = await Promise.all([
        supabase
          .from('experiment_sessions')
          .select('*')
          .eq('shop_domain', shop_domain)
          .eq('session_id', session_id),
        lookupStoreRecord(supabase, shop_domain).catch((error) => {
          console.log('ASSIGN STORE LOOKUP ERROR:', error)
          return null
        })
      ])

      const { data: existing, error: existingError } = existingResult

      const resolvedStoreId = normalizeStoreId(storeRecord?.id)

      if (storeRecord && storeRecord.shop_domain && storeRecord.shop_domain !== shop_domain) {
        console.log('ASSIGN STORE LOOKUP MISMATCH:', JSON.stringify({
          requested_shop_domain: shop_domain,
          resolved_shop_domain: storeRecord.shop_domain
        }))
      }

      const assignmentStoreId = resolvedStoreId

      const { data: existingRows, error: existingRowsError } = { data: existing, error: existingError }

      if (existingRowsError) {
        console.log('ASSIGN LOOKUP ERROR:', existingRowsError)
        return sendSafeServerError(res)
      }

      if (existingRows?.[0]) {
        await ingestPhase1Event({
          env,
          analyticsOptions,
          legacyAssignmentMirrorEnabled,
          supabaseRawEventMirrorEnabled,
          authMode: req.ingestAuth?.mode,
          fetchImpl,
          eventRecord: buildAssignmentEvent({
            storeId: assignmentStoreId,
            shopDomain: existingRows[0].shop_domain,
            sessionId: existingRows[0].session_id,
            visitorId: req.body?.visitor_id || `visitor_for_${existingRows[0].session_id}`,
            experimentVariant: existingRows[0].variant,
            pageUrl: getRequestPageUrl(req) || `https://${existingRows[0].shop_domain}/`,
            referrer: req.body?.referrer || null,
            eventId: `assign_${existingRows[0].shop_domain}_${existingRows[0].session_id}`,
            clientTimestamp: existingRows[0].created_at,
            metadata: {
              experiment_name: req.body?.experiment_name || 'agency_revenue_lift_14_day',
              source: 'assign_variant_route'
            }
          })
        })

        return res.json({
          success: true,
          data: {
            ...existingRows[0],
            store_id: assignmentStoreId
          }
        })
      }

      const variant = Math.random() < 0.5 ? 'control' : 'variant'
      const tracked = await trackSessionStarted({
        eventType: 'experiment_assignment',
        sessionId: session_id,
        shopDomain: shop_domain,
        variant,
        occurredAt: new Date().toISOString()
      }, analyticsOptions)

      await ingestPhase1Event({
        env,
        analyticsOptions,
        legacyAssignmentMirrorEnabled,
        supabaseRawEventMirrorEnabled,
        authMode: req.ingestAuth?.mode,
        fetchImpl,
        eventRecord: buildAssignmentEvent({
          storeId: assignmentStoreId,
          shopDomain: shop_domain,
          sessionId: session_id,
          visitorId: req.body?.visitor_id || `visitor_for_${session_id}`,
          experimentVariant: tracked.session.variant,
          pageUrl: getRequestPageUrl(req) || `https://${shop_domain}/`,
          referrer: req.body?.referrer || null,
          eventId: `assign_${shop_domain}_${session_id}`,
          clientTimestamp: tracked.session.started_at,
          metadata: {
            experiment_name: req.body?.experiment_name || 'agency_revenue_lift_14_day',
            source: 'assign_variant_route'
          }
        })
      })

      return res.json({
        success: true,
        data: {
          shop_domain,
          store_id: assignmentStoreId,
          session_id,
          variant: tracked.session.variant,
          created_at: tracked.session.started_at
        }
      })
    } catch (error) {
      console.log('ASSIGN ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.post('/api/events', requireEventIngestAuth, async (req, res) => {
    try {
      const validation = validatePublicEventPayload(req.body)
      if (!validation.value) {
        console.log('EVENT REJECTED:', JSON.stringify({
          reason: validation.body.error,
          shop_domain: req.body?.properties?.shop_domain || null,
          session_id: req.body?.session_id || null
        }))
        return res.status(validation.status).json(validation.body)
      }

      const {
        anonymousId: anonymous_id,
        eventName: event_name,
        shopDomain: shop_domain,
        sessionId: session_id,
        timestamp,
        path,
        properties,
        referrer: validatedReferrer
      } = validation.value
      const event_id = buildBehavioralEventId({
        anonymousId: anonymous_id,
        sessionId: session_id,
        eventName: event_name,
        timestamp,
        properties
      })
      const page_url = buildPageUrlFromProperties({
        shopDomain: shop_domain,
        path
      })
      const client_timestamp = new Date(timestamp * 1000).toISOString()
      const server_timestamp = new Date().toISOString()
      const server_received_timestamp = Math.floor(Date.now() / 1000)

      const rateLimit = eventIngestLimiter.check(buildRateLimitKey([
        'events',
        getClientIp(req),
        shop_domain,
        session_id
      ]))
      if (!rateLimit.ok) {
        console.log('EVENT RATE LIMITED:', JSON.stringify({
          shop_domain,
          session_id,
          ip: getClientIp(req)
        }))
        return rejectRateLimited(res, rateLimit.retryAfterSeconds)
      }

      if (!originMatchesPageUrl(req, page_url)) {
        return res.status(400).json({
          success: false,
          error: 'origin mismatch'
        })
      }

      if (req.ingestAuth?.mode === 'storefront-unsigned' && isBotLikeRequest(req)) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized'
        })
      }

      console.log('EVENT RECEIVED:', JSON.stringify({
        shop_domain,
        session_id,
        event_name,
        event_id,
        auth_mode: req.ingestAuth?.mode
      }))

      const [sessionResult, storeRecord] = await Promise.all([
        supabase
          .from('experiment_sessions')
          .select('*')
          .eq('shop_domain', shop_domain)
          .eq('session_id', session_id),
        lookupStoreRecord(supabase, shop_domain).catch((error) => {
          console.log('EVENT STORE LOOKUP ERROR:', error)
          return null
        })
      ])

      const { data: sessionRows, error: sessionError } = sessionResult

      if (sessionError) {
        console.log('SESSION LOOKUP ERROR:', sessionError)
        return sendSafeServerError(res)
      }

      if (!sessionRows?.[0]) {
        console.log('EVENT REJECTED: session not assigned')
        return res.status(400).json({
          success: false,
          error: 'session not assigned',
          shop_domain,
          session_id
        })
      }

      const resolvedStoreId = normalizeStoreId(storeRecord?.id)

      let eventRecord
      try {
        eventRecord = {
          store_id: resolvedStoreId,
          event_id,
          event_name,
          shop_domain,
          session_id,
          visitor_id: anonymous_id,
          experiment_variant: req.body?.experiment_variant || sessionRows[0].variant,
          page_url,
          referrer: validatedReferrer || req.get('referer') || null,
          client_timestamp,
          server_timestamp,
          server_received_timestamp,
          metadata: {
            ...properties,
            user_agent: req.headers['user-agent'] || null,
            device_type: properties.device_type || getDeviceTypeFromUserAgent(req.headers['user-agent'])
          }
        }
      } catch (validationError) {
        console.log('EVENT REJECTED: malformed payload', validationError.message)
        return res.status(400).json({
          success: false,
          error: 'malformed payload'
        })
      }

      const duplicate = markOrDetectDuplicateEventId(event_id)
      if (duplicate) {
        return res.status(202).json({
          success: true,
          data: {
            shop_domain,
            session_id,
            event_name,
            event_id,
            store_id: resolvedStoreId,
            duplicate: true,
            server_timestamp,
            tinybird_forwarded: false
          }
        })
      }

      const tinybird = await forwardEventToTinybird({
        eventRecord,
        env,
        fetchImpl
      })

      supabase
        .from('stores')
        .upsert([{
          shop_domain,
          last_event_at: server_timestamp
        }], { onConflict: 'shop_domain' })
        .select()
        .catch((error) => {
          console.log('STORE LAST EVENT UPDATE ERROR:', error)
          return null
        })

      return res.status(202).json({
        success: true,
        data: {
          shop_domain,
          session_id,
          event_name,
          event_id,
          store_id: resolvedStoreId,
          duplicate: false,
          server_timestamp,
          tinybird_forwarded: Boolean(tinybird?.ok)
        }
      })
    } catch (error) {
      console.log('EVENT ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.get('/api/admin/session-features-health', requireOwnerAccess, async (_req, res) => {
    try {
      const data = await buildSessionFeaturesHealthReport({
        env,
        fetchImpl
      })

      return res.json(data)
    } catch (error) {
      console.log('SESSION FEATURES HEALTH ROUTE ERROR:', error)
      return res.status(500).json({
        ok: false,
        error: 'Internal server error'
      })
    }
  })

  async function handleInterventionDecision(req, res, input) {
    const validation = validateInterventionDecisionQuery(input || {})
    if (!validation.value) {
      return res.status(validation.status).json({
        decision: false,
        strategy: 'invalid_request',
        intervention_type: 'none',
        message_id: getInterventionMessageId('none'),
        shadow_mode: false
      })
    }

    const { shopDomain, sessionId, storeId: requestedStoreId } = validation.value
    const rateLimit = interventionDecisionLimiter.check(buildRateLimitKey([
      'intervention-decision',
      getClientIp(req),
      shopDomain,
      sessionId
    ]))

    if (!rateLimit.ok) {
      return res
        .status(429)
        .set('Retry-After', String(rateLimit.retryAfterSeconds))
        .json({
          decision: false,
          strategy: 'rate_limited',
          intervention_type: 'none',
          message_id: getInterventionMessageId('none'),
          shadow_mode: false
        })
    }

    if (isBotLikeRequest(req) && !req.get('origin') && !req.get('referer')) {
      return res.status(401).json({
        decision: false,
        strategy: 'unauthorized',
        intervention_type: 'none',
        message_id: getInterventionMessageId('none'),
        shadow_mode: false
      })
    }

    try {
      const storeRecord = await lookupStoreRecord(supabase, shopDomain).catch((error) => {
        console.log('INTERVENTION STORE LOOKUP ERROR:', error)
        return null
      })

      const {
        session,
        result,
        resolvedStoreId
      } = await getInterventionDecision({
        shopDomain,
        sessionId,
        requestedStoreId: requestedStoreId || '',
        storeRecord,
        env,
        fetchImpl
      })

      await logShadowInterventionDecision({
        shopDomain,
        sessionId,
        session,
        result
        ,
        env,
        fetchImpl
      }).catch((error) => {
        console.log('SHADOW DECISION LOG ERROR:', error)
        return null
      })

      console.log('INTERVENTION DECISION SUCCESS:', JSON.stringify({
        shop_domain: shopDomain,
        session_id: sessionId,
        store_id: resolvedStoreId,
        strategy: result.strategy,
        decision: result.decision,
        intervention_type: result.intervention_type
      }))

      supabase
        .from('stores')
        .upsert([{
          shop_domain: shopDomain,
          last_decision_at: new Date().toISOString()
        }], { onConflict: 'shop_domain' })
        .select()
        .catch((error) => {
          console.log('STORE LAST DECISION UPDATE ERROR:', error)
          return null
        })

      return res
        .set('Cache-Control', 'no-store')
        .json(result)
    } catch (error) {
      console.log('INTERVENTION DECISION ROUTE ERROR:', error)
      await logShadowInterventionDecision({
        shopDomain,
        sessionId,
        session: null,
        result: {
          decision: false,
          strategy: 'error_fail_closed',
          intervention_type: 'none',
          message_id: getInterventionMessageId('none'),
          shadow_mode: false,
          calculated_threshold: 1,
          session_score: 0,
          reason: 'error_fail_closed'
        },
        env,
        fetchImpl
      }).catch((shadowError) => {
        console.log('SHADOW DECISION LOG ERROR:', shadowError)
        return null
      })

      return res
        .set('Cache-Control', 'no-store')
        .json({
          decision: false,
          strategy: 'error_fail_closed',
          intervention_type: 'none',
          message_id: getInterventionMessageId('none'),
          shadow_mode: false
        })
    }
  }

  app.get('/api/intervention-decision', async (req, res) => {
    return handleInterventionDecision(req, res, req.query || {})
  })

  app.post('/api/intervention-decision', async (req, res) => {
    return handleInterventionDecision(req, res, req.body || {})
  })

  app.get('/api/embedded-check', requireShopifySessionToken, async (req, res) => {
    return res.json({
      success: true,
      data: {
        ok: true,
        shop: req.shopifySession.shop,
        user: req.shopifySession.payload.sub || null
      }
    })
  })

  app.get('/api/analytics/conversion-rates/:shop_domain', requireShopifySessionToken, async (req, res) => {
    try {
      const shopDomain = normalizeShop(req.params.shop_domain)

      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const filters = { shopDomain }
      if (req.query.since) filters.since = req.query.since
      if (req.query.until) filters.until = req.query.until

      const conversionRates = await getTriggerConversionRates(filters, analyticsOptions)

      return res.json({
        success: true,
        data: {
          shop_domain: shopDomain,
          conversion_rates: conversionRates
        }
      })
    } catch (error) {
      console.log('ANALYTICS CONVERSION ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.get('/api/analytics/abandonment-by-variant', requireShopifySessionToken, async (req, res) => {
    try {
      const shopDomain = req.shopifySession.shop
      const result = await queryTinybirdSql({
        env,
        fetchImpl,
        logLabel: 'ABANDONMENT BY VARIANT',
        sql: `
          ${buildSessionFeaturesBaseCte()}
          SELECT
            experiment_variant AS variant,
            count() AS sessions,
            sum(
              toUInt64(provisional_abandoned_cart)
              + toUInt64(provisional_abandoned_checkout) > 0
            ) AS abandoned_sessions,
            round(
              if(count() = 0, 0, abandoned_sessions / count() * 100),
              2
            ) AS abandonment_rate_percent
          FROM session_features
          WHERE shop_domain = ${toTinybirdSqlString(shopDomain)}
          GROUP BY experiment_variant
          ORDER BY experiment_variant ASC
        `
      })

      return res.json({
        success: true,
        data: result.data || []
      })
    } catch (error) {
      console.error('TINYBIRD ABANDONMENT ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.get('/api/metrics/:shop_domain', requireShopifySessionToken, async (req, res) => {
    try {
      const shopDomain = normalizeShop(req.params.shop_domain)
      const overview = await getAnalyticsOverview({ shopDomain }, analyticsOptions)

      return res.json({
        success: true,
        data: buildMetricsPayload(shopDomain, overview)
      })
    } catch (error) {
      console.log('METRICS ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.get('/api/debug/:shop_domain', requireShopifySessionToken, async (req, res) => {
    try {
      const shopDomain = normalizeShop(req.params.shop_domain)
      const [sessions, events, overview] = await Promise.all([
        supabase.from('experiment_sessions').select('*').eq('shop_domain', shopDomain),
        supabase.from('events').select('*').eq('shop_domain', shopDomain),
        getAnalyticsOverview({ shopDomain }, analyticsOptions)
      ])

      return res.json({
        success: true,
        sessionCount: sessions.data?.length || 0,
        eventCount: events.data?.length || 0,
        sessions: sessions.data || [],
        events: events.data || [],
        derived: overview
      })
    } catch (error) {
      console.log('DEBUG ROUTE ERROR:', error)
      return sendSafeServerError(res)
    }
  })

  app.get('/dashboard', (req, res) => {
    const shopDomain = normalizeShop(req.query.shop) || 'behavior-test-store.myshopify.com'
    res.send(buildDashboardPage({
      shopDomain,
      apiKey: env.SHOPIFY_API_KEY
    }))
  })

  app.get('/app', (req, res) => {
    const shop = normalizeShop(req.query.shop)
    const host = typeof req.query.host === 'string' ? req.query.host : ''

    if (!shop) {
      return res.send('Missing shop parameter')
    }

    const qs = new URLSearchParams()
    qs.set('shop', shop)
    if (host) qs.set('host', host)

    return res.redirect(`/dashboard?${qs.toString()}`)
  })

  app.get('/', (req, res) => {
    const shop = normalizeShop(req.query.shop)
    const host = typeof req.query.host === 'string' ? req.query.host : ''

    if (!shop) {
      return res.send('BehavioralPro backend is running.')
    }

    const qs = new URLSearchParams()
    qs.set('shop', shop)
    if (host) qs.set('host', host)

    return res.redirect(`/dashboard?${qs.toString()}`)
  })

  app.get('/api/shopify/callback', (req, res) => {
    const shop = normalizeShop(req.query.shop)

    if (!shop) {
      return res.status(400).send('Missing shop parameter')
    }

    const qs = new URLSearchParams()
    qs.set('shop', shop)
    if (typeof req.query.host === 'string' && req.query.host) {
      qs.set('host', req.query.host)
    }

    return res.redirect(`/dashboard?${qs.toString()}`)
  })

  app.post('/webhooks/customers-data-request', (req, res) => {
    if (!verifyWebhookRequest(req)) {
      return res.status(401).send('Invalid webhook signature')
    }

    console.log('WEBHOOK customers/data_request:', JSON.stringify(req.body || {}))
    return res.status(200).send('ok')
  })

  app.post('/webhooks/customers-redact', (req, res) => {
    if (!verifyWebhookRequest(req)) {
      return res.status(401).send('Invalid webhook signature')
    }

    console.log('WEBHOOK customers/redact:', JSON.stringify(req.body || {}))
    return res.status(200).send('ok')
  })

  app.post('/webhooks/shop-redact', (req, res) => {
    if (!verifyWebhookRequest(req)) {
      return res.status(401).send('Invalid webhook signature')
    }

    console.log('WEBHOOK shop/redact:', JSON.stringify(req.body || {}))
    return res.status(200).send('ok')
  })

  app.use((error, _req, res, next) => {
    if (!error) {
      return next()
    }

    console.log('UNHANDLED ROUTE ERROR:', error)

    if (error.type === 'entity.too.large') {
      return res.status(413).json({
        success: false,
        error: 'payload too large'
      })
    }

    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({
        success: false,
        error: 'invalid JSON body'
      })
    }

    return sendSafeServerError(res)
  })

  return app
}

export function startServer({ env = process.env, supabase } = {}) {
  const app = createApp({ env, supabase })
  const port = Number(env.PORT || DEFAULT_PORT)
  return app.listen(port, () => {
    console.log(`Server running on port ${port}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
}
