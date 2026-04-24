import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = path.dirname(fileURLToPath(import.meta.url))
const defaultDataDirectory = path.resolve(packageDirectory, '../data')
const dataOperationQueues = new Map()

const SESSION_CRO_FILE = 'session-cro.json'
const RAW_EVENTS_FILE = 'raw-events.json'

function getDataDirectory(options = {}) {
  return options.dataDirectory || process.env.ANALYTICS_DATA_DIRECTORY || defaultDataDirectory
}

function getFilePath(filename, options = {}) {
  return path.join(getDataDirectory(options), filename)
}

async function withDataLock(options = {}, operation) {
  const queueKey = getDataDirectory(options)
  const previous = dataOperationQueues.get(queueKey) || Promise.resolve()
  let result

  const current = previous
    .catch(() => {})
    .then(async () => {
      result = await operation()
    })

  dataOperationQueues.set(queueKey, current)
  await current

  if (dataOperationQueues.get(queueKey) === current) {
    dataOperationQueues.delete(queueKey)
  }

  return result
}

async function ensureJsonFile(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true })

  try {
    await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }

    await writeFile(filePath, '[]\n', 'utf8')
  }
}

async function readRecords(filename, options = {}) {
  const filePath = getFilePath(filename, options)
  await ensureJsonFile(filePath)

  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw || '[]')

  if (!Array.isArray(parsed)) {
    throw new Error(`${filename} must contain a JSON array`)
  }

  return parsed
}

async function writeRecords(filename, records, options = {}) {
  const filePath = getFilePath(filename, options)
  await ensureJsonFile(filePath)
  await writeFile(filePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
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

function normalizeTimestamp(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback

  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid timestamp')
  }

  return date.toISOString()
}

function normalizeVariant(value) {
  if (value == null) return 'control'
  const normalized = String(value).trim().toLowerCase()

  if (normalized !== 'control' && normalized !== 'variant') {
    throw new Error('variant must be either "control" or "variant"')
  }

  return normalized
}

function normalizeRevenue(value) {
  if (value == null) return 0
  const normalized = Number(value)

  if (Number.isNaN(normalized)) {
    throw new Error('revenue must be a number')
  }

  return normalized
}

function normalizeNumber(value, fieldName) {
  if (value == null) return null
  const normalized = Number(value)

  if (Number.isNaN(normalized)) {
    throw new Error(`${fieldName} must be a number`)
  }

  return normalized
}

function normalizeBoolean(value) {
  return Boolean(value)
}

function normalizeStringArray(value, fieldName) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`)
  }

  return value
    .map(item => normalizeOptionalString(item))
    .filter(Boolean)
}

function normalizeObject(value, fieldName) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`)
  }

  return value
}

function getSessionId(input) {
  return normalizeRequiredString(input.sessionId || input.session_id, 'sessionId')
}

function getShopDomain(input) {
  return normalizeRequiredString(input.shopDomain || input.shop_domain, 'shopDomain')
}

function getTriggerType(input) {
  return normalizeRequiredString(
    input?.triggerType || input?.trigger_type || input?.eventType || input?.event_type,
    'triggerType'
  )
}

