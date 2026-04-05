import 'dotenv/config';
import crypto from 'crypto';
import cors from 'cors';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = Number(process.env.PORT || 3001);

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
} = process.env;

const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
};

const hasSupabaseConfig = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const supabase = hasSupabaseConfig
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!hasSupabaseConfig) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

if (!SHOPIFY_API_KEY) {
  console.warn('Missing SHOPIFY_API_KEY. Embedded app auth will fail.');
}

if (!SHOPIFY_API_SECRET) {
  console.warn('Missing SHOPIFY_API_SECRET. Session token and webhook verification will fail.');
}

app.use(cors(corsOptions));
app.use('/api', express.json());

app.use((req, res, next) => {
  console.log('INCOMING:', req.method, req.url);
  next();
});

app.options('/api/events', cors(corsOptions));
app.options('/api/assign-variant', cors(corsOptions));
app.options('/api/stores', cors(corsOptions));
app.options('/api/metrics/:shop_domain', cors(corsOptions));
app.options('/api/debug/:shop_domain', cors(corsOptions));
<<<<<<< HEAD
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
.order('created_at', { ascending: false });
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
<script>
const shopDomain = ${JSON.stringify(shopDomain)};
function formatMoney(value) {
const num = Number(value || 0);
return "$" + num.toFixed(2);
}
function formatPercentFromDecimal(value) {
const num = Number(value || 0) * 100;
return num.toFixed(1) + "%";
}
function formatLiftPercent(value) {
const num = Number(value || 0);
return num.toFixed(1) + "%";
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
return "No data yet — turn on the app embed, save, then open your storefront in another tab to start tracking activity. Data should appear within seconds.";
}
if (totalPurchases === 0) {
return "Tracking is live. Sessions are being recorded, but no purchases have been captured yet.";
}
return "Tracking is live and data is being collected successfully for this store.";
}
async function loadMetrics() {
try {
const response = await fetch('/api/metrics/' + encodeURIComponent(shopDomain));
const json = await response.json();
if (!json.success || !json.data) {
throw new Error('Metrics response missing data');
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
setText("control-sessions", String(controlSessions));
setText("control-purchases", String(controlPurchases));
setText("control-revenue", formatMoney(control.revenue));
setText("control-conversion", formatPercentFromDecimal(control.conversion_rate));
setText("control-rps", formatMoney(control.revenue_per_session));
setText("variant-sessions", String(variantSessions));
setText("variant-purchases", String(variantPurchases));
setText("variant-revenue", formatMoney(variant.revenue));
setText("variant-conversion", formatPercentFromDecimal(variant.conversion_rate));
setText("variant-rps", formatMoney(variant.revenue_per_session));
setText("lift-percent", formatLiftPercent(data.lift_percent));
setText("status-text", getStatusText(totalSessions, totalPurchases));
setText("total-sessions", String(totalSessions));
setText("total-purchases", String(totalPurchases));
if (totalSessions === 0) {
setNotice('<span class="warning">' + getNoticeText(totalSessions, totalPurchases) + '</span>');
} else {
setNotice('<span class="success">' + getNoticeText(totalSessions, totalPurchases) + '</span>');
}
setText("metrics-json", JSON.stringify(json, null, 2));
} catch (err) {
setText("shop-domain", shopDomain);
setNotice('<span class="error">There was a problem loading dashboard data.</span>');
const metricsJson = document.getElementById("metrics-json");
if (metricsJson) {
metricsJson.textContent = "Error loading dashboard data:\\n\\n" + String(err);
}
const status = document.getElementById("status-text");
if (status) {
status.textContent = "Error";
status.classList.add("error");
}
console.error(err);
}
}
const rawDataWrap = document.getElementById("raw-data-wrap");
const rawDataButton = document.getElementById("toggle-raw-data");
if (rawDataButton && rawDataWrap) {
rawDataButton.addEventListener("click", () => {
const isHidden = rawDataWrap.classList.contains("hidden");
rawDataWrap.classList.toggle("hidden");
rawDataButton.textContent = isHidden ? "Hide Raw Data" : "Show Raw Data";
});
}
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
=======
app.options('/api/session', cors(corsOptions));

function setEmbeddedResponseHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
  );
}

function requireSupabase(res) {
  if (!supabase) {
    res.status(500).json({
      success: false,
      error: 'server_not_configured',
    });
    return false;
  }

  return true;
}

function normalizeShopDomain(shop) {
  if (!shop || typeof shop !== 'string') {
    return '';
  }

  const trimmed = shop.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }

  return trimmed.includes('.myshopify.com') ? trimmed : `${trimmed}.myshopify.com`;
}

