import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import {
  getDecisionMetadata,
  getInterventionDecision,
  getInterventionMessageId
} from '../../../../packages/analytics/src/intervention-decision.js'
import {
  getMdpInterventionDecision,
  normalizeTrajectoryKey
} from '../../../../packages/analytics/src/mdp-bandit.js'
import {
  buildRateLimitKey,
  createInMemoryRateLimiter
} from '../../../../packages/analytics/src/request-security.js'

type PerformanceLogPayload = {
  supabase: any,
  shopDomain: string,
  sessionId: string,
  requestedStoreId?: string,
  resolvedStoreId?: string,
  result: Record<string, unknown> | null,
  outcomeStatus?: string,
  responseStatusCode?: number,
  ingestStartedAtMs: number,
  decisionEndedAtMs: number,
  timing?: Record<string, unknown>
}

type PerformanceQueueEntry = {
  attempts: number,
  payload: PerformanceLogPayload
}

const querySchema = z.object({
  store_id: z.string().min(1).max(128).optional(),
  shop_domain: z.string().includes('.myshopify.com'),
  session_id: z.string().min(8).max(128),
  trajectory: z.string().max(128).optional()
})
const interventionDecisionLimiter = createInMemoryRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60
})

function failClosedResponse(strategy: string, status = 200): NextResponse {
  return NextResponse.json({
    decision: false,
    strategy,
    shadow_mode: false,
    intervention_type: 'none',
    message_id: getInterventionMessageId('none'),
    session_score: 0,
    metadata: {
      reason: strategy,
      calculated_threshold: 1
    }
  }, {
    status,
    headers: {
      'Cache-Control': 'no-store'
    }
  })
}

function getHeader(request: NextRequest, name: string): string {
  return String(request.headers.get(name) || '')
}

function getClientIp(request: NextRequest): string {
  const forwarded = getHeader(request, 'x-forwarded-for')
  if (forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }

  return getHeader(request, 'x-real-ip').trim() || 'unknown'
}

function isBotLikeRequest(request: NextRequest): boolean {
  const userAgent = getHeader(request, 'user-agent').toLowerCase()
  if (!userAgent) return true

  return (
    userAgent.includes('bot') ||
    userAgent.includes('spider') ||
    userAgent.includes('crawler') ||
    userAgent.includes('python-requests') ||
    userAgent.includes('curl/')
  )
}

async function lookupStoreRecord(supabase: any, shopDomain: string) {
  const { data } = await supabase
    .from('stores')
    .select('*')
    .eq('shop_domain', shopDomain)
    .maybeSingle()

  return data || null
}

async function createSupabaseAdminClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) return null

  const { createClient } = await import('@supabase/supabase-js')
  return createClient(url, key)
}

async function logInterventionDecisionPerformance({
  supabase,
  shopDomain,
  sessionId,
  requestedStoreId = '',
  resolvedStoreId = '',
  result,
  outcomeStatus = 'success',
  responseStatusCode = 200,
  ingestStartedAtMs,
  decisionEndedAtMs,
  timing = {}
}: PerformanceLogPayload) {
  if (!supabase) return
  const decisionMetadata = getDecisionMetadata(result, {
    fallbackReason: 'unknown',
    fallbackCalculatedThreshold: 0
  })
  const deploymentVersion =
    String(
      process.env.BEHAVIORALPRO_DEPLOYMENT_VERSION ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.RENDER_GIT_COMMIT ||
      process.env.COMMIT_SHA ||
      process.env.GIT_SHA ||
      ''
    ).trim() || null
  const pilotCohort = String(process.env.BEHAVIORALPRO_PILOT_COHORT || 'pilot_default').trim()
  const rolloutKey = String(process.env.BEHAVIORALPRO_ROLLOUT_KEY || 'rule_based_pilot').trim()

  const { error } = await supabase.from('performance_metrics').insert([{
    route_name: '/api/intervention-decision',
    route_runtime: 'next',
    deployment_version: deploymentVersion,
    pilot_cohort: pilotCohort,
    rollout_key: rolloutKey,
    shop_domain: shopDomain,
    session_id: sessionId,
    requested_store_id: String(requestedStoreId || '').trim() || null,
    resolved_store_id: String(resolvedStoreId || '').trim() || null,
    decision: Boolean(result?.decision),
    outcome_status: String(outcomeStatus || 'success'),
    response_status_code: Number.isFinite(Number(responseStatusCode))
      ? Number(responseStatusCode)
      : 200,
    strategy: String(result?.strategy || 'unknown'),
    intervention_type: String(result?.intervention_type || 'none'),
    reason: decisionMetadata.reason,
    ingest_start_time: new Date(ingestStartedAtMs).toISOString(),
    decision_end_time: new Date(decisionEndedAtMs).toISOString(),
    total_duration_ms: Math.max(0, decisionEndedAtMs - ingestStartedAtMs),
    fetch_store_intervention_benchmarks_ms:
      Number.isFinite(Number(timing?.fetch_store_intervention_benchmarks_ms))
        ? Number(timing.fetch_store_intervention_benchmarks_ms)
        : null,
    evaluate_ms: Number.isFinite(Number(timing?.evaluate_ms))
      ? Number(timing.evaluate_ms)
      : null,
    metadata: {
      shadow_mode: Boolean(result?.shadow_mode),
      message_id: result?.message_id || getInterventionMessageId(result?.intervention_type || 'none'),
      calculated_threshold: decisionMetadata.calculated_threshold,
      session_score: Number(result?.session_score || 0),
      decision_source: process.env.BEHAVIORALPRO_PILOT_BACKEND_URL ? 'next_proxy_or_queue' : 'next_local'
    }
  }])

  if (error) {
    throw new Error(error.message || 'Failed to insert performance_metrics row')
  }
}

