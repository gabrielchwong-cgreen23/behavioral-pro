import { z } from 'zod'
import { sanitizeSessionFrameMetadata } from './session-frame.js'

const DEFAULT_WINDOW_MS = 60 * 1000
const DEFAULT_MAX_REQUESTS = 60
const DEFAULT_EVENT_BODY_LIMIT_BYTES = 16 * 1024
const DEFAULT_PROPERTIES_LIMIT_BYTES = 4 * 1024
const MAX_PAST_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{5,127}$/
const SAFE_ANONYMOUS_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const SAFE_EVENT_NAME_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const SAFE_SHOP_DOMAIN_PATTERN = /^(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/i

const behavioralEventSchema = z.object({
  anonymous_id: z.string().min(8).max(128).regex(SAFE_ANONYMOUS_ID_PATTERN),
  session_id: z.string().min(8).max(128).regex(SAFE_SESSION_ID_PATTERN),
  event_name: z.string().min(1).max(128).regex(SAFE_EVENT_NAME_PATTERN),
  timestamp: z.number().int().positive(),
  properties: z.record(z.unknown())
}).strict()

function normalizeOptionalString(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function safeJsonSizeBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toIsoOrNull(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function isSafeUrl(urlValue) {
  try {
    const parsed = new URL(urlValue)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

export function safeErrorPayload(message, status = 400) {
  return {
    status,
    body: {
      success: false,
      error: message
    }
  }
}

export function getClientIp(req) {
  const forwarded = req.get?.('x-forwarded-for') || req.headers?.['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }

  return req.ip || req.socket?.remoteAddress || 'unknown'
}

export function createInMemoryRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  maxRequests = DEFAULT_MAX_REQUESTS
} = {}) {
  const buckets = new Map()

  return {
    check(key) {
      const now = Date.now()
      const bucket = buckets.get(key)

      if (!bucket || bucket.resetAt <= now) {
        const next = {
          count: 1,
          resetAt: now + windowMs
        }
        buckets.set(key, next)
        return {
          ok: true,
          remaining: maxRequests - 1,
          retryAfterSeconds: Math.ceil(windowMs / 1000)
        }
      }

      if (bucket.count >= maxRequests) {
        return {
          ok: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
        }
      }

      bucket.count += 1
      return {
        ok: true,
        remaining: Math.max(0, maxRequests - bucket.count),
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      }
    }
  }
}

export function buildRateLimitKey(parts = []) {
  return parts.map((part) => normalizeOptionalString(part) || 'unknown').join(':')
}

export function validateRequestedShopAgainstVerifiedShop(requestedShop, verifiedShop) {
  const normalizedRequested = normalizeOptionalString(requestedShop)
  const normalizedVerified = normalizeOptionalString(verifiedShop)

  if (!normalizedRequested || !normalizedVerified) {
    return false
  }

  return normalizedRequested === normalizedVerified
}

export function validateShopDomain(value) {
  const normalized = normalizeOptionalString(value)
  if (!normalized || !SAFE_SHOP_DOMAIN_PATTERN.test(normalized)) {
    return null
  }
  return normalized
}

export function validatePublicEventPayload(body, {
  bodyLimitBytes = DEFAULT_EVENT_BODY_LIMIT_BYTES,
  metadataLimitBytes = DEFAULT_PROPERTIES_LIMIT_BYTES
} = {}) {
  const bodySizeBytes = safeJsonSizeBytes(body)
  if (bodySizeBytes > bodyLimitBytes) {
    return safeErrorPayload('payload too large', 413)
  }

  const parsed = behavioralEventSchema.safeParse(body)
  if (!parsed.success) {
    return safeErrorPayload('Invalid event payload', 400)
  }

  let properties = parsed.data.properties
  if (!isPlainObject(properties)) {
    return safeErrorPayload('Invalid event payload', 400)
  }

  const propertiesSizeBytes = safeJsonSizeBytes(properties)
  if (propertiesSizeBytes > metadataLimitBytes) {
    return safeErrorPayload('properties too large', 413)
  }

  const shopDomain = validateShopDomain(properties.shop_domain)
  if (!shopDomain) {
    return safeErrorPayload('properties.shop_domain is required', 400)
  }

  const path = normalizeOptionalString(properties.path)
  if (path && !(path.startsWith('/') || isSafeUrl(path))) {
    return safeErrorPayload('invalid properties.path', 400)
  }

  const referrer = normalizeOptionalString(properties.referrer)
  if (referrer && !isSafeUrl(referrer)) {
    return safeErrorPayload('invalid properties.referrer', 400)
  }

  const timestampMs = parsed.data.timestamp * 1000
  const now = Date.now()
  if ((now - timestampMs) > MAX_PAST_EVENT_AGE_MS || (timestampMs - now) > MAX_FUTURE_SKEW_MS) {
    return safeErrorPayload('timestamp outside allowed range', 400)
  }

  if (parsed.data.event_name === 'session_frame') {
    try {
      properties = sanitizeSessionFrameMetadata(properties)
    } catch (error) {
      return safeErrorPayload(error.message || 'invalid session_frame payload', 400)
    }
  }

  return {
    status: 200,
    body: {
      success: true
    },
    value: {
      anonymousId: parsed.data.anonymous_id,
      eventName: parsed.data.event_name,
      shopDomain,
      sessionId: parsed.data.session_id,
      timestamp: parsed.data.timestamp,
      path,
      properties,
      referrer
    }
  }
}

export function validateInterventionDecisionQuery(query = {}) {
  const shopDomain = validateShopDomain(query.shop_domain)
  if (!shopDomain) {
    return safeErrorPayload('invalid shop_domain', 400)
  }

  const sessionId = normalizeOptionalString(query.session_id)
  if (!sessionId || !SAFE_SESSION_ID_PATTERN.test(sessionId)) {
    return safeErrorPayload('invalid session_id', 400)
  }

  const storeId = normalizeOptionalString(query.store_id)
  const normalizedStoreId = storeId && SAFE_SESSION_ID_PATTERN.test(storeId) ? storeId : null

  return {
    status: 200,
    body: {
      success: true
    },
    value: {
      storeId: normalizedStoreId,
      shopDomain,
      sessionId
    }
  }
}

export function isBotLikeRequest(req) {
  const userAgent = String(req.get?.('user-agent') || req.headers?.['user-agent'] || '').toLowerCase()
  if (!userAgent) return true

  return (
    userAgent.includes('bot') ||
    userAgent.includes('spider') ||
    userAgent.includes('crawler') ||
    userAgent.includes('python-requests') ||
    userAgent.includes('curl/')
  )
}

export function originMatchesPageUrl(req, pageUrl) {
  const origin = normalizeOptionalString(req.get?.('origin') || req.headers?.origin)
  if (!origin) return true

  try {
    const originUrl = new URL(origin)
    const page = new URL(pageUrl)
    return originUrl.origin === page.origin
  } catch {
    return false
  }
}
