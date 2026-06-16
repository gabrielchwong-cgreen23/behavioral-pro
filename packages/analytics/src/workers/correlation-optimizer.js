import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { pathToFileURL } from 'node:url'

import {
  BASELINE_DYNAMIC_MULTIPLIERS,
  normalizeDynamicMultipliers
} from '../intervention-decision.js'
import {
  getTinybirdHost,
  getTinybirdQueryToken,
  queryTinybirdSql,
  toTinybirdSqlString
} from '../tinybird.js'

export const CORRELATION_LOOKBACK_DAYS = 30
export const MIN_CORRELATION_SESSION_COUNT = 200
export const CORRELATION_FEATURE_MAP = Object.freeze({
  rage_click: 'peak_frame_rage_click_count',
  dead_click: 'peak_frame_dead_click_count',
  policy_hover: 'peak_hover_policy_seconds',
  cta_hover: 'peak_hover_cta_seconds',
  cursor_idle: 'peak_cursor_idle_seconds',
  near_cta: 'peak_near_cta',
  active_zone_policy: 'peak_active_zone_policy',
  policy_page: 'peak_policy_page'
})

function clampDynamicMultiplier(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 0.05
  }
  return Math.max(0.05, Math.min(parsed, 2.00))
}

function toBinary(value) {
  return Number(value) > 0 ? 1 : 0
}

function mean(values = []) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
}

function populationStandardDeviation(values = []) {
  if (values.length < 2) return 0
  const avg = mean(values)
  const variance = values.reduce((sum, value) => {
    const delta = Number(value || 0) - avg
    return sum + (delta * delta)
  }, 0) / values.length

  return Math.sqrt(Math.max(variance, 0))
}

function logWithLevel(logger, level, message, details = null) {
  const writer =
    logger && typeof logger[level] === 'function'
      ? logger[level].bind(logger)
      : typeof logger?.log === 'function'
        ? logger.log.bind(logger)
        : console.log.bind(console)

  if (details == null) {
    writer(message)
    return
  }

  writer(message, details)
}

export function buildStoreCorrelationSql({
  shopDomain,
  lookbackDays = CORRELATION_LOOKBACK_DAYS
} = {}) {
  const days = Number.isFinite(Number(lookbackDays))
    ? Math.max(1, Math.round(Number(lookbackDays)))
    : CORRELATION_LOOKBACK_DAYS

  return `
    WITH raw_base AS (
      SELECT
        nullIf(store_id, '') AS store_id,
        nullIf(shop_domain, '') AS shop_domain,
        nullIf(session_id, '') AS session_id,
        event_id,
        event_name,
        coalesce(server_timestamp, client_timestamp) AS event_ts,
        metadata
      FROM raw_events
      WHERE shop_domain = ${toTinybirdSqlString(shopDomain)}
        AND coalesce(server_timestamp, client_timestamp) >= now() - INTERVAL ${days} DAY
        AND coalesce(server_timestamp, client_timestamp) IS NOT NULL
    ),
    deduped_events_raw AS (
      SELECT
        argMax(store_id, tuple(notEmpty(ifNull(store_id, '')), event_ts)) AS store_id,
        argMax(shop_domain, tuple(notEmpty(ifNull(shop_domain, '')), event_ts)) AS shop_domain,
        argMax(session_id, tuple(notEmpty(ifNull(session_id, '')), event_ts)) AS session_id,
        event_id,
        argMax(event_name, event_ts) AS event_name,
        max(event_ts) AS latest_event_ts,
        argMax(metadata, event_ts) AS metadata
      FROM raw_base
      WHERE notEmpty(ifNull(event_id, ''))
      GROUP BY event_id

      UNION ALL

      SELECT
        store_id,
        shop_domain,
        session_id,
        event_id,
        event_name,
        event_ts AS latest_event_ts,
        metadata
      FROM raw_base
      WHERE empty(ifNull(event_id, ''))
    ),
    deduped_events AS (
      SELECT
        store_id,
        shop_domain,
        session_id,
        event_name,
        latest_event_ts AS event_ts,
        metadata
      FROM deduped_events_raw
    ),
    session_rollups AS (
      SELECT
        ifNull(argMax(store_id, tuple(notEmpty(ifNull(store_id, '')), event_ts)), '') AS store_id,
        shop_domain,
        session_id,
        maxIf(
          JSONExtractFloat(metadata, 'rage_click_count'),
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata)
        ) AS peak_frame_rage_click_count,
        maxIf(
          JSONExtractFloat(metadata, 'dead_click_count'),
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata)
        ) AS peak_frame_dead_click_count,
        maxIf(
          JSONExtractFloat(metadata, 'hover_policy_seconds'),
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata)
        ) AS peak_hover_policy_seconds,
        maxIf(
          JSONExtractFloat(metadata, 'hover_cta_seconds'),
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata)
        ) AS peak_hover_cta_seconds,
        maxIf(
          JSONExtractFloat(metadata, 'cursor_idle_seconds'),
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata)
        ) AS peak_cursor_idle_seconds,
        maxIf(
          toUInt8(JSONExtractFloat(metadata, 'cta_distance') <= 220),
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata)
        ) AS peak_near_cta,
        maxIf(
          toUInt8(
            JSONExtractString(metadata, 'active_zone') = 'shipping_policy_zone'
            OR JSONExtractString(metadata, 'active_zone') = 'return_policy_zone'
          ),
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata)
        ) AS peak_active_zone_policy,
        maxIf(
          toUInt8(positionCaseInsensitive(JSONExtractString(metadata, 'page_type'), 'policy') > 0),
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata)
        ) AS peak_policy_page,
        toUInt8(countIf(event_name = 'purchase') > 0) AS purchased,
        toUInt8(countIf(event_name = 'intervention_triggered') > 0) AS did_intervene,
        toUInt8(
          countIf(event_name = 'purchase') = 0
          AND (
            countIf(event_name = 'add_to_cart') > 0
            OR countIf(event_name = 'begin_checkout') > 0
          )
        ) AS abandoned
      FROM deduped_events
      GROUP BY shop_domain, session_id
    )
    SELECT *
    FROM session_rollups
    WHERE did_intervene = 0
    FORMAT JSON
  `
}

