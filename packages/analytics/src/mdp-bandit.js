const DEFAULT_TRAJECTORY_KEY = 'B'
const DEFAULT_COHORT_KEY = 'mdp_default'
const DEFAULT_STATE_WINDOW = 48
const DEFAULT_POSTERIOR_FLOOR = 0.001
const TERMINAL_REWARD_STATUSES = new Set(['success', 'failure'])
const VALID_TRAJECTORY_CODES = new Set(['B', 'H', 'I', 'C', 'A', 'P', 'K', 'R'])

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeOptionalString(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function normalizeStateCode(value) {
  const normalized = String(value || '').trim().toUpperCase()
  return VALID_TRAJECTORY_CODES.has(normalized) ? normalized : null
}

export function normalizeTrajectoryKey(value, maxLength = DEFAULT_STATE_WINDOW) {
  const raw = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')

  const normalized = Array.from(raw).filter(code => VALID_TRAJECTORY_CODES.has(code)).join('')
  if (!normalized) return DEFAULT_TRAJECTORY_KEY
  return normalized.slice(-Math.max(1, maxLength))
}

export function appendTrajectoryState(currentTrajectory, nextState, {
  maxLength = DEFAULT_STATE_WINDOW,
  collapseRepeats = true
} = {}) {
  const normalizedCurrent = normalizeTrajectoryKey(currentTrajectory, maxLength)
  const normalizedNext = normalizeStateCode(nextState)
  if (!normalizedNext) return normalizedCurrent
  if (collapseRepeats && normalizedCurrent.endsWith(normalizedNext)) {
    return normalizedCurrent
  }
  return normalizeTrajectoryKey(`${normalizedCurrent}${normalizedNext}`, maxLength)
}

function fnv1aHash(parts = []) {
  let hash = 2166136261
  for (const part of parts) {
    const value = String(part || '')
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
  }
  return hash >>> 0
}

export function createSeededRng(...seedParts) {
  let state = fnv1aHash(seedParts) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) + 1) / 4294967297
  }
}

