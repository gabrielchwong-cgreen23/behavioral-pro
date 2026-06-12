type Env = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
}

type VariantRow = {
  id: string
  shop_domain: string
  cohort_key: string
  variant_key: string
  message_id?: string | null
  intervention_type?: string | null
  payload?: Record<string, unknown> | null
  alpha?: number | null
  beta?: number | null
  prior_alpha?: number | null
  prior_beta?: number | null
  is_active?: boolean | null
  priority?: number | null
}

type PosteriorRow = {
  variant_id: string
  alpha?: number | null
  beta?: number | null
}

const DEFAULT_TRAJECTORY = 'B'

function parseCookie(cookieHeader: string | null, key: string): string | null {
  if (!cookieHeader) return null
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=')
    if (name === key) {
      return decodeURIComponent(rest.join('='))
    }
  }
  return null
}

function normalizeTrajectory(value: string | null | undefined): string {
  const normalized = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(-48)
  return normalized || DEFAULT_TRAJECTORY
}

function seededRng(seed: string): () => number {
  let state = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index)
    state = Math.imul(state, 16777619)
  }

  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) + 1) / 4294967297
  }
}

function sampleNormal(rng: () => number): number {
  const u1 = Math.max(rng(), Number.EPSILON)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

function sampleGamma(shape: number, rng: () => number): number {
  const normalizedShape = Math.max(0.001, Number(shape || 1))

  if (normalizedShape < 1) {
    return sampleGamma(normalizedShape + 1, rng) * Math.pow(rng(), 1 / normalizedShape)
  }

  const d = normalizedShape - (1 / 3)
  const c = 1 / Math.sqrt(9 * d)

  while (true) {
    const x = sampleNormal(rng)
    let v = 1 + (c * x)
    if (v <= 0) continue
    v = v * v * v
    const u = rng()
    if (u < 1 - (0.0331 * x * x * x * x)) return d * v
    if (Math.log(u) < (0.5 * x * x) + d * (1 - v + Math.log(v))) return d * v
  }
}

function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGamma(alpha, rng)
  const y = sampleGamma(beta, rng)
  return x / (x + y)
}

async function selectSupabaseRows<T>(env: Env, table: string, query: string): Promise<T[]> {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${query}`
  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    }
  })

  if (!response.ok) {
    throw new Error(`Supabase fetch failed for ${table}: ${response.status}`)
  }

  return await response.json() as T[]
}

async function fetchDecisionState(env: Env, shopDomain: string, trajectory: string) {
  const variantQuery = new URLSearchParams({
    select: '*',
    shop_domain: `eq.${shopDomain}`,
    is_active: 'eq.true',
    order: 'priority.desc,variant_key.asc'
  })
  const posteriorQuery = new URLSearchParams({
    select: 'variant_id,alpha,beta',
    shop_domain: `eq.${shopDomain}`,
    trajectory_key: `eq.${trajectory}`
  })

  const [variants, posteriors] = await Promise.all([
    selectSupabaseRows<VariantRow>(env, 'storefront_intervention_variants', variantQuery.toString()),
    selectSupabaseRows<PosteriorRow>(env, 'storefront_trajectory_bandit_state', posteriorQuery.toString())
  ])

  return { variants, posteriors }
}

function pickWinner(variants: VariantRow[], posteriors: PosteriorRow[], seed: string) {
  const posteriorByVariant = new Map(posteriors.map(row => [row.variant_id, row]))
  const rng = seededRng(seed)
  let winner: (VariantRow & { sampledScore: number }) | null = null

  for (const variant of variants) {
    const posterior = posteriorByVariant.get(variant.id)
    const alpha = Number(posterior?.alpha ?? variant.alpha ?? variant.prior_alpha ?? 1)
    const beta = Number(posterior?.beta ?? variant.beta ?? variant.prior_beta ?? 1)
    const sampledScore = sampleBeta(alpha, beta, rng)
    if (!winner || sampledScore > winner.sampledScore) {
      winner = { ...variant, sampledScore }
    }
  }

  return winner
}

function injectVariantMarkup(html: string, winner: VariantRow & { sampledScore: number }): string {
  const payload = winner.payload || {}
  const replacement = `
    <script type="application/json" id="behavioralpro-edge-decision">
      ${JSON.stringify({
        variant_id: winner.id,
        message_id: winner.message_id || `mdp_${winner.variant_key}`,
        payload,
        sampled_score: Number(winner.sampledScore.toFixed(6))
      })}
    </script>
  `

  if (html.includes('</head>')) {
    return html.replace('</head>', `${replacement}</head>`)
  }

  return `${replacement}${html}`
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const shopDomain = url.searchParams.get('shop_domain') || url.hostname
    const sessionId = parseCookie(request.headers.get('cookie'), 'bp_sid') || 'edge_session'
    const trajectory = normalizeTrajectory(parseCookie(request.headers.get('cookie'), 'bp_t'))

    const upstreamResponse = await fetch(request)
    const contentType = upstreamResponse.headers.get('content-type') || ''

    if (!contentType.includes('text/html')) {
      return upstreamResponse
    }

    const { variants, posteriors } = await fetchDecisionState(env, shopDomain, trajectory)
    if (!variants.length) {
      return upstreamResponse
    }

    const winner = pickWinner(variants, posteriors, `${shopDomain}:${sessionId}:${trajectory}`)
    if (!winner) {
      return upstreamResponse
    }

    const html = await upstreamResponse.text()
    return new Response(injectVariantMarkup(html, winner), {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamResponse.headers
    })
  }
}
