alter table if exists public.performance_metrics
  add column if not exists outcome_status text not null default 'success';

alter table if exists public.performance_metrics
  add column if not exists response_status_code integer not null default 200;

do $$
begin
  if to_regclass('public.performance_metrics') is not null then
    execute '
      create index if not exists performance_metrics_outcome_status_created_at_idx
      on public.performance_metrics (outcome_status, created_at desc)
    ';
  end if;
end
$$;