function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === 'string') {
    return Buffer.from(req.body, 'utf8');
  }

  return Buffer.from('', 'utf8');
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function verifyShopifyWebhook(req) {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    if (!hmacHeader || !SHOPIFY_API_SECRET) {
      return false;
    }

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

function verifyShopifySessionToken(token) {
  try {
    if (!token || !SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const signedPayload = `${encodedHeader}.${encodedPayload}`;

    const expectedSignature = crypto
      .createHmac('sha256', SHOPIFY_API_SECRET)
      .update(signedPayload)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    if (expectedSignature.length !== encodedSignature.length) {
      return null;
    }

    const hasValidSignature = crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'utf8'),
      Buffer.from(encodedSignature, 'utf8')
    );

    if (!hasValidSignature) {
      return null;
    }

    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    if (payload.aud !== SHOPIFY_API_KEY) {
      return null;
    }

    if (payload.exp && payload.exp < now) {
      return null;
    }

    if (payload.nbf && payload.nbf > now) {
      return null;
    }

    if (!payload.dest || !payload.sub) {
      return null;
    }

    return payload;
  } catch (error) {
    console.error('Session token verification error:', error);
    return null;
  }
}

function requireShopifySessionAuth(req, res, next) {
  const authHeader = req.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = verifyShopifySessionToken(token);

  if (!payload) {
    res.setHeader('X-Shopify-Retry-Invalid-Session-Request', '1');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).json({
      success: false,
      error: 'invalid_session_token',
    });
  }

  req.shopifySession = payload;
  next();
}

