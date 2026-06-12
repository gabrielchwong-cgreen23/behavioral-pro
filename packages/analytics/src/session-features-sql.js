function sanitizeLimit(limit) {
  const numeric = Number(limit)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.floor(numeric)
}

function normalizeWhereClause(whereClause) {
  if (!whereClause) return ''
  return `WHERE ${String(whereClause).trim()}`
}

export function buildSessionFeaturesBaseCte() {
  return `
    WITH raw_base AS (
      SELECT
        nullIf(store_id, '') AS store_id,
        nullIf(shop_domain, '') AS shop_domain,
        nullIf(session_id, '') AS session_id,
        nullIf(visitor_id, '') AS visitor_id,
        nullIf(experiment_variant, '') AS experiment_variant,
        page_url,
        referrer,
        event_id,
        event_name,
        coalesce(server_timestamp, client_timestamp) AS event_ts,
        client_timestamp,
        server_timestamp,
        metadata,
        if(notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata) = 0, 1, 0) AS metadata_malformed,
        if(
          notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          nullIf(JSONExtractString(metadata, 'status'), ''),
          NULL
        ) AS discount_status,
        if(
          notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata) AND JSONHas(metadata, 'milestone'),
          JSONExtractFloat(metadata, 'milestone'),
          if(
            notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata) AND JSONHas(metadata, 'scroll_percent'),
            JSONExtractFloat(metadata, 'scroll_percent') / 100.0,
            NULL
          )
        ) AS scroll_milestone,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          JSONExtractFloat(metadata, 't_seconds'),
          NULL
        ) AS frame_t_seconds,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          JSONExtractFloat(metadata, 'mouse_velocity_avg'),
          NULL
        ) AS frame_mouse_velocity_avg,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          JSONExtractFloat(metadata, 'mouse_velocity_max'),
          NULL
        ) AS frame_mouse_velocity_max,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          JSONExtractFloat(metadata, 'friction_score'),
          NULL
        ) AS frame_friction_score,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          JSONExtractFloat(metadata, 'hesitation_score'),
          NULL
        ) AS frame_hesitation_score,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          JSONExtractFloat(metadata, 'intent_score'),
          NULL
        ) AS frame_intent_score,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          JSONExtractFloat(metadata, 'hover_cta_seconds'),
          NULL
        ) AS frame_hover_cta_seconds,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          JSONExtractFloat(metadata, 'hover_price_seconds'),
          NULL
        ) AS frame_hover_price_seconds,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          JSONExtractFloat(metadata, 'hover_policy_seconds'),
          NULL
        ) AS frame_hover_policy_seconds,
        if(
          event_name = 'session_frame' AND notEmpty(ifNull(metadata, '')) AND isValidJSON(metadata),
          nullIf(JSONExtractString(metadata, 'journey_stage'), ''),
          NULL
        ) AS frame_journey_stage
      FROM raw_events
      WHERE notEmpty(ifNull(shop_domain, ''))
        AND notEmpty(ifNull(session_id, ''))
        AND coalesce(server_timestamp, client_timestamp) IS NOT NULL
    ),
    deduped_events_raw AS (
      SELECT
        argMax(store_id, tuple(notEmpty(ifNull(store_id, '')), event_ts)) AS store_id,
        argMax(shop_domain, tuple(notEmpty(ifNull(shop_domain, '')), event_ts)) AS shop_domain,
        argMax(session_id, tuple(notEmpty(ifNull(session_id, '')), event_ts)) AS session_id,
        argMax(visitor_id, tuple(notEmpty(ifNull(visitor_id, '')), event_ts)) AS visitor_id,
        argMax(experiment_variant, tuple(notEmpty(ifNull(experiment_variant, '')), event_ts)) AS experiment_variant,
        argMax(page_url, tuple(notEmpty(ifNull(page_url, '')), event_ts)) AS page_url,
        argMax(referrer, tuple(notEmpty(ifNull(referrer, '')), event_ts)) AS referrer,
        event_id,
        argMax(event_name, event_ts) AS event_name,
        max(client_timestamp) AS client_timestamp,
        max(server_timestamp) AS server_timestamp,
        argMax(metadata, event_ts) AS metadata,
        max(metadata_malformed) AS metadata_malformed,
        argMax(discount_status, tuple(notEmpty(ifNull(discount_status, '')), event_ts)) AS discount_status,
        argMax(scroll_milestone, tuple(scroll_milestone IS NOT NULL, event_ts)) AS scroll_milestone,
        argMax(frame_t_seconds, tuple(frame_t_seconds IS NOT NULL, event_ts)) AS frame_t_seconds,
        argMax(frame_mouse_velocity_avg, tuple(frame_mouse_velocity_avg IS NOT NULL, event_ts)) AS frame_mouse_velocity_avg,
        argMax(frame_mouse_velocity_max, tuple(frame_mouse_velocity_max IS NOT NULL, event_ts)) AS frame_mouse_velocity_max,
        argMax(frame_friction_score, tuple(frame_friction_score IS NOT NULL, event_ts)) AS frame_friction_score,
        argMax(frame_hesitation_score, tuple(frame_hesitation_score IS NOT NULL, event_ts)) AS frame_hesitation_score,
        argMax(frame_intent_score, tuple(frame_intent_score IS NOT NULL, event_ts)) AS frame_intent_score,
        argMax(frame_hover_cta_seconds, tuple(frame_hover_cta_seconds IS NOT NULL, event_ts)) AS frame_hover_cta_seconds,
        argMax(frame_hover_price_seconds, tuple(frame_hover_price_seconds IS NOT NULL, event_ts)) AS frame_hover_price_seconds,
        argMax(frame_hover_policy_seconds, tuple(frame_hover_policy_seconds IS NOT NULL, event_ts)) AS frame_hover_policy_seconds,
        argMax(frame_journey_stage, tuple(notEmpty(ifNull(frame_journey_stage, '')), event_ts)) AS frame_journey_stage,
        max(event_ts) AS latest_event_ts
      FROM raw_base
      WHERE notEmpty(ifNull(event_id, ''))
      GROUP BY event_id

      UNION ALL

      SELECT
        store_id,
        shop_domain,
        session_id,
        visitor_id,
        experiment_variant,
        page_url,
        referrer,
        event_id,
        event_name,
        client_timestamp,
        server_timestamp,
        metadata,
        metadata_malformed,
        discount_status,
        scroll_milestone,
        frame_t_seconds,
        frame_mouse_velocity_avg,
        frame_mouse_velocity_max,
        frame_friction_score,
        frame_hesitation_score,
        frame_intent_score,
        frame_hover_cta_seconds,
        frame_hover_price_seconds,
        frame_hover_policy_seconds,
        frame_journey_stage,
        event_ts AS latest_event_ts
      FROM raw_base
      WHERE empty(ifNull(event_id, ''))
    ),
    deduped_events AS (
      SELECT
        store_id,
        shop_domain,
        session_id,
        visitor_id,
        experiment_variant,
        page_url,
        referrer,
        event_id,
        event_name,
        latest_event_ts AS event_ts,
        client_timestamp,
        server_timestamp,
        metadata,
        metadata_malformed,
        discount_status,
        scroll_milestone,
        frame_t_seconds,
        frame_mouse_velocity_avg,
        frame_mouse_velocity_max,
        frame_friction_score,
        frame_hesitation_score,
        frame_intent_score,
        frame_hover_cta_seconds,
        frame_hover_price_seconds,
        frame_hover_policy_seconds,
        frame_journey_stage
      FROM deduped_events_raw
    ),
    session_features AS (
      SELECT
        argMax(store_id, tuple(notEmpty(ifNull(store_id, '')), event_ts)) AS store_id,
        shop_domain,
        session_id,
        argMax(visitor_id, tuple(notEmpty(ifNull(visitor_id, '')), event_ts)) AS visitor_id,
        argMax(experiment_variant, tuple(notEmpty(ifNull(experiment_variant, '')), event_ts)) AS experiment_variant,
        min(event_ts) AS first_seen_at,
        max(event_ts) AS last_seen_at,
        minIf(event_ts, event_name = 'page_view') AS first_page_view_at,
        minIf(event_ts, event_name = 'product_view') AS first_product_view_at,
        minIf(event_ts, event_name = 'add_to_cart') AS first_add_to_cart_at,
        minIf(event_ts, event_name = 'cart_open') AS first_cart_open_at,
        minIf(event_ts, event_name = 'begin_checkout') AS first_begin_checkout_at,
        minIf(event_ts, event_name = 'checkout_back') AS first_checkout_back_at,
        minIf(event_ts, event_name = 'purchase') AS first_purchase_at,
        minIf(event_ts, event_name = 'intervention_triggered') AS first_intervention_triggered_at,
        count() AS total_events,
        countIf(event_name = 'page_view') AS page_views,
        countIf(event_name = 'product_view') AS product_views,
        countIf(event_name = 'add_to_cart') AS add_to_cart_count,
        countIf(event_name = 'cart_open') AS cart_open_count,
        countIf(event_name = 'cart_close') AS cart_close_count,
        countIf(event_name = 'begin_checkout') AS begin_checkout_count,
        countIf(event_name = 'checkout_back') AS checkout_back_count,
        countIf(event_name = 'purchase') AS purchase_count,
        countIf(event_name = 'coupon_field_focus') AS coupon_field_focus_count,
        countIf(event_name = 'discount_code_applied') AS discount_code_applied_count,
        countIf(event_name = 'discount_code_applied' AND discount_status = 'success') AS discount_code_success_count,
        countIf(event_name = 'discount_code_applied' AND discount_status = 'invalid_code') AS discount_code_invalid_count,
        countIf(event_name = 'quantity_change') AS quantity_change_count,
        countIf(event_name = 'variant_change') AS variant_change_count,
        countIf(event_name = 'policy_page_view') AS policy_page_view_count,
        countIf(event_name = 'scroll_depth_reached') AS scroll_depth_reached_count,
        countIf(event_name = 'scroll_depth_reached' AND scroll_milestone = 0.25) AS scroll_25_count,
        countIf(event_name = 'scroll_depth_reached' AND scroll_milestone = 0.50) AS scroll_50_count,
        countIf(event_name = 'scroll_depth_reached' AND scroll_milestone = 0.75) AS scroll_75_count,
        countIf(event_name = 'scroll_depth_reached' AND scroll_milestone = 1.00) AS scroll_100_count,
        countIf(event_name = 'product_dwell_12s') AS product_dwell_12s_count,
        countIf(event_name = 'review_section_dwell_10s') AS review_section_dwell_10s_count,
        countIf(event_name = 'cta_idle_15s') AS cta_idle_15s_count,
        countIf(event_name = 'rage_click') AS rage_click_count,
        countIf(event_name = 'intervention_triggered') AS intervention_triggered_count,
        avgIf(frame_mouse_velocity_avg, event_name = 'session_frame' AND frame_mouse_velocity_avg IS NOT NULL) AS average_mouse_velocity,
        maxIf(frame_mouse_velocity_max, event_name = 'session_frame' AND frame_mouse_velocity_max IS NOT NULL) AS max_mouse_velocity,
        maxIf(frame_friction_score, event_name = 'session_frame' AND frame_friction_score IS NOT NULL) AS max_friction_score,
        maxIf(frame_hesitation_score, event_name = 'session_frame' AND frame_hesitation_score IS NOT NULL) AS max_hesitation_score,
        maxIf(frame_intent_score, event_name = 'session_frame' AND frame_intent_score IS NOT NULL) AS max_intent_score,
        argMax(frame_t_seconds, tuple(ifNull(frame_friction_score, -1), event_ts)) AS peak_friction_time_seconds,
        sumIf(frame_hover_cta_seconds, event_name = 'session_frame' AND frame_hover_cta_seconds IS NOT NULL) AS hover_cta_total_seconds,
        sumIf(frame_hover_price_seconds, event_name = 'session_frame' AND frame_hover_price_seconds IS NOT NULL) AS hover_price_total_seconds,
        sumIf(frame_hover_policy_seconds, event_name = 'session_frame' AND frame_hover_policy_seconds IS NOT NULL) AS hover_policy_total_seconds,
        argMax(frame_journey_stage, tuple(notEmpty(ifNull(frame_journey_stage, '')), event_ts)) AS final_stage_before_exit,
        sum(metadata_malformed) AS malformed_metadata_count
      FROM deduped_events
      GROUP BY shop_domain, session_id
    )
  `
}

