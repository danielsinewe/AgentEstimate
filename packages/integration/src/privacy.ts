import type {
  AgentEffort,
  AgentProvider,
  AgentSpeed,
  DerivedPromptFeatures,
  RepositoryProfile,
  StoredEstimate,
  StoredRunFeatures,
} from './types.js';
import { analyzePrompt, type EstimateResult } from '@agent-eta/core';

export function derivePromptFeatures(prompt: string): DerivedPromptFeatures {
  const bounded = prompt.slice(0, 100_000);
  const trimmed = bounded.trim();
  const words = trimmed ? trimmed.split(/\s+/u).length : 0;
  const lines = trimmed ? trimmed.split(/\r?\n/u).length : 0;
  const checklistItems = (bounded.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/gu) ?? []).length;
  const analysis = analyzePrompt(bounded);

  return {
    characters: bounded.length,
    words,
    lines,
    checklistItems,
    taskClass: analysis.taskClass,
    scope: analysis.scope,
    ambiguity: analysis.ambiguity,
    external: analysis.signals.external,
    tests: analysis.signals.tests,
    browser: analysis.signals.browser,
    deploy: analysis.signals.deploy,
    destructive: analysis.signals.destructive,
  };
}

export function normalizeProvider(value: unknown, fallback: AgentProvider = 'codex'): AgentProvider {
  return typeof value === 'string' && value.toLowerCase().includes('claude') ? 'claude' : fallback;
}

export function normalizeEffort(value: unknown): AgentEffort {
  if (typeof value !== 'string') return 'medium';
  const normalized = value.toLowerCase().replace(/[-_ ]/gu, '');
  if (normalized === 'low' || normalized === 'minimal' || normalized === 'none') return 'low';
  if (normalized === 'high') return 'high';
  if (normalized === 'xhigh' || normalized === 'veryhigh') return 'xhigh';
  if (normalized === 'max' || normalized === 'ultra') return 'max';
  return 'medium';
}

export function normalizeSpeed(value: unknown): AgentSpeed {
  return typeof value === 'string' && /(?:fast|priority|express)/iu.test(value) ? 'fast' : 'standard';
}

export function normalizeModel(value: unknown, provider: AgentProvider): string {
  if (typeof value !== 'string' || !value.trim()) return provider === 'codex' ? 'codex-default' : 'claude-default';
  return value.trim().replace(/[^a-zA-Z0-9._:/-]/gu, '-').slice(0, 80) || `${provider}-default`;
}

export function toStoredEstimate(estimate: EstimateResult): StoredEstimate {
  return {
    minutes: {
      p25: estimate.minutes.p25,
      p50: estimate.minutes.p50,
      p80: estimate.minutes.p80,
      p95: estimate.minutes.p95,
      expected: estimate.minutes.expected,
    },
    formatted: {
      p50: estimate.formatted.p50,
      p80: estimate.formatted.p80,
    },
    confidence: estimate.confidence,
  };
}

export function toStoredFeatures(input: {
  provider: AgentProvider;
  model: string;
  effort: AgentEffort;
  speed: AgentSpeed;
  prompt: DerivedPromptFeatures;
  repo: RepositoryProfile;
}): StoredRunFeatures {
  return {
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    speed: input.speed,
    prompt: input.prompt,
    repo: {
      fileCount: input.repo.fileCount,
      linesOfCode: input.repo.linesOfCode,
      testFileCount: input.repo.testFileCount,
      languageCount: input.repo.languageCount,
      dependencyCount: input.repo.dependencyCount,
      packageCount: input.repo.packageCount,
      dirtyFileCount: input.repo.dirtyFileCount,
    },
  };
}