function buildInterventionDecisionPerformanceResult(strategy: string, reason = strategy) {
  return {
    decision: false,
    strategy,
    shadow_mode: false,
    intervention_type: 'none',
    message_id: getInterventionMessageId('none'),
    session_score: 0,
    metadata: {
      reason,
      calculated_threshold: 1
    }
  }
}

const performanceMetricsQueue: PerformanceQueueEntry[] = []
let performanceMetricsDrainPromise: Promise<void> | null = null

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function drainPerformanceMetricsQueue(): Promise<void> {
  if (performanceMetricsDrainPromise) {
    return performanceMetricsDrainPromise
  }

  performanceMetricsDrainPromise = (async () => {
    while (performanceMetricsQueue.length > 0) {
      const entry = performanceMetricsQueue[0]

      try {
        await logInterventionDecisionPerformance(entry.payload)
        performanceMetricsQueue.shift()
      } catch (error) {
        entry.attempts += 1

        if (entry.attempts >= 3) {
          console.error('INTERVENTION_DECISION_PERFORMANCE_METRICS_ERROR', error)
          performanceMetricsQueue.shift()
          continue
        }

        await sleep(Math.min(50 * (2 ** (entry.attempts - 1)), 250))
      }
    }
  })()

  try {
    await performanceMetricsDrainPromise
  } finally {
    performanceMetricsDrainPromise = null
  }
}

async function enqueueInterventionDecisionPerformanceLog(
  payload: PerformanceLogPayload,
  { maxWaitMs = 25 }: { maxWaitMs?: number } = {}
): Promise<void> {
  performanceMetricsQueue.push({
    attempts: 0,
    payload
  })

  const drainPromise = drainPerformanceMetricsQueue()
  await Promise.race([
    drainPromise,
    sleep(maxWaitMs)
  ]).catch((error) => {
    console.error('INTERVENTION_DECISION_PERFORMANCE_METRICS_ERROR', error)
  })
}

