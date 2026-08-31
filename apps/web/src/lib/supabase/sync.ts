import { getAuthenticatedUser } from './auth';
import {
  cloudUnavailable,
  getSupabaseClient,
  remoteFailure,
  type CloudResult,
  type SupabaseEnvironment,
} from './runtime';
import type {
  ContributionRow,
  PrivateRunInsert,
  PrivateRunRow,
  RunSource,
  SyncSettingsRow,
} from './types';
import { toPrivateRunInsert } from './validation';

const IMPORT_BATCH_SIZE = 100;

export const BENCHMARK_CONSENT_VERSION = 'benchmark-v1';
export const LOCAL_HISTORY_IMPORT_DECISION = 'import-existing-local-history';

export interface ExplicitLocalHistoryImportAuthorization {
  decision: typeof LOCAL_HISTORY_IMPORT_DECISION;
  confirmedAt: string;
}

export interface SyncSettings {
  cloudSyncEnabled: boolean;
  benchmarkContributionEnabled: boolean;
  benchmarkConsentVersion: string | null;
  benchmarkConsentedAt: string | null;
  localHistoryImportedAt: string | null;
}

export type AutomaticContributionStatus =
  | { status: 'not-requested'; reason: 'not-opted-in' | 'ineligible' }
  | { status: 'contributed'; contributionId: string }
  | { status: 'failed'; message: string };

export interface NewPrivateRunSyncResult {
  run: PrivateRunRow;
  contribution: AutomaticContributionStatus;
}

export type AutomaticContributionPlan =
  | { action: 'skip'; reason: 'not-opted-in' | 'ineligible' }
  | { action: 'contribute'; consentVersion: string }
  | { action: 'fail'; message: string };

function defaultSettings(): SyncSettings {
  return {
    cloudSyncEnabled: false,
    benchmarkContributionEnabled: false,
    benchmarkConsentVersion: null,
    benchmarkConsentedAt: null,
    localHistoryImportedAt: null,
  };
}

function fromSettingsRow(row: SyncSettingsRow): SyncSettings {
  return {
    cloudSyncEnabled: row.cloud_sync_enabled,
    benchmarkContributionEnabled: row.benchmark_contribution_enabled,
    benchmarkConsentVersion: row.benchmark_consent_version,
    benchmarkConsentedAt: row.benchmark_consented_at,
    localHistoryImportedAt: row.local_history_imported_at,
  };
}

function validConfirmation(value: ExplicitLocalHistoryImportAuthorization): boolean {
  if (value.decision !== LOCAL_HISTORY_IMPORT_DECISION) return false;
  const timestamp = Date.parse(value.confirmedAt);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value.confirmedAt;
}

type CloudFailure = Extract<CloudResult<never>, { ok: false }>;
type AuthenticatedContext =
  | {
      ok: true;
      client: NonNullable<ReturnType<typeof getSupabaseClient>>;
      userId: string;
    }
  | { ok: false; failure: CloudFailure };

async function authenticatedContext(environment?: SupabaseEnvironment): Promise<AuthenticatedContext> {
  const client = getSupabaseClient(environment);
  if (!client) return { ok: false, failure: cloudUnavailable<never>() as CloudFailure };
  const user = await getAuthenticatedUser(environment);
  if (!user.ok) return { ok: false, failure: user };
  return { ok: true, client, userId: user.data.id };
}

export async function getSyncSettings(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<SyncSettings>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const { data, error } = await context.client
    .from('user_sync_settings')
    .select('*')
    .eq('user_id', context.userId)
    .maybeSingle();
  if (error) return remoteFailure(error.message);
  return { ok: true, data: data ? fromSettingsRow(data) : defaultSettings() };
}

export async function setCloudSyncEnabled(
  enabled: boolean,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<SyncSettings>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const { data, error } = await context.client
    .from('user_sync_settings')
    .upsert(
      { user_id: context.userId, cloud_sync_enabled: enabled },
      { onConflict: 'user_id' },
    )
    .select('*')
    .single();
  if (error) return remoteFailure(error.message);
  return { ok: true, data: fromSettingsRow(data) };
}

