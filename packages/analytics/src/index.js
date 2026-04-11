import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = path.dirname(fileURLToPath(import.meta.url))
const defaultDataDirectory = path.resolve(packageDirectory, '../data')

const TRIGGERS_FILE = 'triggers.json'
const CHECKOUTS_FILE = 'checkouts.json'

function getDataDirectory(options = {}) {
  return options.dataDirectory || process.env.ANALYTICS_DATA_DIRECTORY || defaultDataDirectory
}

function getFilePath(filename, options = {}) {
  return path.join(getDataDirectory(options), filename)
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

function normalizeMetadata(value) {
  if (value == null) return {}

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata must be an object')
  }

  return value
}

function createRecordId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function buildTriggerMatchKey(record) {
  return record.sessionId || record.triggerId || record.id
}

function buildCheckoutMatchKey(record) {
  return record.sessionId || record.triggerId || null
}

export async function trackTrigger(input, options = {}) {
  const record = {
    id: createRecordId('trigger'),
    triggerType: normalizeRequiredString(input?.triggerType, 'triggerType'),
    sessionId: normalizeOptionalString(input?.sessionId),
    triggerId: normalizeOptionalString(input?.triggerId),
    shopDomain: normalizeOptionalString(input?.shopDomain),
    userId: normalizeOptionalString(input?.userId),
    firedAt: normalizeTimestamp(input?.firedAt),
    metadata: normalizeMetadata(input?.metadata)
  }

  const triggers = await readRecords(TRIGGERS_FILE, options)
  triggers.push(record)
  await writeRecords(TRIGGERS_FILE, triggers, options)

  return record
}

export async function trackCheckoutCompleted(input, options = {}) {
  const record = {
    id: createRecordId('checkout'),
    triggerType: normalizeOptionalString(input?.triggerType),
    sessionId: normalizeOptionalString(input?.sessionId),
    triggerId: normalizeOptionalString(input?.triggerId),
    shopDomain: normalizeOptionalString(input?.shopDomain),
    orderId: normalizeOptionalString(input?.orderId),
    userId: normalizeOptionalString(input?.userId),
    checkoutValue: input?.checkoutValue == null ? null : Number(input.checkoutValue),
    completedAt: normalizeTimestamp(input?.completedAt),
    metadata: normalizeMetadata(input?.metadata)
  }

  if (record.checkoutValue != null && Number.isNaN(record.checkoutValue)) {
    throw new Error('checkoutValue must be a number when provided')
  }

  if (!record.sessionId && !record.triggerId && !record.triggerType) {
    throw new Error('checkoutCompleted requires sessionId, triggerId, or triggerType')
  }

  const checkouts = await readRecords(CHECKOUTS_FILE, options)
  checkouts.push(record)
  await writeRecords(CHECKOUTS_FILE, checkouts, options)

  return record
}

export async function getTriggerConversionRates(filters = {}, options = {}) {
  const [triggers, checkouts] = await Promise.all([
    readRecords(TRIGGERS_FILE, options),
    readRecords(CHECKOUTS_FILE, options)
  ])

  const normalizedShopDomain = normalizeOptionalString(filters.shopDomain)
  const since = filters.since ? new Date(filters.since) : null
  const until = filters.until ? new Date(filters.until) : null

  if (since && Number.isNaN(since.getTime())) {
    throw new Error('Invalid since timestamp')
  }

  if (until && Number.isNaN(until.getTime())) {
    throw new Error('Invalid until timestamp')
  }

  const filteredTriggers = triggers.filter(record => {
    if (normalizedShopDomain && record.shopDomain !== normalizedShopDomain) return false

    const firedAt = new Date(record.firedAt)
    if (since && firedAt < since) return false
    if (until && firedAt > until) return false

    return true
  })

  const filteredCheckouts = checkouts.filter(record => {
    if (normalizedShopDomain && record.shopDomain !== normalizedShopDomain) return false

    const completedAt = new Date(record.completedAt)
    if (since && completedAt < since) return false
    if (until && completedAt > until) return false

    return true
  })

  const ratesByTriggerType = new Map()

  for (const trigger of filteredTriggers) {
    const key = trigger.triggerType

    if (!ratesByTriggerType.has(key)) {
      ratesByTriggerType.set(key, {
        triggerType: key,
        triggerCount: 0,
        triggeredSessions: new Set(),
        convertedSessions: new Set(),
        checkoutCount: 0
      })
    }

    const group = ratesByTriggerType.get(key)
    group.triggerCount += 1
    group.triggeredSessions.add(buildTriggerMatchKey(trigger))
  }

  for (const checkout of filteredCheckouts) {
    const directTriggerType = checkout.triggerType
    const checkoutMatchKey = buildCheckoutMatchKey(checkout)

    if (directTriggerType && ratesByTriggerType.has(directTriggerType)) {
      const group = ratesByTriggerType.get(directTriggerType)
      group.checkoutCount += 1

      if (checkoutMatchKey) {
        group.convertedSessions.add(checkoutMatchKey)
      }
    }

    if (!checkoutMatchKey) {
      continue
    }

    for (const group of ratesByTriggerType.values()) {
      if (group.triggeredSessions.has(checkoutMatchKey)) {
        group.convertedSessions.add(checkoutMatchKey)
        group.checkoutCount += directTriggerType === group.triggerType ? 0 : 1
      }
    }
  }

  return Array.from(ratesByTriggerType.values())
    .sort((left, right) => left.triggerType.localeCompare(right.triggerType))
    .map(group => {
      const triggeredSessionCount = group.triggeredSessions.size
      const convertedSessionCount = group.convertedSessions.size

      return {
        triggerType: group.triggerType,
        triggerCount: group.triggerCount,
        triggeredSessionCount,
        checkoutCount: group.checkoutCount,
        convertedSessionCount,
        conversionRate: triggeredSessionCount === 0
          ? 0
          : convertedSessionCount / triggeredSessionCount
      }
    })
}

export async function getAnalyticsSnapshot(filters = {}, options = {}) {
  const [triggers, checkouts, conversionRates] = await Promise.all([
    readRecords(TRIGGERS_FILE, options),
    readRecords(CHECKOUTS_FILE, options),
    getTriggerConversionRates(filters, options)
  ])

  return {
    triggers,
    checkouts,
    conversionRates
  }
}
