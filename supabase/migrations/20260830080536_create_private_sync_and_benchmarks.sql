-- Agent ETA cloud data is private by default. Only pre-aggregated snapshots are public.
-- Raw prompts, repository names, repository paths, and source code are deliberately absent.
-- The filename matches the migration version recorded by the production project.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.agent_eta_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = statement_timestamp();
  return new;
end;
$$;

create table public.private_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_run_id text not null,
  schema_version smallint not null default 1,
  source text not null default 'web',
  provider text not null,
  model text not null,
  effort text not null,
  speed text not null,
  task_class text not null,
  scope text,
  ambiguity text,
  included_tests boolean not null default false,
  included_browser boolean not null default false,
  included_external_services boolean not null default false,
  included_deploy boolean not null default false,
  destructive boolean not null default false,
  forecast_p25_minutes numeric(12, 3),
  forecast_p50_minutes numeric(12, 3) not null,
  forecast_p80_minutes numeric(12, 3),
  forecast_p95_minutes numeric(12, 3),
  actual_minutes numeric(12, 3),
  outcome text not null default 'success',
  client_created_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),

  constraint private_runs_client_run_id_format check (
    length(client_run_id) between 1 and 128
    and client_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  constraint private_runs_schema_version_check check (schema_version = 1),
  constraint private_runs_source_check check (source in ('web', 'plugin', 'import')),
  constraint private_runs_provider_check check (provider in ('codex', 'claude')),
  constraint private_runs_model_check check (
    length(model) between 1 and 80
    and model = btrim(model)
    and model !~ '[[:cntrl:]]'
  ),
  constraint private_runs_effort_check check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  constraint private_runs_speed_check check (speed in ('standard', 'fast')),
  constraint private_runs_task_class_check check (
    task_class in ('question', 'research', 'review', 'diagnose', 'bugfix', 'feature', 'refactor', 'migration')
  ),
  constraint private_runs_scope_check check (
    scope is null or scope in ('micro', 'small', 'medium', 'large', 'project')
  ),
  constraint private_runs_ambiguity_check check (
    ambiguity is null or ambiguity in ('low', 'medium', 'high')
  ),
  constraint private_runs_outcome_check check (outcome in ('started', 'success', 'failed', 'censored')),
  constraint private_runs_forecast_values_check check (
    forecast_p50_minutes between 0.001 and 5256000
    and (forecast_p25_minutes is null or forecast_p25_minutes between 0.001 and 5256000)
    and (forecast_p80_minutes is null or forecast_p80_minutes between 0.001 and 5256000)
    and (forecast_p95_minutes is null or forecast_p95_minutes between 0.001 and 5256000)
    and (forecast_p25_minutes is null or forecast_p25_minutes <= forecast_p50_minutes)
    and (forecast_p80_minutes is null or forecast_p50_minutes <= forecast_p80_minutes)
    and (forecast_p95_minutes is null or forecast_p80_minutes is null or forecast_p80_minutes <= forecast_p95_minutes)
  ),
  constraint private_runs_actual_value_check check (
    (outcome = 'started' and actual_minutes is null)
    or (outcome <> 'started' and actual_minutes between 0.001 and 5256000)
  ),
  constraint private_runs_unique_client_id unique (user_id, client_run_id)
);

create index private_runs_user_created_idx
  on public.private_runs (user_id, client_created_at desc);
create index private_runs_user_calibration_idx
  on public.private_runs (user_id, provider, task_class, model, effort, speed)
  where outcome = 'success';

create trigger private_runs_set_updated_at
before update on public.private_runs
for each row execute function public.agent_eta_set_updated_at();

create table public.user_sync_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  cloud_sync_enabled boolean not null default false,
  benchmark_contribution_enabled boolean not null default false,
  benchmark_consent_version text,
  benchmark_consented_at timestamptz,
  local_history_imported_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),

  constraint user_sync_settings_consent_check check (
    not benchmark_contribution_enabled
    or (
      benchmark_consent_version is not null
      and length(benchmark_consent_version) between 1 and 40
      and benchmark_consent_version = btrim(benchmark_consent_version)
      and benchmark_consented_at is not null
    )
  )
);

