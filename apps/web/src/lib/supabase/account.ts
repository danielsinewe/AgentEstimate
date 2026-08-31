import { getAuthenticatedUser } from './auth';
import {
  cloudUnavailable,
  getSupabaseClient,
  remoteFailure,
  type CloudResult,
  type SupabaseEnvironment,
} from './runtime';

export const AGENT_ETA_DATA_DELETION_CONFIRMATION = 'delete-my-agent-eta-data' as const;
export type AgentEtaDataDeletionConfirmation = typeof AGENT_ETA_DATA_DELETION_CONFIRMATION;

export async function deleteAgentEtaData(
  confirmation: AgentEtaDataDeletionConfirmation,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<{ deleted: true }>> {
  if (confirmation !== AGENT_ETA_DATA_DELETION_CONFIRMATION) {
    return { ok: false, kind: 'validation', message: 'Confirm Agent ETA data deletion before continuing.' };
  }

  const client = getSupabaseClient(environment);
  if (!client) return cloudUnavailable();
  const user = await getAuthenticatedUser(environment);
  if (!user.ok) return user;
  const { data, error } = await client.rpc('delete_agent_eta_data');
  if (error) {
    return remoteFailure('Agent ETA data deletion failed. Please retry.');
  }
  if (data !== true) {
    return remoteFailure('Agent ETA data deletion returned an unexpected response.');
  }

  await client.auth.signOut({ scope: 'local' });
  return { ok: true, data: { deleted: true } };
}
