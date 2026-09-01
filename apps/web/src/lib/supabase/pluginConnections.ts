import {
  cloudUnavailable,
  getSupabaseClient,
  readSupabaseConfiguration,
  remoteFailure,
  type CloudResult,
  type SupabaseEnvironment,
} from './runtime';
import type { PluginSyncConnection } from './types';

interface PluginConnectionRow {
  id: string;
  token_prefix: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  synced_run_count: number;
}

function toConnection(row: PluginConnectionRow): PluginSyncConnection {
  return {
    id: row.id,
    tokenPrefix: row.token_prefix,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    syncedRunCount: row.synced_run_count,
  };
}

function connectionCode(value: { url: string; publishableKey: string; token: string }): string {
  const json = JSON.stringify({ version: 1, ...value });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `agent-eta-v1.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

async function authenticatedClient(environment?: SupabaseEnvironment) {
  const client = getSupabaseClient(environment);
  if (!client) return { ok: false as const, failure: cloudUnavailable<never>() };
  const { data, error } = await client.auth.getSession();
  if (error) return { ok: false as const, failure: remoteFailure<never>(error.message) };
  if (!data.session?.user) {
    return {
      ok: false as const,
      failure: { ok: false as const, kind: 'signed-out' as const, message: 'Sign in to manage plugin connections.' },
    };
  }
  return { ok: true as const, client };
}

export async function listPluginSyncConnections(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<PluginSyncConnection[]>> {
  const context = await authenticatedClient(environment);
  if (!context.ok) return context.failure;
  const { data, error } = await context.client.rpc('list_plugin_sync_connections');
  if (error) return remoteFailure(error.message);
  return {
    ok: true,
    data: (data as PluginConnectionRow[]).filter((row) => row.revoked_at === null).map(toConnection),
  };
}

export async function createPluginSyncConnection(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<{ connection: PluginSyncConnection; connectionCode: string }>> {
  const configuration = readSupabaseConfiguration(environment);
  if (!configuration) return cloudUnavailable();
  const context = await authenticatedClient(environment);
  if (!context.ok) return context.failure;
  const { data, error } = await context.client.rpc('create_plugin_sync_connection', {
    p_label: 'Codex / Claude Code',
  });
  if (error) return remoteFailure(error.message);
  const row = data[0];
  if (!row) return remoteFailure('The connection could not be created.');
  return {
    ok: true,
    data: {
      connection: toConnection({ ...row, last_used_at: null, revoked_at: null, synced_run_count: 0 }),
      connectionCode: connectionCode({
        url: configuration.url,
        publishableKey: configuration.publishableKey,
        token: row.token,
      }),
    },
  };
}

export async function revokePluginSyncConnection(
  connectionId: string,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<boolean>> {
  const context = await authenticatedClient(environment);
  if (!context.ok) return context.failure;
  const { data, error } = await context.client.rpc('revoke_plugin_sync_connection', {
    p_connection_id: connectionId,
  });
  if (error) return remoteFailure(error.message);
  return { ok: true, data };
}
