import crypto from 'crypto'

export const PHASE1_EVENT_NAMES = [
  'experiment_assignment',
  'page_view',
  'product_view',
  'add_to_cart',
  'cart_open',
  'cart_close',
  'begin_checkout',
  'checkout_back',
  'purchase',
  'coupon_field_focus',
  'discount_code_applied',
  'quantity_change',
  'variant_change',
  'policy_page_view',
  'scroll_depth_reached',
  'product_dwell_12s',
  'review_section_dwell_10s',
  'cta_idle_15s',
  'rage_click',
  'intervention_triggered',
  'intervention_type'
]

export const PHASE1_EVENT_NAME_SET = new Set(PHASE1_EVENT_NAMES)

const LEGACY_EVENT_NAME_MAP = {
  experiment_assignment: { kind: 'assignment' },
  page_view: { eventType: 'page_view' },
  product_view: {
    eventType: 'product_page_view',
    triggerType: 'product_page_view'
  },
  add_to_cart: { eventType: 'add_to_cart_click' },
  begin_checkout: { eventType: 'begin_checkout_click' },
  purchase: { eventType: 'purchase' },
  intervention_triggered: {
    eventType: 'message_shown',
    messageNameField: 'intervention_type'
  },
  intervention_type: {
    eventType: 'message_shown',
    messageNameField: 'intervention_type'
  }
}

function normalizeOptionalString(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function normalizeRequiredString(value, fieldName) {
  const normalized = normalizeOptionalString(value)
  if (!normalized) {
    throw new Error(`${fieldName} is required`)
  }
  return normalized
}

function normalizeTimestamp(value, fieldName) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid timestamp`)
  }
  return date.toISOString()
}

function normalizeMetadata(value) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata must be an object')
  }
  return value
}

export function createPhase1EventId(prefix = 'evt') {
  try {
    return `${prefix}_${crypto.randomUUID()}`
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }
}

export function normalizePhase1EventPayload(input = {}) {
  const metadata = normalizeMetadata(input.metadata ?? input.extra)
  const eventName = normalizeRequiredString(
    input.event_name ?? input.eventType ?? input.event_type,
    'event_name'
  )

  if (!PHASE1_EVENT_NAME_SET.has(eventName)) {
    throw new Error(`event_name must be one of: ${PHASE1_EVENT_NAMES.join(', ')}`)
  }

  return {
    event_name: eventName,
    shop_domain: normalizeRequiredString(input.shop_domain, 'shop_domain'),
    session_id: normalizeRequiredString(input.session_id, 'session_id'),
    visitor_id: normalizeRequiredString(input.visitor_id, 'visitor_id'),
    experiment_variant: normalizeRequiredString(
      input.experiment_variant ?? input.variant,
      'experiment_variant'
    ),
    page_url: normalizeRequiredString(
      input.page_url ?? input.page_location,
      'page_url'
    ),
    referrer: normalizeOptionalString(input.referrer),
    client_timestamp: normalizeTimestamp(
      input.client_timestamp ?? input.occurred_at ?? input.timestamp,
      'client_timestamp'
    ),
    event_id: normalizeRequiredString(input.event_id, 'event_id'),
    metadata
  }
}

export function buildPhase1EventRecord(input = {}, options = {}) {
  const payload = normalizePhase1EventPayload(input)
  return {
    ...payload,
    server_timestamp: normalizeTimestamp(
      options.server_timestamp || new Date().toISOString(),
      'server_timestamp'
    )
  }
}

export function buildAssignmentEvent({
  shopDomain,
  sessionId,
  visitorId,
  experimentVariant,
  pageUrl,
  referrer = null,
  eventId = null,
  clientTimestamp = null,
  metadata = {}
}) {
  return buildPhase1EventRecord({
    event_name: 'experiment_assignment',
    shop_domain: shopDomain,
    session_id: sessionId,
    visitor_id: visitorId,
    experiment_variant: experimentVariant,
    page_url: pageUrl,
    referrer,
    client_timestamp: clientTimestamp || new Date().toISOString(),
    event_id: eventId || createPhase1EventId('assign'),
    metadata
  })
}

export function getLegacyEventMirror(eventRecord) {
  const config = LEGACY_EVENT_NAME_MAP[eventRecord?.event_name]

  if (!config) {
    return null
  }

  const metadata = eventRecord.metadata || {}

  if (config.kind === 'assignment') {
    return {
      kind: 'assignment',
      eventType: 'experiment_assignment'
    }
  }

  return {
    kind: 'event',
    eventType: config.eventType,
    triggerType: config.triggerType || metadata.trigger_type || null,
    messageName: config.messageNameField
      ? metadata[config.messageNameField] || metadata.message_name || eventRecord.event_name
      : metadata.message_name || null
  }
}
