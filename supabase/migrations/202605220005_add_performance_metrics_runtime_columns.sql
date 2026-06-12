alter table if exists public.performance_metrics
  add column if not exists route_runtime text not null default 'unknown';

alter table if exists public.performance_metrics
  add column if not exists deployment_version text null;

do $$
begin
  if to_regclass('public.performance_metrics') is not null then
    execute '
      create index if not exists performance_metrics_route_runtime_created_at_idx
      on public.performance_metrics (route_runtime, created_at desc)
    ';
  end if;
end
$$;
