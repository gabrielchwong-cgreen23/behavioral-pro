import {
  getTinybirdEventsApiUrl,
  getTinybirdHost,
  getTinybirdIngestToken,
  getTinybirdQueryToken,
  queryTinybirdSql,
  toTinybirdSqlString
} from './tinybird.js'

export const INTERVENTION_COHORT_BENCHMARKS = {
  impulse: {
    rageClickThreshold: 1,
    ctaIdleThreshold: 1,
    policyViewThreshold: 1,
    interventionType: 'fast_conversion_nudge'
  },
  mid_tier: {
    rageClickThreshold: 2,
    ctaIdleThreshold: 2,
    policyViewThreshold: 1,
    interventionType: 'reassurance_assist'
  },
  luxury: {
    rageClickThreshold: 3,
    ctaIdleThreshold: 3,
    policyViewThreshold: 2,
    interventionType: 'high_touch_consultation'
  }
}

const STORE_BLEND_FLOOR = 100
const STORE_BLEND_FULL = 1000
const LIVE_SESSION_STATE_VERSION = 1
const INTERVENTION_MESSAGE_IDS = {
  none: 'tidio_no_intervention',
  checkout_recovery: 'tidio_checkout_recovery_v1',
  friction_assistance: 'tidio_friction_assistance_v1',
  trust_reassurance: 'tidio_trust_reassurance_v1',
  cart_recovery: 'tidio_cart_recovery_v1',
  fast_conversion_nudge: 'tidio_fast_conversion_nudge_v1',
  reassurance_assist: 'tidio_reassurance_assist_v1',
  high_touch_consultation: 'tidio_high_touch_consultation_v1'
}
const DEFAULT_INTERVENTION_STORE_CONFIG = {
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

export function resolveInterventionCohort({ storeId = '', shopDomain = '', cohortMap = {} } = {}) {
  return cohortMap[storeId] || cohortMap[shopDomain] || 'mid_tier'
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toBooleanFlag(value, fallback = false) {
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

function normalizeAllowedInterventionTypes(
  value,
  fallback = DEFAULT_INTERVENTION_STORE_CONFIG.allowed_intervention_types
) {
  if (!Array.isArray(value)) return [...fallback]
  const unique = new Set()
  for (const item of value) {
    const normalized = String(item || '').trim()
    if (normalized) unique.add(normalized)
  }
  return unique.size ? Array.from(unique) : [...fallback]
}

export function normalizeInterventionStoreConfig(input = {}) {
  const base = {
    ...DEFAULT_INTERVENTION_STORE_CONFIG,
    ...(input && typeof input === 'object' ? input : {})
  }

  const cohort = ['impulse', 'mid_tier', 'luxury'].includes(String(base.aov_cohort || ''))
    ? String(base.aov_cohort)
    : DEFAULT_INTERVENTION_STORE_CONFIG.aov_cohort

  return {
    interventions_enabled: toBooleanFlag(
      base.interventions_enabled,
      DEFAULT_INTERVENTION_STORE_CONFIG.interventions_enabled
    ),
    is_active: toBooleanFlag(
      base.is_active ?? base.interventions_enabled,
      DEFAULT_INTERVENTION_STORE_CONFIG.is_active
    ),
    tidio_enabled: toBooleanFlag(
      base.tidio_enabled,
      DEFAULT_INTERVENTION_STORE_CONFIG.tidio_enabled
    ),
    shadow_mode: toBooleanFlag(base.shadow_mode, DEFAULT_INTERVENTION_STORE_CONFIG.shadow_mode),
    tidio_project_id:
      String(base.tidio_project_id || DEFAULT_INTERVENTION_STORE_CONFIG.tidio_project_id).trim() ||
      DEFAULT_INTERVENTION_STORE_CONFIG.tidio_project_id,
    aov_cohort: cohort,
    cooldown_seconds: normalizePositiveInteger(
      base.cooldown_seconds,
      DEFAULT_INTERVENTION_STORE_CONFIG.cooldown_seconds,
      { min: 30, max: 3600 }
    ),
    intervention_threshold: Number.isFinite(Number(base.intervention_threshold))
      ? Number(base.intervention_threshold)
      : null,
    allowed_intervention_types: normalizeAllowedInterventionTypes(base.allowed_intervention_types)
  }
}

export function getInterventionStoreConfigFromRecord(storeRecord) {
  return normalizeInterventionStoreConfig({
    ...(storeRecord?.store_config || {}),
    ...(storeRecord?.settings || {}),
    is_active: storeRecord?.is_active ?? storeRecord?.settings?.is_active,
    intervention_threshold:
      storeRecord?.intervention_threshold ?? storeRecord?.settings?.intervention_threshold
  })
}

function buildDecisionResult({
  decision = false,
  strategy,
  interventionType = 'none',
  messageId = getInterventionMessageId(interventionType),
  shadowMode = false,
  calculatedThreshold = 1,
  sessionScore = 0,
  reason = strategy
}) {
  return {
    decision,
    strategy,
    intervention_type: interventionType,
    message_id: messageId,
    shadow_mode: shadowMode,
    calculated_threshold: calculatedThreshold,
    session_score: sessionScore,
    reason
  }
}

export function buildLiveSessionStateKey({ shopDomain = '', sessionId = '' } = {}) {
  const normalizedShopDomain = String(shopDomain || '').trim()
  const normalizedSessionId = String(sessionId || '').trim()
  return `${normalizedShopDomain}::${normalizedSessionId}`
}

export function createLiveSessionStateStore({
  ttlMs = 30 * 60 * 1000,
  now = () => Date.now()
} = {}) {
  const store = new Map()

  function prune() {
    const cutoff = now() - ttlMs
    for (const [key, value] of store.entries()) {
      if (toNumber(value?.updated_at_ms, 0) < cutoff) {
        store.delete(key)
      }
    }
  }

  return {
    get(params = {}) {
      prune()
      return store.get(buildLiveSessionStateKey(params)) || null
    },
    set(params = {}, value) {
      prune()
      store.set(buildLiveSessionStateKey(params), value)
      return value
    },
    delete(params = {}) {
      return store.delete(buildLiveSessionStateKey(params))
    },
    size() {
      prune()
      return store.size
    }
  }
}

function normalizeLiveSessionState(state = {}) {
  return {
    version: LIVE_SESSION_STATE_VERSION,
    store_id: String(state.store_id || '').trim(),
    shop_domain: String(state.shop_domain || '').trim(),
    session_id: String(state.session_id || '').trim(),
    visitor_id: String(state.visitor_id || '').trim(),
    experiment_variant: String(state.experiment_variant || '').trim(),
    page_url: state.page_url || null,
    referrer: state.referrer || null,
    first_seen_at: state.first_seen_at || null,
    last_seen_at: state.last_seen_at || null,
    page_views: toNumber(state.page_views, 0),
    product_views: toNumber(state.product_views, 0),
    add_to_cart_count: toNumber(state.add_to_cart_count, 0),
    begin_checkout_count: toNumber(state.begin_checkout_count, 0),
    purchase_count: toNumber(state.purchase_count, 0),
    rage_click_count: toNumber(state.rage_click_count, 0),
    cta_idle_15s_count: toNumber(state.cta_idle_15s_count, 0),
    policy_page_view_count: toNumber(state.policy_page_view_count, 0),
    intervention_triggered_count: toNumber(state.intervention_triggered_count, 0),
    first_intervention_triggered_at: state.first_intervention_triggered_at || null,
    reached_checkout: toBooleanFlag(state.reached_checkout),
    purchased: toBooleanFlag(state.purchased),
    provisional_abandoned_cart: toBooleanFlag(state.provisional_abandoned_cart),
    provisional_abandoned_checkout: toBooleanFlag(state.provisional_abandoned_checkout),
    updated_at_ms: toNumber(state.updated_at_ms, Date.now())
  }
}

export function seedLiveSessionState({
  existingState = null,
  shopDomain = '',
  sessionId = '',
  storeId = '',
  visitorId = '',
  experimentVariant = '',
  pageUrl = null,
  referrer = null,
  seenAt = null
} = {}) {
  const timestamp = seenAt || new Date().toISOString()
  const next = normalizeLiveSessionState(existingState || {})
  next.store_id = String(storeId || next.store_id || '').trim()
  next.shop_domain = String(shopDomain || next.shop_domain || '').trim()
  next.session_id = String(sessionId || next.session_id || '').trim()
  next.visitor_id = String(visitorId || next.visitor_id || '').trim()
  next.experiment_variant = String(experimentVariant || next.experiment_variant || '').trim()
  next.page_url = pageUrl || next.page_url || null
  next.referrer = referrer || next.referrer || null
  next.first_seen_at = next.first_seen_at || timestamp
  next.last_seen_at = timestamp
  next.updated_at_ms = Date.now()
  return next
}

export function applyEventToLiveSessionState(existingState = null, eventRecord = {}) {
  const eventName = String(eventRecord.event_name || '').trim()
  const eventTimestamp = eventRecord.server_timestamp || eventRecord.client_timestamp || new Date().toISOString()
  const next = seedLiveSessionState({
    existingState,
    shopDomain: eventRecord.shop_domain,
    sessionId: eventRecord.session_id,
    storeId: eventRecord.store_id,
    visitorId: eventRecord.visitor_id,
    experimentVariant: eventRecord.experiment_variant,
    pageUrl: eventRecord.page_url,
    referrer: eventRecord.referrer,
    seenAt: eventTimestamp
  })

  const increment = (field) => {
    next[field] = toNumber(next[field], 0) + 1
  }

  switch (eventName) {
    case 'page_view':
      increment('page_views')
      break
    case 'product_view':
      increment('product_views')
      break
    case 'add_to_cart':
      increment('add_to_cart_count')
      break
    case 'begin_checkout':
      increment('begin_checkout_count')
      next.reached_checkout = true
      break
    case 'purchase':
      increment('purchase_count')
      next.purchased = true
      break
    case 'rage_click':
      increment('rage_click_count')
      break
    case 'cta_idle_15s':
      increment('cta_idle_15s_count')
      break
    case 'policy_page_view':
      increment('policy_page_view_count')
      break
    case 'intervention_triggered':
      increment('intervention_triggered_count')
      next.first_intervention_triggered_at = next.first_intervention_triggered_at || eventTimestamp
      break
    default:
      break
  }

  next.provisional_abandoned_cart =
    next.add_to_cart_count > 0 &&
    next.begin_checkout_count === 0 &&
    next.purchase_count === 0
  next.provisional_abandoned_checkout =
    next.begin_checkout_count > 0 &&
    next.purchase_count === 0
  next.reached_checkout = next.begin_checkout_count > 0
  next.purchased = next.purchase_count > 0
  next.updated_at_ms = Date.now()

  return next
}

export function buildSessionFeaturesFromLiveState(liveSessionState = null) {
  if (!liveSessionState) return null
  const normalized = normalizeLiveSessionState(liveSessionState)
  if (!normalized.shop_domain || !normalized.session_id) {
    return null
  }

  return {
    store_id: normalized.store_id,
    shop_domain: normalized.shop_domain,
    session_id: normalized.session_id,
    visitor_id: normalized.visitor_id,
    experiment_variant: normalized.experiment_variant,
    page_url: normalized.page_url,
    referrer: normalized.referrer,
    first_seen_at: normalized.first_seen_at,
    last_seen_at: normalized.last_seen_at,
    page_views: normalized.page_views,
    product_views: normalized.product_views,
    add_to_cart_count: normalized.add_to_cart_count,
    begin_checkout_count: normalized.begin_checkout_count,
    purchase_count: normalized.purchase_count,
    rage_click_count: normalized.rage_click_count,
    cta_idle_15s_count: normalized.cta_idle_15s_count,
    policy_page_view_count: normalized.policy_page_view_count,
    intervention_triggered_count: normalized.intervention_triggered_count,
    first_intervention_triggered_at: normalized.first_intervention_triggered_at,
    reached_checkout: normalized.reached_checkout ? 1 : 0,
    purchased: normalized.purchased ? 1 : 0,
    provisional_abandoned_cart: normalized.provisional_abandoned_cart ? 1 : 0,
    provisional_abandoned_checkout: normalized.provisional_abandoned_checkout ? 1 : 0
  }
}

export function buildSessionFeaturesFromSessionStateRow(sessionStateRow = null) {
  if (!sessionStateRow) return null

  const counters =
    sessionStateRow.counters && typeof sessionStateRow.counters === 'object'
      ? sessionStateRow.counters
      : {}

  const normalized = normalizeLiveSessionState({
    store_id: sessionStateRow.store_id,
    shop_domain: sessionStateRow.shop_domain,
    session_id: sessionStateRow.session_id,
    visitor_id: sessionStateRow.visitor_id,
    experiment_variant: sessionStateRow.experiment_variant,
    page_url: sessionStateRow.page_url,
    referrer: sessionStateRow.referrer,
    first_seen_at: sessionStateRow.first_seen_at,
    last_seen_at: sessionStateRow.last_seen_at,
    page_views: counters.page_views,
    product_views: counters.product_views,
    add_to_cart_count: counters.add_to_cart_count,
    begin_checkout_count: counters.begin_checkout_count,
    purchase_count: counters.purchase_count,
    rage_click_count: counters.rage_click_count,
    cta_idle_15s_count: counters.cta_idle_15s_count,
    policy_page_view_count: counters.policy_page_view_count,
    intervention_triggered_count: counters.intervention_triggered_count,
    first_intervention_triggered_at:
      sessionStateRow.first_intervention_triggered_at || counters.first_intervention_triggered_at,
    reached_checkout: toNumber(counters.begin_checkout_count, 0) > 0,
    purchased: toNumber(counters.purchase_count, 0) > 0,
    provisional_abandoned_cart:
      toNumber(counters.add_to_cart_count, 0) > 0 &&
      toNumber(counters.begin_checkout_count, 0) === 0 &&
      toNumber(counters.purchase_count, 0) === 0,
    provisional_abandoned_checkout:
      toNumber(counters.begin_checkout_count, 0) > 0 &&
      toNumber(counters.purchase_count, 0) === 0
  })

  return buildSessionFeaturesFromLiveState(normalized)
}

export async function fetchHotSessionState({
  supabase,
  shopDomain,
  sessionId
}) {
  if (!supabase) {
    return null
  }

  const { data, error } = await supabase
    .from('session_state')
    .select('*')
    .eq('shop_domain', shopDomain)
    .eq('session_id', sessionId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message || 'Failed to read session_state')
  }

  return data || null
}

function buildCohortMap({ env = process.env, storeConfig, resolvedStoreId, shopDomain }) {
  let envCohorts = {}

  if (env.BEHAVIORALPRO_AOV_COHORTS) {
    try {
      envCohorts = JSON.parse(env.BEHAVIORALPRO_AOV_COHORTS)
    } catch {
      envCohorts = {}
    }
  }

  return {
    ...envCohorts,
    ...(resolvedStoreId ? { [resolvedStoreId]: storeConfig.aov_cohort } : {}),
    [shopDomain]: storeConfig.aov_cohort
  }
}

export async function getInterventionDecision({
  shopDomain,
  sessionId,
  requestedStoreId = '',
  storeRecord = null,
  supabase = null,
  liveSessionState = null,
  env = process.env,
  fetchImpl = globalThis.fetch
}) {
  let session = null

  if (supabase) {
    try {
      const hotSessionState = await fetchHotSessionState({
        supabase,
        shopDomain,
        sessionId
      })
      session = buildSessionFeaturesFromSessionStateRow(hotSessionState)
    } catch (error) {
      console.log('HOT SESSION STATE FALLBACK:', error.message || error)
    }
  }

  if (!session) {
    session = buildSessionFeaturesFromLiveState(liveSessionState)
  }

  if (!session) {
    session = await fetchCurrentSessionFeatures({
      shopDomain,
      sessionId,
      env,
      fetchImpl
    })
  }

  const storeConfig = getInterventionStoreConfigFromRecord(storeRecord)

  if (!session) {
    return {
      session: null,
      storeConfig,
      resolvedStoreId: '',
      result: buildDecisionResult({
        strategy: 'no_session_data',
        reason: 'no_session_data'
      })
    }
  }

  const resolvedStoreId = String(session?.store_id || requestedStoreId || '').trim()

  if (!storeConfig.is_active || !storeConfig.interventions_enabled) {
    return {
      session,
      storeConfig,
      resolvedStoreId,
      result: buildDecisionResult({
        strategy: 'store_inactive',
        reason: 'store_inactive'
      })
    }
  }

  const interventionTriggeredCount = toNumber(session?.intervention_triggered_count, 0)
  if (interventionTriggeredCount > 0 && session?.first_intervention_triggered_at) {
    const firstTriggeredAt = new Date(session.first_intervention_triggered_at)
    if (!Number.isNaN(firstTriggeredAt.getTime())) {
      const deltaSeconds = Math.floor((Date.now() - firstTriggeredAt.getTime()) / 1000)
      if (deltaSeconds < storeConfig.cooldown_seconds) {
        return {
          session,
          storeConfig,
          resolvedStoreId,
          result: buildDecisionResult({
            strategy: 'cooldown_active',
            calculatedThreshold: Number(storeConfig.cooldown_seconds || 0),
            reason: 'cooldown_active'
          })
        }
      }
    }
  }

  const storeBenchmarks = await fetchStoreInterventionBenchmarks({
    shopDomain,
    env,
    fetchImpl
  })

  const cohort = resolveInterventionCohort({
    storeId: resolvedStoreId,
    shopDomain,
    cohortMap: buildCohortMap({ env, storeConfig, resolvedStoreId, shopDomain })
  })

  let result = evaluate({
    session,
    cohort,
    storeBenchmarks,
    storeConfig: {
      intervention_threshold: storeConfig.intervention_threshold,
      is_active: storeConfig.is_active
    }
  })

  if (
    result.decision &&
    !storeConfig.allowed_intervention_types.includes(result.intervention_type)
  ) {
    result = buildDecisionResult({
      strategy: 'intervention_filtered_by_store_config',
      calculatedThreshold: Number(result.calculated_threshold || 1),
      sessionScore: Number(result.session_score || 0),
      reason: 'intervention_filtered_by_store_config'
    })
  }

  return {
    session,
    storeConfig,
    resolvedStoreId,
    result: {
      ...result,
      shadow_mode: Boolean(storeConfig.shadow_mode)
    }
  }
}

export function computeBlendWeight(storeHistoricalSessionCount) {
  if (storeHistoricalSessionCount < STORE_BLEND_FLOOR) {
    return 0
  }

  return Math.min(1, storeHistoricalSessionCount / STORE_BLEND_FULL)
}

export function blendThreshold(cohortBenchmark, storeBenchmark, storeHistoricalSessionCount) {
  const weight = computeBlendWeight(storeHistoricalSessionCount)
  return ((1 - weight) * cohortBenchmark) + (weight * storeBenchmark)
}

export async function fetchTinybirdPipeJson({
  pipeName,
  params = {},
  env = process.env,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for Tinybird pipe queries')
  }

  const token = getTinybirdQueryToken(env)
  if (!token) {
    throw new Error('Missing Tinybird query token')
  }

  const url = new URL(`${getTinybirdHost(env)}/v0/pipes/${pipeName}.json`)
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`
    }
  })

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(`Tinybird pipe failed with status ${response.status}: ${text}`)
  }

  const parsed = text ? JSON.parse(text) : { data: [] }
  return Array.isArray(parsed.data) ? parsed.data : []
}

export async function fetchCurrentSessionFeatures({
  shopDomain,
  sessionId,
  env = process.env,
  fetchImpl = globalThis.fetch
}) {
  const sql = `
    WITH raw_base AS (
      SELECT
        nullIf(store_id, '') AS store_id,
        nullIf(shop_domain, '') AS shop_domain,
        nullIf(session_id, '') AS session_id,
        nullIf(visitor_id, '') AS visitor_id,
        nullIf(experiment_variant, '') AS experiment_variant,
        page_url,
        referrer,
        event_id,
        event_name,
        coalesce(server_timestamp, client_timestamp) AS event_ts
      FROM raw_events
      WHERE shop_domain = ${toTinybirdSqlString(shopDomain)}
        AND session_id = ${toTinybirdSqlString(sessionId)}
        AND coalesce(server_timestamp, client_timestamp) IS NOT NULL
    ),
    deduped_events AS (
      SELECT
        argMax(store_id, tuple(notEmpty(ifNull(store_id, '')), event_ts)) AS store_id,
        argMax(shop_domain, tuple(notEmpty(ifNull(shop_domain, '')), event_ts)) AS shop_domain,
        argMax(session_id, tuple(notEmpty(ifNull(session_id, '')), event_ts)) AS session_id,
        argMax(visitor_id, tuple(notEmpty(ifNull(visitor_id, '')), event_ts)) AS visitor_id,
        argMax(experiment_variant, tuple(notEmpty(ifNull(experiment_variant, '')), event_ts)) AS experiment_variant,
        argMax(page_url, tuple(notEmpty(ifNull(page_url, '')), event_ts)) AS page_url,
        argMax(referrer, tuple(notEmpty(ifNull(referrer, '')), event_ts)) AS referrer,
        event_id,
        argMax(event_name, event_ts) AS event_name,
        max(event_ts) AS event_ts
      FROM raw_base
      WHERE notEmpty(ifNull(event_id, ''))
      GROUP BY event_id

      UNION ALL

      SELECT
        store_id,
        shop_domain,
        session_id,
        visitor_id,
        experiment_variant,
        page_url,
        referrer,
        event_id,
        event_name,
        event_ts
      FROM raw_base
      WHERE empty(ifNull(event_id, ''))
    )
    SELECT
      ifNull(argMax(store_id, tuple(notEmpty(ifNull(store_id, '')), event_ts)), '') AS store_id,
      shop_domain,
      session_id,
      argMax(visitor_id, tuple(notEmpty(ifNull(visitor_id, '')), event_ts)) AS visitor_id,
      argMax(experiment_variant, tuple(notEmpty(ifNull(experiment_variant, '')), event_ts)) AS experiment_variant,
      min(event_ts) AS first_seen_at,
      max(event_ts) AS last_seen_at,
      countIf(event_name = 'page_view') AS page_views,
      countIf(event_name = 'product_view') AS product_views,
      countIf(event_name = 'add_to_cart') AS add_to_cart_count,
      countIf(event_name = 'begin_checkout') AS begin_checkout_count,
      countIf(event_name = 'purchase') AS purchase_count,
      countIf(event_name = 'rage_click') AS rage_click_count,
      countIf(event_name = 'cta_idle_15s') AS cta_idle_15s_count,
      countIf(event_name = 'policy_page_view') AS policy_page_view_count,
      countIf(event_name = 'intervention_triggered') AS intervention_triggered_count,
      minIf(event_ts, event_name = 'intervention_triggered') AS first_intervention_triggered_at,
      toUInt8(countIf(event_name = 'begin_checkout') > 0) AS reached_checkout,
      toUInt8(countIf(event_name = 'purchase') > 0) AS purchased,
      toUInt8(
        countIf(event_name = 'add_to_cart') > 0
        AND countIf(event_name = 'begin_checkout') = 0
        AND countIf(event_name = 'purchase') = 0
      ) AS provisional_abandoned_cart,
      toUInt8(
        countIf(event_name = 'begin_checkout') > 0
        AND countIf(event_name = 'purchase') = 0
      ) AS provisional_abandoned_checkout
    FROM deduped_events
    GROUP BY shop_domain, session_id
    FORMAT JSON
  `

  try {
    const result = await queryTinybirdSql({
      sql,
      env,
      fetchImpl,
      logLabel: 'CURRENT SESSION FEATURES SQL'
    })

    if (Array.isArray(result.data) && result.data[0]) {
      return result.data[0]
    }
  } catch (error) {
    console.log('CURRENT SESSION FEATURES SQL FALLBACK:', error.message || error)
  }

  const rows = await fetchTinybirdPipeJson({
    pipeName: 'v1_session_features_by_session',
    params: {
      shop_domain: shopDomain,
      session_id: sessionId
    },
    env,
    fetchImpl
  })

  return rows[0] || null
}

export function getInterventionMessageId(interventionType) {
  const normalized = String(interventionType || 'none').trim()
  return INTERVENTION_MESSAGE_IDS[normalized] || `tidio_${normalized}_v1`
}

export async function fetchStoreInterventionBenchmarks({
  shopDomain,
  env = process.env,
  fetchImpl = globalThis.fetch
}) {
  const sql = `
    WITH deduped_events AS (
      SELECT
        shop_domain,
        session_id,
        event_name,
        event_id,
        coalesce(server_timestamp, client_timestamp) AS event_ts
      FROM raw_events
      WHERE shop_domain = ${toTinybirdSqlString(shopDomain)}
        AND notEmpty(ifNull(session_id, ''))
        AND coalesce(server_timestamp, client_timestamp) IS NOT NULL
      ORDER BY event_id, event_ts DESC
      LIMIT 1 BY event_id
    ),
    session_rollup AS (
      SELECT
        shop_domain,
        session_id,
        countIf(event_name = 'rage_click') AS rage_click_count,
        countIf(event_name = 'cta_idle_15s') AS cta_idle_15s_count,
        countIf(event_name = 'policy_page_view') AS policy_page_view_count,
        toUInt8(countIf(event_name = 'begin_checkout') > 0) AS reached_checkout,
        toUInt8(countIf(event_name = 'purchase') > 0) AS purchased
      FROM deduped_events
      GROUP BY shop_domain, session_id
    )
    SELECT
      count() AS historical_session_count,
      quantileTDigest(0.75)(rage_click_count) AS p75_rage_click_count,
      quantileTDigest(0.75)(cta_idle_15s_count) AS p75_cta_idle_15s_count,
      quantileTDigest(0.75)(policy_page_view_count) AS p75_policy_page_view_count,
      avg(reached_checkout) AS reached_checkout_rate,
      avg(purchased) AS purchase_rate
    FROM session_rollup
  `

  const result = await queryTinybirdSql({
    sql,
    env,
    fetchImpl,
    logLabel: 'INTERVENTION STORE BENCHMARKS'
  })

  return result.data?.[0] || {
    historical_session_count: 0,
    p75_rage_click_count: 0,
    p75_cta_idle_15s_count: 0,
    p75_policy_page_view_count: 0,
    reached_checkout_rate: 0,
    purchase_rate: 0
  }
}

export function evaluateInterventionDecision({
  session,
  cohort,
  storeBenchmarks,
  storeConfig = {}
}) {
  const storeIsActive = storeConfig?.is_active !== false
  const configuredInterventionThreshold = Number.isFinite(Number(storeConfig?.intervention_threshold))
    ? Number(storeConfig.intervention_threshold)
    : null
  const cohortBenchmark = INTERVENTION_COHORT_BENCHMARKS[cohort] || INTERVENTION_COHORT_BENCHMARKS.mid_tier
  const historicalSessionCount = toNumber(storeBenchmarks?.historical_session_count, 0)

  const rageClickThreshold = blendThreshold(
    cohortBenchmark.rageClickThreshold,
    toNumber(storeBenchmarks?.p75_rage_click_count, cohortBenchmark.rageClickThreshold),
    historicalSessionCount
  )

  const ctaIdleThreshold = blendThreshold(
    cohortBenchmark.ctaIdleThreshold,
    toNumber(storeBenchmarks?.p75_cta_idle_15s_count, cohortBenchmark.ctaIdleThreshold),
    historicalSessionCount
  )

  const policyViewThreshold = blendThreshold(
    cohortBenchmark.policyViewThreshold,
    toNumber(storeBenchmarks?.p75_policy_page_view_count, cohortBenchmark.policyViewThreshold),
    historicalSessionCount
  )

  const rageClicks = toNumber(session?.rage_click_count, 0)
  const ctaIdleEvents = toNumber(session?.cta_idle_15s_count, 0)
  const policyViews = toNumber(session?.policy_page_view_count, 0)
  const addToCartCount = toNumber(session?.add_to_cart_count, 0)
  const reachedCheckout = toBooleanFlag(session?.reached_checkout)
  const purchased = toBooleanFlag(session?.purchased)
  const provisionalAbandonedCart = toBooleanFlag(session?.provisional_abandoned_cart)
  const provisionalAbandonedCheckout = toBooleanFlag(session?.provisional_abandoned_checkout)
  const strategy = historicalSessionCount < STORE_BLEND_FLOOR ? 'cold_start_static' : 'dynamic_blend'
  const rageClickScore = rageClickThreshold <= 0 ? 0 : rageClicks / rageClickThreshold
  const ctaIdleScore = ctaIdleThreshold <= 0 ? 0 : ctaIdleEvents / ctaIdleThreshold
  const policyViewScore = policyViewThreshold <= 0 ? 0 : policyViews / policyViewThreshold
  const cartRecoveryScore = provisionalAbandonedCart && !reachedCheckout ? 1 : 0
  const checkoutRecoveryScore = provisionalAbandonedCheckout ? 1 : 0
  const sessionScore = Math.max(
    rageClickScore,
    ctaIdleScore,
    policyViewScore,
    cartRecoveryScore,
    checkoutRecoveryScore,
    0
  )

  function buildResult(decision, interventionType, {
    reason = decision ? 'threshold_met' : 'insufficient_intent',
    calculatedThreshold = configuredInterventionThreshold ?? 1
  } = {}) {
    return {
      decision,
      strategy,
      intervention_type: interventionType,
      message_id: getInterventionMessageId(interventionType),
      calculated_threshold: calculatedThreshold,
      session_score: Number(sessionScore.toFixed(4)),
      reason
    }
  }

  let result

  if (!storeIsActive) {
    result = buildResult(false, 'none', {
      reason: 'store_inactive',
      calculatedThreshold: configuredInterventionThreshold ?? 1
    })
  } else {
    function applyConfiguredThreshold(resultValue) {
      if (
        resultValue.decision &&
        configuredInterventionThreshold != null &&
        sessionScore < configuredInterventionThreshold
      ) {
        return {
          ...buildResult(false, 'none', {
            reason: 'below_threshold',
            calculatedThreshold: configuredInterventionThreshold
          }),
          strategy: resultValue.strategy
        }
      }

      if (configuredInterventionThreshold != null) {
        return {
          ...resultValue,
          calculated_threshold: configuredInterventionThreshold
        }
      }

      return resultValue
    }

    if (purchased) {
      result = applyConfiguredThreshold(buildResult(false, 'none', {
        reason: 'already_purchased',
        calculatedThreshold: 1
      }))
    } else if (provisionalAbandonedCheckout) {
      result = applyConfiguredThreshold(buildResult(true, 'checkout_recovery', {
        reason: 'checkout_abandonment_detected',
        calculatedThreshold: 1
      }))
    } else if (rageClicks >= rageClickThreshold) {
      result = applyConfiguredThreshold(buildResult(true, 'friction_assistance', {
        reason: 'rage_click_threshold_exceeded',
        calculatedThreshold: Number(rageClickThreshold.toFixed(4))
      }))
    } else if (ctaIdleEvents >= ctaIdleThreshold && addToCartCount === 0) {
      result = applyConfiguredThreshold(buildResult(true, cohortBenchmark.interventionType, {
        reason: 'cta_idle_threshold_exceeded',
        calculatedThreshold: Number(ctaIdleThreshold.toFixed(4))
      }))
    } else if (policyViews >= policyViewThreshold) {
      result = applyConfiguredThreshold(buildResult(true, 'trust_reassurance', {
        reason: 'policy_view_threshold_exceeded',
        calculatedThreshold: Number(policyViewThreshold.toFixed(4))
      }))
    } else if (provisionalAbandonedCart && !reachedCheckout) {
      result = applyConfiguredThreshold(buildResult(true, 'cart_recovery', {
        reason: 'cart_abandonment_detected',
        calculatedThreshold: 1
      }))
    } else {
      result = applyConfiguredThreshold(buildResult(false, 'none', {
        reason: 'below_threshold',
        calculatedThreshold: configuredInterventionThreshold ?? Number(Math.max(rageClickThreshold, ctaIdleThreshold, policyViewThreshold, 1).toFixed(4))
      }))
    }
  }

  return result
}

export function evaluate(input) {
  return evaluateInterventionDecision(input)
}
