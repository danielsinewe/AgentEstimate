-- Delete only Agent ETA-owned data. Authentication belongs to the shared
-- Supabase project and must remain available to Daniel's other products.
create or replace function project_agent_eta_v2.delete_agent_eta_data()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  delete from project_agent_eta_v2.benchmark_contributions
  where user_id = caller_id;

  delete from project_agent_eta_v2.private_runs
  where user_id = caller_id;

  delete from project_agent_eta_v2.user_sync_settings
  where user_id = caller_id;

  return true;
end;
$$;

revoke all on function project_agent_eta_v2.delete_agent_eta_data() from public, anon, authenticated;
grant execute on function project_agent_eta_v2.delete_agent_eta_data() to authenticated;

comment on function project_agent_eta_v2.delete_agent_eta_data() is
  'Deletes only the authenticated user data owned by Agent ETA; preserves the shared Auth identity.';;
