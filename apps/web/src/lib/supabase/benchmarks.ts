import {
  cloudUnavailable,
  getSupabaseClient,
  remoteFailure,
  type CloudResult,
  type SupabaseEnvironment,
} from './runtime';
import type {
  MetricDimension,
  PublicDashboardSnapshot,
  PublicDashboardSnapshotRow,
  PublicMetricSnapshot,
  PublicProviderBreakdown,
  PublicTaskBreakdown,
  RunProvider,
  RunTaskClass,
} from './types';

export interface PublicMetricFilters {
  dimension?: MetricDimension;
  provider?: RunProvider;
  model?: string;
  taskClass?: RunTaskClass;
}

/** Reads only the privacy-thresholded table exposed to anonymous visitors. */
export async function listPublicMetricSnapshots(
  filters: PublicMetricFilters = {},
  environment?: SupabaseEnvironment,
): Promise<CloudResult<PublicMetricSnapshot[]>> {
  const client = getSupabaseClient(environment);
  if (!client) return cloudUnavailable();

  let query = client
    .from('public_metric_snapshots')
    .select('*')
    .order('sample_count', { ascending: false });
  if (filters.dimension) query = query.eq('dimension_kind', filters.dimension);
  if (filters.provider) query = query.eq('provider', filters.provider);
  if (filters.model) query = query.eq('model', filters.model);
  if (filters.taskClass) query = query.eq('task_class', filters.taskClass);

  const { data, error } = await query;
  if (error) return remoteFailure(error.message);
  return { ok: true, data };
}

function isProviderBreakdown(value: unknown): value is PublicProviderBreakdown[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    return (row.provider === 'codex' || row.provider === 'claude')
      && Number.isInteger(row.totalRuns)
      && Number.isInteger(row.successfulRuns);
  });
}

function isTaskBreakdown(value: unknown): value is PublicTaskBreakdown[] {
  const taskClasses = new Set([
    'question', 'research', 'review', 'diagnose', 'bugfix', 'feature', 'refactor', 'migration',
  ]);
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    return typeof row.taskClass === 'string'
      && taskClasses.has(row.taskClass)
      && Number.isInteger(row.totalRuns)
      && Number.isInteger(row.successfulRuns)
      && (row.medianActualMinutes === null || typeof row.medianActualMinutes === 'number');
  });
}

export function parsePublicDashboardSnapshot(
  row: PublicDashboardSnapshotRow,
): PublicDashboardSnapshot | null {
  if (!isProviderBreakdown(row.provider_breakdown) || !isTaskBreakdown(row.task_breakdown)) {
    return null;
  }
  return {
    ...row,
    provider_breakdown: row.provider_breakdown,
    task_breakdown: row.task_breakdown,
  };
}

/** Reads the single owner-published aggregate snapshot available to every visitor. */
export async function getPublicDashboardSnapshot(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<PublicDashboardSnapshot | null>> {
  const client = getSupabaseClient(environment);
  if (!client) return cloudUnavailable();

  const { data, error } = await client
    .from('public_dashboard_snapshots')
    .select('*')
    .eq('snapshot_key', 'main')
    .maybeSingle();
  if (error) return remoteFailure(error.message);
  if (!data) return { ok: true, data: null };

  const parsed = parsePublicDashboardSnapshot(data);
  return parsed
    ? { ok: true, data: parsed }
    : remoteFailure('The public dashboard returned an invalid snapshot.');
}
