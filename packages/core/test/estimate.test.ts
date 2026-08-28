import { describe, expect, it } from 'vitest';

import {
  analyzePrompt,
  calibrate,
  estimateTask,
  formatDuration,
  type CalibrationSample,
  type EstimateInput,
} from '../src/index.js';

const BASE_INPUT: EstimateInput = {
  prompt: 'Implement the user settings form in src/settings.tsx.',
  provider: 'codex',
  model: 'gpt-5.6-codex',
  effort: 'medium',
  speed: 'standard',
  taskClass: 'feature',
  options: {
    scope: 'medium',
    ambiguity: 'low',
    external: false,
    tests: false,
    browser: false,
    deploy: false,
  },
  repo: { fileCount: 120, linesOfCode: 24_000, testFileCount: 18, packageCount: 1 },
};

describe('estimateTask', () => {
  it('is deterministic for identical inputs', () => {
    expect(estimateTask(BASE_INPUT)).toEqual(estimateTask(BASE_INPUT));
    expect(estimateTask({ ...BASE_INPUT, seed: 'scenario-a' })).toEqual(
      estimateTask({ ...BASE_INPUT, seed: 'scenario-a' }),
    );
  });

  it('always returns ordered quantiles', () => {
    const result = estimateTask({
      ...BASE_INPUT,
      options: { ...BASE_INPUT.options, ambiguity: 'high', external: true, deploy: true },
    });
    const assertOrdered = (values: typeof result.minutes): void => {
      expect(values.p25).toBeLessThanOrEqual(values.p50);
      expect(values.p50).toBeLessThanOrEqual(values.p80);
      expect(values.p80).toBeLessThanOrEqual(values.p95);
    };
    assertOrdered(result.minutes);
    result.stages.forEach((stage) => assertOrdered(stage.minutes));
  });

  it('increases monotonically with scope and repository size', () => {
    const smallScope = estimateTask({
      ...BASE_INPUT,
      options: { ...BASE_INPUT.options, scope: 'small' },
    });
    const largeScope = estimateTask({
      ...BASE_INPUT,
      options: { ...BASE_INPUT.options, scope: 'large' },
    });
    expect(largeScope.minutes.p50).toBeGreaterThan(smallScope.minutes.p50);

    const smallRepo = estimateTask({
      ...BASE_INPUT,
      repo: { fileCount: 20, linesOfCode: 2_000, packageCount: 1 },
    });
    const largeRepo = estimateTask({
      ...BASE_INPUT,
      repo: { fileCount: 20_000, linesOfCode: 4_000_000, packageCount: 80 },
    });
    expect(largeRepo.minutes.p50).toBeGreaterThan(smallRepo.minutes.p50);
  });

  it('adds time for tests and deployment', () => {
    const baseline = estimateTask(BASE_INPUT);
    const withTests = estimateTask({
      ...BASE_INPUT,
      options: { ...BASE_INPUT.options, tests: true },
    });
    const withDeployment = estimateTask({
      ...BASE_INPUT,
      options: { ...BASE_INPUT.options, deploy: true },
    });
    expect(withTests.minutes.p50).toBeGreaterThan(baseline.minutes.p50);
    expect(withDeployment.minutes.p50).toBeGreaterThan(baseline.minutes.p50);
    expect(
      withDeployment.stages.find(({ stage }) => stage === 'deliver')?.minutes.p50,
    ).toBeGreaterThan(baseline.stages.find(({ stage }) => stage === 'deliver')?.minutes.p50 ?? 0);
  });

  it('limits fast mode reduction to model-bound stages', () => {
    const standard = estimateTask(BASE_INPUT);
    const fast = estimateTask({ ...BASE_INPUT, speed: 'fast' });
    for (const standardStage of standard.stages) {
      const fastStage = fast.stages.find(({ stage }) => stage === standardStage.stage);
      expect(fastStage).toBeDefined();
      if (standardStage.modelBound) {
        expect(fastStage?.minutes.p50).toBeLessThan(standardStage.minutes.p50);
      } else {
        expect(fastStage?.minutes).toEqual(standardStage.minutes);
      }
    }
    expect(fast.minutes.p50).toBeLessThan(standard.minutes.p50);
  });

  it('applies robust, clamped personal calibration', () => {
    const samples: CalibrationSample[] = Array.from({ length: 12 }, () => ({
      estimatedMinutes: 30,
      actualMinutes: 60,
      taskClass: 'feature',
      provider: 'codex',
      model: 'gpt-5.6-codex',
      effort: 'medium',
      speed: 'standard',
    }));
    samples.push({ estimatedMinutes: 1, actualMinutes: 10_000, taskClass: 'feature' });

    const calibration = calibrate(samples, BASE_INPUT);
    const baseline = estimateTask(BASE_INPUT);
    const personalized = estimateTask({ ...BASE_INPUT, calibrationSamples: samples });
    expect(calibration.multiplier).toBeGreaterThan(1);
    expect(calibration.multiplier).toBeLessThanOrEqual(1.75);
    expect(calibration.level).toBe('model-effort');
    expect(personalized.minutes.p50).toBeGreaterThan(baseline.minutes.p50);
  });

  it('does not echo or derive the seed from private prompt text', () => {
    const secret = 'PRIVATE-TICKET-7291';
    const first = estimateTask({ ...BASE_INPUT, prompt: `Fix ${secret}` });
    const second = estimateTask({ ...BASE_INPUT, prompt: 'Fix a different ticket' });
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(first.seed).toBe(second.seed);
  });
});

describe('prompt analysis and formatting', () => {
  it('recognizes operational signals without returning prompt fragments', () => {
    const prompt = 'Deploy the web app to production, run Vitest, and verify it in the browser.';
    const analysis = analyzePrompt(prompt);
    expect(analysis.signals.tests).toBe(true);
    expect(analysis.signals.browser).toBe(true);
    expect(analysis.signals.deploy).toBe(true);
    expect(JSON.stringify(analysis)).not.toContain(prompt);
  });

  it('formats useful human durations', () => {
    expect(formatDuration(0.4)).toBe('<1 min');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(90)).toBe('1 hr 30 min');
    expect(formatDuration(120)).toBe('2 hr');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});
