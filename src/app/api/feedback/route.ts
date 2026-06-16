import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

function normalizeShopDomainInput(value: unknown): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null

  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const hostname = parsed.hostname.trim().toLowerCase()
    return hostname || null
  } catch {
    return raw.toLowerCase()
  }
}

const feedbackSchema = z.object({
  shopDomain: z.string().trim().transform((value, context) => {
    const normalized = normalizeShopDomainInput(value)
    if (!normalized) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'shopDomain is required'
      })
      return z.NEVER
    }

    if (!normalized.endsWith('.myshopify.com')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'shopDomain must be a valid .myshopify.com hostname'
      })
      return z.NEVER
    }

    return normalized
  }),
  route: z.string().trim().min(1).max(2048),
  submittedAt: z.string().datetime(),
  type: z.enum(['Bug Report', 'Feature Recommendation']),
  description: z.string().trim().min(1).max(5000)
})

type UserError = {
  field?: string[],
  message: string
}

function jsonResponse(
  body: {
    ok: boolean,
    userErrors: UserError[],
    feedback?: Record<string, unknown>
  },
  status = 200
) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store'
    }
  })
}

async function createSupabaseAdminClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    return null
  }

  const { createClient } = await import('@supabase/supabase-js')
  return createClient(url, key)
}

export async function POST(request: NextRequest) {
  let payload: unknown

  try {
    payload = await request.json()
  } catch {
    return jsonResponse({
      ok: false,
      userErrors: [{ message: 'Request body must be valid JSON.' }]
    }, 400)
  }

  const parsed = feedbackSchema.safeParse(payload)

  if (!parsed.success) {
    return jsonResponse({
      ok: false,
      userErrors: parsed.error.issues.map((issue) => ({
        field: issue.path.map(String),
        message: issue.message
      }))
    }, 400)
  }

  const supabase = await createSupabaseAdminClient()

  if (!supabase) {
    return jsonResponse({
      ok: false,
      userErrors: [{
        message: 'Feedback service is not configured. Add Supabase server credentials.'
      }]
    }, 500)
  }

  const { shopDomain, route, submittedAt, type, description } = parsed.data

  const { data, error } = await supabase
    .from('feedback')
    .insert([{
      shop_domain: shopDomain,
      route,
      submitted_at: submittedAt,
      type,
      description
    }])
    .select('id, shop_domain, route, submitted_at, type')
    .single()

  if (error) {
    return jsonResponse({
      ok: false,
      userErrors: [{
        field: ['feedback'],
        message: error.message || 'Unable to save feedback right now.'
      }]
    }, 500)
  }

  return jsonResponse({
    ok: true,
    userErrors: [],
    feedback: data || undefined
  })
}
