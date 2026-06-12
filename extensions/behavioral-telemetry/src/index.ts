import { register } from '@shopify/web-pixels-extension';

const BACKEND_BASE = 'https://behavioral-pro-production.up.railway.app';
const SESSION_KEY = 'behavioral_pro_pixel_session_id';
const VISITOR_KEY = 'behavioral_pro_pixel_visitor_id';

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toPathname(pageUrl: string) {
  try {
    return new URL(pageUrl).pathname || '/';
  } catch {
    return '/';
  }
}

register(({ analytics, browser }) => {
  let sessionId = createId('pixel_session');
  let visitorId = createId('pixel_visitor');
  const browserApi = browser as any;

  const getStorage = async (key: string, fallbackPrefix: string) => {
    try {
      const existing = await browserApi.localStorage?.getItem(key);
      if (existing) return existing;
      const next = createId(fallbackPrefix);
      await browserApi.localStorage?.setItem(key, next);
      return next;
    } catch {
      return createId(fallbackPrefix);
    }
  };

  const hydrateIds = async () => {
    sessionId = await getStorage(SESSION_KEY, 'pixel_session');
    visitorId = await getStorage(VISITOR_KEY, 'pixel_visitor');
  };

  const mapEventName = (name?: string | null) => {
    switch (name) {
      case 'page_viewed':
        return 'page_view';
      case 'product_viewed':
        return 'product_view';
      case 'product_added_to_cart':
        return 'add_to_cart';
      case 'cart_viewed':
        return 'cart_open';
      case 'checkout_started':
        return 'begin_checkout';
      case 'checkout_completed':
        return 'purchase';
      default:
        return null;
    }
  };

  const streamEvent = async (event: any) => {
    const eventName = mapEventName(event?.name);
    if (!eventName) return;

    await hydrateIds();

    const pageUrl =
      event?.context?.document?.location?.href ||
      event?.context?.window?.location?.href ||
      `https://${event?.context?.document?.location?.hostname || 'unknown.myshopify.com'}/`;

    const shopDomain =
      event?.context?.document?.location?.hostname ||
      event?.context?.window?.location?.hostname ||
      'unknown.myshopify.com';

    const referrer =
      event?.context?.document?.referrer ||
      event?.context?.document?.referrerUrl ||
      null;

    const clientTimestamp = new Date().toISOString();

    browser.fetch(`${BACKEND_BASE}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        anonymous_id: visitorId,
        session_id: sessionId,
        event_name: eventName,
        timestamp: Math.floor(new Date(clientTimestamp).getTime() / 1000),
        properties: {
          path: toPathname(pageUrl),
          shop_domain: shopDomain,
          referrer,
          experiment_variant: 'control',
          source: 'shopify_web_pixel',
          page_url: pageUrl,
          pixel_event_id: createId('pixel_evt'),
          shopify_event_name: event?.name || null,
          raw_event_id: event?.id || null
        }
      })
    }).catch(error => console.error('BehavioralPro pixel drop:', error));
  };

  analytics.subscribe('all_events', streamEvent);
});