export function computePointBiserialCorrelation(
  rows = [],
  featureKey,
  outcomeKey = 'abandoned'
) {
  const preparedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      feature: Number(row?.[featureKey]),
      outcome: toBinary(row?.[outcomeKey])
    }))
    .filter((row) => Number.isFinite(row.feature))

  if (preparedRows.length < 2) {
    return 0
  }

  const positiveRows = preparedRows.filter((row) => row.outcome === 1)
  const negativeRows = preparedRows.filter((row) => row.outcome === 0)

  if (!positiveRows.length || !negativeRows.length) {
    return 0
  }

  const allValues = preparedRows.map((row) => row.feature)
  const deviation = populationStandardDeviation(allValues)

  if (!Number.isFinite(deviation) || deviation === 0) {
    return 0
  }

  const positiveMean = mean(positiveRows.map((row) => row.feature))
  const negativeMean = mean(negativeRows.map((row) => row.feature))
  const p = positiveRows.length / preparedRows.length
  const q = negativeRows.length / preparedRows.length
  const coefficient = ((positiveMean - negativeMean) / deviation) * Math.sqrt(p * q)

  if (!Number.isFinite(coefficient)) {
    return 0
  }

  return Number(coefficient.toFixed(4))
}

export function scaleMultiplierFromCorrelation(baselineMultiplier, correlation) {
  return Number(
    clampDynamicMultiplier(clampDynamicMultiplier(baselineMultiplier) + Number(correlation || 0))
      .toFixed(4)
  )
}

export function optimizeDynamicMultipliersFromRows(rows = [], {
  baseline = BASELINE_DYNAMIC_MULTIPLIERS,
  minSessions = MIN_CORRELATION_SESSION_COUNT,
  logger = console,
  storeLabel = 'unknown_store'
} = {}) {
  const normalizedBaseline = normalizeDynamicMultipliers(baseline)
  const eligibleRows = (Array.isArray(rows) ? rows : []).filter((row) => (
    toBinary(row?.did_intervene) === 0 &&
    (toBinary(row?.purchased) === 1 || toBinary(row?.abandoned) === 1)
  ))

  if (eligibleRows.length < minSessions) {
    logWithLevel(
      logger,
      'warn',
      `CORRELATION OPTIMIZER BASELINE FALLBACK: ${storeLabel}`,
      {
        session_count: eligibleRows.length,
        required_session_count: minSessions
      }
    )

    return {
      dynamic_multipliers: { ...normalizedBaseline },
      correlations: Object.fromEntries(
        Object.keys(CORRELATION_FEATURE_MAP).map((key) => ([key, 0]))
      ),
      session_count: eligibleRows.length,
      used_baseline: true
    }
  }

  const correlations = {}
  const dynamicMultipliers = {}

  for (const [multiplierKey, featureKey] of Object.entries(CORRELATION_FEATURE_MAP)) {
    const correlation = computePointBiserialCorrelation(eligibleRows, featureKey, 'abandoned')
    correlations[multiplierKey] = correlation
    dynamicMultipliers[multiplierKey] = scaleMultiplierFromCorrelation(
      normalizedBaseline[multiplierKey],
      correlation
    )
  }

  return {
    dynamic_multipliers: normalizeDynamicMultipliers(dynamicMultipliers, normalizedBaseline),
    correlations,
    session_count: eligibleRows.length,
    used_baseline: false
  }
}

