begin;

-- These tables are intended for backend-only access via the service role.
alter table if exists public.session_state enable row level security;
alter table if exists public.performance_metrics enable row level security;
alter table if exists public.store_benchmarks enable row level security;
alter table if exists public.feedback enable row level security;

revoke all on public.session_state from public, anon, authenticated;
revoke all on public.performance_metrics from public, anon, authenticated;
revoke all on public.store_benchmarks from public, anon, authenticated;
revoke all on public.feedback from public, anon, authenticated;

alter function public.merge_session_state_counters(jsonb, jsonb)
  set search_path = public, pg_temp;

alter function public.upsert_session_state_counters(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  jsonb
)
  set search_path = public, pg_temp;

revoke all on function public.merge_session_state_counters(jsonb, jsonb)
  from public, anon, authenticated;

revoke all on function public.upsert_session_state_counters(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  jsonb
)
  from public, anon, authenticated;

grant execute on function public.merge_session_state_counters(jsonb, jsonb) to service_role;

grant execute on function public.upsert_session_state_counters(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  jsonb
)
  to service_role;

commit;
