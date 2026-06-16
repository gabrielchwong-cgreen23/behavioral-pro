const SESSION_FRAME_STRING_FIELDS = {
  page_url: { required: false },
  page_type: { required: true, fallback: 'unknown' },
  journey_stage: { required: true, fallback: 'unknown' },
  active_zone: { required: true, fallback: 'unknown_zone' }
}

const SESSION_FRAME_NUMBER_FIELDS = {
  t_seconds: { min: 0, max: 86400, precision: 0 },
  mouse_velocity_avg: { min: 0, max: 1000, precision: 4 },
  mouse_velocity_max: { min: 0, max: 1000, precision: 4 },
  mouse_acceleration_avg: { min: -1000, max: 1000, precision: 4 },
  mouse_distance: { min: 0, max: 100000, precision: 2 },
  scroll_depth: { min: 0, max: 1, precision: 4 },
  scroll_velocity: { min: -1000, max: 1000, precision: 4 },
  cursor_idle_seconds: { min: 0, max: 30, precision: 3 },
  hover_cta_seconds: { min: 0, max: 10, precision: 3 },
  hover_price_seconds: { min: 0, max: 10, precision: 3 },
  hover_policy_seconds: { min: 0, max: 10, precision: 3 },
  hover_reviews_seconds: { min: 0, max: 10, precision: 3 },
  cta_distance: { min: 0, max: 100000, precision: 2 },
  click_count: { min: 0, max: 100, precision: 0 },
  rage_click_count: { min: 0, max: 100, precision: 0 },
  dead_click_count: { min: 0, max: 100, precision: 0 },
  intent_score: { min: 0, max: 1, precision: 4 },
  friction_score: { min: 0, max: 1, precision: 4 },
  hesitation_score: { min: 0, max: 1, precision: 4 },
  policy_anxiety_score: { min: 0, max: 1, precision: 4 },
  cart_commitment_score: { min: 0, max: 1, precision: 4 },
  abandonment_risk_score: { min: 0, max: 1, precision: 4 }
}

const FORBIDDEN_SESSION_FRAME_KEYS = new Set([
  'input_value',
  'field_value',
  'typed_value',
  'typed_text',
  'form_value',
  'name',
  'first_name',
  'last_name',
  'full_name',
  'email',
  'address',
  'address1',
  'address2',
  'city',
  'state',
  'zip',
  'postal_code',
  'phone',
  'card_number',
  'credit_card',
  'payment_info',
  'payment_method',
  'discount_code',
  'coupon_code'
])

const SAFE_CONTEXT_FIELDS = new Set([
  'shop_domain',
  'path',
  'referrer',
  'experiment_variant',
  'device_type',
  'template_name',
  'currency',
  'product_id',
  'product_handle',
  'cart_value',
  'client_event_id',
  'source',
  'page_url'
])

function normalizeOptionalString(value, fallback = null) {
  if (value == null) return fallback
  const normalized = String(value).trim()
  return normalized || fallback
}

function clampNumber(value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, precision = 4 } = {}) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throw new Error('session_frame contains a non-numeric field')
  }

  const bounded = Math.min(max, Math.max(min, numeric))
  if (!Number.isFinite(precision) || precision < 0) {
    return bounded
  }

  return Number(bounded.toFixed(precision))
}

function validateNoSensitiveKeys(input = {}) {
  for (const key of Object.keys(input || {})) {
    if (FORBIDDEN_SESSION_FRAME_KEYS.has(String(key).trim().toLowerCase())) {
      throw new Error(`session_frame field is not allowed: ${key}`)
    }
  }
}

export function sanitizeSessionFrameMetadata(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session_frame metadata must be an object')
  }

  validateNoSensitiveKeys(input)

  const next = {}

  for (const key of SAFE_CONTEXT_FIELDS) {
    const value = input[key]
    if (value == null) continue
    next[key] = typeof value === 'string' ? normalizeOptionalString(value) : value
  }

  for (const [field, config] of Object.entries(SESSION_FRAME_STRING_FIELDS)) {
    const fallback = config.fallback || null
    const normalized = normalizeOptionalString(input[field], fallback)
    if (config.required && !normalized) {
      throw new Error(`session_frame.${field} is required`)
    }
    next[field] = normalized
  }

  for (const [field, config] of Object.entries(SESSION_FRAME_NUMBER_FIELDS)) {
    if (field === 't_seconds') {
      if (input[field] == null) {
        throw new Error('session_frame.t_seconds is required')
      }
      next[field] = clampNumber(input[field], config)
      continue
    }

    if (input[field] == null) {
      next[field] = 0
      continue
    }

    next[field] = clampNumber(input[field], config)
  }

  return next
}

export function buildSessionFrameSignalUpdates(metadata = {}) {
  const frame = sanitizeSessionFrameMetadata(metadata)
  const nearCta = frame.cta_distance <= 220
  const hoverPolicyRecent = frame.hover_policy_seconds
  const hoverCtaRecent = frame.hover_cta_seconds
  const mouseVelocityDropNearCta = nearCta && frame.mouse_velocity_avg <= 0.05 ? 1 : 0
  const idleNearCta = nearCta && frame.cursor_idle_seconds >= 1.5 ? 1 : 0

  return {
    current_intent_score: frame.intent_score,
    current_friction_score: frame.friction_score,
    current_hesitation_score: frame.hesitation_score,
    current_policy_anxiety_score: frame.policy_anxiety_score,
    current_cart_commitment_score: frame.cart_commitment_score,
    current_abandonment_risk_score: frame.abandonment_risk_score,
    hover_cta_seconds_recent: hoverCtaRecent,
    hover_policy_seconds_recent: hoverPolicyRecent,
    cursor_idle_seconds_recent: frame.cursor_idle_seconds,
    frame_rage_click_count_recent: Math.round(frame.rage_click_count),
    frame_dead_click_count_recent: Math.round(frame.dead_click_count),
    near_cta: nearCta ? 1 : 0,
    mouse_velocity_drop_near_cta: mouseVelocityDropNearCta,
    rage_click_recent: frame.rage_click_count > 0 ? 1 : 0,
    dead_click_recent: frame.dead_click_count > 0 ? 1 : 0,
    idle_near_cta: idleNearCta,
    page_type: frame.page_type,
    active_zone: frame.active_zone,
    journey_stage: frame.journey_stage,
    latest_t_seconds: frame.t_seconds
  }
}

export function buildSessionFrameCounterDeltas(metadata = {}) {
  const frame = sanitizeSessionFrameMetadata(metadata)
  return {
    session_frame_count: 1,
    frame_rage_click_count: Math.round(frame.rage_click_count),
    frame_dead_click_count: Math.round(frame.dead_click_count)
  }
}