function sampleStandardNormal(rng) {
  const u1 = Math.max(rng(), Number.EPSILON)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

export function sampleGamma(shape, rng = Math.random) {
  const normalizedShape = Math.max(DEFAULT_POSTERIOR_FLOOR, toNumber(shape, 1))

  if (normalizedShape < 1) {
    return sampleGamma(normalizedShape + 1, rng) * Math.pow(rng(), 1 / normalizedShape)
  }

  const d = normalizedShape - (1 / 3)
  const c = 1 / Math.sqrt(9 * d)

  while (true) {
    const x = sampleStandardNormal(rng)
    let v = 1 + (c * x)
    if (v <= 0) {
      continue
    }
    v = v * v * v
    const u = rng()
    if (u < 1 - (0.0331 * x * x * x * x)) {
      return d * v
    }
    if (Math.log(u) < (0.5 * x * x) + d * (1 - v + Math.log(v))) {
      return d * v
    }
  }
}

export function sampleBeta(alpha, beta, rng = Math.random) {
  const safeAlpha = Math.max(DEFAULT_POSTERIOR_FLOOR, toNumber(alpha, 1))
  const safeBeta = Math.max(DEFAULT_POSTERIOR_FLOOR, toNumber(beta, 1))
  const x = sampleGamma(safeAlpha, rng)
  const y = sampleGamma(safeBeta, rng)
  return x / (x + y)
}

export function resolveMdpCohortKey(storeRecord = {}, requestedStoreId = '') {
  const storeConfig = storeRecord?.store_config || storeRecord?.settings || {}
  return (
    normalizeOptionalString(storeConfig?.mdp_cohort_key) ||
    normalizeOptionalString(storeConfig?.aov_cohort) ||
    normalizeOptionalString(storeRecord?.mdp_cohort_key) ||
    normalizeOptionalString(requestedStoreId) ||
    DEFAULT_COHORT_KEY
  )
}

function normalizeVariantRow(row = {}) {
  return {
    ...row,
    id: normalizeOptionalString(row.id),
    shop_domain: normalizeOptionalString(row.shop_domain),
    store_id: normalizeOptionalString(row.store_id),
    cohort_key: normalizeOptionalString(row.cohort_key) || DEFAULT_COHORT_KEY,
    variant_key: normalizeOptionalString(row.variant_key) || 'control',
    variant_label: normalizeOptionalString(row.variant_label) || 'Control',
    intervention_type: normalizeOptionalString(row.intervention_type) || 'dynamic_message',
    message_id: normalizeOptionalString(row.message_id),
    payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
    is_active: row.is_active !== false,
    priority: Math.trunc(toNumber(row.priority, 0)),
    prior_alpha: Math.max(DEFAULT_POSTERIOR_FLOOR, toNumber(row.prior_alpha, 1)),
    prior_beta: Math.max(DEFAULT_POSTERIOR_FLOOR, toNumber(row.prior_beta, 1)),
    alpha: Math.max(DEFAULT_POSTERIOR_FLOOR, toNumber(row.alpha, 1)),
    beta: Math.max(DEFAULT_POSTERIOR_FLOOR, toNumber(row.beta, 1))
  }
}

function normalizePosteriorRow(row = {}) {
  return {
    ...row,
    variant_id: normalizeOptionalString(row.variant_id),
    trajectory_key: normalizeTrajectoryKey(row.trajectory_key),
    alpha: Math.max(DEFAULT_POSTERIOR_FLOOR, toNumber(row.alpha, 1)),
    beta: Math.max(DEFAULT_POSTERIOR_FLOOR, toNumber(row.beta, 1))
  }
}

export async function fetchActiveVariants(supabase, {
  shopDomain,
  storeId = '',
  cohortKey = DEFAULT_COHORT_KEY
}) {
  const { data, error } = await supabase
    .from('storefront_intervention_variants')
    .select('*')
    .eq('shop_domain', shopDomain)

  if (error) {
    throw new Error(error.message || 'Failed to load storefront_intervention_variants')
  }

  return (data || [])
    .map(normalizeVariantRow)
    .filter((variant) => {
      if (!variant.is_active) return false
      if (variant.cohort_key !== cohortKey && variant.cohort_key !== DEFAULT_COHORT_KEY) {
        return false
      }
      if (variant.store_id && normalizeOptionalString(storeId) && variant.store_id !== normalizeOptionalString(storeId)) {
        return false
      }
      return Boolean(variant.id)
    })
    .sort((left, right) => (
      right.priority - left.priority ||
      left.variant_key.localeCompare(right.variant_key)
    ))
}

export async function fetchTrajectoryBanditState(supabase, {
  shopDomain,
  cohortKey = DEFAULT_COHORT_KEY,
  trajectoryKey = DEFAULT_TRAJECTORY_KEY
}) {
  const { data, error } = await supabase
    .from('storefront_trajectory_bandit_state')
    .select('*')
    .eq('shop_domain', shopDomain)
    .eq('cohort_key', cohortKey)
    .eq('trajectory_key', normalizeTrajectoryKey(trajectoryKey))

  if (error) {
    throw new Error(error.message || 'Failed to load storefront_trajectory_bandit_state')
  }

  return (data || []).map(normalizePosteriorRow)
}

export function selectVariantWithThompsonSampling({
  variants,
  posteriorRows = [],
  shopDomain,
  sessionId,
  trajectoryKey
}) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null
  }

  const posteriorByVariantId = new Map(
    posteriorRows.map(row => [row.variant_id, row])
  )
  const rng = createSeededRng(shopDomain, sessionId, trajectoryKey)

  let winner = null

  for (const variantRow of variants) {
    const variant = normalizeVariantRow(variantRow)
    const posterior = posteriorByVariantId.get(variant.id)
    const alpha = posterior?.alpha ?? variant.alpha
    const beta = posterior?.beta ?? variant.beta
    const sampledScore = sampleBeta(alpha, beta, rng)
    const candidate = {
      ...variant,
      alpha,
      beta,
      sampledScore
    }

    if (!winner || candidate.sampledScore > winner.sampledScore) {
      winner = candidate
    }
  }

  return winner
}

export async function assignBanditSession(supabase, {
  shopDomain,
  storeId = '',
  cohortKey = DEFAULT_COHORT_KEY,
  sessionId,
  trajectoryKey,
  variant,
  metadata = {}
}) {
  if (!variant?.id) return null

  const row = {
    shop_domain: shopDomain,
    store_id: normalizeOptionalString(storeId),
    cohort_key: cohortKey,
    session_id: sessionId,
    trajectory_key: normalizeTrajectoryKey(trajectoryKey),
    variant_id: variant.id,
    reward_status: 'pending',
    assigned_at: new Date().toISOString(),
    metadata
  }

  const { data, error } = await supabase
    .from('storefront_intervention_sessions')
    .upsert([row], { onConflict: 'shop_domain,session_id' })
    .select()

  if (error) {
    throw new Error(error.message || 'Failed to upsert storefront_intervention_sessions')
  }

  return Array.isArray(data) ? data[0] || null : data || null
}