create trigger user_sync_settings_set_updated_at
before update on public.user_sync_settings
for each row execute function public.agent_eta_set_updated_at();

create table public.benchmark_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  private_run_id uuid not null references public.private_runs(id) on delete cascade,
  provider text not null,
  model text not null,
  effort text not null,
  speed text not null,
  task_class text not null,
  forecast_p50_minutes numeric(12, 3) not null,
  forecast_p80_minutes numeric(12, 3) not null,
  forecast_p95_minutes numeric(12, 3),
  actual_minutes numeric(12, 3) not null,
  consent_version text not null,
  consented_at timestamptz not null,
  run_created_at timestamptz not null,
  contributed_at timestamptz not null default statement_timestamp(),

  constraint benchmark_contributions_private_run_unique unique (private_run_id),
  constraint benchmark_contributions_provider_check check (provider in ('codex', 'claude')),
  constraint benchmark_contributions_model_check check (
    length(model) between 1 and 80
    and model = btrim(model)
    and model !~ '[[:cntrl:]]'
  ),
  constraint benchmark_contributions_effort_check check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  constraint benchmark_contributions_speed_check check (speed in ('standard', 'fast')),
  constraint benchmark_contributions_task_class_check check (
    task_class in ('question', 'research', 'review', 'diagnose', 'bugfix', 'feature', 'refactor', 'migration')
  ),
  constraint benchmark_contributions_values_check check (
    forecast_p50_minutes between 0.001 and 5256000
    and forecast_p80_minutes >= forecast_p50_minutes
    and forecast_p80_minutes <= 5256000
    and (forecast_p95_minutes is null or forecast_p95_minutes >= forecast_p80_minutes)
    and (forecast_p95_minutes is null or forecast_p95_minutes <= 5256000)
    and actual_minutes between 0.001 and 5256000
  ),
  constraint benchmark_contributions_consent_version_check check (
    length(consent_version) between 1 and 40
    and consent_version = btrim(consent_version)
  )
);

create index benchmark_contributions_aggregate_idx
  on public.benchmark_contributions (run_created_at, provider, model, task_class);
create index benchmark_contributions_user_idx
  on public.benchmark_contributions (user_id, contributed_at desc);

create table public.public_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_key text not null unique,
  dimension_kind text not null,
  provider text,
  model text,
  task_class text,
  period_start timestamptz not null,
  period_end timestamptz not null,
  sample_count integer not null,
  contributor_count integer not null,
  median_actual_minutes numeric(12, 3) not null,
  median_absolute_error_minutes numeric(12, 3) not null,
  p50_observed_coverage numeric(6, 5) not null,
  p80_observed_coverage numeric(6, 5) not null,
  generated_at timestamptz not null default statement_timestamp(),

  constraint public_metric_snapshots_key_check check (length(snapshot_key) between 1 and 256),
  constraint public_metric_snapshots_dimension_kind_check check (
    dimension_kind in ('overall', 'provider', 'provider_model', 'provider_model_task')
  ),
  constraint public_metric_snapshots_provider_check check (provider is null or provider in ('codex', 'claude')),
  constraint public_metric_snapshots_model_check check (model is null or length(model) between 1 and 80),
  constraint public_metric_snapshots_task_class_check check (
    task_class is null
    or task_class in ('question', 'research', 'review', 'diagnose', 'bugfix', 'feature', 'refactor', 'migration')
  ),
  constraint public_metric_snapshots_dimensions_check check (
    (dimension_kind = 'overall' and provider is null and model is null and task_class is null)
    or (dimension_kind = 'provider' and provider is not null and model is null and task_class is null)
    or (dimension_kind = 'provider_model' and provider is not null and model is not null and task_class is null)
    or (dimension_kind = 'provider_model_task' and provider is not null and model is not null and task_class is not null)
  ),
  constraint public_metric_snapshots_period_check check (period_end > period_start),
  constraint public_metric_snapshots_cohort_check check (sample_count >= 25 and contributor_count >= 20),
  constraint public_metric_snapshots_metrics_check check (
    median_actual_minutes > 0
    and median_absolute_error_minutes >= 0
    and p50_observed_coverage between 0 and 1
    and p80_observed_coverage between 0 and 1
  )
);

