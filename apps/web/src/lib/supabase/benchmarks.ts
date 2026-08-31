import {
  cloudUnavailable,
  getSupabaseClient,
  remoteFailure,
  type CloudResult,
  type SupabaseEnvironment,
} from './runtime';
import type { MetricDimension, PublicMetricSnapshot, RunProvider, RunTaskClass } from './types';

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
