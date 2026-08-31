-- Keep the origin fields used by future-only benchmark eligibility immutable.

create or replace function public.agent_eta_preserve_private_run_origin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.id := old.id;
  new.user_id := old.user_id;
  new.client_run_id := old.client_run_id;
  new.source := old.source;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists private_runs_preserve_origin on public.private_runs;

create trigger private_runs_preserve_origin
before update on public.private_runs
for each row execute function public.agent_eta_preserve_private_run_origin();

revoke all on function public.agent_eta_preserve_private_run_origin() from public, anon, authenticated;
grant execute on function public.agent_eta_preserve_private_run_origin() to service_role;

comment on function public.agent_eta_preserve_private_run_origin() is
  'Makes private-run identity, ownership, source, and server creation time immutable after insert.';
