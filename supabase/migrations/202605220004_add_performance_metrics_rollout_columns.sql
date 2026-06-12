alter table if exists public.performance_metrics
  add column if not exists pilot_cohort text not null default 'pilot_default';

alter table if exists public.performance_metrics
  add column if not exists rollout_key text not null default 'rule_based_pilot';

do $$
begin
  if to_regclass('public.performance_metrics') is not null then
    execute '
      create index if not exists performance_metrics_pilot_cohort_created_at_idx
      on public.performance_metrics (pilot_cohort, created_at desc)
    ';
  end if;
end
$$;
