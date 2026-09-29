begin;
insert into auth.users(id) values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002');

set local role service_role;
insert into public.assistant_memories(user_id, memory_key, type, content, confidence, importance, source) values
  ('00000000-0000-0000-0000-000000000001', 'commute.duration', 'fact', 'Дорога занимает час', 1, 0.7, 'telegram'),
  ('00000000-0000-0000-0000-000000000002', 'commute.duration', 'fact', 'Дорога занимает двадцать минут', 1, 0.7, 'telegram');
-- Exact dedupe; scoped update does not change B.
insert into public.assistant_memories(user_id, memory_key, type, content, confidence, importance, source)
values ('00000000-0000-0000-0000-000000000001', 'commute.duration', 'fact', 'Дорога занимает час', 1, 0.7, 'telegram')
on conflict (user_id, memory_key) do update set content = excluded.content;
do $$ begin
  if (select count(*) from public.assistant_memories) <> 2 then raise exception 'dedupe failed'; end if;
  if exists (select from public.assistant_memories where revision <> 1) then raise exception 'dedupe increased revision'; end if;
end $$;
update public.assistant_memories set content = 'Дорога занимает сорок минут'
where user_id = '00000000-0000-0000-0000-000000000001' and memory_key = 'commute.duration';
update public.assistant_memories set last_accessed_at = now()
where user_id = '00000000-0000-0000-0000-000000000001';
do $$ begin
  if (select revision from public.assistant_memories where user_id = '00000000-0000-0000-0000-000000000001') <> 2 then raise exception 'revision failed'; end if;
  if (select revision from public.assistant_memories where user_id = '00000000-0000-0000-0000-000000000002') <> 1 then raise exception 'cross user update'; end if;
end $$;

insert into public.assistant_actions(user_id, request_id, conversation_id, source, message_length)
values ('00000000-0000-0000-0000-000000000001', 'telegram:1:1', 'telegram:1', 'telegram', 10);
do $$ begin
  begin
    insert into public.assistant_actions(user_id, request_id, conversation_id, source, message_length)
    values ('00000000-0000-0000-0000-000000000001', 'telegram:1:1', 'telegram:1', 'telegram', 10);
    raise exception 'duplicate action accepted';
  exception when unique_violation then null; end;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
do $$ begin
  if (select count(*) from public.assistant_memories) <> 1 then raise exception 'RLS leaked memory'; end if;
  if (select count(*) from public.assistant_actions) <> 1 then raise exception 'RLS lost own audit'; end if;
  begin
    update public.assistant_memories set content = 'bypassed backend policy';
    raise exception 'client write allowed';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
do $$ begin
  if (select count(*) from public.assistant_memories) <> 1 then raise exception 'RLS leaked other memory'; end if;
  if (select count(*) from public.assistant_actions) <> 0 then raise exception 'RLS leaked audit'; end if;
end $$;
set local role anon;
do $$ begin
  begin perform * from public.assistant_memories; raise exception 'anon read allowed';
  exception when insufficient_privilege then null; end;
end $$;

set local role service_role;
update public.assistant_memories set archived_at = now()
where user_id = '00000000-0000-0000-0000-000000000001' and memory_key = 'commute.duration';
do $$ begin
  if exists (select from public.assistant_memories where user_id = '00000000-0000-0000-0000-000000000001' and archived_at is null) then raise exception 'archive failed'; end if;
  if not exists (select from public.assistant_memories where user_id = '00000000-0000-0000-0000-000000000002' and archived_at is null) then raise exception 'archive touched B'; end if;
end $$;
rollback;