function buildDecisionResult(variant, {
  sessionId,
  trajectoryKey,
  cohortKey
}) {
  if (!variant?.id) {
    return {
      decision: false,
      strategy: 'mdp_no_variant_available',
      shadow_mode: false,
      intervention_type: 'none',
      message_id: 'tidio_no_intervention',
      session_score: 0,
      metadata: {
        reason: 'mdp_no_variant_available',
        calculated_threshold: 0
      }
    }
  }

  return {
    decision: true,
    strategy: 'trajectory_thompson_sampling',
    shadow_mode: false,
    intervention_type: variant.intervention_type,
    message_id: variant.message_id || `mdp_${variant.variant_key}`,
    session_score: Number(variant.sampledScore.toFixed(6)),
    session_id: sessionId,
    variant_id: variant.id,
    trajectory_key: normalizeTrajectoryKey(trajectoryKey),
    payload: variant.payload,
    metadata: {
      reason: 'mdp_variant_selected',
      calculated_threshold: Number(variant.sampledScore.toFixed(6)),
      cohort_key: cohortKey,
      variant_key: variant.variant_key,
      alpha: variant.alpha,
      beta: variant.beta
    }
  }
}

export async function getMdpInterventionDecision({
  shopDomain,
  sessionId,
  trajectoryKey = DEFAULT_TRAJECTORY_KEY,
  requestedStoreId = '',
  storeRecord = null,
  supabase = null
}) {
  const cohortKey = resolveMdpCohortKey(storeRecord, requestedStoreId)
  const normalizedTrajectoryKey = normalizeTrajectoryKey(trajectoryKey)

  if (!supabase) {
    return {
      session: null,
      resolvedStoreId: requestedStoreId || storeRecord?.store_id || '',
      result: buildDecisionResult(null, {
        sessionId,
        trajectoryKey: normalizedTrajectoryKey,
        cohortKey
      })
    }
  }

  const variants = await fetchActiveVariants(supabase, {
    shopDomain,
    storeId: requestedStoreId || storeRecord?.store_id || '',
    cohortKey
  })

  if (variants.length === 0) {
    return {
      session: null,
      resolvedStoreId: requestedStoreId || storeRecord?.store_id || '',
      result: buildDecisionResult(null, {
        sessionId,
        trajectoryKey: normalizedTrajectoryKey,
        cohortKey
      })
    }
  }

  const posteriorRows = await fetchTrajectoryBanditState(supabase, {
    shopDomain,
    cohortKey,
    trajectoryKey: normalizedTrajectoryKey
  })

  const winner = selectVariantWithThompsonSampling({
    variants,
    posteriorRows,
    shopDomain,
    sessionId,
    trajectoryKey: normalizedTrajectoryKey
  })

  const assignment = await assignBanditSession(supabase, {
    shopDomain,
    storeId: requestedStoreId || storeRecord?.store_id || '',
    cohortKey,
    sessionId,
    trajectoryKey: normalizedTrajectoryKey,
    variant: winner,
    metadata: {
      variant_key: winner?.variant_key || null,
      selection_strategy: 'trajectory_thompson_sampling'
    }
  })

  return {
    session: assignment,
    resolvedStoreId: requestedStoreId || storeRecord?.store_id || '',
    result: buildDecisionResult(winner, {
      sessionId,
      trajectoryKey: normalizedTrajectoryKey,
      cohortKey
    })
  }
}

async function readSessionAssignment(supabase, {
  shopDomain,
  sessionId
}) {
  const { data, error } = await supabase
    .from('storefront_intervention_sessions')
    .select('*')
    .eq('shop_domain', shopDomain)
    .eq('session_id', sessionId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message || 'Failed to load storefront_intervention_sessions row')
  }

  return data || null
}

async function readVariant(supabase, variantId) {
  const { data, error } = await supabase
    .from('storefront_intervention_variants')
    .select('*')
    .eq('id', variantId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message || 'Failed to load storefront_intervention_variants row')
  }

  return data || null
}