export async function setBenchmarkContributionEnabled(
  enabled: boolean,
  consentVersion = BENCHMARK_CONSENT_VERSION,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<SyncSettings>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  if (enabled && (!consentVersion || consentVersion.length > 40 || consentVersion.trim() !== consentVersion)) {
    return { ok: false, kind: 'validation', message: 'Benchmark consent version is invalid.' };
  }

  const consentedAt = enabled ? new Date().toISOString() : null;
  const { data, error } = await context.client
    .from('user_sync_settings')
    .upsert(
      {
        user_id: context.userId,
        benchmark_contribution_enabled: enabled,
        benchmark_consent_version: enabled ? consentVersion : null,
        benchmark_consented_at: consentedAt,
      },
      { onConflict: 'user_id' },
    )
    .select('*')
    .single();
  if (error) return remoteFailure(error.message);
  return { ok: true, data: fromSettingsRow(data) };
}

/** This policy considers one newly synced run only. Enabling opt-in never backfills history. */
export function planAutomaticContribution(
  settings: Pick<SyncSettings, 'benchmarkContributionEnabled' | 'benchmarkConsentVersion'>,
  run: Pick<PrivateRunRow, 'outcome' | 'forecast_p80_minutes' | 'actual_minutes'>,
): AutomaticContributionPlan {
  if (!settings.benchmarkContributionEnabled) return { action: 'skip', reason: 'not-opted-in' };
  if (run.outcome !== 'success' || run.forecast_p80_minutes === null || run.actual_minutes === null) {
    return { action: 'skip', reason: 'ineligible' };
  }
  if (!settings.benchmarkConsentVersion) {
    return { action: 'fail', message: 'Private sync succeeded, but benchmark consent is incomplete.' };
  }
  return { action: 'contribute', consentVersion: settings.benchmarkConsentVersion };
}

