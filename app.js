import 'dotenv/config'
import cors from 'cors'
import crypto from 'crypto'
import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { pathToFileURL } from 'node:url'
import {
  getAnalyticsOverview,
  getTriggerConversionRates,
  trackBehavioralEvent,
  trackSessionStarted
} from './packages/analytics/src/index.js'
import { registerOwnerAnalyticsRoutes } from './packages/owner-analytics/src/index.js'

const DEFAULT_PORT = 3001
const SIGNATURE_HEADER = 'x-behavioralpro-signature'
const TIMESTAMP_HEADER = 'x-behavioralpro-timestamp'
const SIGNATURE_TTL_MS = 5 * 60 * 1000

function createSupabaseClient(env) {
  if (!env?.SUPABASE_URL) {
    throw new Error('Missing SUPABASE_URL')
  }

  if (!env?.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
  }

  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
}

export function normalizeShop(shop) {
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

function getDeviceTypeFromUserAgent(userAgent) {
  const value = String(userAgent || '').toLowerCase()
  if (!value) return null
  if (value.includes('ipad') || value.includes('tablet')) return 'tablet'
  if (value.includes('mobi') || value.includes('iphone') || value.includes('android')) {
    return 'mobile'
  }

  return 'desktop'
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

function verifyShopifyWebhook({ rawBody, hmacHeader, secret }) {
  if (!rawBody || !hmacHeader || !secret) {
    return false
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64')

  const digestBuffer = Buffer.from(digest, 'utf8')
  const headerBuffer = Buffer.from(String(hmacHeader), 'utf8')

  if (digestBuffer.length !== headerBuffer.length) {
    return false
  }

  try {
    return crypto.timingSafeEqual(digestBuffer, headerBuffer)
  } catch {
    return false
  }
}

export function verifyShopifySessionToken(token, env) {
  const apiKey = env.SHOPIFY_API_KEY
  const apiSecret = env.SHOPIFY_API_SECRET

  if (!token) {
    throw new Error('Missing bearer token')
  }

  if (!apiKey || !apiSecret) {
    throw new Error('Missing Shopify API environment variables')
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
    .createHmac('sha256', apiSecret)
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

  if (payload.aud !== apiKey) {
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

export function createIngestSignature({ rawBody, timestamp, secret }) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex')
}

export function verifySignedIngestRequest({ rawBody, headers, secret, maxAgeMs = SIGNATURE_TTL_MS }) {
  if (!secret) {
    return {
      ok: false,
      error: 'Missing ingest signing secret'
    }
  }

  const signature = headers?.[SIGNATURE_HEADER] || headers?.[SIGNATURE_HEADER.toLowerCase()]
  const timestamp = headers?.[TIMESTAMP_HEADER] || headers?.[TIMESTAMP_HEADER.toLowerCase()]

  if (!signature || !timestamp) {
    return {
      ok: false,
      error: 'Missing ingest signature headers'
    }
  }

  const timestampMs = Number(timestamp)

  if (!Number.isFinite(timestampMs)) {
    return {
      ok: false,
      error: 'Invalid ingest timestamp'
    }
  }

  if (Math.abs(Date.now() - timestampMs) > maxAgeMs) {
    return {
      ok: false,
      error: 'Expired ingest signature'
    }
  }

  const expected = createIngestSignature({
    rawBody: rawBody || '',
    timestamp: String(timestamp),
    secret
  })

  const providedBuffer = Buffer.from(String(signature), 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')

  if (providedBuffer.length !== expectedBuffer.length) {
    return {
      ok: false,
      error: 'Invalid ingest signature'
    }
  }

  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return {
      ok: false,
      error: 'Invalid ingest signature'
    }
  }

  return {
    ok: true
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

export function buildMetricsPayload(shopDomain, overview) {
  const controlSessions = overview.sessionTable.filter(session => session.variant === 'control')
  const variantSessions = overview.sessionTable.filter(session => session.variant === 'variant')

  function summarize(sessions) {
    const purchases = sessions.filter(session => session.converted).length
    const revenue = sessions.reduce((sum, session) => sum + Number(session.revenue || 0), 0)

    return {
      sessions: sessions.length,
      purchases,
      revenue,
      conversion_rate: sessions.length === 0 ? 0 : purchases / sessions.length,
      revenue_per_session: sessions.length === 0 ? 0 : revenue / sessions.length
    }
  }

  const control = summarize(controlSessions)
  const variant = summarize(variantSessions)
  const liftPercent = control.revenue_per_session === 0
    ? 0
    : ((variant.revenue_per_session - control.revenue_per_session) / control.revenue_per_session) * 100

  return {
    shop_domain: shopDomain,
    control,
    variant,
    lift_percent: liftPercent
  }
}

function buildDashboardPage({ shopDomain, apiKey }) {
  const escapedShop = escapeHtml(shopDomain)
  const escapedApiKey = escapeHtml(apiKey || '')

  return `<!doctype html>
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
    .analytics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
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
    .analytics-empty {
      color: #6b7280;
      font-size: 14px;
      line-height: 1.5;
    }
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

    <div class="card">
      <div class="pill">Private Analytics</div>
      <h2>Trigger Conversion Rates</h2>
      <div class="muted" style="margin-bottom: 16px;">
        Visible only after the embedded Shopify session token is validated for this store.
      </div>
      <div class="analytics-grid" id="analytics-rates-grid">
        <div class="analytics-empty" id="analytics-empty-state">
          Waiting for secure analytics data...
        </div>
      </div>
    </div>
  </div>

  <script>
    const shopDomain = ${JSON.stringify(shopDomain)};

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

    function renderAnalyticsRates(items) {
      const container = document.getElementById('analytics-rates-grid');
      if (!container) return;

      if (!Array.isArray(items) || items.length === 0) {
        container.innerHTML =
          '<div class="analytics-empty">No trigger analytics recorded for this store yet.</div>';
        return;
      }

      container.innerHTML = items
        .map(item => {
          const triggerType = String(item.triggerType || 'unknown');
          const triggerCount = Number(item.triggerCount || 0);
          const checkoutCount = Number(item.checkoutCount || 0);
          const conversionRate = formatPercent(item.conversionRate || 0);

          return [
            '<div class="stat">',
            '<div class="label">Trigger Type</div>',
            '<div class="value small">' + triggerType + '</div>',
            '<div class="label" style="margin-top: 14px;">Triggers Fired</div>',
            '<div class="value small">' + String(triggerCount) + '</div>',
            '<div class="label" style="margin-top: 14px;">Completed Checkouts</div>',
            '<div class="value small">' + String(checkoutCount) + '</div>',
            '<div class="label" style="margin-top: 14px;">Conversion Rate</div>',
            '<div class="value small">' + conversionRate + '</div>',
            '</div>'
          ].join('');
        })
        .join('');
    }

    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)
        )
      ]);
    }

    async function getSessionTokenOrThrow() {
      if (!window.shopify) {
        throw new Error('window.shopify is missing');
      }

      if (typeof window.shopify.idToken !== 'function') {
        throw new Error('shopify.idToken is not available');
      }

      const token = await withTimeout(window.shopify.idToken(), 8000, 'shopify.idToken()');

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
        setStatus('embedded-auth-status', 'Requesting session token...');

        const response = await authedFetch(
          '/api/embedded-check?shop=' + encodeURIComponent(shopDomain),
          { method: 'GET' }
        );

        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(json.error || 'Embedded auth check failed');
        }

        setStatus('embedded-auth-status', 'Session token accepted', 'ok');
        return true;
      } catch (error) {
        console.error('Embedded auth check error:', error);
        setStatus('embedded-auth-status', 'Failed: ' + String(error.message || error), 'error');

        const metricsJson = document.getElementById('metrics-json');
        if (metricsJson) {
          metricsJson.textContent =
            'Embedded auth error:\\n\\n' + String(error.message || error);
        }

        return false;
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
            'Error loading dashboard data:\\n\\n' + String(error.message || error);
        }
      }
    }

    async function loadAnalyticsRates() {
      try {
        const response = await authedFetch(
          '/api/analytics/conversion-rates/' +
            encodeURIComponent(shopDomain) +
            '?shop=' +
            encodeURIComponent(shopDomain),
          { method: 'GET' }
        );

        const json = await response.json();

        if (!response.ok || !json.success || !json.data) {
          throw new Error(json.error || 'Analytics response missing data');
        }

        renderAnalyticsRates(json.data.conversion_rates || []);
      } catch (error) {
        console.error('Analytics rates error:', error);
        renderAnalyticsRates([]);
      }
    }

    async function boot() {
      const authOk = await verifyEmbeddedAuth();
      if (authOk) {
        await Promise.all([loadMetrics(), loadAnalyticsRates()]);
      } else {
        setStatus('status-text', 'Blocked by auth', 'error');
        renderAnalyticsRates([]);
      }
    }

    boot();
  </script>
</body>
</html>`
}

export function createApp({ env = process.env, supabase: providedSupabase } = {}) {
  const app = express()
  const corsOptions = {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-BehavioralPro-Signature', 'X-BehavioralPro-Timestamp', 'X-Analytics-Token'],
    credentials: false
  }
  const supabase = providedSupabase || createSupabaseClient(env)
  const analyticsOptions = { supabase }
  const ingestSigningSecret = env.INGEST_SIGNING_SECRET || env.SHOPIFY_API_SECRET

  if (!env.SHOPIFY_API_KEY) {
    console.warn('Missing SHOPIFY_API_KEY')
  }

  if (!env.SHOPIFY_API_SECRET) {
    console.warn('Missing SHOPIFY_API_SECRET')
  }

  if (!providedSupabase && !env.SUPABASE_URL) {
    console.warn('Missing SUPABASE_URL')
  }

  if (!providedSupabase && !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Missing SUPABASE_SERVICE_ROLE_KEY')
  }

  app.use(cors(corsOptions))
  app.use(express.json({
    verify(req, _res, buf) {
      req.rawBody = buf.toString('utf8')
    }
  }))
  app.use((req, _res, next) => {
    console.log('INCOMING:', req.method, req.url)
    next()
  })

  for (const route of [
    '/api/events',
    '/api/assign-variant',
    '/api/stores',
    '/api/metrics/:shop_domain',
    '/api/debug/:shop_domain',
    '/api/embedded-check',
    '/api/analytics/conversion-rates/:shop_domain'
  ]) {
    app.options(route, cors(corsOptions))
  }

  registerOwnerAnalyticsRoutes({
    app,
    supabase,
    ownerToken: env.ANALYTICS_OWNER_TOKEN,
    analyticsOptions
  })

  function requireShopifySessionToken(req, res, next) {
    try {
      const token = getBearerToken(req)
      const verified = verifyShopifySessionToken(token, env)
      const requestedShop =
        normalizeShop(req.query.shop) ||
        normalizeShop(req.params.shop_domain) ||
        normalizeShop(req.body?.shop_domain)

      if (requestedShop && requestedShop !== verified.shop) {
        return sendInvalidSessionResponse(res, 'Shop mismatch')
      }

      req.shopifySession = verified
      return next()
    } catch (error) {
      console.log('SESSION TOKEN ERROR:', error.message)
      return sendInvalidSessionResponse(res, error.message)
    }
  }

  function requireSignedIngestOrSession(req, res, next) {
    const requestedShop =
      normalizeShop(req.query.shop) ||
      normalizeShop(req.params.shop_domain) ||
      normalizeShop(req.body?.shop_domain)

    try {
      const token = getBearerToken(req)
      if (token) {
        const verified = verifyShopifySessionToken(token, env)
        if (requestedShop && requestedShop !== verified.shop) {
          return sendInvalidSessionResponse(res, 'Shop mismatch')
        }
        req.shopifySession = verified
        req.ingestAuth = { mode: 'session-token' }
        return next()
      }
    } catch (error) {
      console.log('SESSION TOKEN ERROR:', error.message)
    }

    const signed = verifySignedIngestRequest({
      rawBody: req.rawBody || '',
      headers: req.headers,
      secret: ingestSigningSecret
    })

    if (!signed.ok) {
      return res.status(401).json({
        success: false,
        error: signed.error
      })
    }

    req.ingestAuth = { mode: 'signed-ingest' }
    return next()
  }

  function requireEventIngestAuth(req, res, next) {
    const requestedShop = normalizeShop(req.body?.shop_domain)

    try {
      const token = getBearerToken(req)
      if (token) {
        const verified = verifyShopifySessionToken(token, env)
        if (requestedShop && requestedShop !== verified.shop) {
          return sendInvalidSessionResponse(res, 'Shop mismatch')
        }
        req.shopifySession = verified
        req.ingestAuth = { mode: 'session-token' }
        return next()
      }
    } catch (error) {
      console.log('SESSION TOKEN ERROR:', error.message)
    }

    const signed = verifySignedIngestRequest({
      rawBody: req.rawBody || '',
      headers: req.headers,
      secret: ingestSigningSecret
    })

    if (signed.ok) {
      req.ingestAuth = { mode: 'signed-ingest' }
      return next()
    }

    // Theme app extensions run in the storefront and cannot hold server secrets.
    // Allow unsigned ingest here so the live storefront experiment can still assign
    // variants and emit events, while keeping store registration protected.
    if (requestedShop && req.body?.session_id) {
      req.ingestAuth = { mode: 'storefront-unsigned' }
      return next()
    }

    return res.status(401).json({
      success: false,
      error: signed.error
    })
  }

  function verifyWebhookRequest(req) {
    return verifyShopifyWebhook({
      rawBody: req.rawBody || '',
      hmacHeader: req.get('X-Shopify-Hmac-Sha256'),
      secret: env.SHOPIFY_API_SECRET
    })
  }

  app.post('/api/stores', requireSignedIngestOrSession, async (req, res) => {
    try {
      const shop_domain = normalizeShop(req.body?.shop_domain)
      const { access_token = null, scope = null } = req.body || {}

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

  app.post('/api/assign-variant', requireEventIngestAuth, async (req, res) => {
    try {
      const shop_domain = normalizeShop(req.body?.shop_domain)
      const { session_id } = req.body || {}

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

      if (existingError) {
        console.log('ASSIGN LOOKUP ERROR:', existingError)
        return res.status(500).json({ success: false, error: existingError })
      }

      if (existing?.[0]) {
        await trackSessionStarted({
          eventType: 'experiment_assignment',
          sessionId: existing[0].session_id,
          shopDomain: existing[0].shop_domain,
          variant: existing[0].variant,
          occurredAt: existing[0].created_at
        }, analyticsOptions)

        return res.json({ success: true, data: existing[0] })
      }

      const variant = Math.random() < 0.5 ? 'control' : 'variant'
      const tracked = await trackSessionStarted({
        eventType: 'experiment_assignment',
        sessionId: session_id,
        shopDomain: shop_domain,
        variant,
        occurredAt: new Date().toISOString()
      }, analyticsOptions)

      return res.json({
        success: true,
        data: {
          shop_domain,
          session_id,
          variant: tracked.session.variant,
          created_at: tracked.session.started_at
        }
      })
    } catch (error) {
      console.log('ASSIGN ROUTE ERROR:', error)
      return res.status(500).json({
        success: false,
        error: String(error.message || error)
      })
    }
  })

  app.post('/api/events', requireEventIngestAuth, async (req, res) => {
    try {
      console.log('EVENT RECEIVED:', JSON.stringify(req.body, null, 2))

      const shop_domain = normalizeShop(req.body?.shop_domain)
      const {
        session_id,
        event_type,
        value = 0,
        occurred_at = new Date().toISOString(),
        extra = {},
        event_id = null,
        dedupe_key = null
      } = req.body || {}

      if (!shop_domain || !session_id || !event_type) {
        console.log('EVENT REJECTED: missing fields')
        return res.status(400).json({
          success: false,
          error: 'missing fields',
          received: req.body
        })
      }

      const { data: sessionRows, error: sessionError } = await supabase
        .from('experiment_sessions')
        .select('*')
        .eq('shop_domain', shop_domain)
        .eq('session_id', session_id)

      if (sessionError) {
        console.log('SESSION LOOKUP ERROR:', sessionError)
        return res.status(500).json({ success: false, error: sessionError })
      }

      if (!sessionRows?.[0]) {
        console.log('EVENT REJECTED: session not assigned')
        return res.status(400).json({
          success: false,
          error: 'session not assigned',
          shop_domain,
          session_id
        })
      }

      const tracked = await trackBehavioralEvent({
        eventId: event_id,
        eventType: event_type,
        sessionId: session_id,
        shopDomain: shop_domain,
        variant: sessionRows[0].variant,
        occurredAt: occurred_at,
        value,
        visitorId: req.body?.visitor_id,
        dedupeKey: dedupe_key,
        pageType: req.body?.page_type,
        pageUrl: req.body?.page_url,
        pagePath: req.body?.page_path,
        referrer: req.body?.referrer,
        trafficSource: req.body?.traffic_source,
        deviceType: req.body?.device_type || getDeviceTypeFromUserAgent(req.headers['user-agent']),
        productId: req.body?.product_id,
        productHandle: req.body?.product_handle,
        cartValue: req.body?.cart_value,
        reason: req.body?.reason,
        triggerType: req.body?.trigger_type,
        messageName: req.body?.message_name,
        metadata: {
          ...extra,
          experiment_name: req.body?.experiment_name,
          source: 'shopify_extension'
        }
      }, analyticsOptions)

      return res.json({
        success: true,
        data: {
          shop_domain,
          session_id,
          event_type,
          duplicate: Boolean(tracked.duplicate)
        }
      })
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

  app.get('/api/analytics/conversion-rates/:shop_domain', requireShopifySessionToken, async (req, res) => {
    try {
      const shopDomain = normalizeShop(req.params.shop_domain)

      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const filters = { shopDomain }
      if (req.query.since) filters.since = req.query.since
      if (req.query.until) filters.until = req.query.until

      const conversionRates = await getTriggerConversionRates(filters, analyticsOptions)

      return res.json({
        success: true,
        data: {
          shop_domain: shopDomain,
          conversion_rates: conversionRates
        }
      })
    } catch (error) {
      console.log('ANALYTICS CONVERSION ROUTE ERROR:', error)
      return res.status(500).json({
        success: false,
        error: String(error.message || error)
      })
    }
  })

app.get('/api/analytics/abandonment-by-variant', async (req, res) => {
  try {
    const tinybirdHost = process.env.TINYBIRD_HOST || 'https://api.europe-west2.gcp.tinybird.co'
    const tinybirdToken = process.env.TINYBIRD_TOKEN

    if (!tinybirdToken) {
      return res.status(500).json({
        success: false,
        error: 'Missing TINYBIRD_TOKEN environment variable',
      })
    }

    const url = `${tinybirdHost}/v0/pipes/abandonment_by_variant.json`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tinybirdToken}`,
      },
    })

    const text = await response.text()

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: 'Tinybird request failed',
        status: response.status,
        details: text,
      })
    }

    const tinybirdResponse = JSON.parse(text)

    return res.json({
      success: true,
      data: tinybirdResponse.data || [],
    })
  } catch (error) {
    console.error('TINYBIRD ABANDONMENT ROUTE ERROR:', error)
    return res.status(500).json({
      success: false,
      error: String(error.message || error),
    })
  }
})

  app.get('/api/metrics/:shop_domain', requireShopifySessionToken, async (req, res) => {
    try {
      const shopDomain = normalizeShop(req.params.shop_domain)
      const overview = await getAnalyticsOverview({ shopDomain }, analyticsOptions)

      return res.json({
        success: true,
        data: buildMetricsPayload(shopDomain, overview)
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
      const shopDomain = normalizeShop(req.params.shop_domain)
      const [sessions, events, overview] = await Promise.all([
        supabase.from('experiment_sessions').select('*').eq('shop_domain', shopDomain),
        supabase.from('events').select('*').eq('shop_domain', shopDomain),
        getAnalyticsOverview({ shopDomain }, analyticsOptions)
      ])

      return res.json({
        success: true,
        sessionCount: sessions.data?.length || 0,
        eventCount: events.data?.length || 0,
        sessions: sessions.data || [],
        events: events.data || [],
        derived: overview
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
    res.send(buildDashboardPage({
      shopDomain,
      apiKey: env.SHOPIFY_API_KEY
    }))
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

    return res.redirect(`/dashboard?${qs.toString()}`)
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

    return res.redirect(`/dashboard?${qs.toString()}`)
  })

  app.get('/api/shopify/callback', (req, res) => {
    const shop = normalizeShop(req.query.shop)

    if (!shop) {
      return res.status(400).send('Missing shop parameter')
    }

    const qs = new URLSearchParams()
    qs.set('shop', shop)
    if (typeof req.query.host === 'string' && req.query.host) {
      qs.set('host', req.query.host)
    }

    return res.redirect(`/dashboard?${qs.toString()}`)
  })

  app.post('/webhooks/customers-data-request', (req, res) => {
    if (!verifyWebhookRequest(req)) {
      return res.status(401).send('Invalid webhook signature')
    }

    console.log('WEBHOOK customers/data_request:', JSON.stringify(req.body || {}))
    return res.status(200).send('ok')
  })

  app.post('/webhooks/customers-redact', (req, res) => {
    if (!verifyWebhookRequest(req)) {
      return res.status(401).send('Invalid webhook signature')
    }

    console.log('WEBHOOK customers/redact:', JSON.stringify(req.body || {}))
    return res.status(200).send('ok')
  })

  app.post('/webhooks/shop-redact', (req, res) => {
    if (!verifyWebhookRequest(req)) {
      return res.status(401).send('Invalid webhook signature')
    }

    console.log('WEBHOOK shop/redact:', JSON.stringify(req.body || {}))
    return res.status(200).send('ok')
  })

  return app
}

export function startServer({ env = process.env, supabase } = {}) {
  const app = createApp({ env, supabase })
  const port = Number(env.PORT || DEFAULT_PORT)
  return app.listen(port, () => {
    console.log(`Server running on port ${port}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
}
