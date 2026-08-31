-- Manual development rollback for 20260830080536_create_private_sync_and_benchmarks.sql.
-- This is destructive: it removes all synced runs, contribution data, and snapshots.
-- Production rollback should normally be a new forward migration instead.

drop trigger if exists user_sync_settings_remove_contributions on public.user_sync_settings;
drop trigger if exists user_sync_settings_set_updated_at on public.user_sync_settings;
drop trigger if exists private_runs_set_updated_at on public.private_runs;

drop function if exists public.refresh_agent_eta_public_metrics(timestamptz, timestamptz);
drop function if exists public.contribute_private_run(uuid, text);
drop function if exists public.agent_eta_remove_contributions_on_opt_out();

drop table if exists public.public_metric_snapshots;
drop table if exists public.benchmark_contributions;
drop table if exists public.user_sync_settings;
drop table if exists public.private_runs;

drop function if exists public.agent_eta_set_updated_at();