async function requireSyncEnabled(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<SyncSettings>> {
  const settings = await getSyncSettings(environment);
  if (!settings.ok) return settings;
  if (!settings.data.cloudSyncEnabled) {
    return {
      ok: false,
      kind: 'sync-disabled',
      message: 'Private cloud sync is off. The run remains local.',
    };
  }
  return settings;
}

async function upsertRuns(
  inputs: readonly unknown[],
  source: RunSource,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<PrivateRunRow[]>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const rows: PrivateRunInsert[] = [];
  for (const [index, input] of inputs.entries()) {
    const parsed = toPrivateRunInsert(input, context.userId, source);
    if (!parsed.ok) {
      return { ok: false, kind: 'validation', message: `Run ${index + 1}: ${parsed.error}` };
    }
    rows.push(parsed.value);
  }
  if (rows.length === 0) return { ok: true, data: [] };
  const synced: PrivateRunRow[] = [];
  for (let start = 0; start < rows.length; start += IMPORT_BATCH_SIZE) {
    const batch = rows.slice(start, start + IMPORT_BATCH_SIZE);
    const { data, error } = await context.client
      .from('private_runs')
      .upsert(batch, { onConflict: 'user_id,client_run_id' })
      .select('*');
    if (error) return remoteFailure(error.message);
    synced.push(...data);
  }
  return { ok: true, data: synced };
}

/** Syncs one newly saved run only when the user already enabled cloud sync. */
export async function syncNewPrivateRun(
  input: unknown,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<NewPrivateRunSyncResult>> {
  const enabled = await requireSyncEnabled(environment);
  if (!enabled.ok) return enabled;
  const result = await upsertRuns([input], 'web', environment);
  if (!result.ok) return result;
  const row = result.data[0];
  if (!row) return { ok: false, kind: 'remote', message: 'Cloud sync returned no run.' };

  const plan = planAutomaticContribution(enabled.data, row);
  if (plan.action === 'skip') {
    return { ok: true, data: { run: row, contribution: { status: 'not-requested', reason: plan.reason } } };
  }
  if (plan.action === 'fail') {
    return { ok: true, data: { run: row, contribution: { status: 'failed', message: plan.message } } };
  }

  const contribution = await contributePrivateRun(row.id, plan.consentVersion, environment);
  if (!contribution.ok) {
    return {
      ok: true,
      data: {
        run: row,
        contribution: {
          status: 'failed',
          message: 'Private sync succeeded, but the benchmark contribution was not saved.',
        },
      },
    };
  }
  return {
    ok: true,
    data: {
      run: row,
      contribution: { status: 'contributed', contributionId: contribution.data.contributionId },
    },
  };
}

/**
 * Existing browser history can only be uploaded through this explicit import path.
 * Enabling cloud sync or signing in never calls it implicitly.
 */
export async function importLocalHistory(
  inputs: readonly unknown[],
  authorization: ExplicitLocalHistoryImportAuthorization,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<{ imported: number; importedAt: string }>> {
  if (!validConfirmation(authorization)) {
    return {
      ok: false,
      kind: 'consent-required',
      message: 'Confirm the local-history import before uploading existing runs.',
    };
  }
  const enabled = await requireSyncEnabled(environment);
  if (!enabled.ok) return enabled;
  const result = await upsertRuns(inputs, 'import', environment);
  if (!result.ok) return result;

  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const importedAt = new Date().toISOString();
  const { error } = await context.client
    .from('user_sync_settings')
    .update({ local_history_imported_at: importedAt })
    .eq('user_id', context.userId);
  if (error) return remoteFailure(error.message);
  return { ok: true, data: { imported: result.data.length, importedAt } };
}

export async function listPrivateRuns(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<PrivateRunRow[]>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const { data, error } = await context.client
    .from('private_runs')
    .select('*')
    .order('client_created_at', { ascending: false });
  if (error) return remoteFailure(error.message);
  return { ok: true, data };
}

export async function deletePrivateRun(
  privateRunId: string,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<null>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const { error } = await context.client
    .from('private_runs')
    .delete()
    .eq('id', privateRunId)
    .eq('user_id', context.userId);
  if (error) return remoteFailure(error.message);
  return { ok: true, data: null };
}

export async function deleteAllPrivateRuns(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<null>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const { error } = await context.client
    .from('private_runs')
    .delete()
    .eq('user_id', context.userId);
  if (error) return remoteFailure(error.message);
  return { ok: true, data: null };
}

export async function contributePrivateRun(
  privateRunId: string,
  consentVersion = BENCHMARK_CONSENT_VERSION,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<{ contributionId: string }>> {
  const client = getSupabaseClient(environment);
  if (!client) return cloudUnavailable();
  const { data, error } = await client.rpc('contribute_private_run', {
    p_private_run_id: privateRunId,
    p_consent_version: consentVersion,
  });
  if (error) return remoteFailure(error.message);
  return { ok: true, data: { contributionId: data } };
}

export async function listOwnContributions(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<ContributionRow[]>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const { data, error } = await context.client
    .from('benchmark_contributions')
    .select('*')
    .eq('user_id', context.userId)
    .order('contributed_at', { ascending: false });
  if (error) return remoteFailure(error.message);
  return { ok: true, data };
}

export async function retractContribution(
  contributionId: string,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<null>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const { error } = await context.client
    .from('benchmark_contributions')
    .delete()
    .eq('id', contributionId)
    .eq('user_id', context.userId);
  if (error) return remoteFailure(error.message);
  return { ok: true, data: null };
}

export async function deleteSyncSettings(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<null>> {
  const context = await authenticatedContext(environment);
  if (!context.ok) return context.failure;
  const { error } = await context.client
    .from('user_sync_settings')
    .delete()
    .eq('user_id', context.userId);
  if (error) return remoteFailure(error.message);
  return { ok: true, data: null };
}
