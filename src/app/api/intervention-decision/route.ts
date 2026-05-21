import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import {
  getInterventionDecision,
  getInterventionMessageId
} from '../../../../packages/analytics/src/intervention-decision.js'

const querySchema = z.object({
  store_id: z.string().min(1).max(128).optional(),
  shop_domain: z.string().includes('.myshopify.com'),
  session_id: z.string().min(8).max(128)
})

function failClosedResponse(strategy: string, status = 200): NextResponse {
  return NextResponse.json({
    decision: false,
    strategy,
    shadow_mode: false,
    intervention_type: 'none',
    message_id: getInterventionMessageId('none')
  }, {
    status,
    headers: {
      'Cache-Control': 'no-store'
    }
  })
}

async function lookupStoreRecord(shopDomain: string) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) return null

  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(url, key)
  const { data } = await supabase
    .from('stores')
    .select('*')
    .eq('shop_domain', shopDomain)
    .maybeSingle()

  return data || null
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsedQuery = querySchema.safeParse({
    store_id: request.nextUrl.searchParams.get('store_id') || undefined,
    shop_domain: request.nextUrl.searchParams.get('shop_domain'),
    session_id: request.nextUrl.searchParams.get('session_id')
  })

  if (!parsedQuery.success) {
    return failClosedResponse('invalid_request', 400)
  }

  const {
    store_id: requestedStoreId,
    shop_domain: shopDomain,
    session_id: sessionId
  } = parsedQuery.data

  try {
    const storeRecord = await lookupStoreRecord(shopDomain).catch(() => null)
    const { result } = await getInterventionDecision({
      shopDomain,
      sessionId,
      requestedStoreId,
      storeRecord,
      env: process.env
    })

    return NextResponse.json(result, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    console.error('INTERVENTION_DECISION_ROUTE_ERROR', error)
    return failClosedResponse('error_fail_closed', 200)
  }
}
