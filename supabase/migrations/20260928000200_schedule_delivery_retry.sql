alter table public.schedule_deliveries
  add column if not exists claim_token uuid;

create or replace function public.claim_schedule_delivery(
  p_user_id uuid,
  p_send_on date,
  p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean;
begin
  insert into public.schedule_deliveries (
    user_id, send_on, status, attempted_at, claim_token
  ) values (
    p_user_id, p_send_on, 'attempted', now(), p_claim_token
  )
  on conflict (user_id, send_on) do update
    set status = 'attempted',
        attempted_at = now(),
        claim_token = excluded.claim_token,
        sent_at = null
    where public.schedule_deliveries.status = 'failed'
       or (
         public.schedule_deliveries.status = 'attempted'
         and public.schedule_deliveries.attempted_at < now() - interval '10 minutes'
       )
  returning true into claimed;

  if coalesce(claimed, false) then
    return 'claimed';
  end if;
  if exists (
    select 1 from public.schedule_deliveries
    where user_id = p_user_id and send_on = p_send_on and status = 'sent'
  ) then
    return 'sent';
  end if;
  return 'busy';
end;
$$;

revoke all on function public.claim_schedule_delivery(uuid, date, uuid) from public, anon, authenticated;
grant execute on function public.claim_schedule_delivery(uuid, date, uuid) to service_role;

comment on function public.claim_schedule_delivery(uuid, date, uuid) is
  'Atomically claims a daily schedule delivery. Failed attempts can retry; unfinished claims expire after ten minutes.';
