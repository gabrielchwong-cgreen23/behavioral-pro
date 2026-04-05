import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3001;

const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
};

// ---------- BASIC MIDDLEWARE ----------
app.use(cors(corsOptions));

// Use JSON parser for normal API routes only.
// Do NOT rely on this for Shopify webhooks.
app.use('/api', express.json());

app.use((req, res, next) => {
  console.log('INCOMING:', req.method, req.url);
  next();
});

// ---------- ENV CHECK ----------
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  APP_URL,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

if (!SHOPIFY_API_SECRET) {
  console.warn('Missing SHOPIFY_API_SECRET. Webhook HMAC verification will fail.');
}

// ---------- SUPABASE ----------
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// ---------- HELPERS ----------
function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string') {
    return Buffer.from(req.body, 'utf8');
  }
  return Buffer.from('', 'utf8');
}

function verifyShopifyWebhook(req) {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    if (!hmacHeader || !SHOPIFY_API_SECRET) return false;

    const rawBody = getRawBody(req);

    const digest = crypto
      .createHmac('sha256', SHOPIFY_API_SECRET)
      .update(rawBody)
      .digest('base64');

    return crypto.timingSafeEqual(
      Buffer.from(digest, 'utf8'),
      Buffer.from(hmacHeader, 'utf8')
    );
  } catch (error) {
    console.error('Webhook verification error:', error);
    return false;
  }
}

function shopifyWebhookHandler(topic, processor) {
  return async (req, res) => {
    try {
      const isValid = verifyShopifyWebhook(req);

      if (!isValid) {
        console.log(`Invalid webhook signature for ${topic}`);
        return res.status(401).send('Invalid webhook signature');
      }

      let payload = {};
      try {
        payload = JSON.parse(getRawBody(req).toString('utf8') || '{}');
      } catch (parseError) {
        console.log(`Failed to parse ${topic} webhook body:`, parseError);
        return res.status(400).send('Invalid JSON');
      }

      console.log(`${topic} webhook received:`, payload);

      await processor(payload, req);

      return res.status(200).send('ok');
    } catch (error) {
      console.error(`${topic} webhook error:`, error);
      return res.status(500).send('server error');
    }
  };
}

function normalizeShopDomain(shop) {
  if (!shop) return '';
  return shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
}

function verifyShopifyOAuthCallback(query) {
  try {
    const hmac = query.hmac;

    if (!hmac || !SHOPIFY_API_SECRET) {
      return false;
    }

    const message = Object.keys(query)
      .filter((key) => key !== 'hmac' && key !== 'signature')
      .sort()
      .map((key) => `${key}=${Array.isArray(query[key]) ? query[key].join(',') : query[key]}`)
      .join('&');

    const digest = crypto
      .createHmac('sha256', SHOPIFY_API_SECRET)
      .update(message, 'utf8')
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(digest, 'utf8'),
      Buffer.from(String(hmac), 'utf8')
    );
  } catch (error) {
    console.error('OAuth callback verification error:', error);
    return false;
  }
}

async function exchangeShopifyAccessToken({ shop, code }) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    }),
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || 'Failed to exchange OAuth code');
  }

  return {
    accessToken: json.access_token,
    scope: json.scope || null,
  };
}