export function buildSessionFeaturesSelectSql({
  whereClause = '',
  orderBy = 'last_seen_at DESC, shop_domain ASC, session_id ASC',
  limit = null
} = {}) {
  const normalizedLimit = sanitizeLimit(limit)

  return `
    ${buildSessionFeaturesBaseCte()}
    SELECT
      store_id,
      shop_domain,
      session_id,
      visitor_id,
      experiment_variant,
      first_seen_at,
      last_seen_at,
      first_page_view_at,
      first_product_view_at,
      first_add_to_cart_at,
      first_cart_open_at,
      first_begin_checkout_at,
      first_checkout_back_at,
      first_purchase_at,
      first_intervention_triggered_at,
      if(last_seen_at >= first_seen_at, dateDiff('second', first_seen_at, last_seen_at), NULL) AS session_duration_seconds,
      if(first_product_view_at >= first_seen_at, dateDiff('second', first_seen_at, first_product_view_at), NULL) AS time_to_first_product_view_seconds,
      if(first_add_to_cart_at >= first_seen_at, dateDiff('second', first_seen_at, first_add_to_cart_at), NULL) AS time_to_first_add_to_cart_seconds,
      if(first_begin_checkout_at >= first_seen_at, dateDiff('second', first_seen_at, first_begin_checkout_at), NULL) AS time_to_first_begin_checkout_seconds,
      if(first_purchase_at >= first_seen_at, dateDiff('second', first_seen_at, first_purchase_at), NULL) AS time_to_first_purchase_seconds,
      if(
        first_purchase_at >= first_intervention_triggered_at AND first_intervention_triggered_at IS NOT NULL,
        dateDiff('second', first_intervention_triggered_at, first_purchase_at),
        NULL
      ) AS time_from_first_intervention_to_purchase_seconds,
      total_events,
      page_views,
      product_views,
      add_to_cart_count,
      cart_open_count,
      cart_close_count,
      begin_checkout_count,
      checkout_back_count,
      purchase_count,
      coupon_field_focus_count,
      discount_code_applied_count,
      discount_code_success_count,
      discount_code_invalid_count,
      quantity_change_count,
      variant_change_count,
      policy_page_view_count,
      scroll_depth_reached_count,
      scroll_25_count,
      scroll_50_count,
      scroll_75_count,
      scroll_100_count,
      product_dwell_12s_count,
      review_section_dwell_10s_count,
      cta_idle_15s_count,
      rage_click_count,
      intervention_triggered_count,
      average_mouse_velocity,
      max_mouse_velocity,
      max_friction_score,
      max_hesitation_score,
      max_intent_score,
      peak_friction_time_seconds,
      hover_cta_total_seconds,
      hover_price_total_seconds,
      hover_policy_total_seconds,
      final_stage_before_exit,
      begin_checkout_count > 0 AS reached_checkout,
      purchase_count > 0 AS purchased,
      intervention_triggered_count > 0 AS had_intervention,
      add_to_cart_count > 0 AND begin_checkout_count = 0 AND purchase_count = 0 AS provisional_abandoned_cart,
      begin_checkout_count > 0 AND purchase_count = 0 AS provisional_abandoned_checkout,
      dateDiff('minute', last_seen_at, now()) >= 30 AS session_inactive_30m,
      malformed_metadata_count
    FROM session_features
    ${normalizeWhereClause(whereClause)}
    ORDER BY ${orderBy}
    ${normalizedLimit ? `LIMIT ${normalizedLimit}` : ''}
  `
}
