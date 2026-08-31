import { createClient } from 'npm:@supabase/supabase-js@2.112.4';

const ALLOWED_HEADERS = 'authorization, apikey, content-type, x-client-info';
const ALLOWED_METHODS = 'POST, OPTIONS';
const RECENT_AUTHENTICATION_MAX_AGE_MS = 10 * 60 * 1000;
const SERVER_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

type JsonBody = { deleted: true } | { error: 'forbidden' | 'method_not_allowed' | 'unauthorized' | 'reauth_required' | 'unavailable' | 'request_failed' };

function configuredOrigins(): Set<string> {
  const configured = Deno.env.get('AGENT_ETA_ALLOWED_ORIGINS') ?? '';
  const origins = new Set<string>();
  for (const candidate of configured.split(',').map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = new URL(candidate);
      const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.origin === candidate
          && (parsed.protocol === 'https:' || (local && parsed.protocol === 'http:'))
          && !parsed.username
          && !parsed.password) {
        origins.add(candidate);
      }
    } catch {
      // Invalid entries are ignored so configuration fails closed.
    }
  }
  return origins;
}

function responseHeaders(origin?: string): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/json; charset=utf-8',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Max-Age', '600');
  }
  return headers;
}

function json(status: number, body: JsonBody, origin?: string, allow?: string): Response {
  const headers = responseHeaders(origin);
  if (allow) headers.set('Allow', allow);
  return new Response(JSON.stringify(body), { status, headers });
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7);
  if (token.length < 20 || token.length > 8192 || token.trim() !== token || /\s/u.test(token)) return null;
  return token;
}

function hasRecentSignIn(lastSignInAt: unknown, nowMs = Date.now()): boolean {
  if (typeof lastSignInAt !== 'string'
      || !SERVER_TIMESTAMP_PATTERN.test(lastSignInAt)
      || !Number.isFinite(nowMs)) return false;
  const signedInAtMs = Date.parse(lastSignInAt);
  if (!Number.isFinite(signedInAtMs)) return false;
  const ageMs = nowMs - signedInAtMs;
  return ageMs >= 0 && ageMs <= RECENT_AUTHENTICATION_MAX_AGE_MS;
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  if (!origin || !configuredOrigins().has(origin)) {
    return json(403, { error: 'forbidden' });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders(origin) });
  }
  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' }, origin, ALLOWED_METHODS);
  }

  const token = bearerToken(request);
  if (!token) return json(401, { error: 'unauthorized' }, origin);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return json(503, { error: 'unavailable' }, origin);
  }

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return json(401, { error: 'unauthorized' }, origin);
    if (!hasRecentSignIn(user.last_sign_in_at)) {
      return json(403, { error: 'reauth_required' }, origin);
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, false);
    if (deleteError) return json(500, { error: 'request_failed' }, origin);

    return json(200, { deleted: true }, origin);
  } catch {
    return json(500, { error: 'request_failed' }, origin);
  }
});