async function createSupabaseAdminClient(env = process.env) {
  if (!env.SUPABASE_URL) {
    throw new Error('Missing SUPABASE_URL')
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
  }

  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
}

export async function fetchStoreCorrelationRows({
  shopDomain,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const sql = buildStoreCorrelationSql({ shopDomain })
  const result = await queryTinybirdSql({
    sql,
    env,
    fetchImpl,
    logLabel: `CORRELATION OPTIMIZER ${shopDomain}`
  })

  return Array.isArray(result.data) ? result.data : []
}

export async function runCorrelationOptimizer({
  supabase = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  shopDomainFilter = '',
  minSessions = MIN_CORRELATION_SESSION_COUNT
} = {}) {
  const supabaseClient = supabase || await createSupabaseAdminClient(env)
  const tinybirdToken = getTinybirdQueryToken(env)

  if (!tinybirdToken) {
    throw new Error('Missing Tinybird query token')
  }

  logWithLevel(logger, 'info', 'CORRELATION OPTIMIZER START', {
    tinybird_host: getTinybirdHost(env),
    lookback_days: CORRELATION_LOOKBACK_DAYS
  })

  const { data: stores, error } = await supabaseClient
    .from('stores')
    .select('*')

  if (error) {
    throw new Error(`Failed to read stores: ${error.message || error}`)
  }

  const normalizedFilter = String(shopDomainFilter || '').trim().toLowerCase()
  const candidateStores = (Array.isArray(stores) ? stores : [])
    .filter((store) => String(store?.shop_domain || '').trim())
    .filter((store) => (
      !normalizedFilter ||
      String(store.shop_domain || '').trim().toLowerCase() === normalizedFilter
    ))

  const results = []

  for (const store of candidateStores) {
    const shopDomain = String(store.shop_domain || '').trim()
    const storeLabel = `${String(store.id || 'unknown_store_id')}::${shopDomain}`
    try {
      const rows = await fetchStoreCorrelationRows({
        shopDomain,
        env,
        fetchImpl
      })
      const optimized = optimizeDynamicMultipliersFromRows(rows, {
        baseline: BASELINE_DYNAMIC_MULTIPLIERS,
        minSessions,
        logger,
        storeLabel
      })
      const nextSettings = {
        ...(store.settings && typeof store.settings === 'object' ? store.settings : {}),
        dynamic_multipliers: optimized.dynamic_multipliers
      }

      const { error: updateError } = await supabaseClient
        .from('stores')
        .update({ settings: nextSettings })
        .eq('shop_domain', shopDomain)

      if (updateError) {
        throw new Error(`Failed to persist dynamic multipliers for ${shopDomain}: ${updateError.message || updateError}`)
      }

      results.push({
        store_id: store.id || '',
        shop_domain: shopDomain,
        session_count: optimized.session_count,
        used_baseline: optimized.used_baseline,
        dynamic_multipliers: optimized.dynamic_multipliers,
        correlations: optimized.correlations
      })

      logWithLevel(logger, 'info', `CORRELATION OPTIMIZER STORE UPDATED: ${storeLabel}`, {
        session_count: optimized.session_count,
        used_baseline: optimized.used_baseline,
        dynamic_multipliers: optimized.dynamic_multipliers
      })
    } catch (error) {
      logWithLevel(logger, 'error', `CORRELATION OPTIMIZER STORE FAILED: ${storeLabel}`, {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return results
}

async function main() {
  const shopDomainFilter = process.argv[2] || ''
  const results = await runCorrelationOptimizer({
    shopDomainFilter
  })

  console.log(`Correlation optimizer updated ${results.length} store(s).`)
  console.table(results.map((row) => ({
    shop_domain: row.shop_domain,
    session_count: row.session_count,
    used_baseline: row.used_baseline
  })))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('correlation-optimizer failed:', error.message || error)
    process.exitCode = 1
  })
}