create index public_metric_snapshots_dimension_idx
  on public.public_metric_snapshots (dimension_kind, provider, model, task_class);
create index public_metric_snapshots_generated_idx
  on public.public_metric_snapshots (generated_at desc);

alter table public.private_runs enable row level security;
alter table public.user_sync_settings enable row level security;
alter table public.benchmark_contributions enable row level security;
alter table public.public_metric_snapshots enable row level security;

create policy "Users read their private runs"
on public.private_runs for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users create their private runs"
on public.private_runs for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users update their private runs"
on public.private_runs for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users delete their private runs"
on public.private_runs for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "Users read their sync settings"
on public.user_sync_settings for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users create their sync settings"
on public.user_sync_settings for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users update their sync settings"
on public.user_sync_settings for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users delete their sync settings"
on public.user_sync_settings for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "Users read their contributions"
on public.benchmark_contributions for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users retract their contributions"
on public.benchmark_contributions for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "Anyone reads safe metric snapshots"
on public.public_metric_snapshots for select to anon, authenticated
using (true);

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

  if not found or not v_enabled or v_consent_version is distinct from p_consent_version then
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
    raise exception 'Only a completed successful private run with a P80 forecast can be contributed'
      using errcode = '22023';
  end if;

  return v_contribution_id;
end;
$$;

create or replace function public.agent_eta_remove_contributions_on_opt_out()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.benchmark_contributions where user_id = old.user_id;
    return old;
  end if;

  if old.benchmark_contribution_enabled and not new.benchmark_contribution_enabled then
    delete from public.benchmark_contributions where user_id = old.user_id;
  end if;
  return new;
end;
$$;

create trigger user_sync_settings_remove_contributions
after update of benchmark_contribution_enabled or delete on public.user_sync_settings
for each row execute function public.agent_eta_remove_contributions_on_opt_out();

