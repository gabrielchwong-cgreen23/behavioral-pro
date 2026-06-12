alter table if exists public.session_state
  add column if not exists signals jsonb not null default '{}'::jsonb;

create or replace function public.merge_session_state_signals(
  existing_signals jsonb,
  signal_updates jsonb
)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := coalesce(existing_signals, '{}'::jsonb);
  signal_entry record;
begin
  for signal_entry in
    select key, value
    from jsonb_each(coalesce(signal_updates, '{}'::jsonb))
  loop
    result := jsonb_set(
      result,
      array[signal_entry.key],
      signal_entry.value,
      true
    );
  end loop;

  return result;
end;
$$;

create or replace function public.upsert_session_state_counters(
  p_shop_domain text,
  p_session_id text,
  p_store_id text default null,
  p_visitor_id text default null,
  p_experiment_variant text default null,
  p_page_url text default null,
  p_referrer text default null,
  p_seen_at timestamptz default timezone('utc', now()),
  p_counter_deltas jsonb default '{}'::jsonb,
  p_signal_updates jsonb default '{}'::jsonb
)
returns public.session_state
language plpgsql
security definer
as $$
declare
  session_state_row public.session_state;
begin
  insert into public.session_state (
    shop_domain,
    session_id,
    store_id,
    visitor_id,
    experiment_variant,
    page_url,
    referrer,
    counters,
    signals,
    first_seen_at,
    last_seen_at,
    first_intervention_triggered_at,
    updated_at
  ) values (
    p_shop_domain,
    p_session_id,
    nullif(p_store_id, ''),
    nullif(p_visitor_id, ''),
    nullif(p_experiment_variant, ''),
    p_page_url,
    p_referrer,
    coalesce(p_counter_deltas, '{}'::jsonb),
    coalesce(p_signal_updates, '{}'::jsonb),
    coalesce(p_seen_at, timezone('utc', now())),
    coalesce(p_seen_at, timezone('utc', now())),
    case
      when coalesce((p_counter_deltas ->> 'intervention_triggered_count')::bigint, 0) > 0
        then coalesce(p_seen_at, timezone('utc', now()))
      else null
    end,
    timezone('utc', now())
  )
  on conflict (shop_domain, session_id) do update
  set
    store_id = coalesce(nullif(excluded.store_id, ''), session_state.store_id),
    visitor_id = coalesce(nullif(excluded.visitor_id, ''), session_state.visitor_id),
    experiment_variant = coalesce(
      nullif(excluded.experiment_variant, ''),
      session_state.experiment_variant
    ),
    page_url = coalesce(excluded.page_url, session_state.page_url),
    referrer = coalesce(excluded.referrer, session_state.referrer),
    counters = public.merge_session_state_counters(
      session_state.counters,
      excluded.counters
    ),
    signals = public.merge_session_state_signals(
      session_state.signals,
      excluded.signals
    ),
    first_seen_at = coalesce(
      session_state.first_seen_at,
      excluded.first_seen_at,
      timezone('utc', now())
    ),
    last_seen_at = greatest(
      coalesce(session_state.last_seen_at, excluded.last_seen_at, timezone('utc', now())),
      coalesce(excluded.last_seen_at, session_state.last_seen_at, timezone('utc', now()))
    ),
    first_intervention_triggered_at = coalesce(
      session_state.first_intervention_triggered_at,
      case
        when coalesce((excluded.counters ->> 'intervention_triggered_count')::bigint, 0) > 0
          then coalesce(excluded.last_seen_at, timezone('utc', now()))
        else null
      end
    ),
    updated_at = timezone('utc', now())
  returning * into session_state_row;

  return session_state_row;
end;
$$;
