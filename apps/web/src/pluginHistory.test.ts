import { describe, expect, it } from 'vitest';
import { parsePluginHistory } from './pluginHistory';

const started = {
  schemaVersion: 1,
  kind: 'started',
  runId: '0123456789abcdef0123456789abcdef',
  startedAt: '2026-08-31T10:00:00.000Z',
  features: {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    speed: 'standard',
    prompt: {
      taskClass: 'feature',
      scope: 'medium',
      ambiguity: 'low',
      tests: true,
      browser: true,
      external: false,
      deploy: true,
      destructive: false,
    },
  },
  estimate: { minutes: { p25: 8, p50: 12, p80: 18, p95: 26 } },
};

describe('plugin history import', () => {
  it('joins privacy-safe started and completed records', () => {
    const completed = {
      schemaVersion: 1,
      kind: 'completed',
      runId: started.runId,
      completedAt: '2026-08-31T10:14:00.000Z',
      elapsedMs: 14 * 60_000,
      outcome: 'success',
    };
    const result = parsePluginHistory(`${JSON.stringify(started)}\n${JSON.stringify(completed)}\n`);
    expect(result).toMatchObject({ ignoredLines: 0, incompleteRuns: 0 });
    expect(result.runs).toEqual([
      expect.objectContaining({
        id: started.runId,
        provider: 'codex',
        taskClass: 'feature',
        estimatedMinutes: 12,
        estimatedP80Minutes: 18,
        actualMinutes: 14,
        successful: true,
        historySource: 'plugin',
      }),
    ]);
    expect(JSON.stringify(result.runs)).not.toContain('prompt');
  });

  it('ignores malformed and unfinished records', () => {
    const result = parsePluginHistory(`not json\n${JSON.stringify(started)}\n`);
    expect(result.runs).toEqual([]);
    expect(result.ignoredLines).toBe(1);
    expect(result.incompleteRuns).toBe(1);
  });
});