create or replace function public.refresh_agent_eta_public_metrics(
  p_period_start timestamptz default statement_timestamp() - interval '90 days',
  p_period_end timestamptz default statement_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot_count integer;
begin
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'A valid half-open aggregation period is required' using errcode = '22023';
  end if;

  delete from public.public_metric_snapshots;

  with eligible as (
    select
      user_id,
      provider,
      model,
      task_class,
      forecast_p50_minutes,
      forecast_p80_minutes,
      actual_minutes
    from public.benchmark_contributions
    where run_created_at >= p_period_start
      and run_created_at < p_period_end
  ),
  cohorts as (
    select
      'overall'::text as dimension_kind,
      null::text as provider,
      null::text as model,
      null::text as task_class,
      count(*)::integer as sample_count,
      count(distinct user_id)::integer as contributor_count,
      round((percentile_cont(0.5) within group (order by actual_minutes))::numeric, 3) as median_actual_minutes,
      round((percentile_cont(0.5) within group (order by abs(actual_minutes - forecast_p50_minutes)))::numeric, 3)
        as median_absolute_error_minutes,
      round(avg(case when actual_minutes <= forecast_p50_minutes then 1 else 0 end)::numeric, 5)
        as p50_observed_coverage,
      round(avg(case when actual_minutes <= forecast_p80_minutes then 1 else 0 end)::numeric, 5)
        as p80_observed_coverage
    from eligible

    union all

    select
      'provider', provider, null, null,
      count(*)::integer,
      count(distinct user_id)::integer,
      round((percentile_cont(0.5) within group (order by actual_minutes))::numeric, 3),
      round((percentile_cont(0.5) within group (order by abs(actual_minutes - forecast_p50_minutes)))::numeric, 3),
      round(avg(case when actual_minutes <= forecast_p50_minutes then 1 else 0 end)::numeric, 5),
      round(avg(case when actual_minutes <= forecast_p80_minutes then 1 else 0 end)::numeric, 5)
    from eligible
    group by provider

    union all

    select
      'provider_model', provider, model, null,
      count(*)::integer,
      count(distinct user_id)::integer,
      round((percentile_cont(0.5) within group (order by actual_minutes))::numeric, 3),
      round((percentile_cont(0.5) within group (order by abs(actual_minutes - forecast_p50_minutes)))::numeric, 3),
      round(avg(case when actual_minutes <= forecast_p50_minutes then 1 else 0 end)::numeric, 5),
      round(avg(case when actual_minutes <= forecast_p80_minutes then 1 else 0 end)::numeric, 5)
    from eligible
    group by provider, model

    union all

    select
      'provider_model_task', provider, model, task_class,
      count(*)::integer,
      count(distinct user_id)::integer,
      round((percentile_cont(0.5) within group (order by actual_minutes))::numeric, 3),
      round((percentile_cont(0.5) within group (order by abs(actual_minutes - forecast_p50_minutes)))::numeric, 3),
      round(avg(case when actual_minutes <= forecast_p50_minutes then 1 else 0 end)::numeric, 5),
      round(avg(case when actual_minutes <= forecast_p80_minutes then 1 else 0 end)::numeric, 5)
    from eligible
    group by provider, model, task_class
  )
  insert into public.public_metric_snapshots (
    snapshot_key,
    dimension_kind,
    provider,
    model,
    task_class,
    period_start,
    period_end,
    sample_count,
    contributor_count,
    median_actual_minutes,
    median_absolute_error_minutes,
    p50_observed_coverage,
    p80_observed_coverage,
    generated_at
  )
  select
    concat_ws('|', dimension_kind, coalesce(provider, '*'), coalesce(model, '*'), coalesce(task_class, '*')),
    dimension_kind,
    provider,
    model,
    task_class,
    p_period_start,
    p_period_end,
    sample_count,
    contributor_count,
    median_actual_minutes,
    median_absolute_error_minutes,
    p50_observed_coverage,
    p80_observed_coverage,
    statement_timestamp()
  from cohorts
  where sample_count >= 25 and contributor_count >= 20;

  get diagnostics v_snapshot_count = row_count;
  return v_snapshot_count;
end;
$$;

revoke all on table public.private_runs from public, anon, authenticated;
revoke all on table public.user_sync_settings from public, anon, authenticated;
revoke all on table public.benchmark_contributions from public, anon, authenticated;
revoke all on table public.public_metric_snapshots from public, anon, authenticated;

grant select, insert, update, delete on table public.private_runs to authenticated;
grant select, insert, update, delete on table public.user_sync_settings to authenticated;
grant select, delete on table public.benchmark_contributions to authenticated;
grant select on table public.public_metric_snapshots to anon, authenticated;
grant all on table public.private_runs to service_role;
grant all on table public.user_sync_settings to service_role;
grant all on table public.benchmark_contributions to service_role;
grant all on table public.public_metric_snapshots to service_role;

revoke all on function public.agent_eta_set_updated_at() from public, anon, authenticated;
revoke all on function public.contribute_private_run(uuid, text) from public, anon;
revoke all on function public.agent_eta_remove_contributions_on_opt_out() from public, anon, authenticated;
revoke all on function public.refresh_agent_eta_public_metrics(timestamptz, timestamptz) from public, anon, authenticated;

grant execute on function public.contribute_private_run(uuid, text) to authenticated, service_role;
grant execute on function public.refresh_agent_eta_public_metrics(timestamptz, timestamptz) to service_role;

comment on table public.private_runs is
  'User-owned derived Agent ETA run data. Raw prompts, repository names, paths, and code are prohibited by schema.';
comment on table public.benchmark_contributions is
  'Consent-gated copies of safe run fields. Raw rows are never publicly readable.';
comment on table public.public_metric_snapshots is
  'Public, service-generated aggregate metrics. Each cohort has at least 25 runs from 20 contributors.';
comment on function public.refresh_agent_eta_public_metrics(timestamptz, timestamptz) is
  'Service-role-only refresh of privacy-thresholded public benchmark snapshots.';
