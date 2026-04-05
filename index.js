import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'

const app = express()
const PORT = process.env.PORT || 3001

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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

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

app.get('/api/metrics/:shop_domain', async (req, res) => {
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

app.get('/api/debug/:shop_domain', async (req, res) => {
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
  const shopDomain = req.query.shop || 'behavior-test-store.myshopify.com'

  const html =
    '<!doctype html>' +
    '<html>' +
    '<head>' +
    '<meta charset="UTF-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
    '<title>BehavioralPro Dashboard</title>' +
    '<style>' +
    '*{box-sizing:border-box;}' +
    'body{font-family:Arial,sans-serif;margin:0;padding:32px;background:#f6f7f8;color:#111827;}' +
    '.container{max-width:1100px;margin:0 auto;}' +
    'h1{font-size:44px;margin:0 0 24px;font-weight:700;letter-spacing:-0.02em;}' +
    'h2{font-size:20px;margin:0 0 16px;}' +
    '.card{background:#ffffff;border-radius:16px;padding:20px;margin-bottom:20px;box-shadow:0 1px 10px rgba(0,0,0,0.06);}' +
    '.muted{color:#6b7280;font-size:14px;line-height:1.5;}' +
    '.store-line{font-size:18px;}' +
    '.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-bottom:20px;}' +
    '.stats-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;}' +
    '.stat{background:#f9fafb;border-radius:12px;padding:14px;}' +
    '.label{font-size:13px;color:#6b7280;margin-bottom:6px;}' +
    '.value{font-size:28px;font-weight:700;line-height:1.1;}' +
    '.value.small{font-size:20px;}' +
    '.pill{display:inline-block;padding:6px 10px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:12px;font-weight:600;margin-bottom:10px;}' +
    '.instructions ol{margin:12px 0 0 18px;padding:0;line-height:1.7;}' +
    'pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.5;background:#0f172a;color:#e5e7eb;padding:16px;border-radius:12px;overflow:auto;}' +
    '.error{color:#b91c1c;font-weight:600;}' +
    '@media (max-width:900px){.grid{grid-template-columns:1fr;}}' +
    '@media (max-width:640px){body{padding:18px;}h1{font-size:32px;}.stats-grid{grid-template-columns:1fr;}}' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<div class="container">' +
    '<h1>BehavioralPro Dashboard</h1>' +
    '<div class="card">' +
    '<div class="store-line"><strong>Store:</strong> <span id="shop-domain"></span></div>' +
    '<div class="muted" style="margin-top: 8px;">Revenue lift test dashboard for this Shopify store.</div>' +
    '</div>' +
    '<div class="card instructions">' +
    '<div class="pill">Setup</div>' +
    '<h2>How to start the test</h2>' +
    '<div class="muted">If data is not appearing yet, make sure the app embed is turned on for this store.</div>' +
    '<ol>' +
    '<li>Go to <strong>Online Store → Themes → Customize</strong></li>' +
    '<li>Open <strong>App embeds</strong></li>' +
    '<li>Toggle <strong>BehavioralPro</strong> ON</li>' +
    '<li>Save</li>' +
    '</ol>' +
    '</div>' +
    '<div class="grid">' +
    '<div class="card">' +
    '<div class="pill">Control</div>' +
    '<div class="stats-grid">' +
    '<div class="stat"><div class="label">Sessions</div><div class="value" id="control-sessions">—</div></div>' +
    '<div class="stat"><div class="label">Purchases</div><div class="value" id="control-purchases">—</div></div>' +
    '<div class="stat"><div class="label">Revenue</div><div class="value small" id="control-revenue">—</div></div>' +
    '<div class="stat"><div class="label">Conversion Rate</div><div class="value small" id="control-conversion">—</div></div>' +
    '<div class="stat"><div class="label">Revenue / Session</div><div class="value small" id="control-rps">—</div></div>' +
    '</div>' +
    '</div>' +
    '<div class="card">' +
    '<div class="pill">Variant</div>' +
    '<div class="stats-grid">' +
    '<div class="stat"><div class="label">Sessions</div><div class="value" id="variant-sessions">—</div></div>' +
    '<div class="stat"><div class="label">Purchases</div><div class="value" id="variant-purchases">—</div></div>' +
    '<div class="stat"><div class="label">Revenue</div><div class="value small" id="variant-revenue">—</div></div>' +
    '<div class="stat"><div class="label">Conversion Rate</div><div class="value small" id="variant-conversion">—</div></div>' +
    '<div class="stat"><div class="label">Revenue / Session</div><div class="value small" id="variant-rps">—</div></div>' +
    '</div>' +
    '</div>' +
    '<div class="card">' +
    '<div class="pill">Lift</div>' +
    '<div class="stats-grid">' +
    '<div class="stat"><div class="label">Lift %</div><div class="value" id="lift-percent">—</div></div>' +
    '<div class="stat"><div class="label">Current Status</div><div class="value small" id="status-text">Loading...</div></div>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="card">' +
    '<h2>Debug JSON</h2>' +
    '<pre id="metrics-json">Loading...</pre>' +
    '</div>' +
    '</div>' +
    '<script>' +
    'const shopDomain = ' + JSON.stringify(shopDomain) + ';' +
    'function formatMoney(value){const num=Number(value||0);return "$"+num.toFixed(2);}' +
    'function formatPercent(value){const num=Number(value||0)*100;return num.toFixed(1)+"%";}' +
    'function setText(id,value){const el=document.getElementById(id);if(el) el.textContent=value;}' +
    'async function loadMetrics(){' +
      'try{' +
        'const response=await fetch("/api/metrics/"+encodeURIComponent(shopDomain));' +
        'const json=await response.json();' +
        'if(!json.success||!json.data){throw new Error("Metrics response missing data");}' +
        'const data=json.data;' +
        'const control=data.control||{};' +
        'const variant=data.variant||{};' +
        'setText("shop-domain",shopDomain);' +
        'setText("control-sessions",String(control.sessions ?? 0));' +
        'setText("control-purchases",String(control.purchases ?? 0));' +
        'setText("control-revenue",formatMoney(control.revenue));' +
        'setText("control-conversion",formatPercent(control.conversion_rate));' +
        'setText("control-rps",formatMoney(control.revenue_per_session));' +
        'setText("variant-sessions",String(variant.sessions ?? 0));' +
        'setText("variant-purchases",String(variant.purchases ?? 0));' +
        'setText("variant-revenue",formatMoney(variant.revenue));' +
        'setText("variant-conversion",formatPercent(variant.conversion_rate));' +
        'setText("variant-rps",formatMoney(variant.revenue_per_session));' +
        'const lift=Number(data.lift_percent ?? 0);' +
        'setText("lift-percent",lift.toFixed(1)+"%");' +
        'const totalSessions=Number(control.sessions||0)+Number(variant.sessions||0);' +
        'const totalPurchases=Number(control.purchases||0)+Number(variant.purchases||0);' +
        'let status="Running";' +
        'if(totalSessions===0) status="Waiting for traffic";' +
        'else if(totalPurchases===0) status="Collecting data";' +
        'setText("status-text",status);' +
        'setText("metrics-json",JSON.stringify(json,null,2));' +
      '}catch(err){' +
        'setText("shop-domain",shopDomain);' +
        'const metricsJson=document.getElementById("metrics-json");' +
        'if(metricsJson){metricsJson.textContent="Error loading dashboard data:\\n\\n"+String(err);}' +
        'const status=document.getElementById("status-text");' +
        'if(status){status.textContent="Error";status.classList.add("error");}' +
        'console.error(err);' +
      '}' +
    '}' +
    'loadMetrics();' +
    '</script>' +
    '</body>' +
    '</html>'

  return res.send(html)
})

app.get('/', (req, res) => {
  return res.send('BehavioralPro backend is running.')
})

app.get('/app', (req, res) => {
  const shop = req.query.shop

  if (!shop) {
    return res.send('Missing shop parameter')
  }

  const shopDomain = shop.includes('.myshopify.com')
    ? shop
    : shop + '.myshopify.com'

  return res.redirect('/dashboard?shop=' + encodeURIComponent(shopDomain))
})

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT)
})
