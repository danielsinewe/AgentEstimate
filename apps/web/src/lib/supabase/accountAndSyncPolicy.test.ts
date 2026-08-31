import { describe, expect, it } from 'vitest';
import {
  AGENT_ETA_DATA_DELETION_CONFIRMATION,
  deleteAgentEtaData,
  type AgentEtaDataDeletionConfirmation,
} from './account';
import { planAutomaticContribution } from './sync';

describe('Agent ETA data deletion helper', () => {
  it('requires the exact destructive confirmation before looking for cloud config', async () => {
    await expect(deleteAgentEtaData('wrong-confirmation' as AgentEtaDataDeletionConfirmation, {})).resolves.toEqual({
      ok: false,
      kind: 'validation',
      message: 'Confirm Agent ETA data deletion before continuing.',
    });
  });

  it('fails locally and safely when cloud data is not configured', async () => {
    await expect(deleteAgentEtaData(AGENT_ETA_DATA_DELETION_CONFIRMATION, {})).resolves.toEqual({
      ok: false,
      kind: 'not-configured',
      message: 'Cloud data is not configured. Agent ETA will keep working locally.',
    });
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