async function readTrajectoryPosterior(supabase, {
  shopDomain,
  cohortKey,
  trajectoryKey,
  variantId
}) {
  const { data, error } = await supabase
    .from('storefront_trajectory_bandit_state')
    .select('*')
    .eq('shop_domain', shopDomain)
    .eq('cohort_key', cohortKey)
    .eq('trajectory_key', normalizeTrajectoryKey(trajectoryKey))
    .eq('variant_id', variantId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message || 'Failed to load trajectory posterior')
  }

  return data || null
}

export async function recordBanditReward(supabase, {
  shopDomain,
  sessionId,
  variantId = '',
  orderId = '',
  trajectoryKey = DEFAULT_TRAJECTORY_KEY,
  wasSuccess,
  rewardSource = 'manual'
}) {
  const assignment = await readSessionAssignment(supabase, {
    shopDomain,
    sessionId
  })

  if (!assignment?.id) {
    return {
      applied: false,
      reason: 'assignment_not_found'
    }
  }

  if (TERMINAL_REWARD_STATUSES.has(String(assignment.reward_status || ''))) {
    return {
      applied: false,
      reason: 'reward_already_recorded',
      assignment
    }
  }

  const effectiveVariantId = normalizeOptionalString(variantId) || normalizeOptionalString(assignment.variant_id)
  const effectiveTrajectoryKey = normalizeTrajectoryKey(trajectoryKey || assignment.trajectory_key)
  const nextRewardStatus = wasSuccess ? 'success' : 'failure'
  const now = new Date().toISOString()

  const { data: updatedAssignments, error: assignmentError } = await supabase
    .from('storefront_intervention_sessions')
    .upsert([{
      ...assignment,
      reward_status: nextRewardStatus,
      rewarded_at: now,
      converted_at: wasSuccess ? now : assignment.converted_at || null,
      checkout_order_id: normalizeOptionalString(orderId) || assignment.checkout_order_id || null,
      metadata: {
        ...(assignment.metadata && typeof assignment.metadata === 'object' ? assignment.metadata : {}),
        reward_source: rewardSource
      }
    }], { onConflict: 'id' })
    .select()

  if (assignmentError) {
    throw new Error(assignmentError.message || 'Failed to update storefront_intervention_sessions')
  }

  const variant = normalizeVariantRow(await readVariant(supabase, effectiveVariantId))
  const nextVariant = {
    ...variant,
    alpha: Number((variant.alpha + (wasSuccess ? 1 : 0)).toFixed(6)),
    beta: Number((variant.beta + (wasSuccess ? 0 : 1)).toFixed(6)),
    successes_count: Math.trunc(toNumber(variant.successes_count, 0) + (wasSuccess ? 1 : 0)),
    failures_count: Math.trunc(toNumber(variant.failures_count, 0) + (wasSuccess ? 0 : 1)),
    updated_at: now
  }

  const { error: variantError } = await supabase
    .from('storefront_intervention_variants')
    .upsert([nextVariant], { onConflict: 'id' })
    .select()

  if (variantError) {
    throw new Error(variantError.message || 'Failed to update storefront_intervention_variants')
  }

  const trajectoryPosterior = await readTrajectoryPosterior(supabase, {
    shopDomain,
    cohortKey: assignment.cohort_key || DEFAULT_COHORT_KEY,
    trajectoryKey: effectiveTrajectoryKey,
    variantId: effectiveVariantId
  })

  const nextTrajectoryPosterior = trajectoryPosterior
    ? {
        ...trajectoryPosterior,
        alpha: Number((toNumber(trajectoryPosterior.alpha, variant.prior_alpha) + (wasSuccess ? 1 : 0)).toFixed(6)),
        beta: Number((toNumber(trajectoryPosterior.beta, variant.prior_beta) + (wasSuccess ? 0 : 1)).toFixed(6)),
        successes_count: Math.trunc(toNumber(trajectoryPosterior.successes_count, 0) + (wasSuccess ? 1 : 0)),
        failures_count: Math.trunc(toNumber(trajectoryPosterior.failures_count, 0) + (wasSuccess ? 0 : 1)),
        last_seen_at: now,
        updated_at: now
      }
    : {
        shop_domain: shopDomain,
        store_id: normalizeOptionalString(assignment.store_id),
        cohort_key: assignment.cohort_key || DEFAULT_COHORT_KEY,
        trajectory_key: effectiveTrajectoryKey,
        variant_id: effectiveVariantId,
        alpha: Number((variant.prior_alpha + (wasSuccess ? 1 : 0)).toFixed(6)),
        beta: Number((variant.prior_beta + (wasSuccess ? 0 : 1)).toFixed(6)),
        successes_count: wasSuccess ? 1 : 0,
        failures_count: wasSuccess ? 0 : 1,
        first_seen_at: assignment.assigned_at || now,
        last_seen_at: now,
        created_at: now,
        updated_at: now
      }

  const { error: trajectoryError } = await supabase
    .from('storefront_trajectory_bandit_state')
    .upsert([nextTrajectoryPosterior], {
      onConflict: trajectoryPosterior?.id ? 'id' : 'shop_domain,cohort_key,trajectory_key,variant_id'
    })
    .select()

  if (trajectoryError) {
    throw new Error(trajectoryError.message || 'Failed to update trajectory posterior')
  }

  return {
    applied: true,
    reward_status: nextRewardStatus,
    assignment: Array.isArray(updatedAssignments) ? updatedAssignments[0] || assignment : assignment,
    variant_id: effectiveVariantId
  }
}

