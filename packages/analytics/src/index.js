import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = path.dirname(fileURLToPath(import.meta.url))
const defaultDataDirectory = path.resolve(packageDirectory, '../data')

const SESSION_CRO_FILE = 'session-cro.json'

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

function normalizeStringArray(value, fieldName) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`)
  }

  return value
    .map(item => normalizeOptionalString(item))
    .filter(Boolean)
}

function getTriggerType(input) {
  return normalizeRequiredString(
    input?.triggerType || input?.trigger_type,
    'triggerType'
  )
}

function getMessageName(input) {
  return normalizeRequiredString(
    input?.messageName || input?.message_name || input?.triggerType || input?.trigger_type,
    'messageName'
  )
}

function matchesWindow(timestamp, since, until) {
  const date = new Date(timestamp)
  if (since && date < since) return false
  if (until && date > until) return false
  return true
}

function createEmptySessionRecord(input = {}) {
  return {
    session_id: normalizeRequiredString(input.sessionId || input.session_id, 'sessionId'),
    shop_domain: normalizeRequiredString(input.shopDomain || input.shop_domain, 'shopDomain'),
    variant: normalizeVariant(input.variant),
    triggers_fired: normalizeStringArray(input.triggers_fired, 'triggers_fired'),
    messages_shown: normalizeStringArray(input.messages_shown, 'messages_shown'),
    converted: Boolean(input.converted),
    revenue: normalizeRevenue(input.revenue),
    started_at: normalizeTimestamp(input.startedAt || input.started_at),
    ended_at: input.endedAt || input.ended_at
      ? normalizeTimestamp(input.endedAt || input.ended_at)
      : null
  }
}

async function readSessionTable(options = {}) {
  const records = await readRecords(SESSION_CRO_FILE, options)
  return records.map(record => ({
    session_id: normalizeRequiredString(record.session_id, 'session_id'),
    shop_domain: normalizeRequiredString(record.shop_domain, 'shop_domain'),
    variant: normalizeVariant(record.variant),
    triggers_fired: normalizeStringArray(record.triggers_fired, 'triggers_fired'),
    messages_shown: normalizeStringArray(record.messages_shown, 'messages_shown'),
    converted: Boolean(record.converted),
    revenue: normalizeRevenue(record.revenue),
    started_at: normalizeTimestamp(record.started_at),
    ended_at: record.ended_at ? normalizeTimestamp(record.ended_at) : null
  }))
}

async function writeSessionTable(records, options = {}) {
  await writeRecords(SESSION_CRO_FILE, records, options)
}

async function upsertSessionRecord(input, options = {}, updateRecord) {
  const sessionId = normalizeRequiredString(input.sessionId || input.session_id, 'sessionId')
  const shopDomain = normalizeRequiredString(input.shopDomain || input.shop_domain, 'shopDomain')
  const records = await readSessionTable(options)

  const existingIndex = records.findIndex(record =>
    record.session_id === sessionId && record.shop_domain === shopDomain
  )

  const existingRecord = existingIndex >= 0
    ? records[existingIndex]
    : createEmptySessionRecord(input)

  const nextRecord = updateRecord(existingRecord)

  if (existingIndex >= 0) {
    records[existingIndex] = nextRecord
  } else {
    records.push(nextRecord)
  }

  await writeSessionTable(records, options)
  return nextRecord
}

export async function trackTrigger(input, options = {}) {
  const triggerType = getTriggerType(input)

  return upsertSessionRecord(input, options, record => ({
    ...record,
    variant: input.variant == null ? record.variant : normalizeVariant(input.variant),
    started_at: input.startedAt || input.started_at
      ? normalizeTimestamp(input.startedAt || input.started_at)
      : record.started_at,
    ended_at: input.endedAt || input.ended_at
      ? normalizeTimestamp(input.endedAt || input.ended_at)
      : record.ended_at,
    triggers_fired: [...record.triggers_fired, triggerType]
  }))
}

export async function trackMessageShown(input, options = {}) {
  const messageName = getMessageName(input)

  return upsertSessionRecord(input, options, record => ({
    ...record,
    variant: input.variant == null ? record.variant : normalizeVariant(input.variant),
    started_at: input.startedAt || input.started_at
      ? normalizeTimestamp(input.startedAt || input.started_at)
      : record.started_at,
    ended_at: input.endedAt || input.ended_at
      ? normalizeTimestamp(input.endedAt || input.ended_at)
      : record.ended_at,
    messages_shown: [...record.messages_shown, messageName]
  }))
}

export async function trackCheckoutCompleted(input, options = {}) {
  return upsertSessionRecord(input, options, record => ({
    ...record,
    variant: input.variant == null ? record.variant : normalizeVariant(input.variant),
    converted: true,
    revenue: normalizeRevenue(
      input.checkoutValue ??
      input.checkout_value ??
      input.revenue ??
      record.revenue
    ),
    ended_at: normalizeTimestamp(
      input.completedAt ||
      input.completed_at ||
      input.endedAt ||
      input.ended_at
    )
  }))
}

export async function endSession(input, options = {}) {
  return upsertSessionRecord(input, options, record => ({
    ...record,
    variant: input.variant == null ? record.variant : normalizeVariant(input.variant),
    ended_at: normalizeTimestamp(input.endedAt || input.ended_at)
  }))
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

export async function getAnalyticsSnapshot(filters = {}, options = {}) {
  const [sessionTable, conversionRates] = await Promise.all([
    getSessionCROTable(filters, options),
    getTriggerConversionRates(filters, options)
  ])

  return {
    sessionTable,
    conversionRates
  }
}