function getMessageName(input) {
  return normalizeRequiredString(
    input?.messageName || input?.message_name || input?.triggerType || input?.trigger_type,
    'messageName'
  )
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function matchesWindow(timestamp, since, until) {
  const date = new Date(timestamp)
  if (since && date < since) return false
  if (until && date > until) return false
  return true
}

function createEmptySessionRecord(input = {}) {
  return {
    session_id: getSessionId(input),
    shop_domain: getShopDomain(input),
    variant: normalizeVariant(input.variant),
    triggers_fired: normalizeStringArray(input.triggers_fired, 'triggers_fired'),
    messages_shown: normalizeStringArray(input.messages_shown, 'messages_shown'),
    converted: normalizeBoolean(input.converted),
    revenue: normalizeRevenue(input.revenue),
    started_at: normalizeTimestamp(input.startedAt || input.started_at),
    ended_at: input.endedAt || input.ended_at
      ? normalizeTimestamp(input.endedAt || input.ended_at)
      : null
  }
}

function normalizeSessionRecord(record) {
  return {
    session_id: normalizeRequiredString(record.session_id, 'session_id'),
    shop_domain: normalizeRequiredString(record.shop_domain, 'shop_domain'),
    variant: normalizeVariant(record.variant),
    triggers_fired: normalizeStringArray(record.triggers_fired, 'triggers_fired'),
    messages_shown: normalizeStringArray(record.messages_shown, 'messages_shown'),
    converted: normalizeBoolean(record.converted),
    revenue: normalizeRevenue(record.revenue),
    started_at: normalizeTimestamp(record.started_at),
    ended_at: record.ended_at ? normalizeTimestamp(record.ended_at) : null
  }
}

function normalizeRawEventRecord(record) {
  return {
    event_id: normalizeRequiredString(record.event_id, 'event_id'),
    session_id: normalizeRequiredString(record.session_id, 'session_id'),
    shop_domain: normalizeRequiredString(record.shop_domain, 'shop_domain'),
    variant: normalizeVariant(record.variant),
    event_type: normalizeRequiredString(record.event_type, 'event_type'),
    occurred_at: normalizeTimestamp(record.occurred_at),
    visitor_id: normalizeOptionalString(record.visitor_id),
    dedupe_key: normalizeOptionalString(record.dedupe_key),
    value: normalizeRevenue(record.value),
    page_type: normalizeOptionalString(record.page_type),
    page_url: normalizeOptionalString(record.page_url),
    page_path: normalizeOptionalString(record.page_path),
    referrer: normalizeOptionalString(record.referrer),
    traffic_source: normalizeOptionalString(record.traffic_source),
    device_type: normalizeOptionalString(record.device_type),
    product_id: normalizeOptionalString(record.product_id),
    product_handle: normalizeOptionalString(record.product_handle),
    cart_value: normalizeNumber(record.cart_value, 'cart_value'),
    reason: normalizeOptionalString(record.reason),
    metadata: normalizeObject(record.metadata, 'metadata')
  }
}

function buildRawEventRecord(input = {}) {
  return normalizeRawEventRecord({
    event_id: input.eventId || input.event_id || createId('evt'),
    session_id: getSessionId(input),
    shop_domain: getShopDomain(input),
    variant: input.variant,
    event_type: normalizeRequiredString(input.eventType || input.event_type, 'eventType'),
    occurred_at: input.occurredAt || input.occurred_at || new Date().toISOString(),
    visitor_id: input.visitorId || input.visitor_id,
    dedupe_key: input.dedupeKey || input.dedupe_key,
    value: input.value,
    page_type: input.pageType || input.page_type,
    page_url: input.pageUrl || input.page_url,
    page_path: input.pagePath || input.page_path,
    referrer: input.referrer,
    traffic_source: input.trafficSource || input.traffic_source,
    device_type: input.deviceType || input.device_type,
    product_id: input.productId || input.product_id,
    product_handle: input.productHandle || input.product_handle,
    cart_value: input.cartValue || input.cart_value,
    reason: input.reason,
    metadata: input.metadata || input.extra
  })
}

async function readSessionTable(options = {}) {
  const records = await readRecords(SESSION_CRO_FILE, options)
  return records.map(normalizeSessionRecord)
}

async function writeSessionTable(records, options = {}) {
  await writeRecords(SESSION_CRO_FILE, records.map(normalizeSessionRecord), options)
}

async function readRawEventLog(options = {}) {
  const records = await readRecords(RAW_EVENTS_FILE, options)
  return records.map(normalizeRawEventRecord)
}

async function writeRawEventLog(records, options = {}) {
  await writeRecords(RAW_EVENTS_FILE, records.map(normalizeRawEventRecord), options)
}

async function upsertSessionRecord(input, options = {}, updateRecord) {
  const sessionId = getSessionId(input)
  const shopDomain = getShopDomain(input)
  const records = await readSessionTable(options)

  const existingIndex = records.findIndex(record =>
    record.session_id === sessionId && record.shop_domain === shopDomain
  )

  const existingRecord = existingIndex >= 0
    ? records[existingIndex]
    : createEmptySessionRecord(input)

  const nextRecord = normalizeSessionRecord(updateRecord(existingRecord))

  if (existingIndex >= 0) {
    records[existingIndex] = nextRecord
  } else {
    records.push(nextRecord)
  }

  await writeSessionTable(records, options)
  return nextRecord
}

async function recordRawEventUnlocked(input, options = {}) {
  const rawEvents = await readRawEventLog(options)
  const event = buildRawEventRecord(input)

  const duplicate = rawEvents.find(record => {
    if (record.event_id === event.event_id) return true

    return Boolean(
      record.dedupe_key &&
      event.dedupe_key &&
      record.shop_domain === event.shop_domain &&
      record.session_id === event.session_id &&
      record.event_type === event.event_type &&
      record.dedupe_key === event.dedupe_key
    )
  })

  if (duplicate) {
    return {
      event: duplicate,
      duplicate: true
    }
  }

  rawEvents.push(event)
  await writeRawEventLog(rawEvents, options)

  return {
    event,
    duplicate: false
  }
}

export async function recordRawEvent(input, options = {}) {
  return withDataLock(options, async () => recordRawEventUnlocked(input, options))
}

export async function trackSessionStarted(input, options = {}) {
  return withDataLock(options, async () => {
    const { event, duplicate } = await recordRawEventUnlocked({
      ...input,
      eventType: input.eventType || input.event_type || 'session_started'
    }, options)

    const session = await upsertSessionRecord({
      sessionId: event.session_id,
      shopDomain: event.shop_domain,
      variant: event.variant,
      startedAt: event.occurred_at
    }, options, record => ({
      ...record,
      variant: event.variant || record.variant,
      started_at: record.started_at || event.occurred_at
    }))

    return {
      session,
      event,
      duplicate: Boolean(duplicate)
    }
  })
}

export async function trackTrigger(input, options = {}) {
  return withDataLock(options, async () => {
    const triggerType = getTriggerType(input)
    const { event, duplicate } = await recordRawEventUnlocked({
      ...input,
      eventType: input.eventType || input.event_type || 'trigger_fired',
      metadata: {
        ...normalizeObject(input.metadata || input.extra, 'metadata'),
        trigger_type: triggerType
      }
    }, options)

    if (duplicate) {
      const sessionTable = await readSessionTable(options)
      const session = sessionTable.find(record =>
        record.session_id === event.session_id && record.shop_domain === event.shop_domain
      ) || createEmptySessionRecord({
        sessionId: event.session_id,
        shopDomain: event.shop_domain,
        variant: event.variant,
        startedAt: event.occurred_at
      })

      return {
        session,
        event,
        duplicate: true
      }
    }

    const session = await upsertSessionRecord({
      sessionId: event.session_id,
      shopDomain: event.shop_domain,
      variant: event.variant,
      startedAt: event.occurred_at
    }, options, record => ({
      ...record,
      variant: event.variant || record.variant,
      triggers_fired: [...record.triggers_fired, triggerType]
    }))

    return {
      session,
      event,
      duplicate: false
    }
  })
}

export async function trackMessageShown(input, options = {}) {
  return withDataLock(options, async () => {
    const messageName = getMessageName(input)
    const { event, duplicate } = await recordRawEventUnlocked({
      ...input,
      eventType: input.eventType || input.event_type || 'message_shown',
      metadata: {
        ...normalizeObject(input.metadata || input.extra, 'metadata'),
        message_name: messageName
      }
    }, options)

    if (duplicate) {
      const sessionTable = await readSessionTable(options)
      const session = sessionTable.find(record =>
        record.session_id === event.session_id && record.shop_domain === event.shop_domain
      ) || createEmptySessionRecord({
        sessionId: event.session_id,
        shopDomain: event.shop_domain,
        variant: event.variant,
        startedAt: event.occurred_at
      })

      return {
        session,
        event,
        duplicate: true
      }
    }

    const session = await upsertSessionRecord({
      sessionId: event.session_id,
      shopDomain: event.shop_domain,
      variant: event.variant,
      startedAt: event.occurred_at
    }, options, record => ({
      ...record,
      variant: event.variant || record.variant,
      messages_shown: [...record.messages_shown, messageName]
    }))

    return {
      session,
      event,
      duplicate: false
    }
  })
}

export async function trackCheckoutStarted(input, options = {}) {
  return withDataLock(options, async () => {
    const { event, duplicate } = await recordRawEventUnlocked({
      ...input,
      eventType: input.eventType || input.event_type || 'checkout_started'
    }, options)

    const session = await upsertSessionRecord({
      sessionId: event.session_id,
      shopDomain: event.shop_domain,
      variant: event.variant,
      startedAt: event.occurred_at
    }, options, record => ({
      ...record,
      variant: event.variant || record.variant
    }))

    return {
      session,
      event,
      duplicate
    }
  })
}

export async function trackCheckoutCompleted(input, options = {}) {
  return withDataLock(options, async () => {
    const { event, duplicate } = await recordRawEventUnlocked({
      ...input,
      eventType: input.eventType || input.event_type || 'checkout_completed',
      value: input.checkoutValue ?? input.checkout_value ?? input.revenue ?? input.value ?? 0
    }, options)

    if (duplicate) {
      const sessionTable = await readSessionTable(options)
      const session = sessionTable.find(record =>
        record.session_id === event.session_id && record.shop_domain === event.shop_domain
      ) || createEmptySessionRecord({
        sessionId: event.session_id,
        shopDomain: event.shop_domain,
        variant: event.variant,
        startedAt: event.occurred_at
      })

      return {
        session,
        event,
        duplicate: true
      }
    }

    const session = await upsertSessionRecord({
      sessionId: event.session_id,
      shopDomain: event.shop_domain,
      variant: event.variant,
      startedAt: event.occurred_at
    }, options, record => ({
      ...record,
      variant: event.variant || record.variant,
      converted: true,
      revenue: normalizeRevenue(event.value),
      ended_at: event.occurred_at
    }))

    return {
      session,
      event,
      duplicate: false
    }
  })
}

export async function endSession(input, options = {}) {
  return withDataLock(options, async () => {
    const { event, duplicate } = await recordRawEventUnlocked({
      ...input,
      eventType: input.eventType || input.event_type || 'session_ended'
    }, options)

    const session = await upsertSessionRecord({
      sessionId: event.session_id,
      shopDomain: event.shop_domain,
      variant: event.variant,
      startedAt: event.occurred_at
    }, options, record => ({
      ...record,
      variant: event.variant || record.variant,
      ended_at: event.occurred_at
    }))

    return {
      session,
      event,
      duplicate
    }
  })
}

export async function trackBehavioralEvent(input, options = {}) {
  const eventType = normalizeRequiredString(input.eventType || input.event_type, 'eventType')

  if (eventType === 'session_started' || eventType === 'experiment_assignment') {
    return trackSessionStarted(input, options)
  }

  if (eventType === 'message_shown') {
    return trackMessageShown(input, options)
  }

  if (eventType === 'checkout_started') {
    return trackCheckoutStarted(input, options)
  }

  if (eventType === 'checkout_completed' || eventType === 'purchase') {
    return trackCheckoutCompleted(input, options)
  }

  if (eventType === 'session_ended') {
    return endSession(input, options)
  }

  if (
    eventType === 'trigger_fired' ||
    eventType === 'product_page_view' ||
    eventType === 'add_to_cart_click' ||
    eventType === 'begin_checkout_click'
  ) {
    return trackTrigger({
      ...input,
      triggerType: input.triggerType || input.trigger_type || eventType
    }, options)
  }

  return withDataLock(options, async () => {
    const { event, duplicate } = await recordRawEventUnlocked(input, options)
    const session = await upsertSessionRecord({
      sessionId: event.session_id,
      shopDomain: event.shop_domain,
      variant: event.variant,
      startedAt: event.occurred_at
    }, options, record => ({
      ...record,
      variant: event.variant || record.variant
    }))

    return {
      session,
      event,
      duplicate
    }
  })
}

export async function getSessionCROTable(filters = {}, options = {}) {
  const records = await readSessionTable(options)
  const shopDomain = normalizeOptionalString(filters.shopDomain || filters.shop_domain)
  const since = filters.since ? new Date(filters.since) : null
  const until = filters.until ? new Date(filters.until) : null

  if (since && Number.isNaN(since.getTime())) {
    throw new Error('Invalid since timestamp')
  }

  if (until && Number.isNaN(until.getTime())) {
    throw new Error('Invalid until timestamp')
  }

  return records.filter(record => {
    if (shopDomain && record.shop_domain !== shopDomain) return false
    return matchesWindow(record.started_at, since, until)
  })
}

export async function getRawEventLog(filters = {}, options = {}) {
  const records = await readRawEventLog(options)
  const shopDomain = normalizeOptionalString(filters.shopDomain || filters.shop_domain)
  const sessionId = normalizeOptionalString(filters.sessionId || filters.session_id)
  const since = filters.since ? new Date(filters.since) : null
  const until = filters.until ? new Date(filters.until) : null

  if (since && Number.isNaN(since.getTime())) {
    throw new Error('Invalid since timestamp')
  }

  if (until && Number.isNaN(until.getTime())) {
    throw new Error('Invalid until timestamp')
  }

  return records
    .filter(record => {
      if (shopDomain && record.shop_domain !== shopDomain) return false
      if (sessionId && record.session_id !== sessionId) return false
      return matchesWindow(record.occurred_at, since, until)
    })
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))
}

