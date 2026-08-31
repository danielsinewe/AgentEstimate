import { describe, expect, it } from 'vitest';
import { isCloudDataConfigured, readSupabaseConfiguration } from './runtime';
import { toLocalRunInput, toPrivateRunInsert } from './validation';

const validRun = {
  id: 'e17e721a-e1ee-4cab-895f-63e9992b6804',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
  taskClass: 'feature',
  estimatedMinutes: 12,
  estimatedP80Minutes: 20,
  estimatedP95Minutes: 31,
  actualMinutes: 16,
  successful: true,
  createdAt: '2026-08-30T08:00:00.000Z',
} as const;

describe('optional Supabase runtime', () => {
  it('stays unconfigured when either public value is absent', () => {
    expect(readSupabaseConfiguration({})).toBeNull();
    expect(isCloudDataConfigured({ VITE_SUPABASE_URL: 'https://example.supabase.co' })).toBe(false);
  });

  it('accepts only a safe URL and publishable key pair', () => {
    expect(readSupabaseConfiguration({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    })).toEqual({
      url: 'https://example.supabase.co',
      publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    });
    expect(readSupabaseConfiguration({
      VITE_SUPABASE_URL: 'https://user:password@example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    })).toBeNull();
  });
});

describe('private run allowlist', () => {
  it('maps a local calibration run without prompt or repository fields', () => {
    const result = toPrivateRunInsert(validRun, 'user-1', 'import');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      user_id: 'user-1',
      client_run_id: validRun.id,
      source: 'import',
      forecast_p50_minutes: 12,
      forecast_p80_minutes: 20,
      actual_minutes: 16,
      outcome: 'success',
    });
    expect(result.value).not.toHaveProperty('prompt');
    expect(result.value).not.toHaveProperty('repoPath');
  });

  it.each(['prompt', 'repoPath', 'repositoryName', 'cwd', 'sourceCode']) (
    'rejects prohibited field %s',
    (field) => {
      const result = toPrivateRunInsert({ ...validRun, [field]: 'private value' }, 'user-1', 'web');
      expect(result).toEqual(expect.objectContaining({ ok: false }));
    },
  );

  it('rejects invalid quantile order before a network call', () => {
    const result = toPrivateRunInsert(
      { ...validRun, estimatedP80Minutes: 8 },
      'user-1',
      'web',
    );
    expect(result).toEqual({ ok: false, error: 'P80 cannot be below P50.' });
  });

  it('sanitizes browser history before local calibration', () => {
    const result = toLocalRunInput({ ...validRun, harmlessUnknownField: 'discard me' });
    expect(result).toEqual({ ok: true, value: { ...validRun, outcome: 'success' } });
  });

  it('rejects corrupt browser history instead of calibrating with it', () => {
    expect(toLocalRunInput({ ...validRun, actualMinutes: -12 })).toEqual({
      ok: false,
      error: 'Run durations are invalid.',
    });
  });
});
