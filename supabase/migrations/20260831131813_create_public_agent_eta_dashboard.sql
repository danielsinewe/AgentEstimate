begin;

-- A public dashboard is deliberately separate from private history and the
-- multi-contributor benchmark pool. Only explicitly enabled owners are rolled
-- into this aggregate snapshot. No user ids or individual run rows are exposed.

create table "project_agent_eta_v2".public_dashboard_sources (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  enabled_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create trigger public_dashboard_sources_set_updated_at
before update on "project_agent_eta_v2".public_dashboard_sources
for each row execute function "project_agent_eta_v2".agent_eta_set_updated_at();

create table "project_agent_eta_v2".public_dashboard_snapshots (
  snapshot_key text primary key,
  total_runs integer not null,
  successful_runs integer not null,
  stopped_runs integer not null,
  failed_runs integer not null,
  measured_runs integer not null,
  within_p80_runs integer not null,
  p80_coverage numeric(6, 5) not null,
  median_actual_minutes numeric(12, 3) not null,
  median_absolute_error_minutes numeric(12, 3) not null,
  provider_breakdown jsonb not null default '[]'::jsonb,
  task_breakdown jsonb not null default '[]'::jsonb,
  period_start timestamptz not null,
  period_end timestamptz not null,
  generated_at timestamptz not null default statement_timestamp(),

  constraint public_dashboard_snapshot_key_check check (
    length(snapshot_key) between 1 and 80
  ),
  constraint public_dashboard_snapshot_counts_check check (
    total_runs > 0
    and successful_runs between 0 and total_runs
    and stopped_runs between 0 and total_runs
    and failed_runs between 0 and total_runs
    and measured_runs between 0 and successful_runs
    and within_p80_runs between 0 and measured_runs
  ),
  constraint public_dashboard_snapshot_metrics_check check (
    p80_coverage between 0 and 1
    and median_actual_minutes > 0
    and median_absolute_error_minutes >= 0
  ),
  constraint public_dashboard_snapshot_json_check check (
    jsonb_typeof(provider_breakdown) = 'array'
    and jsonb_typeof(task_breakdown) = 'array'
  ),
  constraint public_dashboard_snapshot_period_check check (
    period_end >= period_start
  )
);

alter table "project_agent_eta_v2".public_dashboard_sources enable row level security;
alter table "project_agent_eta_v2".public_dashboard_snapshots enable row level security;

create policy "Anyone reads public dashboard snapshots"
on "project_agent_eta_v2".public_dashboard_snapshots
for select to anon, authenticated
using (true);

create or replace function "project_agent_eta_v2".refresh_agent_eta_public_dashboard()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row_count integer;
begin
  if not exists (
    select 1
    from "project_agent_eta_v2".private_runs as run
    join "project_agent_eta_v2".public_dashboard_sources as source
      on source.user_id = run.user_id
     and source.enabled
    where run.outcome = 'success'
      and run.actual_minutes is not null
  ) then
    delete from "project_agent_eta_v2".public_dashboard_snapshots;
    return 0;
  end if;

  with eligible as (
    select run.*
    from "project_agent_eta_v2".private_runs as run
    join "project_agent_eta_v2".public_dashboard_sources as source
      on source.user_id = run.user_id
     and source.enabled
  ),
  overall as (
    select
      count(*)::integer as total_runs,
      count(*) filter (
        where outcome = 'success' and actual_minutes is not null
      )::integer as successful_runs,
      count(*) filter (where outcome = 'censored')::integer as stopped_runs,
      count(*) filter (where outcome = 'failed')::integer as failed_runs,
      count(*) filter (
        where outcome = 'success'
          and actual_minutes is not null
          and forecast_p80_minutes is not null
      )::integer as measured_runs,
      count(*) filter (
        where outcome = 'success'
          and actual_minutes is not null
          and forecast_p80_minutes is not null
          and actual_minutes <= forecast_p80_minutes
      )::integer as within_p80_runs,
      round((
        percentile_cont(0.5) within group (order by actual_minutes)
        filter (where outcome = 'success' and actual_minutes is not null)
      )::numeric, 3) as median_actual_minutes,
      round((
        percentile_cont(0.5) within group (order by abs(actual_minutes - forecast_p50_minutes))
        filter (where outcome = 'success' and actual_minutes is not null)
      )::numeric, 3) as median_absolute_error_minutes,
      min(client_created_at) as period_start,
      max(client_created_at) as period_end
    from eligible
  ),
  provider_rows as (
    select
      provider,
      count(*)::integer as total_runs,
      count(*) filter (where outcome = 'success')::integer as successful_runs
    from eligible
    group by provider
  ),
  task_rows as (
    select
      task_class,
      count(*)::integer as total_runs,
      count(*) filter (where outcome = 'success')::integer as successful_runs,
      round((
        percentile_cont(0.5) within group (order by actual_minutes)
        filter (where outcome = 'success' and actual_minutes is not null)
      )::numeric, 3) as median_actual_minutes
    from eligible
    group by task_class
  )
  insert into "project_agent_eta_v2".public_dashboard_snapshots (
    snapshot_key,
    total_runs,
    successful_runs,
    stopped_runs,
    failed_runs,
    measured_runs,
    within_p80_runs,
    p80_coverage,
    median_actual_minutes,
    median_absolute_error_minutes,
    provider_breakdown,
    task_breakdown,
    period_start,
    period_end,
    generated_at
  )
  select
    'main',
    overall.total_runs,
    overall.successful_runs,
    overall.stopped_runs,
    overall.failed_runs,
    overall.measured_runs,
    overall.within_p80_runs,
    coalesce(round(overall.within_p80_runs::numeric / nullif(overall.measured_runs, 0), 5), 0),
    overall.median_actual_minutes,
    overall.median_absolute_error_minutes,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'provider', provider,
          'totalRuns', total_runs,
          'successfulRuns', successful_runs
        )
        order by total_runs desc, provider
      )
      from provider_rows
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'taskClass', task_class,
          'totalRuns', total_runs,
          'successfulRuns', successful_runs,
          'medianActualMinutes', median_actual_minutes
        )
        order by total_runs desc, task_class
      )
      from task_rows
    ), '[]'::jsonb),
    overall.period_start,
    overall.period_end,
    statement_timestamp()
  from overall
  on conflict (snapshot_key) do update
  set
    total_runs = excluded.total_runs,
    successful_runs = excluded.successful_runs,
    stopped_runs = excluded.stopped_runs,
    failed_runs = excluded.failed_runs,
    measured_runs = excluded.measured_runs,
    within_p80_runs = excluded.within_p80_runs,
    p80_coverage = excluded.p80_coverage,
    median_actual_minutes = excluded.median_actual_minutes,
    median_absolute_error_minutes = excluded.median_absolute_error_minutes,
    provider_breakdown = excluded.provider_breakdown,
    task_breakdown = excluded.task_breakdown,
    period_start = excluded.period_start,
    period_end = excluded.period_end,
    generated_at = excluded.generated_at;

  get diagnostics v_row_count = row_count;
  return v_row_count;
