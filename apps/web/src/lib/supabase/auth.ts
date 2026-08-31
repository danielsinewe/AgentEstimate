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
  readSupabaseConfiguration,
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
  const configuration = readSupabaseConfiguration(environment);
  if (!configuration) return cloudUnavailable();

  const params = new URLSearchParams({
    provider: 'github',
    redirect_to: sameOriginRedirect(redirectTo) ?? configuration.url,
    scopes: 'read:user user:email',
  });
  return {
    ok: true,
    data: { redirectUrl: `${configuration.url}/auth/v1/authorize?${params.toString()}` },
  };
}

async function consumeOAuthHash(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
): Promise<string | null> {
  if (typeof window === 'undefined' || !window.location.hash) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;

  window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  const { error } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  return error?.message ?? null;
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
  const callbackError = await consumeOAuthHash(client);
  if (callbackError) return remoteFailure(callbackError);
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