async function maybeProxyToPilotBackend(request: NextRequest): Promise<NextResponse | null> {
  const backendBase = String(process.env.BEHAVIORALPRO_PILOT_BACKEND_URL || '').trim()
  if (!backendBase) {
    return null
  }

  const url = new URL('/api/intervention-decision', backendBase)
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value)
  })

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      origin: getHeader(request, 'origin'),
      referer: getHeader(request, 'referer'),
      'user-agent': getHeader(request, 'user-agent'),
      'x-forwarded-for': getClientIp(request)
    },
    cache: 'no-store'
  })

  const bodyText = await response.text()
  const headers = new Headers()
  headers.set('Cache-Control', response.headers.get('cache-control') || 'no-store')

  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    headers.set('Retry-After', retryAfter)
  }

  return new NextResponse(bodyText, {
    status: response.status,
    headers
  })
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ingestStartedAtMs = Date.now()
  const parsedQuery = querySchema.safeParse({
    store_id: request.nextUrl.searchParams.get('store_id') || undefined,
    shop_domain: request.nextUrl.searchParams.get('shop_domain'),
    session_id: request.nextUrl.searchParams.get('session_id'),
    trajectory: request.nextUrl.searchParams.get('trajectory') || undefined
  })

  if (!parsedQuery.success) {
    await enqueueInterventionDecisionPerformanceLog({
      supabase: await createSupabaseAdminClient(),
      shopDomain: String(request.nextUrl.searchParams.get('shop_domain') || '').trim(),
      sessionId: String(request.nextUrl.searchParams.get('session_id') || '').trim(),
      requestedStoreId: String(request.nextUrl.searchParams.get('store_id') || '').trim(),
      resolvedStoreId: '',
      result: buildInterventionDecisionPerformanceResult('invalid_request'),
      outcomeStatus: 'aborted',
      responseStatusCode: 400,
      ingestStartedAtMs,
      decisionEndedAtMs: Date.now(),
      timing: {
        fetch_store_intervention_benchmarks_ms: null,
        evaluate_ms: null
      }
    })
    return failClosedResponse('invalid_request', 400)
  }

  const {
    store_id: requestedStoreId,
    shop_domain: shopDomain,
    session_id: sessionId,
    trajectory
  } = parsedQuery.data

  const rateLimit = interventionDecisionLimiter.check(buildRateLimitKey([
    'intervention-decision-next',
    getClientIp(request),
    shopDomain,
    sessionId
  ]))

  if (!rateLimit.ok) {
    await enqueueInterventionDecisionPerformanceLog({
      supabase: await createSupabaseAdminClient(),
      shopDomain,
      sessionId,
      requestedStoreId: requestedStoreId || '',
      resolvedStoreId: '',
      result: buildInterventionDecisionPerformanceResult('rate_limited'),
      outcomeStatus: 'blocked',
      responseStatusCode: 429,
      ingestStartedAtMs,
      decisionEndedAtMs: Date.now(),
      timing: {
        fetch_store_intervention_benchmarks_ms: null,
        evaluate_ms: null
      }
    })

    return NextResponse.json({
      decision: false,
      strategy: 'rate_limited',
      shadow_mode: false,
      intervention_type: 'none',
      message_id: getInterventionMessageId('none'),
      session_score: 0,
      metadata: {
        reason: 'rate_limited',
        calculated_threshold: 1
      }
    }, {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(rateLimit.retryAfterSeconds)
      }
    })
  }

  if (isBotLikeRequest(request) && !getHeader(request, 'origin') && !getHeader(request, 'referer')) {
    await enqueueInterventionDecisionPerformanceLog({
      supabase: await createSupabaseAdminClient(),
      shopDomain,
      sessionId,
      requestedStoreId: requestedStoreId || '',
      resolvedStoreId: '',
      result: buildInterventionDecisionPerformanceResult('unauthorized'),
      outcomeStatus: 'blocked',
      responseStatusCode: 401,
      ingestStartedAtMs,
      decisionEndedAtMs: Date.now(),
      timing: {
        fetch_store_intervention_benchmarks_ms: null,
        evaluate_ms: null
      }
    })

    return failClosedResponse('unauthorized', 401)
  }

  try {
    const proxiedResponse = await maybeProxyToPilotBackend(request)
    if (proxiedResponse) {
      return proxiedResponse
    }

    const supabase = await createSupabaseAdminClient()
    const decisionTiming = {
      fetch_store_intervention_benchmarks_ms: null,
      evaluate_ms: null
    }
    const storeRecord = supabase
      ? await lookupStoreRecord(supabase, shopDomain).catch(() => null)
      : null
    let decisionPayload = await getMdpInterventionDecision({
      shopDomain,
      sessionId,
      trajectoryKey: normalizeTrajectoryKey(trajectory),
      requestedStoreId,
      storeRecord,
      supabase
    })

    if (!decisionPayload?.result?.decision) {
      decisionPayload = await getInterventionDecision({
        shopDomain,
        sessionId,
        requestedStoreId,
        storeRecord,
        supabase,
        env: process.env,
        decisionTiming
      })
    }

    const { result, resolvedStoreId } = decisionPayload
    const decisionEndedAtMs = Date.now()

    await enqueueInterventionDecisionPerformanceLog({
      supabase,
      shopDomain,
      sessionId,
      requestedStoreId,
      resolvedStoreId,
      result,
      ingestStartedAtMs,
      decisionEndedAtMs,
      timing: decisionTiming,
      outcomeStatus: 'success',
      responseStatusCode: 200
    })

    return NextResponse.json(result, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    console.error('INTERVENTION_DECISION_ROUTE_ERROR', error)
    await enqueueInterventionDecisionPerformanceLog({
      supabase: await createSupabaseAdminClient(),
      shopDomain,
      sessionId,
      requestedStoreId,
      resolvedStoreId: '',
      result: buildInterventionDecisionPerformanceResult('error_fail_closed'),
      outcomeStatus: 'error',
      responseStatusCode: 500,
      ingestStartedAtMs,
      decisionEndedAtMs: Date.now(),
      timing: {
        fetch_store_intervention_benchmarks_ms: null,
        evaluate_ms: null
      }
    })
    return failClosedResponse('error_fail_closed', 200)
  }
}
