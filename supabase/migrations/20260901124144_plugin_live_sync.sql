begin;

-- Plugin sync is opt-in and token based so Codex and Claude Code do not need
-- access to the user's browser session. Tokens are stored as SHA-256 digests;
-- only the one-time plaintext connection code leaves this function.
create table "project_agent_eta_v2".plugin_sync_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash bytea not null unique,
  token_prefix text not null,
  label text not null default 'Coding agent',
  created_at timestamptz not null default statement_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  synced_run_count bigint not null default 0,

  constraint plugin_sync_connections_prefix_check check (
    token_prefix ~ '^aet_[a-f0-9]{8}$'
  ),
  constraint plugin_sync_connections_label_check check (
    length(label) between 1 and 60
    and label = btrim(label)
    and label !~ '[[:cntrl:]]'
  ),
  constraint plugin_sync_connections_count_check check (synced_run_count >= 0)
);

create index plugin_sync_connections_user_idx
  on "project_agent_eta_v2".plugin_sync_connections (user_id, created_at desc);

alter table "project_agent_eta_v2".plugin_sync_connections enable row level security;

alter table "project_agent_eta_v2".private_runs
  add column prompt_characters integer,
  add column prompt_words integer,
  add column prompt_lines integer,
  add column prompt_checklist_items integer,
  add column repo_file_count integer,
  add column repo_lines_of_code bigint,
  add column repo_test_file_count integer,
  add column repo_language_count integer,
  add column repo_dependency_count integer,
  add column repo_package_count integer,
  add column repo_dirty_file_count integer,
  add constraint private_runs_derived_counts_check check (
    (prompt_characters is null or prompt_characters >= 0)
    and (prompt_words is null or prompt_words >= 0)
    and (prompt_lines is null or prompt_lines >= 0)
    and (prompt_checklist_items is null or prompt_checklist_items >= 0)
    and (repo_file_count is null or repo_file_count >= 0)
    and (repo_lines_of_code is null or repo_lines_of_code >= 0)
    and (repo_test_file_count is null or repo_test_file_count >= 0)
    and (repo_language_count is null or repo_language_count >= 0)
    and (repo_dependency_count is null or repo_dependency_count >= 0)
    and (repo_package_count is null or repo_package_count >= 0)
    and (repo_dirty_file_count is null or repo_dirty_file_count >= 0)
  );

create or replace function "project_agent_eta_v2".create_plugin_sync_connection(
  p_label text default 'Coding agent'
)
returns table (
  id uuid,
  token text,
  token_prefix text,
  label text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_token text;
  v_label text := coalesce(nullif(btrim(p_label), ''), 'Coding agent');
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '28000';
  end if;

  if length(v_label) > 60 or v_label ~ '[[:cntrl:]]' then
    raise exception 'Connection label is invalid' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from "project_agent_eta_v2".user_sync_settings as settings
    where settings.user_id = v_user_id
      and settings.cloud_sync_enabled
  ) then
    raise exception 'Private cloud sync must be enabled first' using errcode = '42501';
  end if;

  if (
    select count(*)
    from "project_agent_eta_v2".plugin_sync_connections as connection
    where connection.user_id = v_user_id
      and connection.revoked_at is null
  ) >= 10 then
    raise exception 'Revoke an existing connection before adding another' using errcode = '54000';
  end if;

  v_token := 'aet_' || encode(extensions.gen_random_bytes(32), 'hex');

  return query
  insert into "project_agent_eta_v2".plugin_sync_connections as connection (
    user_id,
    token_hash,
    token_prefix,
    label
  ) values (
    v_user_id,
    extensions.digest(v_token, 'sha256'),
    left(v_token, 12),
    v_label
  )
  returning
    connection.id,
    v_token,
    connection.token_prefix,
    connection.label,
    connection.created_at;
end;
$$;

