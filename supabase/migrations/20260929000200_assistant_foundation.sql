-- Additive assistant state. Operational schedule/tasks/grades remain authoritative.
create table public.assistant_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  memory_key text not null check (memory_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  type text not null check (type in ('preference','fact','goal','constraint','learning')),
  content text not null check (length(btrim(content)) between 8 and 500),
  confidence double precision not null check (confidence between 0.8 and 1),
  importance double precision not null check (importance between 0 and 1),
  source text not null check (source in ('telegram','tma','web')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz,
  archived_at timestamptz,
  unique (user_id, memory_key)
);

create index assistant_memories_active_rank_idx
  on public.assistant_memories (user_id, importance desc, updated_at desc)
  where archived_at is null;
create index assistant_memories_active_type_idx
  on public.assistant_memories (user_id, type, updated_at desc)
  where archived_at is null;

-- Atomic same-key replacement, exact retry dedupe, and revision tracking.
-- Retrieval touches do not make an old fact appear recently learned.
create function public.assistant_memory_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_at := old.created_at;
  if row(new.content, new.type, new.confidence, new.importance, new.archived_at)
    is distinct from row(old.content, old.type, old.confidence, old.importance, old.archived_at) then
    new.revision := old.revision + 1;
    new.updated_at := now();
  else
    new.revision := old.revision;
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;
create trigger assistant_memories_revision before update on public.assistant_memories
  for each row execute function public.assistant_memory_revision();

create table public.assistant_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (length(request_id) between 1 and 120),
  conversation_id text not null check (length(conversation_id) between 1 and 120),
  source text not null check (source in ('telegram','tma','web')),
  message_length integer not null check (message_length between 1 and 4096),
  status text not null default 'running' check (status in ('running','succeeded','rejected','failed','unhandled')),
  intent text check (intent ~ '^[a-z][a-z0-9_.]{0,79}$'),
  tool_name text check (tool_name ~ '^[a-z][a-z0-9_.]{0,79}$'),
  duration_ms integer check (duration_ms >= 0),
  error_code text check (error_code in ('invalid_input','unauthorized','unknown_tool','confirmation_required','handler_error','model_error','storage_error','busy')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, request_id)
);
create index assistant_actions_user_created_idx on public.assistant_actions (user_id, created_at desc);
create trigger assistant_actions_updated before update on public.assistant_actions
  for each row execute function public.set_updated_at();

alter table public.assistant_memories enable row level security;
alter table public.assistant_actions enable row level security;
revoke all on public.assistant_memories, public.assistant_actions from anon, authenticated;
grant select on public.assistant_memories, public.assistant_actions to authenticated;
grant all on public.assistant_memories, public.assistant_actions to service_role;
create policy assistant_memories_owner_read on public.assistant_memories for select to authenticated
  using (public.lifeos_is_owner(user_id));
create policy assistant_actions_owner_read on public.assistant_actions for select to authenticated
  using (public.lifeos_is_owner(user_id));
-- No client writes: candidate policy and audit idempotency are backend boundaries.
