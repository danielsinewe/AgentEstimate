import { FunctionsHttpError } from '@supabase/supabase-js';
import { getAuthenticatedUser } from './auth';
import {
  cloudUnavailable,
  getSupabaseClient,
  remoteFailure,
  type CloudResult,
  type SupabaseEnvironment,
} from './runtime';

export const ACCOUNT_DELETION_CONFIRMATION = 'delete-my-agent-eta-account' as const;
export type AccountDeletionConfirmation = typeof ACCOUNT_DELETION_CONFIRMATION;
export const RECENT_AUTHENTICATION_MAX_AGE_MS = 10 * 60 * 1000;
export const REAUTHENTICATION_REQUIRED_MESSAGE =
  'For security, sign out and back in with GitHub, then delete your account within 10 minutes.';
const SERVER_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

/** Mirrors the server-side gate; the Edge Function remains authoritative. */
export function isRecentServerVerifiedAuthentication(
  lastSignInAt: unknown,
  nowMs = Date.now(),
): boolean {
  if (typeof lastSignInAt !== 'string'
      || !SERVER_TIMESTAMP_PATTERN.test(lastSignInAt)
      || !Number.isFinite(nowMs)) return false;
  const signedInAtMs = Date.parse(lastSignInAt);
  if (!Number.isFinite(signedInAtMs)) return false;
  const ageMs = nowMs - signedInAtMs;
  return ageMs >= 0 && ageMs <= RECENT_AUTHENTICATION_MAX_AGE_MS;
}

async function isReauthenticationRequiredError(error: unknown): Promise<boolean> {
  if (!(error instanceof FunctionsHttpError)) return false;
  const response = error.context;
  if (!(response instanceof Response) || response.status !== 403) return false;
  try {
    const body: unknown = await response.clone().json();
    return body !== null
      && typeof body === 'object'
      && !Array.isArray(body)
      && Object.keys(body).length === 1
      && 'error' in body
      && body.error === 'reauth_required';
  } catch {
    return false;
  }
}

export async function deleteAccount(
  confirmation: AccountDeletionConfirmation,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<{ deleted: true }>> {
  if (confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
    return { ok: false, kind: 'validation', message: 'Confirm account deletion before continuing.' };
  }

  const client = getSupabaseClient(environment);
  if (!client) return cloudUnavailable();
  const user = await getAuthenticatedUser(environment);
  if (!user.ok) return user;
  if (!isRecentServerVerifiedAuthentication(user.data.last_sign_in_at)) {
    return { ok: false, kind: 'reauth-required', message: REAUTHENTICATION_REQUIRED_MESSAGE };
  }

  const { data, error } = await client.functions.invoke<{ deleted?: unknown }>('delete-account', {
    method: 'POST',
  });
  if (error) {
    if (await isReauthenticationRequiredError(error)) {
      return { ok: false, kind: 'reauth-required', message: REAUTHENTICATION_REQUIRED_MESSAGE };
    }
    return remoteFailure('Account deletion failed. Please sign in again and retry.');
  }
  if (!data || data.deleted !== true || Object.keys(data).some((key) => key !== 'deleted')) {
    return remoteFailure('Account deletion returned an unexpected response.');
  }

  await client.auth.signOut({ scope: 'local' });
  return { ok: true, data: { deleted: true } };
}
