-- Make "future-only" benchmark consent authoritative at the database boundary.
-- Consent timestamps come from the server and cannot be backdated while opt-in is active.

create or replace function public.agent_eta_normalize_benchmark_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.benchmark_contribution_enabled then
    new.benchmark_consent_version := null;
    new.benchmark_consented_at := null;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.benchmark_consented_at := statement_timestamp();
    return new;
  end if;

  if not old.benchmark_contribution_enabled
     or old.benchmark_consent_version is distinct from new.benchmark_consent_version then
    new.benchmark_consented_at := statement_timestamp();
  else
    new.benchmark_consented_at := old.benchmark_consented_at;
  end if;

  return new;
end;
$$;

drop trigger if exists user_sync_settings_normalize_benchmark_consent
on public.user_sync_settings;

create trigger user_sync_settings_normalize_benchmark_consent
before insert or update of benchmark_contribution_enabled, benchmark_consent_version, benchmark_consented_at
on public.user_sync_settings
for each row execute function public.agent_eta_normalize_benchmark_consent();

create or replace function public.contribute_private_run(
  p_private_run_id uuid,
  p_consent_version text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_contribution_id uuid;
  v_enabled boolean;
  v_consent_version text;
  v_consented_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '28000';
  end if;

  if p_consent_version is null
     or length(p_consent_version) not between 1 and 40
     or p_consent_version <> btrim(p_consent_version) then
    raise exception 'A valid consent version is required' using errcode = '22023';
  end if;

  select
    benchmark_contribution_enabled,
    benchmark_consent_version,
    benchmark_consented_at
  into v_enabled, v_consent_version, v_consented_at
  from public.user_sync_settings
  where user_id = v_user_id;

  if not found
     or not v_enabled
     or v_consent_version is distinct from p_consent_version
     or v_consented_at is null then
    raise exception 'Benchmark contribution consent is not active' using errcode = '42501';
  end if;

  insert into public.benchmark_contributions (
    user_id,
    private_run_id,
    provider,
    model,
    effort,
    speed,
    task_class,
    forecast_p50_minutes,
    forecast_p80_minutes,
    forecast_p95_minutes,
    actual_minutes,
    consent_version,
    consented_at,
    run_created_at
  )
  select
    run.user_id,
    run.id,
    run.provider,
    run.model,
    run.effort,
    run.speed,
    run.task_class,
    run.forecast_p50_minutes,
    run.forecast_p80_minutes,
    run.forecast_p95_minutes,
    run.actual_minutes,
    v_consent_version,
    v_consented_at,
    run.client_created_at
  from public.private_runs as run
  where run.id = p_private_run_id
    and run.user_id = v_user_id
    and run.outcome = 'success'
    and run.forecast_p80_minutes is not null
    and run.actual_minutes is not null
    and run.source <> 'import'
    and run.created_at >= v_consented_at
  on conflict (private_run_id) do update
  set
    provider = excluded.provider,
    model = excluded.model,
    effort = excluded.effort,
    speed = excluded.speed,
    task_class = excluded.task_class,
    forecast_p50_minutes = excluded.forecast_p50_minutes,
    forecast_p80_minutes = excluded.forecast_p80_minutes,
    forecast_p95_minutes = excluded.forecast_p95_minutes,
    actual_minutes = excluded.actual_minutes,
    consent_version = excluded.consent_version,
    consented_at = excluded.consented_at,
    run_created_at = excluded.run_created_at,
    contributed_at = statement_timestamp()
  returning id into v_contribution_id;

  if v_contribution_id is null then
    raise exception 'Only a future completed run created after active consent can be contributed'
      using errcode = '22023';
  end if;

  return v_contribution_id;
end;
$$;

revoke all on function public.agent_eta_normalize_benchmark_consent() from public, anon, authenticated;
grant execute on function public.agent_eta_normalize_benchmark_consent() to service_role;

revoke all on function public.contribute_private_run(uuid, text) from public, anon;
grant execute on function public.contribute_private_run(uuid, text) to authenticated, service_role;

comment on function public.agent_eta_normalize_benchmark_consent() is
  'Server-normalizes future-only benchmark consent timestamps and blocks client backdating.';

comment on function public.contribute_private_run(uuid, text) is
  'Copies one future eligible private run into the retractable benchmark pool after explicit active consent.';