function ensureAuthorizedShop(req, res, next) {
  const requestedShop = normalizeShopDomain(
    req.params.shop_domain || req.body?.shop_domain || req.query.shop
  );

  const sessionShop = normalizeShopDomain(
    req.shopifySession?.dest?.replace(/^https?:\/\//, '')
  );

  if (!requestedShop || !sessionShop || requestedShop !== sessionShop) {
    return res.status(403).json({
      success: false,
      error: 'shop_mismatch',
    });
  }

  next();
}

function shopifyWebhookHandler(topic, processor) {
  return async (req, res) => {
    try {
      if (!verifyShopifyWebhook(req)) {
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

      await processor(payload, req);
      return res.status(200).send('ok');
    } catch (error) {
      console.error(`${topic} webhook error:`, error);
      return res.status(500).send('server error');
    }
  };
}

function calculateMetrics(sessions = [], events = []) {
  const controlSessions = sessions.filter((row) => row.variant === 'control').length;
  const variantSessions = sessions.filter((row) => row.variant === 'variant').length;

  const controlPurchases = events.filter(
    (row) => row.variant === 'control' && row.event_type === 'purchase'
  );
  const variantPurchases = events.filter(
    (row) => row.variant === 'variant' && row.event_type === 'purchase'
  );

  const controlRevenue = controlPurchases.reduce(
    (sum, row) => sum + Number(row.value || 0),
    0
  );
  const variantRevenue = variantPurchases.reduce(
    (sum, row) => sum + Number(row.value || 0),
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

function buildEmbeddedUrl(pathname, query) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const queryString = params.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

function renderDashboardPage({ shopDomain, host }) {
  const apiKeyMeta = SHOPIFY_API_KEY || '';
  const appUrl = buildEmbeddedUrl('/app', { shop: shopDomain, host });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="shopify-api-key" content="${apiKeyMeta}" />
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <title>BehavioralPro Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      font-family: Arial, sans-serif;
      background: #f6f7f8;
      color: #111827;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 40px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 20px;
    }
    .subheadline {
      max-width: 760px;
      margin-bottom: 24px;
      color: #4b5563;
      font-size: 16px;
      line-height: 1.6;
    }
    .card {
      margin-bottom: 20px;
      padding: 20px;
      border-radius: 16px;
      background: #ffffff;
      box-shadow: 0 1px 10px rgba(0, 0, 0, 0.06);
    }
    .muted {
      color: #6b7280;
      font-size: 14px;
      line-height: 1.6;
    }
    .store-line {
      margin-bottom: 6px;
      font-size: 18px;
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
      padding: 14px;
      border-radius: 12px;
      background: #f9fafb;
    }
    .label {
      margin-bottom: 6px;
      color: #6b7280;
      font-size: 13px;
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
      margin-bottom: 10px;
      padding: 6px 10px;
      border-radius: 999px;
      background: #eef2ff;
      color: #3730a3;
      font-size: 12px;
      font-weight: 600;
    }
    .instructions ol {
      margin: 12px 0 0 18px;
      padding: 0;
      line-height: 1.8;
    }
    .notice {
      margin-top: 14px;
      padding: 14px 16px;
      border: 1px solid #dbeafe;
      border-radius: 12px;
      background: #eff6ff;
      color: #1e3a8a;
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
      background: #111827;
      color: white;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { opacity: 0.92; }
    pre {
      margin: 0;
      overflow: auto;
      padding: 16px;
      border-radius: 12px;
      background: #0f172a;
      color: #e5e7eb;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
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
  <script>
    const shopDomain = ${JSON.stringify(shopDomain)};
    const embeddedAppUrl = ${JSON.stringify(appUrl)};

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
      if (el) el.textContent = String(value);
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
        return "No data yet - turn on the app embed, save, then open your storefront in another tab to start tracking activity. Data should appear within seconds.";
      }

      if (totalPurchases === 0) {
        return "Tracking is live. Sessions are being recorded, but no purchases have been captured yet.";
      }

      return "Tracking is live and data is being collected successfully for this store.";
    }

    async function getSessionToken() {
      if (!window.shopify || typeof window.shopify.idToken !== "function") {
        throw new Error("Shopify App Bridge is not available");
      }

      if (window.shopify.ready) {
        await window.shopify.ready;
      }

      const token = await window.shopify.idToken();
      if (!token) {
        throw new Error("Shopify session token was not returned");
      }

      return token;
    }

    async function authFetch(url, options = {}) {
      const response = await fetch(url, options);
      const shouldRetryWithFreshToken =
        response.status === 401 &&
        response.headers.get("X-Shopify-Retry-Invalid-Session-Request") === "1";

      if (!shouldRetryWithFreshToken) {
        return response;
      }

      const token = await getSessionToken();
      const headers = {
        ...(options.headers || {}),
        Authorization: "Bearer " + token,
      };

      if (options.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }

      return fetch(url, {
        ...options,
        headers,
      });
    }

    async function ensureEmbeddedContext() {
      if (window.top === window.self && embeddedAppUrl) {
        window.location.assign(embeddedAppUrl);
      }
    }

    async function loadMetrics() {
      try {
        const response = await authFetch("/api/metrics/" + encodeURIComponent(shopDomain));
        const json = await response.json();

        if (!response.ok || !json.success || !json.data) {
          throw new Error(json.error || "Metrics response missing data");
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
        setText("control-conversion", formatPercentFromDecimal(control.conversion_rate));
        setText("control-rps", formatMoney(control.revenue_per_session));
        setText("variant-sessions", variantSessions);
        setText("variant-purchases", variantPurchases);
        setText("variant-revenue", formatMoney(variant.revenue));
        setText("variant-conversion", formatPercentFromDecimal(variant.conversion_rate));
        setText("variant-rps", formatMoney(variant.revenue_per_session));
        setText("lift-percent", formatLiftPercent(data.lift_percent));
        setText("status-text", getStatusText(totalSessions, totalPurchases));
        setText("total-sessions", totalSessions);
        setText("total-purchases", totalPurchases);
        setNotice(
          '<span class="' + (totalSessions === 0 ? "warning" : "success") + '">' +
          getNoticeText(totalSessions, totalPurchases) +
          "</span>"
        );
        setText("metrics-json", JSON.stringify(json, null, 2));
      } catch (error) {
        setText("shop-domain", shopDomain);
        setNotice('<span class="error">There was a problem loading dashboard data.</span>');
        setText("metrics-json", "Error loading dashboard data:\\n\\n" + String(error));

        const status = document.getElementById("status-text");
        if (status) {
          status.textContent = "Error";
          status.classList.add("error");
        }

        console.error(error);
      }
    }

    const rawDataWrap = document.getElementById("raw-data-wrap");
    const rawDataButton = document.getElementById("toggle-raw-data");

    if (rawDataButton && rawDataWrap) {
      rawDataButton.addEventListener("click", () => {
        const isHidden = rawDataWrap.classList.contains("hidden");
        rawDataWrap.classList.toggle("hidden");
        rawDataButton.textContent = isHidden ? "Hide Raw Data" : "Show Raw Data";
      });
    }

    window.addEventListener("load", async () => {
      setText("shop-domain", shopDomain);
      await ensureEmbeddedContext();
      await loadMetrics();
    });
  </script>
</body>
</html>`;
}

app.get('/health', (req, res) => {
  res.json({
    success: true,
    shopifyApiKeyConfigured: Boolean(SHOPIFY_API_KEY),
    shopifyApiSecretConfigured: Boolean(SHOPIFY_API_SECRET),
    supabaseConfigured: hasSupabaseConfig,
  });
});

app.post(
  '/webhooks/customers-data-request',
  express.raw({ type: '*/*' }),
  shopifyWebhookHandler('customers/data_request', async (payload) => {
    console.log(
      'Processed customers/data_request for shop:',
      payload.shop_domain || payload.shop_id || 'unknown'
    );
  })
);

app.post(
  '/webhooks/customers-redact',
  express.raw({ type: '*/*' }),
  shopifyWebhookHandler('customers/redact', async (payload) => {
    console.log(
      'Processed customers/redact for shop:',
      payload.shop_domain || payload.shop_id || 'unknown'
    );
  })
);

app.post(
  '/webhooks/shop-redact',
  express.raw({ type: '*/*' }),
  shopifyWebhookHandler('shop/redact', async (payload) => {
    console.log(
      'Processed shop/redact for shop:',
      payload.shop_domain || payload.shop_id || 'unknown'
    );

    if (!supabase) {
      return;
    }

    const possibleShopDomain =
      payload.shop_domain ||
      payload.myshopify_domain ||
      payload.domain ||
      null;

    if (possibleShopDomain) {
      /*
      await supabase.from('events').delete().eq('shop_domain', possibleShopDomain);
      await supabase.from('experiment_sessions').delete().eq('shop_domain', possibleShopDomain);
      await supabase.from('stores').delete().eq('shop_domain', possibleShopDomain);
      */
    }
  })
);

app.get('/api/session', requireShopifySessionAuth, (req, res) => {
  res.json({
    success: true,
    data: {
      shop: normalizeShopDomain(req.shopifySession.dest.replace(/^https?:\/\//, '')),
      subject: req.shopifySession.sub,
      expires_at: req.shopifySession.exp || null,
    },
  });
});

app.post('/api/stores', async (req, res) => {
  try {
    if (!requireSupabase(res)) {
      return;
    }

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
    if (!requireSupabase(res)) {
      return;
    }

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
    if (!requireSupabase(res)) {
      return;
    }

    console.log('EVENT RECEIVED:', JSON.stringify(req.body, null, 2));

    const { shop_domain, session_id, event_type, value = 0 } = req.body || {};

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

    const { data, error } = await supabase
      .from('events')
      .insert([insertRow])
      .select();

    if (error) {
      console.log('EVENT INSERT ERROR:', error);
      return res.status(500).json({ success: false, error });
    }

    return res.json({ success: true, data });
  } catch (error) {
    console.log('EVENT ROUTE ERROR:', error);
    return res.status(500).json({
      success: false,
      error: String(error.message || error),
    });
  }
});

app.get(
  '/api/metrics/:shop_domain',
  requireShopifySessionAuth,
  ensureAuthorizedShop,
  async (req, res) => {
    try {
      if (!requireSupabase(res)) {
        return;
      }

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

      return res.json({
        success: true,
        data: {
          shop_domain,
          ...calculateMetrics(sessions || [], events || []),
        },
      });
    } catch (error) {
      console.log('METRICS ROUTE ERROR:', error);
      return res.status(500).json({
        success: false,
        error: String(error.message || error),
      });
    }
  }
);

app.get(
  '/api/debug/:shop_domain',
  requireShopifySessionAuth,
  ensureAuthorizedShop,
  async (req, res) => {
    try {
      if (!requireSupabase(res)) {
        return;
      }

      const shop_domain = normalizeShopDomain(req.params.shop_domain);

      const { data: sessions, error: sessionsError } = await supabase
        .from('experiment_sessions')
        .select('*')
        .eq('shop_domain', shop_domain);

      const { data: events, error: eventsError } = await supabase
        .from('events')
        .select('*')
        .eq('shop_domain', shop_domain)
        .order('created_at', { ascending: false });

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
      return res.status(500).json({
        success: false,
        error: String(error.message || error),
      });
    }
  }
);

app.get('/dashboard', (req, res) => {
  const shopDomain = normalizeShopDomain(req.query.shop) || 'behavior-test-store.myshopify.com';
  const host = typeof req.query.host === 'string' ? req.query.host : '';
  setEmbeddedResponseHeaders(res);
  res.type('html').send(renderDashboardPage({ shopDomain, host }));
});

app.get('/', (req, res) => {
  const shop = normalizeShopDomain(req.query.shop);
  const host = typeof req.query.host === 'string' ? req.query.host : '';

  if (shop) {
    return res.redirect(buildEmbeddedUrl('/app', { shop, host }));
  }

  return res.redirect('/dashboard');
});

app.get('/app', (req, res) => {
  const shop = normalizeShopDomain(req.query.shop);
  const host = typeof req.query.host === 'string' ? req.query.host : '';

  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  setEmbeddedResponseHeaders(res);
  return res.type('html').send(renderDashboardPage({ shopDomain: shop, host }));
});

app.listen(PORT, () => {
  console.log('Server running on port', PORT);
>>>>>>> 6554689 (Update Shopify App Bridge and session token flow)
});