function getAppBaseUrl(req) {
  return (APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function calculateMetrics(sessions = [], events = []) {
  const controlSessions = sessions.filter((s) => s.variant === 'control').length;
  const variantSessions = sessions.filter((s) => s.variant === 'variant').length;

  const controlPurchases = events.filter(
    (e) => e.variant === 'control' && e.event_type === 'purchase'
  );

  const variantPurchases = events.filter(
    (e) => e.variant === 'variant' && e.event_type === 'purchase'
  );

  const controlRevenue = controlPurchases.reduce(
    (sum, e) => sum + Number(e.value || 0),
    0
  );

  const variantRevenue = variantPurchases.reduce(
    (sum, e) => sum + Number(e.value || 0),
    0
  );

  const conversionRateControl = controlSessions
    ? controlPurchases.length / controlSessions
    : 0;

  const conversionRateVariant = variantSessions
    ? variantPurchases.length / variantSessions
    : 0;

  const revenuePerSessionControl = controlSessions
    ? controlRevenue / controlSessions
    : 0;

  const revenuePerSessionVariant = variantSessions
    ? variantRevenue / variantSessions
    : 0;

  const liftPercent = revenuePerSessionControl
    ? ((revenuePerSessionVariant - revenuePerSessionControl) / revenuePerSessionControl) * 100
    : 0;

  return {
    control: {
      sessions: controlSessions,
      purchases: controlPurchases.length,
      revenue: controlRevenue,
      conversion_rate: conversionRateControl,
      revenue_per_session: revenuePerSessionControl,
    },
    variant: {
      sessions: variantSessions,
      purchases: variantPurchases.length,
      revenue: variantRevenue,
      conversion_rate: conversionRateVariant,
      revenue_per_session: revenuePerSessionVariant,
    },
    lift_percent: liftPercent,
  };
}

// ---------- OPTIONS ----------
app.options('/api/events', cors(corsOptions));
app.options('/api/assign-variant', cors(corsOptions));
app.options('/api/stores', cors(corsOptions));
app.options('/api/metrics/:shop_domain', cors(corsOptions));
app.options('/api/debug/:shop_domain', cors(corsOptions));

// ---------- SHOPIFY MANDATORY COMPLIANCE WEBHOOKS ----------
// IMPORTANT: use express.raw so HMAC is computed against the exact raw payload.
app.post(
  '/webhooks/customers-data-request',
  express.raw({ type: '*/*' }),
  shopifyWebhookHandler('customers/data_request', async (payload) => {
    // Optional: log/store request for compliance workflow
    console.log('Processed customers/data_request for shop:', payload.shop_domain || payload.shop_id || 'unknown');
  })
);

app.post(
  '/webhooks/customers-redact',
  express.raw({ type: '*/*' }),
  shopifyWebhookHandler('customers/redact', async (payload) => {
    // Optional: perform customer-level redaction in your own DB if needed
    console.log('Processed customers/redact for shop:', payload.shop_domain || payload.shop_id || 'unknown');
  })
);

app.post(
  '/webhooks/shop-redact',
  express.raw({ type: '*/*' }),
  shopifyWebhookHandler('shop/redact', async (payload) => {
    // Optional: remove shop data from your DB if required
    console.log('Processed shop/redact for shop:', payload.shop_domain || payload.shop_id || 'unknown');

    const possibleShopDomain =
      payload.shop_domain ||
      payload.myshopify_domain ||
      payload.domain ||
      null;

    if (possibleShopDomain) {
      // Example cleanup — keep or remove depending on your data retention model.
      // Uncomment if you want to actually delete records when shop/redact arrives.

      /*
      await supabase.from('events').delete().eq('shop_domain', possibleShopDomain);
      await supabase.from('experiment_sessions').delete().eq('shop_domain', possibleShopDomain);
      await supabase.from('stores').delete().eq('shop_domain', possibleShopDomain);
      */
    }
  })
);

// ---------- API ROUTES ----------
app.get('/api/shopify/callback', async (req, res) => {
  try {
    const { shop, code } = req.query || {};
    const normalizedShop = normalizeShopDomain(shop);

    if (!normalizedShop || !code) {
      return res.status(400).send('Missing Shopify callback parameters');
    }

    if (!verifyShopifyOAuthCallback(req.query || {})) {
      return res.status(401).send('Invalid Shopify callback signature');
    }

    const { accessToken, scope } = await exchangeShopifyAccessToken({
      shop: normalizedShop,
      code: String(code),
    });

    const row = {
      shop_domain: normalizedShop,
      access_token: accessToken,
      scope,
      installed_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('stores')
      .upsert([row], { onConflict: 'shop_domain' });

    if (error) {
      console.log('SHOPIFY CALLBACK STORE UPSERT ERROR:', error);
      return res.status(500).send('Failed to persist shop install');
    }

    return res.redirect(`/app?shop=${encodeURIComponent(normalizedShop)}`);
  } catch (error) {
    console.log('SHOPIFY CALLBACK ERROR:', error);
    return res.status(500).send(String(error.message || error));
  }
});

app.post('/api/stores', async (req, res) => {
  try {
    const { shop_domain, access_token = null, scope = null } = req.body || {};

    if (!shop_domain) {
      return res.status(400).json({
        success: false,
        error: 'shop_domain is required',
      });
    }

    const row = {
      shop_domain: normalizeShopDomain(shop_domain),
      access_token,
      scope,
      installed_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('stores')
      .upsert([row], { onConflict: 'shop_domain' })
      .select();

    if (error) {
      console.log('STORE UPSERT ERROR:', error);
      return res.status(500).json({ success: false, error });
    }

    return res.json({ success: true, data });
  } catch (error) {
    console.log('STORE ROUTE ERROR:', error);
    return res.status(500).json({
      success: false,
      error: String(error.message || error),
    });
  }
});

app.post('/api/assign-variant', async (req, res) => {
  try {
    const { shop_domain, session_id } = req.body || {};

    if (!shop_domain || !session_id) {
      return res.status(400).json({
        success: false,
        error: 'missing fields',
      });
    }

    const normalizedShop = normalizeShopDomain(shop_domain);

    const { data: existing, error: existingError } = await supabase
      .from('experiment_sessions')
      .select('*')
      .eq('shop_domain', normalizedShop)
      .eq('session_id', session_id)
      .maybeSingle();

    if (existingError) {
      console.log('ASSIGN LOOKUP ERROR:', existingError);
      return res.status(500).json({ success: false, error: existingError });
    }

    if (existing) {
      return res.json({ success: true, data: existing });
    }

    const variant = Math.random() < 0.5 ? 'control' : 'variant';

    const { data, error } = await supabase
      .from('experiment_sessions')
      .insert([
        {
          shop_domain: normalizedShop,
          session_id,
          variant,
          created_at: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (error) {
      console.log('ASSIGN INSERT ERROR:', error);
      return res.status(500).json({ success: false, error });
    }

    return res.json({ success: true, data });
  } catch (error) {
    console.log('ASSIGN ROUTE ERROR:', error);
    return res.status(500).json({
      success: false,
      error: String(error.message || error),
    });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    console.log('EVENT RECEIVED:', JSON.stringify(req.body, null, 2));

    const {
      shop_domain,
      session_id,
      event_type,
      value = 0,
    } = req.body || {};

    if (!shop_domain || !session_id || !event_type) {
      console.log('EVENT REJECTED: missing fields');
      return res.status(400).json({
        success: false,
        error: 'missing fields',
        received: req.body,
      });
    }

    const normalizedShop = normalizeShopDomain(shop_domain);

    const { data: session, error: sessionError } = await supabase
      .from('experiment_sessions')
      .select('*')
      .eq('shop_domain', normalizedShop)
      .eq('session_id', session_id)
      .maybeSingle();

    if (sessionError) {
      console.log('SESSION LOOKUP ERROR:', sessionError);
      return res.status(500).json({ success: false, error: sessionError });
    }

    if (!session) {
      console.log('EVENT REJECTED: session not assigned');
      return res.status(400).json({
        success: false,
        error: 'session not assigned',
        shop_domain: normalizedShop,
        session_id,
      });
    }

    const insertRow = {
      shop_domain: normalizedShop,
      session_id,
      variant: session.variant,
      event_type,
      value: Number(value || 0),
      created_at: new Date().toISOString(),
    };

    console.log('EVENT INSERT ROW:', JSON.stringify(insertRow, null, 2));

    const { data, error } = await supabase
      .from('events')
      .insert([insertRow])
      .select();

    if (error) {
      console.log('EVENT INSERT ERROR:', error);
      return res.status(500).json({ success: false, error });
    }

    console.log('EVENT INSERTED OK:', JSON.stringify(data, null, 2));
    return res.json({ success: true, data });
  } catch (error) {
    console.log('EVENT ROUTE ERROR:', error);
    return res.status(500).json({
      success: false,
      error: String(error.message || error),
    });
  }
});

app.get('/api/metrics/:shop_domain', async (req, res) => {
  try {
    const shop_domain = normalizeShopDomain(req.params.shop_domain);

    const { data: sessions, error: sessionsError } = await supabase
      .from('experiment_sessions')
      .select('*')
      .eq('shop_domain', shop_domain);

    if (sessionsError) {
      console.log('METRICS SESSION ERROR:', sessionsError);
      return res.status(500).json({ success: false, error: sessionsError });
    }

    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('*')
      .eq('shop_domain', shop_domain);

    if (eventsError) {
      console.log('METRICS EVENTS ERROR:', eventsError);
      return res.status(500).json({ success: false, error: eventsError });
    }

    const metrics = calculateMetrics(sessions || [], events || []);

    return res.json({
      success: true,
      data: {
        shop_domain,
        ...metrics,
      },
    });
  } catch (error) {
    console.log('METRICS ROUTE ERROR:', error);
    return res.status(500).json({
      success: false,
      error: String(error.message || error),
    });
  }
});

app.get('/', (req, res) => {
  const shop = req.query.shop;

  if (shop) {
    return res.redirect(`/app?shop=${encodeURIComponent(shop)}`);
  }

  return res.redirect('/dashboard');
});


app.get('/api/debug/:shop_domain', async (req, res) => {
  try {
    const shop_domain = normalizeShopDomain(req.params.shop_domain);

    const { data: sessions, error: sessionsError } = await supabase
      .from('experiment_sessions')
      .select('*')
      .eq('shop_domain', shop_domain);

    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('*')
      .eq('shop_domain', shop_domain)
      .order('created_at', { ascending: false
 });

    return res.json({
      success: true,
      sessionsError,
      eventsError,
      sessionCount: sessions?.length || 0,
      eventCount: events?.length || 0,
      sessions: sessions || [],
      events: events || [],
    });
  } catch (error) {
    console.log('DEBUG ROUTE ERROR:', error);
    console.log('BOOT: running V3 build with raw webhook handler');
    return res.status(500).json({
      success: false,
      error: String(error.message || error),
    });
  }
});

// ---------- DASHBOARD ----------
app.get('/dashboard', (req, res) => {
  const shopParam = req.query.shop;
  const shopDomain = shopParam
    ? normalizeShopDomain(shopParam)
    : 'behavior-test-store.myshopify.com';

  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
    .container {
      max-width: 1100px;
      margin: 0 auto;
    }
    h1 {
      font-size: 40px;
      margin: 0 0 12px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    h2 {
      font-size: 20px;
      margin: 0 0 16px;
    }
    .subheadline {
      font-size: 16px;
      color: #4b5563;
      line-height: 1.6;
      margin-bottom: 24px;
      max-width: 760px;
    }
    .card {
      background: #ffffff;
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 1px 10px rgba(0, 0, 0, 0.06);
    }
    .muted {
      color: #6b7280;
      font-size: 14px;
      line-height: 1.6;
    }
    .store-line {
      font-size: 18px;
      margin-bottom: 6px;
    }
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
    .stat {
      background: #f9fafb;
      border-radius: 12px;
      padding: 14px;
    }
    .label {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 6px;
    }
    .value {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.1;
    }
    .value.small {
      font-size: 20px;
    }
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
    .instructions ol {
      margin: 12px 0 0 18px;
      padding: 0;
      line-height: 1.8;
    }
    .notice {
      border: 1px solid #dbeafe;
      background: #eff6ff;
      color: #1e3a8a;
      border-radius: 12px;
      padding: 14px 16px;
      margin-top: 14px;
      font-size: 14px;
      line-height: 1.6;
    }
    .success { color: #166534; }
    .warning { color: #92400e; }
    .error {
      color: #b91c1c;
      font-weight: 600;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      background: #111827;
      color: white;
    }
    button:hover { opacity: 0.92; }
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
    .hidden { display: none; }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      body { padding: 18px; }
      h1 { font-size: 30px; }
      .stats-grid { grid-template-columns: 1fr; }
      .toggle-row {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>BehavioralPro Dashboard</h1>
    <div class="subheadline">
      BehavioralPro tracks visitor hesitation and intent signals, triggers contextual responses,
      and measures revenue lift through a built-in control vs. variant test.
    </div>

    <div class="card">
      <div class="store-line"><strong>Store:</strong> <span id="shop-domain"></span></div>
      <div class="muted">
        This dashboard shows experiment performance for the currently selected Shopify store.
      </div>
      <div class="notice" id="top-notice">
        Loading dashboard data...
      </div>
    </div>

    <div class="card instructions">
      <div class="pill">Setup</div>
      <h2>How to start tracking</h2>
      <div class="muted">
        If this is your first time opening the app, turn on the app embed so BehavioralPro can begin
        tracking storefront activity.
      </div>
      <ol>
        <li>Go to <strong>Online Store → Themes → Customize</strong></li>
        <li>Open <strong>App embeds</strong></li>
        <li>Toggle <strong>BehavioralPro</strong> ON</li>
        <li>Save</li>
        <li>Open your storefront in another tab to generate activity</li>
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
          <div class="stat"><div class="label">Total Sessions</div><div class="value small" id="total-sessions">—</div></div>
          <div class="stat"><div class="label">Total Purchases</div><div class="value small" id="total-purchases">—</div></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="toggle-row">
        <div>
          <h2 style="margin-bottom: 4px;">Raw Data (Advanced)</h2>
          <div class="muted">Optional debugging output for advanced review.</div>
        </div>
        <button id="toggle-raw-data" type="button">Show Raw Data</button>
      </div>
      <div id="raw-data-wrap" class="hidden">
        <pre id="metrics-json">Loading...</pre>
      </div>
    </div>
  </div>

<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>

<script>
  const shopDomain = ${JSON.stringify(shopDomain)};
  const apiKey = "${process.env.SHOPIFY_API_KEY}";

  // ---------- APP BRIDGE INIT ----------
  const app = window.shopify.createApp({
    apiKey: apiKey,
    host: new URLSearchParams(window.location.search).get("host"),
  });

  // ---------- GET SESSION TOKEN ----------
  async function getSessionToken() {
    try {
      return await window.shopify.idToken();
    } catch (e) {
      console.error("Failed to get session token:", e);
      throw e;
    }
  }

  // ---------- AUTHENTICATED FETCH ----------
  async function authFetch(url, options = {}) {
    const token = await getSessionToken();

    const headers = {
      ...(options.headers || {}),
      Authorization: 'Bearer ' + token,
      "Content-Type": "application/json",
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }

  // ---------- FORMATTERS ----------
  function formatMoney(value) {
    return "$" + Number(value || 0).toFixed(2);
  }

  function formatPercentFromDecimal(value) {
    return (Number(value || 0) * 100).toFixed(1) + "%";
  }

  function formatLiftPercent(value) {
    return Number(value || 0).toFixed(1) + "%";
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setNotice(html) {
    const el = document.getElementById("top-notice");
    if (el) el.innerHTML = html;
  }

  function getStatusText(totalSessions, totalPurchases) {
    if (totalSessions === 0) return "Waiting for traffic";
    if (totalPurchases === 0) return "Collecting data";
    return "Running";
  }

  function getNoticeText(totalSessions, totalPurchases) {
    if (totalSessions === 0) {
      return "No data yet — turn on the app embed and generate activity.";
    }
    if (totalPurchases === 0) {
      return "Tracking is live but no purchases yet.";
    }
    return "Tracking is live and working.";
  }

  // ---------- LOAD METRICS ----------
  async function loadMetrics() {
    try {
      const response = await authFetch(
        '/api/metrics/' + encodeURIComponent(shopDomain)
      );

      const json = await response.json();

      if (!json.success || !json.data) {
        throw new Error("Invalid metrics response");
      }

      const data = json.data;
      const control = data.control || {};
      const variant = data.variant || {};

      const controlSessions = Number(control.sessions || 0);
      const controlPurchases = Number(control.purchases || 0);
      const variantSessions = Number(variant.sessions || 0);
      const variantPurchases = Number(variant.purchases || 0);

      const totalSessions = controlSessions + variantSessions;
      const totalPurchases = controlPurchases + variantPurchases;

      setText("shop-domain", shopDomain);

      setText("control-sessions", controlSessions);
      setText("control-purchases", controlPurchases);
      setText("control-revenue", formatMoney(control.revenue));
      setText("control-conversion", 
formatPercentFromDecimal(control.conversion_rate));
      setText("control-rps", formatMoney(control.revenue_per_session));

      setText("variant-sessions", variantSessions);
      setText("variant-purchases", variantPurchases);
      setText("variant-revenue", formatMoney(variant.revenue));
      setText("variant-conversion", 
formatPercentFromDecimal(variant.conversion_rate));
      setText("variant-rps", formatMoney(variant.revenue_per_session));

      setText("lift-percent", formatLiftPercent(data.lift_percent));
      setText("status-text", getStatusText(totalSessions, 
totalPurchases));
      setText("total-sessions", totalSessions);
      setText("total-purchases", totalPurchases);

      if (totalSessions === 0) {
        setNotice('<span class="warning">' + getNoticeText(totalSessions, 
totalPurchases) + '</span>');
      } else {
        setNotice('<span class="success">' + getNoticeText(totalSessions, 
totalPurchases) + '</span>');
      }

      setText("metrics-json", JSON.stringify(json, null, 2));

    } catch (err) {
      console.error(err);
      setNotice('<span class="error">Failed to load data</span>');
    }
  }

  // ---------- START ----------
  loadMetrics();
</script>
</body>
</html>
  `);
});

// ---------- BASIC ROUTES ----------
app.get('/', (_req, res) => {
  res.send('BehavioralPro backend is running.');
});

app.get('/app', (req, res) => {
  const shop = req.query.shop;

  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  const shopDomain = normalizeShopDomain(shop);
  return res.redirect(`/dashboard?shop=${encodeURIComponent(shopDomain)}`);
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
