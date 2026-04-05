import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

const app = express()
const PORT = process.env.PORT || 3001

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET

if (!SHOPIFY_API_KEY) {
  console.warn('Missing SHOPIFY_API_KEY')
}

if (!SHOPIFY_API_SECRET) {
  console.warn('Missing SHOPIFY_API_SECRET')
}

const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}

app.use(cors(corsOptions))
app.use(express.json())

app.use((req, res, next) => {
  console.log('INCOMING:', req.method, req.url)
  next()
})

app.options('/api/events', cors(corsOptions))
app.options('/api/assign-variant', cors(corsOptions))
app.options('/api/stores', cors(corsOptions))
app.options('/api/metrics/:shop_domain', cors(corsOptions))
app.options('/api/debug/:shop_domain', cors(corsOptions))
app.options('/api/embedded-check', cors(corsOptions))

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function normalizeShop(shop) {
  if (!shop || typeof shop !== 'string') return null
  return shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function base64UrlDecode(input) {
  let value = String(input).replace(/-/g, '+').replace(/_/g, '/')
  while (value.length % 4 !== 0) {
    value += '='
  }
  return Buffer.from(value, 'base64')
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization
  if (!authHeader || typeof authHeader !== 'string') return null
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : null
}

function verifyShopifySessionToken(token) {
  if (!token) {
    throw new Error('Missing bearer token')
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT structure')
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts

  const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'))
  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'))

  if (header.alg !== 'HS256') {
    throw new Error('Unexpected JWT algorithm')
  }

  const signedPart = `${encodedHeader}.${encodedPayload}`
  const expectedSignature = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(signedPart)
    .digest()

  const actualSignature = base64UrlDecode(encodedSignature)

  if (expectedSignature.length !== actualSignature.length) {
    throw new Error('Invalid JWT signature length')
  }

  if (!crypto.timingSafeEqual(expectedSignature, actualSignature)) {
    throw new Error('Invalid JWT signature')
  }

  const now = Math.floor(Date.now() / 1000)

  if (typeof payload.nbf === 'number' && now < payload.nbf) {
    throw new Error('Token not yet valid')
  }

  if (typeof payload.exp === 'number' && now >= payload.exp) {
    throw new Error('Token expired')
  }

  if (payload.aud !== SHOPIFY_API_KEY) {
    throw new Error('Token audience mismatch')
  }

  if (!payload.dest) {
    throw new Error('Token missing dest')
  }

  const destUrl = new URL(payload.dest)
  const destHost = destUrl.hostname

  if (!destHost.endsWith('.myshopify.com')) {
    throw new Error('Token dest is not a myshopify domain')
  }

  return {
    header,
    payload,
    shop: destHost
  }
}

function sendInvalidSessionResponse(res, message) {
  return res
    .status(401)
    .set('X-Shopify-Retry-Invalid-Session-Request', '1')
    .json({
      success: false,
      error: message
    })
}

function requireShopifySessionToken(req, res, next) {
  try {
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res.status(500).json({
        success: false,
        error: 'Missing Shopify API environment variables'
      })
    }

    const token = getBearerToken(req)
    const verified = verifyShopifySessionToken(token)

    const requestedShop =
      normalizeShop(req.query.shop) ||
      normalizeShop(req.params.shop_domain) ||
      normalizeShop(req.body?.shop_domain)

    if (requestedShop && requestedShop !== verified.shop) {
      return sendInvalidSessionResponse(res, 'Shop mismatch')
    }

    req.shopifySession = verified
    next()
  } catch (error) {
    console.log('SESSION TOKEN ERROR:', error.message)
    return sendInvalidSessionResponse(res, error.message)
  }
}

app.post('/api/stores', async (req, res) => {
  try {
    const { shop_domain, access_token = null, scope = null } = req.body || {}

    if (!shop_domain) {
      return res.status(400).json({
        success: false,
        error: 'shop_domain is required'
      })
    }

    const row = {
      shop_domain,
      access_token,
      scope,
      installed_at: new Date().toISOString()
    }

    const { data, error } = await supabase
      .from('stores')
      .upsert([row], { onConflict: 'shop_domain' })
      .select()

    if (error) {
      console.log('STORE UPSERT ERROR:', error)
      return res.status(500).json({ success: false, error })
    }

    return res.json({ success: true, data })
  } catch (error) {
    console.log('STORE ROUTE ERROR:', error)
    return res.status(500).json({
      success: false,
      error: String(error.message || error)
    })
  }
})

app.post('/api/assign-variant', async (req, res) => {
  try {
    const { shop_domain, session_id } = req.body || {}

    if (!shop_domain || !session_id) {
      return res.status(400).json({
        success: false,
        error: 'missing fields'
      })
    }

    const { data: existing, error: existingError } = await supabase
      .from('experiment_sessions')
      .select('*')
      .eq('shop_domain', shop_domain)
      .eq('session_id', session_id)
      .maybeSingle()

    if (existingError) {
      console.log('ASSIGN LOOKUP ERROR:', existingError)
      return res.status(500).json({ success: false, error: existingError })
    }

    if (existing) {
      return res.json({ success: true, data: existing })
    }

    const variant = Math.random() < 0.5 ? 'control' : 'variant'

    const { data, error } = await supabase
      .from('experiment_sessions')
      .insert([
        {
          shop_domain,
          session_id,
          variant,
          created_at: new Date().toISOString()
        }
      ])
      .select()
      .single()

    if (error) {
      console.log('ASSIGN INSERT ERROR:', error)
      return res.status(500).json({ success: false, error })
    }

    return res.json({ success: true, data })
  } catch (error) {
    console.log('ASSIGN ROUTE ERROR:', error)
    return res.status(500).json({
      success: false,
      error: String(error.message || error)
    })
  }
})

app.post('/api/events', async (req, res) => {
  try {
    console.log('EVENT RECEIVED:', JSON.stringify(req.body, null, 2))

    const { shop_domain, session_id, event_type, value = 0 } = req.body || {}

    if (!shop_domain || !session_id || !event_type) {
      console.log('EVENT REJECTED: missing fields')
      return res.status(400).json({
        success: false,
        error: 'missing fields',
        received: req.body
      })
    }

    const { data: session, error: sessionError } = await supabase
      .from('experiment_sessions')
      .select('*')
      .eq('shop_domain', shop_domain)
      .eq('session_id', session_id)
      .maybeSingle()

    if (sessionError) {
      console.log('SESSION LOOKUP ERROR:', sessionError)
      return res.status(500).json({ success: false, error: sessionError })
    }

    if (!session) {
      console.log('EVENT REJECTED: session not assigned')
      return res.status(400).json({
        success: false,
        error: 'session not assigned',
        shop_domain,
        session_id
      })
    }

    const insertRow = {
      shop_domain,
      session_id,
      variant: session.variant,
      event_type,
      value: Number(value || 0),
      created_at: new Date().toISOString()
    }

    console.log('EVENT INSERT ROW:', JSON.stringify(insertRow, null, 2))

    const { data, error } = await supabase
      .from('events')
      .insert([insertRow])
      .select()

    if (error) {
      console.log('EVENT INSERT ERROR:', error)
      return res.status(500).json({ success: false, error })
    }

    console.log('EVENT INSERTED OK:', JSON.stringify(data, null, 2))
    return res.json({ success: true, data })
  } catch (error) {
    console.log('EVENT ROUTE ERROR:', error)
    return res.status(500).json({
      success: false,
      error: String(error.message || error)
    })
  }
})

app.get('/api/embedded-check', requireShopifySessionToken, async (req, res) => {
  return res.json({
    success: true,
    data: {
      ok: true,
      shop: req.shopifySession.shop,
      user: req.shopifySession.payload.sub || null
    }
  })
})

app.get('/api/metrics/:shop_domain', requireShopifySessionToken, async (req, res) => {
  try {
    const { shop_domain } = req.params

    const { data: sessions, error: sessionsError } = await supabase
      .from('experiment_sessions')
      .select('*')
      .eq('shop_domain', shop_domain)

    if (sessionsError) {
      console.log('METRICS SESSION ERROR:', sessionsError)
      return res.status(500).json({ success: false, error: sessionsError })
    }

    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('*')
      .eq('shop_domain', shop_domain)

    if (eventsError) {
      console.log('METRICS EVENTS ERROR:', eventsError)
      return res.status(500).json({ success: false, error: eventsError })
    }

    const safeSessions = sessions || []
    const safeEvents = events || []

    const controlSessions = safeSessions.filter(s => s.variant === 'control').length
    const variantSessions = safeSessions.filter(s => s.variant === 'variant').length

    const controlPurchases = safeEvents.filter(
      e => e.variant === 'control' && e.event_type === 'purchase'
    )

    const variantPurchases = safeEvents.filter(
      e => e.variant === 'variant' && e.event_type === 'purchase'
    )

    const controlRevenue = controlPurchases.reduce(
      (sum, e) => sum + Number(e.value || 0),
      0
    )

    const variantRevenue = variantPurchases.reduce(
      (sum, e) => sum + Number(e.value || 0),
      0
    )

    const conversionRateControl = controlSessions
      ? controlPurchases.length / controlSessions
      : 0

    const conversionRateVariant = variantSessions
      ? variantPurchases.length / variantSessions
      : 0

    const revenuePerSessionControl = controlSessions
      ? controlRevenue / controlSessions
      : 0

    const revenuePerSessionVariant = variantSessions
      ? variantRevenue / variantSessions
      : 0

    const liftPercent = revenuePerSessionControl
      ? ((revenuePerSessionVariant - revenuePerSessionControl) / revenuePerSessionControl) * 100
      : 0

    return res.json({
      success: true,
      data: {
        shop_domain,
        control: {
          sessions: controlSessions,
          purchases: controlPurchases.length,
          revenue: controlRevenue,
          conversion_rate: conversionRateControl,
          revenue_per_session: revenuePerSessionControl
        },
        variant: {
          sessions: variantSessions,
          purchases: variantPurchases.length,
          revenue: variantRevenue,
          conversion_rate: conversionRateVariant,
          revenue_per_session: revenuePerSessionVariant
        },
        lift_percent: liftPercent
      }
    })
  } catch (error) {
    console.log('METRICS ROUTE ERROR:', error)
    return res.status(500).json({
      success: false,
      error: String(error.message || error)
    })
  }
})

app.get('/api/debug/:shop_domain', requireShopifySessionToken, async (req, res) => {
  try {
    const { shop_domain } = req.params

    const { data: sessions, error: sessionsError } = await supabase
      .from('experiment_sessions')
      .select('*')
      .eq('shop_domain', shop_domain)

    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('*')
      .eq('shop_domain', shop_domain)
      .order('created_at', { ascending: false })

    return res.json({
      success: true,
      sessionsError,
      eventsError,
      sessionCount: sessions?.length || 0,
      eventCount: events?.length || 0,
      sessions: sessions || [],
      events: events || []
    })
  } catch (error) {
    console.log('DEBUG ROUTE ERROR:', error)
    return res.status(500).json({
      success: false,
      error: String(error.message || error)
    })
  }
})

app.get('/dashboard', (req, res) => {
  const shopDomain = normalizeShop(req.query.shop) || 'behavior-test-store.myshopify.com'
  const host = typeof req.query.host === 'string' ? req.query.host : ''
  const escapedShop = escapeHtml(shopDomain)
  const escapedApiKey = escapeHtml(SHOPIFY_API_KEY || '')

  res.send(`<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="shopify-api-key" content="${escapedApiKey}" />
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <title>BehavioralPro Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 32px;
      background: #f6f7f8;
      color: #111827;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 {
      font-size: 44px;
      margin: 0 0 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    h2 { font-size: 20px; margin: 0 0 16px; }
    .card {
      background: #ffffff;
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 1px 10px rgba(0, 0, 0, 0.06);
    }
    .muted { color: #6b7280; font-size: 14px; line-height: 1.5; }
    .store-line { font-size: 18px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .stat { background: #f9fafb; border-radius: 12px; padding: 14px; }
    .label { font-size: 13px; color: #6b7280; margin-bottom: 6px; }
    .value { font-size: 28px; font-weight: 700; line-height: 1.1; }
    .value.small { font-size: 20px; }
    .pill {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: #eef2ff;
      color: #3730a3;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 10px;
    }
    .instructions ol { margin: 12px 0 0 18px; padding: 0; line-height: 1.7; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.5;
      background: #0f172a;
      color: #e5e7eb;
      padding: 16px;
      border-radius: 12px;
      overflow: auto;
    }
    .error { color: #b91c1c; font-weight: 600; }
    .ok { color: #047857; font-weight: 600; }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      body { padding: 18px; }
      h1 { font-size: 32px; }
      .stats-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>BehavioralPro Dashboard</h1>

    <div class="card">
      <div class="store-line"><strong>Store:</strong> <span id="shop-domain">${escapedShop}</span></div>
      <div class="muted" style="margin-top: 8px;">
        Revenue lift test dashboard for this Shopify store.
      </div>
      <div class="muted" style="margin-top: 8px;">
        Embedded auth check: <span id="embedded-auth-status">Checking...</span>
      </div>
    </div>

    <div class="card instructions">
      <div class="pill">Setup</div>
      <h2>How to start the test</h2>
      <div class="muted">
        If data is not appearing yet, make sure the app embed is turned on for this store.
      </div>
      <ol>
        <li>Go to <strong>Online Store → Themes → Customize</strong></li>
        <li>Open <strong>App embeds</strong></li>
        <li>Toggle <strong>BehavioralPro</strong> ON</li>
        <li>Save</li>
      </ol>
    </div>

    <div class="grid">
      <div class="card">
        <div class="pill">Control</div>
        <div class="stats-grid">
          <div class="stat"><div class="label">Sessions</div><div class="value" id="control-sessions">—</div></div>
          <div class="stat"><div class="label">Purchases</div><div class="value" id="control-purchases">—</div></div>
          <div class="stat"><div class="label">Revenue</div><div class="value small" id="control-revenue">—</div></div>
          <div class="stat"><div class="label">Conversion Rate</div><div class="value small" id="control-conversion">—</div></div>
          <div class="stat"><div class="label">Revenue / Session</div><div class="value small" id="control-rps">—</div></div>
        </div>
      </div>

      <div class="card">
        <div class="pill">Variant</div>
        <div class="stats-grid">
          <div class="stat"><div class="label">Sessions</div><div class="value" id="variant-sessions">—</div></div>
          <div class="stat"><div class="label">Purchases</div><div class="value" id="variant-purchases">—</div></div>
          <div class="stat"><div class="label">Revenue</div><div class="value small" id="variant-revenue">—</div></div>
          <div class="stat"><div class="label">Conversion Rate</div><div class="value small" id="variant-conversion">—</div></div>
          <div class="stat"><div class="label">Revenue / Session</div><div class="value small" id="variant-rps">—</div></div>
        </div>
      </div>

      <div class="card">
        <div class="pill">Lift</div>
        <div class="stats-grid">
          <div class="stat"><div class="label">Lift %</div><div class="value" id="lift-percent">—</div></div>
          <div class="stat"><div class="label">Current Status</div><div class="value small" id="status-text">Loading...</div></div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Debug JSON</h2>
      <pre id="metrics-json">Loading...</pre>
    </div>
  </div>

  <script>
    const shopDomain = ${JSON.stringify(shopDomain)};
    const host = ${JSON.stringify(host)};

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function setStatus(id, value, className) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = value;
      el.classList.remove('ok', 'error');
      if (className) el.classList.add(className);
    }

    function formatMoney(value) {
      const num = Number(value || 0);
      return '$' + num.toFixed(2);
    }

    function formatPercent(value) {
      const num = Number(value || 0) * 100;
      return num.toFixed(1) + '%';
    }

    async function getSessionTokenOrThrow() {
      if (!window.shopify || typeof window.shopify.idToken !== 'function') {
        throw new Error('App Bridge session token API not available');
      }

      const token = await window.shopify.idToken();

      if (!token) {
        throw new Error('No session token returned');
      }

      return token;
    }

    async function authedFetch(url, options = {}) {
      const token = await getSessionTokenOrThrow();

      const headers = new Headers(options.headers || {});
      headers.set('Authorization', 'Bearer ' + token);

      return fetch(url, {
        ...options,
        headers,
        credentials: 'same-origin'
      });
    }

    async function verifyEmbeddedAuth() {
      try {
        const response = await authedFetch(
          '/api/embedded-check?shop=' + encodeURIComponent(shopDomain),
          { method: 'GET' }
        );

        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(json.error || 'Embedded auth check failed');
        }

        setStatus('embedded-auth-status', 'Session token accepted', 'ok');
      } catch (error) {
        console.error('Embedded auth check error:', error);
        setStatus(
          'embedded-auth-status',
          'Failed: ' + String(error.message || error),
          'error'
        );
      }
    }

    async function loadMetrics() {
      try {
        const response = await authedFetch(
          '/api/metrics/' +
            encodeURIComponent(shopDomain) +
            '?shop=' +
            encodeURIComponent(shopDomain),
          { method: 'GET' }
        );

        const json = await response.json();

        if (!response.ok || !json.success || !json.data) {
          throw new Error(json.error || 'Metrics response missing data');
        }

        const data = json.data;
        const control = data.control || {};
        const variant = data.variant || {};

        setText('control-sessions', String(control.sessions ?? 0));
        setText('control-purchases', String(control.purchases ?? 0));
        setText('control-revenue', formatMoney(control.revenue));
        setText('control-conversion', formatPercent(control.conversion_rate));
        setText('control-rps', formatMoney(control.revenue_per_session));

        setText('variant-sessions', String(variant.sessions ?? 0));
        setText('variant-purchases', String(variant.purchases ?? 0));
        setText('variant-revenue', formatMoney(variant.revenue));
        setText('variant-conversion', formatPercent(variant.conversion_rate));
        setText('variant-rps', formatMoney(variant.revenue_per_session));

        const lift = Number(data.lift_percent ?? 0);
        setText('lift-percent', lift.toFixed(1) + '%');

        const totalSessions = Number(control.sessions || 0) + Number(variant.sessions || 0);
        const totalPurchases = Number(control.purchases || 0) + Number(variant.purchases || 0);

        let status = 'Running';
        if (totalSessions === 0) status = 'Waiting for traffic';
        else if (totalPurchases === 0) status = 'Collecting data';

        setText('status-text', status);
        setText('metrics-json', JSON.stringify(json, null, 2));
      } catch (error) {
        console.error('Metrics error:', error);
        setStatus('status-text', 'Error', 'error');

        const metricsJson = document.getElementById('metrics-json');
        if (metricsJson) {
          metricsJson.textContent =
            'Error loading dashboard data:\\n\\n' +
            String(error.message || error);
        }
      }
    }

    async function boot() {
      try {
        await verifyEmbeddedAuth();
        await loadMetrics();
      } catch (error) {
        console.error('Boot error:', error);
      }
    }

    boot();
  </script>
</body>
</html>`)
})

app.get('/app', (req, res) => {
  const shop = normalizeShop(req.query.shop)
  const host = typeof req.query.host === 'string' ? req.query.host : ''

  if (!shop) {
    return res.send('Missing shop parameter')
  }

  const qs = new URLSearchParams()
  qs.set('shop', shop)
  if (host) qs.set('host', host)

  return res.redirect('/dashboard?' + qs.toString())
})

app.get('/', (req, res) => {
  const shop = normalizeShop(req.query.shop)
  const host = typeof req.query.host === 'string' ? req.query.host : ''

  if (!shop) {
    return res.send('BehavioralPro backend is running.')
  }

  const qs = new URLSearchParams()
  qs.set('shop', shop)
  if (host) qs.set('host', host)

  return res.redirect('/dashboard?' + qs.toString())
})

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT)
})