export async function reconcilePendingBanditFailures(supabase, {
  olderThanMs = 4 * 60 * 60 * 1000
} = {}) {
  const { data, error } = await supabase
    .from('storefront_intervention_sessions')
    .select('*')
    .eq('reward_status', 'pending')

  if (error) {
    throw new Error(error.message || 'Failed to load pending bandit sessions')
  }

  const cutoffMs = Date.now() - olderThanMs
  const pendingRows = (data || [])
    .filter((row) => new Date(row.assigned_at || 0).getTime() <= cutoffMs)
    .sort((left, right) => new Date(left.assigned_at).getTime() - new Date(right.assigned_at).getTime())

  const applied = []

  for (const row of pendingRows) {
    const result = await recordBanditReward(supabase, {
      shopDomain: row.shop_domain,
      sessionId: row.session_id,
      variantId: row.variant_id,
      trajectoryKey: row.trajectory_key,
      wasSuccess: false,
      rewardSource: 'timeout_reconciliation'
    })
    if (result.applied) {
      applied.push(result)
    }
  }

  return {
    processed: applied.length,
    rows: applied
  }
}

export async function detectTrajectoryAnomalies(supabase, {
  minimumConsecutiveFailures = 100
} = {}) {
  const { data, error } = await supabase
    .from('storefront_intervention_sessions')
    .select('*')

  if (error) {
    throw new Error(error.message || 'Failed to load bandit sessions for anomaly detection')
  }

  const grouped = new Map()
  for (const row of data || []) {
    const key = `${row.shop_domain}::${normalizeTrajectoryKey(row.trajectory_key)}`
    const bucket = grouped.get(key) || []
    bucket.push(row)
    grouped.set(key, bucket)
  }

  const alerts = []

  for (const [key, rows] of grouped.entries()) {
    const sorted = rows
      .slice()
      .sort((left, right) => new Date(right.assigned_at).getTime() - new Date(left.assigned_at).getTime())

    let consecutiveFailures = 0
    let sawSuccess = false

    for (const row of sorted) {
      if (row.reward_status === 'success') {
        sawSuccess = true
        break
      }
      if (row.reward_status === 'failure') {
        consecutiveFailures += 1
        continue
      }
      break
    }

    if (!sawSuccess && consecutiveFailures >= minimumConsecutiveFailures) {
      const [shopDomain, trajectoryKey] = key.split('::')
      alerts.push({
        shop_domain: shopDomain,
        trajectory_key: trajectoryKey,
        consecutive_failures: consecutiveFailures,
        zero_conversions: true
      })
    }
  }

  return alerts
}

export function buildTinybirdTrajectoryWatchdogSql({
  windowMinutes = 15,
  minimumSessions = 100
} = {}) {
  const safeMinutes = Math.max(1, Math.trunc(toNumber(windowMinutes, 15)))
  const safeMinimum = Math.max(1, Math.trunc(toNumber(minimumSessions, 100)))

  return `
    SELECT
      shop_domain,
      trajectory_key,
      count() AS sessions,
      countIf(converted = 1) AS conversions,
      countIf(converted = 0) AS failures
    FROM trajectory_sessions
    WHERE event_ts >= now() - INTERVAL ${safeMinutes} MINUTE
    GROUP BY shop_domain, trajectory_key
    HAVING sessions >= ${safeMinimum}
      AND conversions = 0
    ORDER BY failures DESC, shop_domain ASC, trajectory_key ASC
    FORMAT JSON
  `.trim()
}
