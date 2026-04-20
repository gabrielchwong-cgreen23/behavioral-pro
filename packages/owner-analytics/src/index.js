import {
  getSessionCROTable,
  getTriggerConversionRates
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
    body {
      margin: 0;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      padding: 32px;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 38px; margin: 0 0 10px; }
    p { margin: 0 0 20px; color: #cbd5f5; }
    .card {
      background: #111827;
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 20px;
      border: 1px solid rgba(148, 163, 184, 0.2);
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
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      background: #0b1220;
      color: #f8fafc;
    }
    button {
      cursor: pointer;
      background: #2563eb;
      border-color: transparent;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
    }
    .stat {
      background: rgba(15, 23, 42, 0.6);
      border-radius: 14px;
      padding: 14px;
      border: 1px solid rgba(148, 163, 184, 0.15);
    }
    .label { font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
    .value { font-size: 20px; font-weight: 600; }
    .muted { color: #94a3b8; font-size: 13px; }
    .error { color: #f87171; }
    .pill {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.2);
      color: #bfdbfe;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .link {
      color: #93c5fd;
      text-decoration: none;
      font-size: 14px;
    }
    .link:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>BehavioralPro Owner Analytics</h1>
    <p>Owner-only view across all installed stores.</p>

    <div class="card">
      <div class="pill">Store Selector</div>
      <div class="controls">
        <select id="store-select"></select>
        <button id="refresh-button">Refresh</button>
        <span class="muted" id="status-text">Loading stores...</span>
      </div>
      <a class="link" id="raw-json-link" href="#">Open raw session JSON</a>
    </div>

    <div class="card">
      <div class="pill">Trigger Conversion Rates</div>
      <div id="rates-grid" class="grid"></div>
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

    function renderRates(rates) {
      const grid = document.getElementById('rates-grid');
      if (!grid) return;

      if (!Array.isArray(rates) || rates.length === 0) {
        grid.innerHTML = '<div class="muted">No analytics data for this store yet.</div>';
        return;
      }

      grid.innerHTML = rates.map(rate => {
        const triggerType = String(rate.triggerType || 'unknown');
        const triggerCount = Number(rate.triggerCount || 0);
        const checkoutCount = Number(rate.checkoutCount || 0);
        const conversionRate = formatPercent(rate.conversionRate || 0);

        return [
          '<div class="stat">',
          '<div class="label">Trigger Type</div>',
          '<div class="value">' + triggerType + '</div>',
          '<div class="label" style="margin-top: 12px;">Triggers Fired</div>',
          '<div class="value">' + triggerCount + '</div>',
          '<div class="label" style="margin-top: 12px;">Completed Checkouts</div>',
          '<div class="value">' + checkoutCount + '</div>',
          '<div class="label" style="margin-top: 12px;">Conversion Rate</div>',
          '<div class="value">' + conversionRate + '</div>',
          '</div>'
        ].join('');
      }).join('');
    }

    function updateRawJsonLink() {
      const select = document.getElementById('store-select');
      const link = document.getElementById('raw-json-link');
      if (!select || !link || !select.value) return;

      link.href =
        '/owner-analytics/raw/' +
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
        setStatus('Ready');
        updateRawJsonLink();
      }

      return stores;
    }

    async function loadRatesForSelectedStore() {
      const select = document.getElementById('store-select');
      if (!select || !select.value) {
        renderRates([]);
        return;
      }

      setStatus('Loading analytics...');
      const data = await fetchJson(
        '/api/owner/analytics/conversion-rates/' + encodeURIComponent(select.value)
      );
      renderRates(data.conversion_rates || []);
      updateRawJsonLink();
      setStatus('Ready');
    }

    async function boot() {
      try {
        await loadStores();
        await loadRatesForSelectedStore();
      } catch (error) {
        console.error(error);
        setStatus(error.message || 'Failed to load data', true);
      }
    }

    document.getElementById('refresh-button').addEventListener('click', loadRatesForSelectedStore);
    document.getElementById('store-select').addEventListener('change', async () => {
      updateRawJsonLink();
      await loadRatesForSelectedStore();
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

  app.get(
    '/api/owner/analytics/conversion-rates/:shop_domain',
    requireOwner,
    async (req, res) => {
      try {
        const shopDomain = req.params.shop_domain

        if (!shopDomain) {
          return res.status(400).json({
            success: false,
            error: 'shop_domain is required'
          })
        }

        const conversionRates = await getTriggerConversionRates({
          shopDomain
        })

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
    }
  )

  app.get(
    '/api/owner/session-cro/:shop_domain',
    requireOwner,
    async (req, res) => {
      try {
        const shopDomain = req.params.shop_domain

        if (!shopDomain) {
          return res.status(400).json({
            success: false,
            error: 'shop_domain is required'
          })
        }

        const sessionTable = await getSessionCROTable({
          shopDomain
        })

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
    }
  )

  app.get(
    '/owner-analytics/raw/:shop_domain',
    requireOwner,
    async (req, res) => {
      try {
        const shopDomain = req.params.shop_domain

        if (!shopDomain) {
          return res.status(400).send('shop_domain is required')
        }

        const sessionTable = await getSessionCROTable({
          shopDomain
        })

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
    }
  )
}
