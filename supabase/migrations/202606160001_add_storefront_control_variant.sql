alter table if exists public.storefront_intervention_variants
  add column if not exists is_control boolean not null default false;

create unique index if not exists storefront_intervention_variants_one_control_idx
  on public.storefront_intervention_variants (
    shop_domain,
    cohort_key,
    coalesce(store_id, '')
  )
  where is_control = true;
