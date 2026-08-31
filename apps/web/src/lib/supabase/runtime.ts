import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

const AGENT_ETA_DATABASE_SCHEMA = 'project_agent_eta_v2';

export interface SupabaseEnvironment {
  VITE_SUPABASE_URL?: unknown;
  VITE_SUPABASE_PUBLISHABLE_KEY?: unknown;
}

export interface SupabaseConfiguration {
  url: string;
  publishableKey: string;
}

export type CloudFailureKind =
  | 'not-configured'
  | 'signed-out'
  | 'sync-disabled'
  | 'consent-required'
  | 'reauth-required'
  | 'validation'
  | 'remote';

export type CloudResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: CloudFailureKind; message: string };

let cachedClient: SupabaseClient<Database, 'project_agent_eta_v2'> | null | undefined;
let cachedConfigurationKey: string | null = null;

function isSafeSupabaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return (parsed.protocol === 'https:' || (local && parsed.protocol === 'http:'))
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function isSafePublishableKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 20
    && value.length <= 4096
    && value.trim() === value
    && !/\s/u.test(value);
}

export function readSupabaseConfiguration(
  environment: SupabaseEnvironment = import.meta.env as SupabaseEnvironment,
): SupabaseConfiguration | null {
  const url = environment.VITE_SUPABASE_URL;
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!isSafeSupabaseUrl(url) || !isSafePublishableKey(publishableKey)) return null;
  return { url, publishableKey };
}

export function isCloudDataConfigured(
  environment: SupabaseEnvironment = import.meta.env as SupabaseEnvironment,
): boolean {
  return readSupabaseConfiguration(environment) !== null;
}

export function getSupabaseClient(
  environment: SupabaseEnvironment = import.meta.env as SupabaseEnvironment,
): SupabaseClient<Database, 'project_agent_eta_v2'> | null {
  const configuration = readSupabaseConfiguration(environment);
  if (!configuration) {
    cachedClient = null;
    cachedConfigurationKey = null;
    return null;
  }

  const configurationKey = `${configuration.url}\n${configuration.publishableKey}`;
  if (cachedClient !== undefined && cachedConfigurationKey === configurationKey) return cachedClient;

  cachedClient = createClient<Database, 'project_agent_eta_v2'>(configuration.url, configuration.publishableKey, {
    db: { schema: AGENT_ETA_DATABASE_SCHEMA },
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      persistSession: true,
      storageKey: 'agent-eta-auth-v1',
    },
    global: {
      headers: { 'X-Client-Info': 'agent-eta-web/0.1' },
    },
  });
  cachedConfigurationKey = configurationKey;
  return cachedClient;
}

export function cloudUnavailable<T>(): CloudResult<T> {
  return {
    ok: false,
    kind: 'not-configured',
    message: 'Cloud data is not configured. Agent ETA will keep working locally.',
  };
}

export function remoteFailure<T>(message: string): CloudResult<T> {
  return { ok: false, kind: 'remote', message };
}
