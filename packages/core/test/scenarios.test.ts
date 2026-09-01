import { describe, expect, it } from 'vitest';

import {
  calibrate,
  estimateTask,
  type CalibrationSample,
  type EstimateInput,
} from '../src/index.js';

const REPO = {
  fileCount: 680,
  linesOfCode: 74_000,
  testFileCount: 68,
  languageCount: 2,
  dependencyCount: 60,
  packageCount: 2,
};

const estimate = (prompt: string, overrides: Partial<EstimateInput> = {}) => estimateTask({
  prompt,
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
  repo: REPO,
  ...overrides,
});

describe('cold-start scenario contracts', () => {
  it('does not treat a reply-only command as a coding feature', () => {
    const result = estimate('Reply only OK. Do not use tools.');
    expect(result.analysis).toMatchObject({ taskClass: 'question', scope: 'micro', ambiguity: 'low' });
    expect(result.minutes.p50).toBeLessThan(5);
    expect(result.minutes.p80).toBeLessThan(6);
  });

  it('keeps an explicit one-line typo in a bounded micro-task range', () => {
    const result = estimate('Fix one typo in README.md.');
    expect(result.analysis).toMatchObject({ taskClass: 'bugfix', scope: 'micro', ambiguity: 'low' });
    expect(result.minutes.p50).toBeGreaterThan(8);
    expect(result.minutes.p50).toBeLessThan(25);
  });

  it('prices vague product improvement as broad, uncertain work', () => {
    const result = estimate('Make the app better. Impress me.');
    expect(result.analysis).toMatchObject({ taskClass: 'feature', scope: 'large', ambiguity: 'high' });
    expect(result.minutes.p50).toBeGreaterThan(90);
    expect(result.minutes.p80 / result.minutes.p50).toBeGreaterThan(1.3);
  });

  it('models chained service, test, browser, and release loops as interacting work', () => {
    const isolated = estimate('Implement Google sign-in.', {
      options: { scope: 'large', ambiguity: 'medium', external: false, tests: false, browser: false, deploy: false },
    });
    const chained = estimate('Implement Google sign-in, test it, verify it in the browser, and deploy it.', {
      options: { scope: 'large', ambiguity: 'medium', external: true, tests: true, browser: true, deploy: true },
    });
    expect(chained.minutes.p50).toBeGreaterThan(isolated.minutes.p50 + 45);
    expect(chained.stages.find((stage) => stage.stage === 'verify')?.minutes.p50)
      .toBeGreaterThan(isolated.stages.find((stage) => stage.stage === 'verify')?.minutes.p50 ?? 0);
    expect(chained.drivers.slice(0, 3).every((driver) => typeof driver.impactMinutes === 'number')).toBe(true);
  });

  it('keeps a full migration above a normal feature reference class', () => {
    const feature = estimate('Add a settings page with tests.');
    const migration = estimate('Migrate the production monorepo from REST to GraphQL end-to-end, update all tests, and deploy it.');
    expect(migration.analysis.taskClass).toBe('migration');
    expect(migration.minutes.p50).toBeGreaterThan(feature.minutes.p50 * 1.8);
  });

  it('does not mistake a terse product-quality request for a micro edit', () => {
    const result = estimate('Make it more trustworthy based on data.');
    expect(result.analysis).toMatchObject({ taskClass: 'feature', scope: 'large', ambiguity: 'high' });
  });
});

describe('personal calibration safeguards', () => {
  const context = {
    taskClass: 'feature' as const,
    provider: 'codex' as const,
    model: 'gpt-5.6-sol',
    effort: 'high' as const,
    speed: 'standard' as const,
  };

  it('quarantines implausible stop boundaries instead of poisoning future runs', () => {
    const samples: CalibrationSample[] = Array.from({ length: 2 }, () => ({
      estimatedMinutes: 90,
      estimatedP80Minutes: 110,
      actualMinutes: 1,
      ...context,
    }));
    const result = calibrate(samples, context);
    expect(result).toMatchObject({ multiplier: 1, effectiveSampleCount: 0, excludedSampleCount: 2, applied: false });
  });

  it('counts each overlapping similar run once and shrinks a tiny sample', () => {
    const samples: CalibrationSample[] = Array.from({ length: 2 }, () => ({
      estimatedMinutes: 90,
      estimatedP80Minutes: 110,
      actualMinutes: 30,
      ...context,
    }));
    const result = calibrate(samples, context);
    expect(result.effectiveSampleCount).toBe(2);
    expect(result.multiplier).toBeGreaterThan(0.75);
    expect(result.multiplier).toBeLessThan(0.9);
  });

  it('learns an upper-quantile coverage correction from enough comparable runs', () => {
    const actuals = [45, 50, 52, 55, 58, 60, 62, 65, 70, 120, 140, 170];
    const samples: CalibrationSample[] = actuals.map((actualMinutes) => ({
      estimatedMinutes: 60,
      estimatedP80Minutes: 80,
      estimatedP95Minutes: 100,
      actualMinutes,
      ...context,
    }));
    const result = calibrate(samples, context);
    expect(result.quantileMultipliers.p80).toBeGreaterThan(result.quantileMultipliers.p50);
    expect(result.quantileMultipliers.p95).toBeGreaterThan(result.quantileMultipliers.p50);
  });

  it('learns absolute bias from uncalibrated baselines instead of compounding old forecasts', () => {
    const actuals = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22];
    const samples: CalibrationSample[] = actuals.map((actualMinutes) => ({
      estimatedMinutes: 36,
      estimatedP80Minutes: 48,
      estimatedP95Minutes: 66,
      baselineP50Minutes: 68,
      baselineP80Minutes: 86,
      baselineP95Minutes: 112,
      actualMinutes,
      ...context,
    }));
    const result = calibrate(samples, context);
    expect(result.multiplier).toBeLessThan(0.3);
    expect(result.quantileMultipliers.p80).toBeLessThan(0.5);
    expect(result.observedP50Coverage).toBeGreaterThan(0.8);
    expect(result.observedP80Coverage).toBeGreaterThan(0.9);
  });
});
