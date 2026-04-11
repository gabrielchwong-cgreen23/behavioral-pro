# `@behavioral-pro/analytics`

Small file-backed analytics package for trigger and checkout tracking.

## API

```js
import {
  trackTrigger,
  trackCheckoutCompleted,
  getTriggerConversionRates
} from '@behavioral-pro/analytics'
```

### `trackTrigger(input, options?)`

Tracks when a trigger fires.

```js
await trackTrigger({
  triggerType: 'scarcity-banner',
  sessionId: 'sess_123',
  shopDomain: 'example.myshopify.com',
  metadata: { productId: 'gid://shopify/Product/1' }
})
```

### `trackCheckoutCompleted(input, options?)`

Tracks when a checkout completes. Matching works best when you pass the same
`sessionId` or `triggerId` that was recorded during `trackTrigger(...)`.

```js
await trackCheckoutCompleted({
  sessionId: 'sess_123',
  shopDomain: 'example.myshopify.com',
  orderId: '1001',
  checkoutValue: 89.99
})
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

- `packages/analytics/data/triggers.json`
- `packages/analytics/data/checkouts.json`

You can override the location with either:

- `options.dataDirectory`
- `ANALYTICS_DATA_DIRECTORY`

## Suggested wiring

Import the package from server-side code only, then call:

- `trackTrigger(...)` wherever your trigger exposure actually fires
- `trackCheckoutCompleted(...)` when you confirm a completed purchase or checkout
- `getTriggerConversionRates(...)` from an internal metrics endpoint or dashboard

Because it is a separate workspace package with JSON storage, it stays isolated
from the current Shopify app extension behavior until you explicitly wire it in.
