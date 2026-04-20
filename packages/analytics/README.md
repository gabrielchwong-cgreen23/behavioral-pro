# `@behavioral-pro/analytics`

Small file-backed analytics package for session-level trigger CRO tracking.

## API

```js
import {
  trackTrigger,
  trackMessageShown,
  trackCheckoutCompleted,
  endSession,
  getSessionCROTable,
  getTriggerConversionRates
} from '@behavioral-pro/analytics'
```

### `trackTrigger(input, options?)`

Tracks when a trigger fires and appends it to the session-level `triggers_fired`
array in the JSON table.

```js
await trackTrigger({
  triggerType: 'scarcity-banner',
  sessionId: 'sess_123',
  shopDomain: 'example.myshopify.com',
  variant: 'variant'
})
```

### `trackMessageShown(input, options?)`

Tracks a CRO message shown within the session and appends it to the
`messages_shown` array.

```js
await trackMessageShown({
  messageName: 'free-shipping-nudge',
  sessionId: 'sess_123',
  shopDomain: 'example.myshopify.com'
})
```

### `trackCheckoutCompleted(input, options?)`

Marks the session as converted, stores revenue, and sets `ended_at`.

```js
await trackCheckoutCompleted({
  sessionId: 'sess_123',
  shopDomain: 'example.myshopify.com',
  checkoutValue: 89.99,
  completedAt: new Date().toISOString()
})
```

### `endSession(input, options?)`

Closes a non-converted session by setting `ended_at`.

```js
await endSession({
  sessionId: 'sess_123',
  shopDomain: 'example.myshopify.com',
  endedAt: new Date().toISOString()
})
```

### `getSessionCROTable(filters?, options?)`

Returns the session-level JSON table with this shape:

```json
[
  {
    "session_id": "sess_123",
    "shop_domain": "example.myshopify.com",
    "variant": "variant",
    "triggers_fired": ["scarcity-banner"],
    "messages_shown": ["free-shipping-nudge"],
    "converted": true,
    "revenue": 89.99,
    "started_at": "2026-04-18T00:00:00.000Z",
    "ended_at": "2026-04-18T00:05:00.000Z"
  }
]
```

### `getTriggerConversionRates(filters?, options?)`

Returns conversion metrics per `triggerType`.

```js
const metrics = await getTriggerConversionRates({
  shopDomain: 'example.myshopify.com'
})
```

## Storage

By default, records are written to:

- `packages/analytics/data/session-cro.json`

You can override the location with either:

- `options.dataDirectory`
- `ANALYTICS_DATA_DIRECTORY`

## Suggested wiring

Import the package from server-side code only, then call:

- `trackTrigger(...)` wherever your trigger exposure actually fires
- `trackMessageShown(...)` when a CRO message is actually rendered to the shopper
- `trackCheckoutCompleted(...)` when purchase/checkout is completed
- `endSession(...)` when the session ends without conversion
- `getSessionCROTable(...)` when you want the raw JSON table
- `getTriggerConversionRates(...)` when you want aggregated conversion metrics

Because it is a separate workspace package with JSON storage, it stays isolated
from the current Shopify app extension behavior until you explicitly wire it in.