export async function getTriggerConversionRates(filters = {}, options = {}) {
  const sessions = await getSessionCROTable(filters, options)
  const ratesByTriggerType = new Map()

  for (const session of sessions) {
    const uniqueTriggerTypes = [...new Set(session.triggers_fired)]

    for (const triggerType of uniqueTriggerTypes) {
      if (!ratesByTriggerType.has(triggerType)) {
        ratesByTriggerType.set(triggerType, {
          triggerType,
          triggerCount: 0,
          triggeredSessionCount: 0,
          checkoutCount: 0,
          convertedSessionCount: 0,
          revenue: 0
        })
      }

      const group = ratesByTriggerType.get(triggerType)
      group.triggerCount += session.triggers_fired.filter(item => item === triggerType).length
      group.triggeredSessionCount += 1

      if (session.converted) {
        group.checkoutCount += 1
        group.convertedSessionCount += 1
        group.revenue += Number(session.revenue || 0)
      }
    }
  }

  return Array.from(ratesByTriggerType.values())
    .sort((left, right) => left.triggerType.localeCompare(right.triggerType))
    .map(group => ({
      ...group,
      conversionRate: group.triggeredSessionCount === 0
        ? 0
        : group.convertedSessionCount / group.triggeredSessionCount
    }))
}

export async function getAnalyticsOverview(filters = {}, options = {}) {
  const [sessionTable, rawEvents, conversionRates] = await Promise.all([
    getSessionCROTable(filters, options),
    getRawEventLog(filters, options),
    getTriggerConversionRates(filters, options)
  ])

  const convertedSessions = sessionTable.filter(session => session.converted)
  const revenue = convertedSessions.reduce((sum, session) => sum + Number(session.revenue || 0), 0)
  const messageCount = sessionTable.reduce((sum, session) => sum + session.messages_shown.length, 0)
  const triggerCount = sessionTable.reduce((sum, session) => sum + session.triggers_fired.length, 0)

  return {
    totals: {
      sessions: sessionTable.length,
      convertedSessions: convertedSessions.length,
      revenue,
      triggerCount,
      messageCount,
      rawEventCount: rawEvents.length,
      conversionRate: sessionTable.length === 0
        ? 0
        : convertedSessions.length / sessionTable.length
    },
    sessionTable,
    rawEvents,
    conversionRates
  }
}

export async function getAnalyticsSnapshot(filters = {}, options = {}) {
  return getAnalyticsOverview(filters, options)
}
