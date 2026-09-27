create table if not exists public.schedule_deliveries (
  user_id uuid not null references auth.users(id) on delete cascade,
  send_on date not null,
  status text not null default 'attempted',
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (user_id, send_on),
  constraint schedule_deliveries_status_check check (status in ('attempted', 'sent', 'failed'))
);

alter table public.schedule_deliveries enable row level security;
-- Only the backend service role writes this delivery ledger.
