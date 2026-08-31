import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  deleteAccount,
  isRecentServerVerifiedAuthentication,
  RECENT_AUTHENTICATION_MAX_AGE_MS,
  type AccountDeletionConfirmation,
} from './account';
import { planAutomaticContribution } from './sync';

describe('account deletion helper', () => {
  it('requires the exact destructive confirmation before looking for cloud config', async () => {
    await expect(deleteAccount('wrong-confirmation' as AccountDeletionConfirmation, {})).resolves.toEqual({
      ok: false,
      kind: 'validation',
      message: 'Confirm account deletion before continuing.',
    });
  });

  it('fails locally and safely when cloud data is not configured', async () => {
    await expect(deleteAccount(ACCOUNT_DELETION_CONFIRMATION, {})).resolves.toEqual({
      ok: false,
      kind: 'not-configured',
      message: 'Cloud data is not configured. Agent ETA will keep working locally.',
    });
  });
});

describe('recent authentication preflight', () => {
  const nowMs = Date.parse('2026-08-30T10:00:00.000Z');

  it('accepts a fresh server-verified sign-in through the exact ten-minute boundary', () => {
    expect(isRecentServerVerifiedAuthentication('2026-08-30T09:59:00.000Z', nowMs)).toBe(true);
    expect(isRecentServerVerifiedAuthentication(
      new Date(nowMs - RECENT_AUTHENTICATION_MAX_AGE_MS).toISOString(),
      nowMs,
    )).toBe(true);
  });

  it('rejects an old sign-in', () => {
    expect(isRecentServerVerifiedAuthentication(
      new Date(nowMs - RECENT_AUTHENTICATION_MAX_AGE_MS - 1).toISOString(),
      nowMs,
    )).toBe(false);
  });

  it.each([undefined, null, ''])('rejects a missing sign-in timestamp: %s', (value) => {
    expect(isRecentServerVerifiedAuthentication(value, nowMs)).toBe(false);
  });

  it.each([
    'not-a-date',
    '2026-13-99T99:99:99Z',
    '2026-08-30',
    'August 30, 2026 09:59:00 GMT',
  ])('rejects malformed timestamp: %s', (value) => {
    expect(isRecentServerVerifiedAuthentication(value, nowMs)).toBe(false);
  });

  it('rejects a future timestamp instead of accepting clock ambiguity', () => {
    expect(isRecentServerVerifiedAuthentication('2026-08-30T10:00:00.001Z', nowMs)).toBe(false);
  });
});

describe('automatic contribution policy', () => {
  const successfulRun = {
    outcome: 'success' as const,
    forecast_p80_minutes: 18,
    actual_minutes: 15,
  };

  it('contributes only a new eligible run when opt-in is already active', () => {
    expect(planAutomaticContribution({
      benchmarkContributionEnabled: true,
      benchmarkConsentVersion: 'benchmark-v1',
    }, successfulRun)).toEqual({ action: 'contribute', consentVersion: 'benchmark-v1' });
  });

  it('does not contribute when the user has not opted in', () => {
    expect(planAutomaticContribution({
      benchmarkContributionEnabled: false,
      benchmarkConsentVersion: null,
    }, successfulRun)).toEqual({ action: 'skip', reason: 'not-opted-in' });
  });

  it('does not contribute incomplete or unsuccessful runs', () => {
    expect(planAutomaticContribution({
      benchmarkContributionEnabled: true,
      benchmarkConsentVersion: 'benchmark-v1',
    }, {
      outcome: 'failed',
      forecast_p80_minutes: 18,
      actual_minutes: 15,
    })).toEqual({ action: 'skip', reason: 'ineligible' });
  });

  it('reports inconsistent active consent instead of silently skipping it', () => {
    expect(planAutomaticContribution({
      benchmarkContributionEnabled: true,
      benchmarkConsentVersion: null,
    }, successfulRun)).toEqual({
      action: 'fail',
      message: 'Private sync succeeded, but benchmark consent is incomplete.',
    });
  });
});
