app.postimport 'dotenv/config'
import express from 'express'
import { createClient } from '@supabase/supabase-js'
import cors from 'cors'

const app = express()

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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

app.post('/api/stores', async (req, res) => {
  const { shop_domain, access_token = null, scope = null } = req.body

  if (!shop_domain) {
    return res.status(400).json({ success: false, error: 'shop_domain is required' })
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
    return res.status(500).json({ success: false, error })
  }

  res.json({ success: true, data })
})

app.post('/api/events', async (req, res) => {
  console.log('EVENT RECEIVED:', JSON.stringify(req.body, null, 2))

  const { shop_domain, session_id, event_type, value = 0 } = req.body

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
    value,
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
  res.json({ success: true, data })
})

app.post('/api/assign-variant', async (req, res) => {
  const { shop_domain, session_id } = req.body

  if (!shop_domain || !session_id) {
    return res.status(400).json({ success: false, error: 'missing fields' })
  }

  const { data: existing, error: existingError } = await supabase
    .from('experiment_sessions')
    .select('*')
    .eq('shop_domain', shop_domain)
    .eq('session_id', session_id)
    .maybeSingle()

  if (existingError) {
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
    return res.status(500).json({ success: false, error })
  }

  res.json({ success: true, data })
})
app.get('/api/metrics/:shop_domain', async (req, res) => {
  const { shop_domain } = req.params

  const { data: sessions, error: sessionsError } = await supabase
    .from('experiment_sessions')
    .select('*')
    .eq('shop_domain', shop_domain)

  if (sessionsError) {
    return res.status(500).json({ success: false, error: sessionsError })
  }

  const { data: events, error: eventsError } = await supabase
    .from('events')
    .select('*')
    .eq('shop_domain', shop_domain)

  if (eventsError) {
    return res.status(500).json({ success: false, error: eventsError })
  }

  const controlSessions = sessions.filter(s => s.variant === 'control').length
  const variantSessions = sessions.filter(s => s.variant === 'variant').length

  const controlPurchases = events.filter(e => e.variant === 'control' && e.event_type === 'purchase')
  const variantPurchases = events.filter(e => e.variant === 'variant' && e.event_type === 'purchase')

  const controlRevenue = controlPurchases.reduce((sum, e) => sum + Number(e.value || 0), 0)
  const variantRevenue = variantPurchases.reduce((sum, e) => sum + Number(e.value || 0), 0)

  const conversionRateControl = controlSessions ? controlPurchases.length / controlSessions : 0
  const conversionRateVariant = variantSessions ? variantPurchases.length / variantSessions : 0

  const revenuePerSessionControl = controlSessions ? controlRevenue / controlSessions : 0
  const revenuePerSessionVariant = variantSessions ? variantRevenue / variantSessions : 0

  const liftPercent = revenuePerSessionControl
    ? ((revenuePerSessionVariant - revenuePerSessionControl) / revenuePerSessionControl) * 100
    : 0

  res.json({
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
})
app.get("/dashboard", (req, res) => {
  const shopDomain = req.query.shop || "behavior-test-store.myshopify.com";

  res.send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>BehavioralPro Dashboard</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 24px;
            background: #f7f7f8;
            color: #111;
          }
          h1 {
            margin-top: 0;
          }
          .card {
            background: white;
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 16px;
            box-shadow: 0 1px 6px rgba(0,0,0,0.08);
          }
          .muted {
            color: #666;
            font-size: 14px;
          }
          pre {
            white-space: pre-wrap;
            word-break: break-word;
            background: #111;
            color: #eee;
            padding: 16px;
            border-radius: 8px;
            overflow: auto;
          }
        </style>
      </head>
      <body>
        <h1>BehavioralPro Dashboard</h1>
        <div class="card">
          <div><strong>Store:</strong> <span id="shop">${shopDomain}</span></div>
          <div class="muted">Reading metrics from /api/metrics/${shopDomain}</div>
        </div>

        <div class="card">
          <h2>Metrics JSON</h2>
          <pre id="output">Loading...</pre>
        </div>

        <script>
          const shopDomain = ${JSON.stringify(shopDomain)};

          fetch("/api/metrics/" + encodeURIComponent(shopDomain))
            .then(async (res) => {
              const text = await res.text();
              try {
                return JSON.parse(text);
              } catch (e) {
                throw new Error("Non-JSON response: " + text);
              }
            })
            .then((data) => {
              document.getElementById("output").textContent =
                JSON.stringify(data, null, 2);
            })
            .catch((err) => {
              document.getElementById("output").textContent =
                "Error loading dashboard data:\\n\\n" + String(err);
            });
        </script>
      </body>
    </html>
  `);
});
app.get('/api/debug/:shop_domain', async (req, res) => {
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

  res.json({
    success: true,
    sessionsError,
    eventsError,
    sessionCount: sessions?.length || 0,
    eventCount: events?.length || 0,
    sessions,
    events
  })
})
app.listen(3001, () => {
  console.log('Server running on port 3001')
})