end;
$$;

create or replace function "project_agent_eta_v2".refresh_public_dashboard_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform "project_agent_eta_v2".refresh_agent_eta_public_dashboard();
  return null;
end;
$$;

create trigger private_runs_refresh_public_dashboard
after insert or update or delete on "project_agent_eta_v2".private_runs
for each statement execute function "project_agent_eta_v2".refresh_public_dashboard_after_change();

create trigger public_dashboard_sources_refresh_snapshot
after insert or update or delete on "project_agent_eta_v2".public_dashboard_sources
for each statement execute function "project_agent_eta_v2".refresh_public_dashboard_after_change();

revoke all on table "project_agent_eta_v2".public_dashboard_sources
from public, anon, authenticated;
revoke all on table "project_agent_eta_v2".public_dashboard_snapshots
from public, anon, authenticated;

grant select on table "project_agent_eta_v2".public_dashboard_snapshots
to anon, authenticated;
grant all on table "project_agent_eta_v2".public_dashboard_sources to service_role;
grant all on table "project_agent_eta_v2".public_dashboard_snapshots to service_role;

revoke all on function "project_agent_eta_v2".refresh_agent_eta_public_dashboard()
from public, anon, authenticated;
revoke all on function "project_agent_eta_v2".refresh_public_dashboard_after_change()
from public, anon, authenticated;

grant execute on function "project_agent_eta_v2".refresh_agent_eta_public_dashboard()
to service_role;

comment on table "project_agent_eta_v2".public_dashboard_sources is
  'Private owner allowlist for the public aggregate dashboard. Never exposed through the Data API.';
comment on table "project_agent_eta_v2".public_dashboard_snapshots is
  'Public aggregate Agent ETA metrics. Contains no user ids, run ids, prompts, repositories, paths, or code.';
comment on function "project_agent_eta_v2".refresh_agent_eta_public_dashboard() is
  'Refreshes the public aggregate dashboard from explicitly enabled owner data only.';

notify pgrst, 'reload schema';
commit;
