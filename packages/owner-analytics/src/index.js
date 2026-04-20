import {
  getAnalyticsOverview,
  getSessionCROTable,
  getTriggerConversionRates,
  getRawEventLog
} from '@behavioral-pro/analytics'

function getOwnerToken(req) {
  const headerToken = req.headers['x-analytics-token']
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim()
  }

  if (typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim()
  }

  return null
}

function requireOwnerToken(token) {
  return function requireOwnerTokenMiddleware(req, res, next) {
    if (!token) {
      return res.status(500).send('Missing ANALYTICS_OWNER_TOKEN')
    }

    const provided = getOwnerToken(req)
    if (!provided || provided !== token) {
      return res.status(401).send('Unauthorized')
    }

    return next()
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildOwnerAnalyticsPage(token) {
  const safeToken = escapeHtml(token || '')

  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BehavioralPro Owner Analytics</title>
  <style>
    * { box-sizing: border-box; }
    :root {
      --bg: #09111d;
      --panel: #101b2b;
      --panel-border: rgba(148, 163, 184, 0.18);
      --muted: #9fb1cc;
      --text: #edf4ff;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.16);
      --success: #34d399;
      --danger: #f87171;
    }
    body {
      margin: 0;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(56, 189, 248, 0.16), transparent 28%),
        radial-gradient(circle at top right, rgba(52, 211, 153, 0.12), transparent 24%),
        var(--bg);
      color: var(--text);
      padding: 28px;
    }
    .container { max-width: 1280px; margin: 0 auto; }
    h1 { font-size: 40px; margin: 0 0 8px; letter-spacing: -0.03em; }
    p { margin: 0 0 22px; color: var(--muted); }
    .card {
      background: var(--panel);
      border-radius: 18px;
      padding: 20px;
      margin-bottom: 20px;
      border: 1px solid var(--panel-border);
      backdrop-filter: blur(12px);
    }
    .controls {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 12px;
    }
    select, button {
      font-size: 14px;
      padding: 11px 13px;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      background: #081120;
      color: var(--text);
    }
    button {
      cursor: pointer;
      background: linear-gradient(135deg, #0ea5e9, #2563eb);
      border-color: transparent;
      font-weight: 600;
    }
    .summary-grid, .rates-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
    }
    .stat {
      background: rgba(8, 17, 32, 0.72);
      border-radius: 14px;
      padding: 14px;
      border: 1px solid rgba(148, 163, 184, 0.12);
    }
    .label { font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
    .value { font-size: 22px; font-weight: 700; }
    .muted { color: var(--muted); font-size: 13px; }
    .error { color: var(--danger); }
    .pill {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: #c6f1ff;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .link-row {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .link {
      color: #8ddcff;
      text-decoration: none;
      font-size: 14px;
    }
    .link:hover { text-decoration: underline; }
    .table-wrap {
      overflow: auto;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.12);
      background: rgba(8, 17, 32, 0.65);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid rgba(148, 163, 184, 0.1);
      vertical-align: top;
      font-size: 13px;
    }
    th {
      color: var(--muted);
      font-weight: 700;
      background: rgba(148, 163, 184, 0.04);
      position: sticky;
      top: 0;
    }
    code {
      background: rgba(148, 163, 184, 0.1);
      padding: 3px 6px;
      border-radius: 8px;
      font-size: 12px;
    }
    .tag-list {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tag {
      display: inline-flex;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.12);
      color: #d6f6ff;
      font-size: 12px;
    }
    @media (max-width: 720px) {
      body { padding: 18px; }
      h1 { font-size: 32px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>BehavioralPro Owner Analytics</h1>
    <p>Owner-only view across installed stores with session CRO, raw events, and trigger conversion quality.</p>

    <div class="card">
      <div class="pill">Store Selector</div>
      <div class="controls">
        <select id="store-select"></select>
        <button id="refresh-button">Refresh</button>
        <span class="muted" id="status-text">Loading stores...</span>
      </div>
      <div class="link-row">
        <a class="link" id="raw-json-link" href="#">Open raw session JSON</a>
        <a class="link" id="raw-events-link" href="#">Open raw events JSON</a>
      </div>
    </div>

    <div class="card">
      <div class="pill">Overview</div>
      <div class="summary-grid" id="summary-grid"></div>
    </div>

    <div class="card">
      <div class="pill">Trigger Conversion Rates</div>
      <div id="rates-grid" class="rates-grid"></div>
    </div>

    <div class="card">
      <div class="pill">Session CRO Table</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Variant</th>
              <th>Triggers</th>
              <th>Messages</th>
              <th>Converted</th>
              <th>Revenue</th>
              <th>Started</th>
              <th>Ended</th>
            </tr>
          </thead>
          <tbody id="session-table-body"></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="pill">Recent Raw Events</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Session</th>
              <th>Variant</th>
              <th>Page</th>
              <th>Source</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody id="events-table-body"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const token = ${JSON.stringify(safeToken)};

    function setStatus(text, isError) {
      const el = document.getElementById('status-text');
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('error', Boolean(isError));
    }

    function formatPercent(value) {
      const num = Number(value || 0) * 100;
      return num.toFixed(1) + '%';
    }

    function formatMoney(value) {
      return '$' + Number(value || 0).toFixed(2);
    }

    function formatTimestamp(value) {
      if (!value) return '—';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function renderTagList(items) {
      if (!Array.isArray(items) || items.length === 0) return '<span class="muted">—</span>';
      return '<div class="tag-list">' + items.map(item =>
        '<span class="tag">' + String(item) + '</span>'
      ).join('') + '</div>';
    }

    function renderSummary(totals) {
      const grid = document.getElementById('summary-grid');
      if (!grid) return;

      const cards = [
        ['Sessions', totals.sessions || 0],
        ['Converted', totals.convertedSessions || 0],
        ['Revenue', formatMoney(totals.revenue)],
        ['Conversion Rate', formatPercent(totals.conversionRate)],
        ['Triggers Fired', totals.triggerCount || 0],
        ['Messages Shown', totals.messageCount || 0],
        ['Raw Events', totals.rawEventCount || 0]
      ]

      grid.innerHTML = cards.map(([label, value]) => [
        '<div class="stat">',
        '<div class="label">' + label + '</div>',
        '<div class="value">' + String(value) + '</div>',
        '</div>'
      ].join('')).join('')
    }

    function renderRates(rates) {
      const grid = document.getElementById('rates-grid');
      if (!grid) return;

      if (!Array.isArray(rates) || rates.length === 0) {
        grid.innerHTML = '<div class="muted">No trigger analytics data for this store yet.</div>';
        return;
      }

      grid.innerHTML = rates.map(rate => {
        return [
          '<div class="stat">',
          '<div class="label">Trigger Type</div>',
          '<div class="value">' + String(rate.triggerType || 'unknown') + '</div>',
          '<div class="label" style="margin-top: 12px;">Trigger Count</div>',
          '<div class="value">' + String(rate.triggerCount || 0) + '</div>',
          '<div class="label" style="margin-top: 12px;">Converted Sessions</div>',
          '<div class="value">' + String(rate.convertedSessionCount || 0) + '</div>',
          '<div class="label" style="margin-top: 12px;">Conversion Rate</div>',
          '<div class="value">' + formatPercent(rate.conversionRate || 0) + '</div>',
          '</div>'
        ].join('');
      }).join('');
    }

    function renderSessionTable(sessions) {
      const body = document.getElementById('session-table-body');
      if (!body) return;

      if (!Array.isArray(sessions) || sessions.length === 0) {
        body.innerHTML = '<tr><td colspan="8" class="muted">No session CRO rows for this store yet.</td></tr>';
        return;
      }

      body.innerHTML = sessions.map(session => [
        '<tr>',
        '<td><code>' + String(session.session_id) + '</code></td>',
        '<td>' + String(session.variant) + '</td>',
        '<td>' + renderTagList(session.triggers_fired) + '</td>',
        '<td>' + renderTagList(session.messages_shown) + '</td>',
        '<td>' + (session.converted ? 'true' : 'false') + '</td>',
        '<td>' + formatMoney(session.revenue) + '</td>',
        '<td>' + formatTimestamp(session.started_at) + '</td>',
        '<td>' + formatTimestamp(session.ended_at) + '</td>',
        '</tr>'
      ].join('')).join('');
    }

    function renderRawEvents(events) {
      const body = document.getElementById('events-table-body');
      if (!body) return;

      if (!Array.isArray(events) || events.length === 0) {
        body.innerHTML = '<tr><td colspan="7" class="muted">No raw events captured for this store yet.</td></tr>';
        return;
      }

      body.innerHTML = events.slice(0, 50).map(event => {
        const metadata = event.metadata && Object.keys(event.metadata).length
          ? '<code>' + JSON.stringify(event.metadata) + '</code>'
          : '<span class="muted">—</span>';

        return [
          '<tr>',
          '<td>' + formatTimestamp(event.occurred_at) + '</td>',
          '<td><code>' + String(event.event_type) + '</code></td>',
          '<td><code>' + String(event.session_id) + '</code></td>',
          '<td>' + String(event.variant) + '</td>',
          '<td>' + String(event.page_path || event.page_type || '—') + '</td>',
          '<td>' + String(event.traffic_source || event.device_type || '—') + '</td>',
          '<td>' + metadata + '</td>',
          '</tr>'
        ].join('');
      }).join('');
    }

    function updateLinks() {
      const select = document.getElementById('store-select');
      const rawJsonLink = document.getElementById('raw-json-link');
      const rawEventsLink = document.getElementById('raw-events-link');
      if (!select || !rawJsonLink || !rawEventsLink || !select.value) return;

      rawJsonLink.href =
        '/owner-analytics/raw/' +
        encodeURIComponent(select.value) +
        '?token=' +
        encodeURIComponent(token);

      rawEventsLink.href =
        '/api/owner/raw-events/' +
        encodeURIComponent(select.value) +
        '?token=' +
        encodeURIComponent(token);
    }

    async function fetchJson(url) {
      const response = await fetch(url, {
        headers: {
          'x-analytics-token': token
        }
      });

      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Request failed');
      }

      return json.data;
    }

    async function loadStores() {
      setStatus('Loading stores...');
      const data = await fetchJson('/api/owner/stores');
      const stores = data.stores || [];

      const select = document.getElementById('store-select');
      select.innerHTML = '';

      for (const store of stores) {
        const option = document.createElement('option');
        option.value = store.shop_domain;
        option.textContent = store.shop_domain;
        select.appendChild(option);
      }

      if (stores.length === 0) {
        setStatus('No stores found', true);
      } else {
        updateLinks();
        setStatus('Ready');
      }

      return stores;
    }

    async function loadStoreAnalytics() {
      const select = document.getElementById('store-select');
      if (!select || !select.value) {
        renderSummary({});
        renderRates([]);
        renderSessionTable([]);
        renderRawEvents([]);
        return;
      }

      updateLinks();
      setStatus('Loading analytics...');

      const [overview, sessions, events] = await Promise.all([
        fetchJson('/api/owner/analytics/overview/' + encodeURIComponent(select.value)),
        fetchJson('/api/owner/session-cro/' + encodeURIComponent(select.value)),
        fetchJson('/api/owner/raw-events/' + encodeURIComponent(select.value))
      ]);

      renderSummary(overview.totals || {});
      renderRates(overview.conversion_rates || []);
      renderSessionTable(sessions.session_cro || []);
      renderRawEvents(events.raw_events || []);
      setStatus('Ready');
    }

    async function boot() {
      try {
        await loadStores();
        await loadStoreAnalytics();
      } catch (error) {
        console.error(error);
        setStatus(error.message || 'Failed to load data', true);
      }
    }

    document.getElementById('refresh-button').addEventListener('click', loadStoreAnalytics);
    document.getElementById('store-select').addEventListener('change', async () => {
      updateLinks();
      await loadStoreAnalytics();
    });

    boot();
  </script>
</body>
</html>`
}

export function registerOwnerAnalyticsRoutes({ app, supabase, ownerToken }) {
  const requireOwner = requireOwnerToken(ownerToken)

  app.get('/owner-analytics', requireOwner, (req, res) => {
    res.send(buildOwnerAnalyticsPage(ownerToken))
  })

  app.get('/api/owner/stores', requireOwner, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('stores')
        .select('shop_domain, installed_at')
        .order('installed_at', { ascending: false })

      if (error) {
        console.log('OWNER STORES ERROR:', error)
        return res.status(500).json({ success: false, error })
      }

      return res.json({
        success: true,
        data: {
          stores: data || []
        }
      })
    } catch (error) {
      console.log('OWNER STORES ROUTE ERROR:', error)
      return res.status(500).json({
        success: false,
        error: String(error.message || error)
      })
    }
  })

  app.get('/api/owner/analytics/overview/:shop_domain', requireOwner, async (req, res) => {
    try {
      const shopDomain = req.params.shop_domain

      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const overview = await getAnalyticsOverview({ shopDomain })

      return res.json({
        success: true,
        data: {
          shop_domain: shopDomain,
          ...overview,
          conversion_rates: overview.conversionRates
        }
      })
    } catch (error) {
      console.log('OWNER OVERVIEW ROUTE ERROR:', error)
      return res.status(500).json({
        success: false,
        error: String(error.message || error)
      })
    }
  })

  app.get('/api/owner/analytics/conversion-rates/:shop_domain', requireOwner, async (req, res) => {
    try {
      const shopDomain = req.params.shop_domain

      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const conversionRates = await getTriggerConversionRates({ shopDomain })

      return res.json({
        success: true,
        data: {
          shop_domain: shopDomain,
          conversion_rates: conversionRates
        }
      })
    } catch (error) {
      console.log('OWNER ANALYTICS ROUTE ERROR:', error)
      return res.status(500).json({
        success: false,
        error: String(error.message || error)
      })
    }
  })

  app.get('/api/owner/session-cro/:shop_domain', requireOwner, async (req, res) => {
    try {
      const shopDomain = req.params.shop_domain

      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const sessionTable = await getSessionCROTable({ shopDomain })

      return res.json({
        success: true,
        data: {
          shop_domain: shopDomain,
          session_cro: sessionTable
        }
      })
    } catch (error) {
      console.log('OWNER SESSION CRO ROUTE ERROR:', error)
      return res.status(500).json({
        success: false,
        error: String(error.message || error)
      })
    }
  })

  app.get('/api/owner/raw-events/:shop_domain', requireOwner, async (req, res) => {
    try {
      const shopDomain = req.params.shop_domain

      if (!shopDomain) {
        return res.status(400).json({
          success: false,
          error: 'shop_domain is required'
        })
      }

      const rawEvents = await getRawEventLog({ shopDomain })

      return res.json({
        success: true,
        data: {
          shop_domain: shopDomain,
          raw_events: rawEvents
        }
      })
    } catch (error) {
      console.log('OWNER RAW EVENTS ROUTE ERROR:', error)
      return res.status(500).json({
        success: false,
        error: String(error.message || error)
      })
    }
  })

  app.get('/owner-analytics/raw/:shop_domain', requireOwner, async (req, res) => {
    try {
      const shopDomain = req.params.shop_domain

      if (!shopDomain) {
        return res.status(400).send('shop_domain is required')
      }

      const sessionTable = await getSessionCROTable({ shopDomain })

      res.type('application/json')
      return res.send(
        `${JSON.stringify(
          {
            shop_domain: shopDomain,
            session_cro: sessionTable
          },
          null,
          2
        )}\n`
      )
    } catch (error) {
      console.log('OWNER RAW SESSION CRO PAGE ERROR:', error)
      return res.status(500).send(String(error.message || error))
    }
  })
}
