WITH input AS (
  SELECT
    {{String(shop_domain, '')}} AS requested_shop_domain,
    {{String(session_id, '')}} AS requested_session_id
),
deduped_events AS (
  SELECT
    coalesce(
      nullIf(store_id, ''),
      if(
        notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
        nullIf(JSONExtractString(metadata, 'store_id'), ''),
        NULL
      ),
      ''
    ) AS resolved_store_id,
    shop_domain,
    session_id,
    visitor_id,
    experiment_variant,
    event_name,
    event_id,
    coalesce(server_timestamp, client_timestamp) AS event_ts
  FROM raw_events
  WHERE shop_domain = (SELECT requested_shop_domain FROM input)
    AND session_id = (SELECT requested_session_id FROM input)
    AND coalesce(server_timestamp, client_timestamp) IS NOT NULL
  ORDER BY event_id, coalesce(server_timestamp, client_timestamp) DESC
  LIMIT 1 BY event_id
)
SELECT
  ifNull(anyLast(resolved_store_id), '') AS store_id,
  shop_domain,
  session_id,
  anyLast(visitor_id) AS visitor_id,
  anyLast(experiment_variant) AS experiment_variant,
  min(event_ts) AS first_seen_at,
  max(event_ts) AS last_seen_at,
  countIf(event_name = 'page_view') AS page_views,
  countIf(event_name = 'product_view') AS product_views,
  countIf(event_name = 'add_to_cart') AS add_to_cart_count,
  countIf(event_name = 'begin_checkout') AS begin_checkout_count,
  countIf(event_name = 'purchase') AS purchase_count,
  countIf(event_name = 'rage_click') AS rage_click_count,
  countIf(event_name = 'cta_idle_15s') AS cta_idle_15s_count,
  countIf(event_name = 'policy_page_view') AS policy_page_view_count,
  toUInt8(countIf(event_name = 'begin_checkout') > 0) AS reached_checkout,
  toUInt8(countIf(event_name = 'purchase') > 0) AS purchased,
  toUInt8(
    countIf(event_name = 'add_to_cart') > 0
    AND countIf(event_name = 'begin_checkout') = 0
    AND countIf(event_name = 'purchase') = 0
  ) AS provisional_abandoned_cart,
  toUInt8(
    countIf(event_name = 'begin_checkout') > 0
    AND countIf(event_name = 'purchase') = 0
  ) AS provisional_abandoned_checkout
FROM deduped_events
GROUP BY
  shop_domain,
  session_id