create or replace function "project_agent_eta_v2".list_plugin_sync_connections()
returns table (
  id uuid,
  token_prefix text,
  label text,
  created_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  synced_run_count bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    connection.id,
    connection.token_prefix,
    connection.label,
    connection.created_at,
    connection.last_used_at,
    connection.revoked_at,
    connection.synced_run_count
  from "project_agent_eta_v2".plugin_sync_connections as connection
  where connection.user_id = auth.uid()
  order by connection.created_at desc;
$$;

create or replace function "project_agent_eta_v2".revoke_plugin_sync_connection(
  p_connection_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '28000';
  end if;

  update "project_agent_eta_v2".plugin_sync_connections
  set revoked_at = coalesce(revoked_at, statement_timestamp())
  where id = p_connection_id
    and user_id = v_user_id;

  return found;
end;
$$;

create or replace function "project_agent_eta_v2".sync_plugin_runs(
  p_token text,
  p_runs jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection_id uuid;
  v_user_id uuid;
  v_run jsonb;
  v_run_count integer;
  v_accepted_ids jsonb;
  v_allowed_keys constant text[] := array[
    'client_run_id',
    'provider',
    'model',
    'effort',
    'speed',
    'task_class',
    'scope',
    'ambiguity',
    'included_tests',
    'included_browser',
    'included_external_services',
    'included_deploy',
    'destructive',
    'prompt_characters',
    'prompt_words',
    'prompt_lines',
    'prompt_checklist_items',
    'repo_file_count',
    'repo_lines_of_code',
    'repo_test_file_count',
    'repo_language_count',
    'repo_dependency_count',
    'repo_package_count',
    'repo_dirty_file_count',
    'forecast_p25_minutes',
    'forecast_p50_minutes',
    'forecast_p80_minutes',
    'forecast_p95_minutes',
    'actual_minutes',
    'outcome',
    'client_created_at'
  ];
begin
  if p_token is null or p_token !~ '^aet_[a-f0-9]{64}$' then
    raise exception 'Connection token is invalid' using errcode = '28000';
  end if;

  select connection.id, connection.user_id
  into v_connection_id, v_user_id
  from "project_agent_eta_v2".plugin_sync_connections as connection
  where connection.token_hash = extensions.digest(p_token, 'sha256')
    and connection.revoked_at is null;

  if not found then
    raise exception 'Connection token is invalid or revoked' using errcode = '28000';
  end if;

  if not exists (
    select 1
    from "project_agent_eta_v2".user_sync_settings as settings
    where settings.user_id = v_user_id
      and settings.cloud_sync_enabled
  ) then
    raise exception 'Private cloud sync is disabled' using errcode = '42501';
  end if;

  if p_runs is null or jsonb_typeof(p_runs) <> 'array' then
    raise exception 'Runs must be a JSON array' using errcode = '22023';
  end if;

  if pg_column_size(p_runs) > 262144 then
    raise exception 'Sync payload is too large' using errcode = '54000';
  end if;

  v_run_count := jsonb_array_length(p_runs);
  if v_run_count < 1 or v_run_count > 100 then
    raise exception 'Sync batches must contain 1 to 100 runs' using errcode = '22023';
  end if;

  for v_run in select value from jsonb_array_elements(p_runs)
  loop
    if jsonb_typeof(v_run) <> 'object' then
      raise exception 'Each run must be a JSON object' using errcode = '22023';
    end if;
    if exists (
      select 1
      from jsonb_object_keys(v_run) as supplied(key)
      where not (supplied.key = any(v_allowed_keys))
    ) then
      raise exception 'Run contains a prohibited field' using errcode = '22023';
    end if;
  end loop;

  with parsed as (
    select *
    from jsonb_to_recordset(p_runs) as run (
      client_run_id text,
      provider text,
      model text,
      effort text,
      speed text,
      task_class text,
      scope text,
      ambiguity text,
      included_tests boolean,
      included_browser boolean,
      included_external_services boolean,
      included_deploy boolean,
      destructive boolean,
      prompt_characters integer,
      prompt_words integer,
      prompt_lines integer,
      prompt_checklist_items integer,
      repo_file_count integer,
      repo_lines_of_code bigint,
      repo_test_file_count integer,
      repo_language_count integer,
      repo_dependency_count integer,
      repo_package_count integer,
      repo_dirty_file_count integer,
      forecast_p25_minutes numeric,
      forecast_p50_minutes numeric,
      forecast_p80_minutes numeric,
      forecast_p95_minutes numeric,
      actual_minutes numeric,
      outcome text,
      client_created_at timestamptz
    )
  ),
  upserted as (
    insert into "project_agent_eta_v2".private_runs as target (
      user_id,
      client_run_id,
      schema_version,
      source,
      provider,
      model,
      effort,
      speed,
      task_class,
      scope,
      ambiguity,
      included_tests,
      included_browser,
      included_external_services,
      included_deploy,
      destructive,
      prompt_characters,
      prompt_words,
      prompt_lines,
      prompt_checklist_items,
      repo_file_count,
      repo_lines_of_code,
      repo_test_file_count,
      repo_language_count,
      repo_dependency_count,
      repo_package_count,
      repo_dirty_file_count,
      forecast_p25_minutes,
      forecast_p50_minutes,
      forecast_p80_minutes,
      forecast_p95_minutes,
      actual_minutes,
      outcome,
      client_created_at
    )
    select
      v_user_id,
      parsed.client_run_id,
      1,
      'plugin',
      parsed.provider,
      parsed.model,
      parsed.effort,
      parsed.speed,
      parsed.task_class,
      parsed.scope,
      parsed.ambiguity,
      coalesce(parsed.included_tests, false),
      coalesce(parsed.included_browser, false),
      coalesce(parsed.included_external_services, false),
      coalesce(parsed.included_deploy, false),
      coalesce(parsed.destructive, false),
      parsed.prompt_characters,
      parsed.prompt_words,
      parsed.prompt_lines,
      parsed.prompt_checklist_items,
      parsed.repo_file_count,
      parsed.repo_lines_of_code,
      parsed.repo_test_file_count,
      parsed.repo_language_count,
      parsed.repo_dependency_count,
      parsed.repo_package_count,
      parsed.repo_dirty_file_count,
      parsed.forecast_p25_minutes,
      parsed.forecast_p50_minutes,
      parsed.forecast_p80_minutes,
      parsed.forecast_p95_minutes,
      parsed.actual_minutes,
      parsed.outcome,
      parsed.client_created_at
    from parsed
    where parsed.outcome in ('success', 'failed', 'censored')
      and parsed.actual_minutes is not null
    on conflict (user_id, client_run_id) do update
    set
      provider = excluded.provider,
      model = excluded.model,
      effort = excluded.effort,
      speed = excluded.speed,
      task_class = excluded.task_class,
      scope = excluded.scope,
      ambiguity = excluded.ambiguity,
      included_tests = excluded.included_tests,
      included_browser = excluded.included_browser,
      included_external_services = excluded.included_external_services,
      included_deploy = excluded.included_deploy,
      destructive = excluded.destructive,
      prompt_characters = excluded.prompt_characters,
      prompt_words = excluded.prompt_words,
      prompt_lines = excluded.prompt_lines,
      prompt_checklist_items = excluded.prompt_checklist_items,
      repo_file_count = excluded.repo_file_count,
      repo_lines_of_code = excluded.repo_lines_of_code,
      repo_test_file_count = excluded.repo_test_file_count,
      repo_language_count = excluded.repo_language_count,
      repo_dependency_count = excluded.repo_dependency_count,
      repo_package_count = excluded.repo_package_count,
      repo_dirty_file_count = excluded.repo_dirty_file_count,
      forecast_p25_minutes = excluded.forecast_p25_minutes,
      forecast_p50_minutes = excluded.forecast_p50_minutes,
      forecast_p80_minutes = excluded.forecast_p80_minutes,
      forecast_p95_minutes = excluded.forecast_p95_minutes,
      actual_minutes = excluded.actual_minutes,
      outcome = excluded.outcome,
      client_created_at = excluded.client_created_at
    where target.source = 'plugin'
    returning client_run_id
  )
  select coalesce(jsonb_agg(client_run_id order by client_run_id), '[]'::jsonb)
  into v_accepted_ids
  from upserted;

  update "project_agent_eta_v2".plugin_sync_connections
  set
    last_used_at = statement_timestamp(),
    synced_run_count = synced_run_count + jsonb_array_length(v_accepted_ids)
  where id = v_connection_id;

  return jsonb_build_object(
    'accepted', jsonb_array_length(v_accepted_ids),
    'runIds', v_accepted_ids,
    'syncedAt', statement_timestamp()
  );
end;
$$;

revoke all on table "project_agent_eta_v2".plugin_sync_connections
from public, anon, authenticated;
grant all on table "project_agent_eta_v2".plugin_sync_connections to service_role;

revoke all on function "project_agent_eta_v2".create_plugin_sync_connection(text)
from public, anon, authenticated;
revoke all on function "project_agent_eta_v2".list_plugin_sync_connections()
from public, anon, authenticated;
revoke all on function "project_agent_eta_v2".revoke_plugin_sync_connection(uuid)
from public, anon, authenticated;
revoke all on function "project_agent_eta_v2".sync_plugin_runs(text, jsonb)
from public, anon, authenticated;

grant execute on function "project_agent_eta_v2".create_plugin_sync_connection(text)
to authenticated;
grant execute on function "project_agent_eta_v2".list_plugin_sync_connections()
to authenticated;
grant execute on function "project_agent_eta_v2".revoke_plugin_sync_connection(uuid)
to authenticated;
grant execute on function "project_agent_eta_v2".sync_plugin_runs(text, jsonb)
to anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'project_agent_eta_v2'
      and tablename = 'public_dashboard_snapshots'
  ) then
    alter publication supabase_realtime
      add table "project_agent_eta_v2".public_dashboard_snapshots;
  end if;
end;
$$;

comment on table "project_agent_eta_v2".plugin_sync_connections is
  'Revocable, hashed credentials for opt-in plugin-to-cloud sync. Plaintext tokens are never stored.';
comment on function "project_agent_eta_v2".sync_plugin_runs(text, jsonb) is
  'Accepts only allowlisted, derived run telemetry. Prompts, code, repositories, paths, sessions, and account ids are rejected or absent.';

notify pgrst, 'reload schema';
commit;
