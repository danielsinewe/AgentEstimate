import type { StoredEstimate, StoredRunFeatures } from '../src/types.js';

export const TEST_FEATURES: StoredRunFeatures = {
  provider: 'codex',
  model: 'gpt-5.6-codex',
  effort: 'medium',
  speed: 'standard',
  prompt: {
    characters: 42,
    words: 8,
    lines: 1,
    checklistItems: 0,
    taskClass: 'feature',
    scope: 'micro',
    ambiguity: 'low',
    external: false,
    tests: true,
    browser: false,
    deploy: false,
    destructive: false,
  },
  repo: {
    fileCount: 12,
    linesOfCode: 900,
    testFileCount: 3,
    languageCount: 1,
    dependencyCount: 4,
    packageCount: 1,
    dirtyFileCount: 0,
  },
};

export const TEST_ESTIMATE: StoredEstimate = {
  minutes: {
    p25: 8,
    p50: 10,
    p80: 15,
    p95: 24,
    expected: 12,
  },
  formatted: {
    p50: '10 min',
    p80: '15 min',
  },
  confidence: {
    level: 'medium',
    spread: 2.4,
    reason: 'Test fixture',
  },
};
