import {
  isAuthSessionMissingError,
  type AuthChangeEvent,
  type Session,
  type Subscription,
  type User,
} from '@supabase/supabase-js';
import {
  cloudUnavailable,
  getSupabaseClient,
  remoteFailure,
  type CloudResult,
  type SupabaseEnvironment,
} from './runtime';

function sameOriginRedirect(requested?: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const fallback = new URL('/', window.location.origin).toString();
  if (!requested) return fallback;
  try {
    const parsed = new URL(requested, window.location.origin);
    return parsed.origin === window.location.origin ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

export async function signInWithGitHub(
  redirectTo?: string,
  environment?: SupabaseEnvironment,
): Promise<CloudResult<{ redirectUrl: string | null }>> {
  const client = getSupabaseClient(environment);
  if (!client) return cloudUnavailable();

  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: sameOriginRedirect(redirectTo),
      scopes: 'read:user user:email',
    },
  });
  if (error) return remoteFailure(error.message);
  return { ok: true, data: { redirectUrl: data.url } };
}

export async function signOut(environment?: SupabaseEnvironment): Promise<CloudResult<null>> {
  const client = getSupabaseClient(environment);
  if (!client) return cloudUnavailable();
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) return remoteFailure(error.message);
  return { ok: true, data: null };
}

export async function getAuthenticatedUser(
  environment?: SupabaseEnvironment,
): Promise<CloudResult<User>> {
  const client = getSupabaseClient(environment);
  if (!client) return cloudUnavailable();
  const { data, error } = await client.auth.getUser();
  if (error && isAuthSessionMissingError(error)) {
    return { ok: false, kind: 'signed-out', message: 'Sign in to use private cloud data.' };
  }
  if (error) return remoteFailure(error.message);
  if (!data.user) {
    return { ok: false, kind: 'signed-out', message: 'Sign in to use private cloud data.' };
  }
  return { ok: true, data: data.user };
}

export function subscribeToAuth(
  listener: (event: AuthChangeEvent, session: Session | null) => void,
  environment?: SupabaseEnvironment,
): Subscription | null {
  const client = getSupabaseClient(environment);
  if (!client) return null;
  return client.auth.onAuthStateChange(listener).data.subscription;
}
