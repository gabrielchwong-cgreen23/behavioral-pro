alter table public.stores
  add column if not exists settings jsonb not null default '{}'::jsonb;

alter table public.stores
  add column if not exists last_event_at timestamptz;

alter table public.stores
  add column if not exists last_decision_at timestamptz;
