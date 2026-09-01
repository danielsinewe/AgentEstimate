import { describe, expect, it } from 'vitest';
import { estimateTask } from '@agent-eta/core';
import {
  derivePromptFeatures,
  normalizeEffort,
  normalizeModel,
  normalizeProvider,
  normalizeSpeed,
  toStoredEstimate,
  toStoredFeatures,
} from '../src/privacy.js';
import type { RepositoryProfile } from '../src/types.js';

describe('privacy-safe feature derivation', () => {
  it('classifies scope, ambiguity, and operational signals without retaining prompt text', () => {
    const secret = 'PRIVATE-TICKET-7291';
    const prompt = [
      `Build the ${secret} integration; I do not know the best architecture, so figure it out.`,
      '- Research the external API',
      '- Implement the web app',
      '- Add Vitest coverage',
      '- Verify the UI in a browser',
      '- Deploy to production',
      '- Remove all obsolete records',
    ].join('\n');
    const features = derivePromptFeatures(prompt);

    expect(features).toMatchObject({
      taskClass: 'refactor',
      scope: 'project',
      ambiguity: 'medium',
      external: true,
      tests: true,
      browser: true,
      deploy: true,
      destructive: true,
      checklistItems: 6,
      lines: 7,
    });
    expect(features.words).toBeGreaterThan(30);
    expect(JSON.stringify(features)).not.toContain(secret);
    expect(JSON.stringify(features)).not.toContain('external API');
  });

  it('bounds work on extremely long prompts and applies deterministic task precedence', () => {
    const features = derivePromptFeatures(`migrate and refactor and fix ${'x '.repeat(60_000)}`);
    expect(features.characters).toBe(100_000);
    expect(features.taskClass).toBe('migration');
    expect(features.scope).toBe('project');
  });

  it('normalizes provider, effort, speed, and model values conservatively', () => {
    expect(normalizeProvider('Claude Sonnet')).toBe('claude');
    expect(normalizeProvider('gpt-5.6')).toBe('codex');
    expect(normalizeProvider(undefined, 'claude')).toBe('claude');

    expect(normalizeEffort('minimal')).toBe('low');
    expect(normalizeEffort('very-high')).toBe('xhigh');
    expect(normalizeEffort('ultra')).toBe('max');
    expect(normalizeEffort('unexpected')).toBe('medium');

    expect(normalizeSpeed('priority')).toBe('fast');
    expect(normalizeSpeed('regular')).toBe('standard');

    expect(normalizeModel(' claude opus 4.1 🚀 ', 'claude')).toBe('claude-opus-4.1--');
    expect(normalizeModel('', 'codex')).toBe('codex-default');
    expect(normalizeModel(undefined, 'claude')).toBe('claude-default');
    expect(normalizeModel('a'.repeat(100), 'codex')).toHaveLength(80);
  });

  it('stores only numeric repository metadata and the forecast subset', () => {
    const repo: RepositoryProfile = {
      root: '/private/customer/acme-secret-repo',
      source: 'git',
      fileCount: 44,
      linesOfCode: 9_000,
      testFileCount: 8,
      languageCount: 2,
      dependencyCount: 18,
      packageCount: 2,
      dirtyFileCount: 3,
      sampledCodeFiles: 20,
      truncated: true,
    };
    const prompt = derivePromptFeatures('Implement and test a feature.');
    const storedFeatures = toStoredFeatures({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      speed: 'fast',
      prompt,
      repo,
    });
    const estimate = estimateTask({
      prompt: 'Implement and test a feature.',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      speed: 'fast',
    });
    const storedEstimate = toStoredEstimate(estimate, estimate);
    const serialized = JSON.stringify({ storedFeatures, storedEstimate });

    expect(storedFeatures.repo).toEqual({
      fileCount: 44,
      linesOfCode: 9_000,
      testFileCount: 8,
      languageCount: 2,
      dependencyCount: 18,
      packageCount: 2,
      dirtyFileCount: 3,
    });
    expect(serialized).not.toContain(repo.root);
    expect(serialized).not.toContain('sampledCodeFiles');
    expect(serialized).not.toContain('truncated');
    expect(serialized).not.toContain('drivers');
    expect(serialized).not.toContain('seed');
    expect(Object.keys(storedEstimate.formatted)).toEqual(['p50', 'p80']);
    expect(storedEstimate.baseline).toEqual({
      p50: estimate.minutes.p50,
      p80: estimate.minutes.p80,
      p95: estimate.minutes.p95,
    });
  });
});
