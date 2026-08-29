import { access, chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { handleHookInvocation, handleHookObject, readHookStdin } from '../src/hook.js';
import { CalibrationStore, resolvePluginDataDir } from '../src/store.js';
import { TEST_ESTIMATE, TEST_FEATURES } from './helpers.js';

describe('CalibrationStore', () => {
  it('resolves explicit and environment-specific data directories in priority order', () => {
    expect(resolvePluginDataDir({ dataDir: './explicit-data' })).toBe(join(process.cwd(), 'explicit-data'));
    expect(resolvePluginDataDir({
      env: { AGENT_ETA_DATA_DIR: './agent-eta-data', CODEX_PLUGIN_DATA: './codex-data' },
    })).toBe(join(process.cwd(), 'agent-eta-data'));
    expect(resolvePluginDataDir({ env: { PLUGIN_DATA: './codex-data' } })).toBe(join(process.cwd(), 'codex-data'));
    expect(resolvePluginDataDir({ env: { CLAUDE_PLUGIN_DATA: './claude-data' } })).toBe(join(process.cwd(), 'claude-data'));
    expect(resolvePluginDataDir({
      env: {},
      cwd: '/Users/test/.codex/plugins/cache/indiecorns/agent-eta/0.1.0+codex.test',
    })).toBe('/Users/test/.codex/plugins/data/agent-eta-indiecorns');
    expect(resolvePluginDataDir({ env: { XDG_DATA_HOME: './xdg' } })).toBe(join(process.cwd(), 'xdg', 'agent-eta'));
  });

  it('deduplicates starts, completes the latest active run once, and keeps private file permissions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-store-'));
    const store = new CalibrationStore({ dataDir });
    const startedAt = new Date('2026-08-28T10:00:00.000Z');
    const input = {
      sessionId: 'provider:plain-session-id',
      repoIdentity: '/private/repos/acme',
      startedAt,
      features: TEST_FEATURES,
      estimate: TEST_ESTIMATE,
      identityHint: 'stable-turn-identity',
    };

    const first = await store.startRun(input);
    const duplicate = await store.startRun(input);
    expect(duplicate.runId).toBe(first.runId);
    expect(await store.records()).toHaveLength(1);

    const completion = await store.completeRun({
      sessionId: input.sessionId,
      completedAt: new Date('2026-08-28T10:12:30.000Z'),
      outcome: 'success',
    });
    expect(completion.created).toBe(true);
    expect(completion.record?.elapsedMs).toBe(750_000);
    expect((await store.completeRun({ sessionId: input.sessionId, outcome: 'success' })).created).toBe(false);

    const history = await store.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ outcome: 'success', elapsedMs: 750_000 });
    const serialized = await readFile(store.historyPath, 'utf8');
    expect(serialized).not.toContain('plain-session-id');
    expect(serialized).not.toContain('/private/repos/acme');
    expect(first.runId).toMatch(/^[a-f0-9]{32}$/u);
    expect(first.sessionKey).toMatch(/^[a-f0-9]{32}$/u);
    expect(first.repoKey).toMatch(/^[a-f0-9]{32}$/u);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(store.historyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, '.install-salt'))).mode & 0o777).toBe(0o600);
  });

  it('ignores corrupt JSONL tails and calculates useful calibration metrics', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-calibration-'));
    const store = new CalibrationStore({ dataDir });

    for (let index = 0; index < 3; index += 1) {
      const startedAt = new Date(Date.UTC(2026, 7, 28, 10, index));
      await store.startRun({
        sessionId: `session-${index}`,
        repoIdentity: '/repo',
        startedAt,
        features: TEST_FEATURES,
        estimate: TEST_ESTIMATE,
      });
      await store.completeRun({
        sessionId: `session-${index}`,
        completedAt: new Date(startedAt.getTime() + [8, 10, 20][index]! * 60_000),
        outcome: index === 2 ? 'failed' : 'success',
      });
    }
    await writeFile(store.historyPath, '{partial invalid tail', { flag: 'a' });

    expect(await store.records()).toHaveLength(6);
    expect(await store.calibrationStatus()).toEqual({
      state: 'cold-start',
      startedRuns: 3,
      completedRuns: 3,
      successfulRuns: 2,
      eligibleCalibrationRuns: 2,
      excludedCalibrationRuns: 0,
      failedRuns: 1,
      censoredRuns: 0,
      medianActualMinutes: 9,
      medianAbsoluteErrorMinutes: 1,
      p50ObservedCoverage: 1,
      p80ObservedCoverage: 1,
    });
    const samples = await store.calibrationSamples();
    expect(samples).toHaveLength(2);
    expect(samples.every((sample) => sample.actualMinutes <= 10)).toBe(true);
    expect(await store.privacyFingerprint()).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('skips parseable malformed records without losing later valid history', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-malformed-history-'));
    const store = new CalibrationStore({ dataDir });
    const started = await store.startRun({
      sessionId: 'valid-session',
      repoIdentity: '/repo',
      startedAt: new Date('2026-08-28T10:00:00.000Z'),
      features: TEST_FEATURES,
      estimate: TEST_ESTIMATE,
    });
    const completion = {
      schemaVersion: 1,
      kind: 'completed',
      runId: started.runId,
      completedAt: '2026-08-28T10:01:00.000Z',
      elapsedMs: 60_000,
      outcome: 'success',
    };
    const malformedRecords: unknown[] = [
      { ...started, features: null },
      { ...started, features: [] },
      { ...started, features: { ...started.features, provider: 'other' } },
      { ...started, features: { ...started.features, effort: 'ultra' } },
      { ...started, features: { ...started.features, speed: 'turbo' } },
      {
        ...started,
        features: { ...started.features, prompt: { ...started.features.prompt, taskClass: 'write' } },
      },
      {
        ...started,
        features: { ...started.features, prompt: { ...started.features.prompt, scope: 'enormous' } },
      },
      {
        ...started,
        features: { ...started.features, prompt: { ...started.features.prompt, ambiguity: 'unknown' } },
      },
      {
        ...started,
        features: { ...started.features, prompt: { ...started.features.prompt, tests: 'yes' } },
      },
      {
        ...started,
        features: { ...started.features, repo: { ...started.features.repo, fileCount: -1 } },
      },
      {
        ...started,
        features: { ...started.features, repo: { ...started.features.repo, linesOfCode: 1.5 } },
      },
      { ...started, features: { ...started.features, model: 'm'.repeat(81) } },
      { ...started, startedAt: '2026-08-28T10:00:00Z' },
      { ...started, source: 'manual' },
      { ...started, estimate: { ...started.estimate, minutes: { ...started.estimate.minutes, p50: -1 } } },
      { ...started, estimate: { ...started.estimate, minutes: { ...started.estimate.minutes, p25: 20 } } },
      { ...started, estimate: { ...started.estimate, confidence: { ...started.estimate.confidence, level: 'certain' } } },
      { ...started, estimate: { ...started.estimate, confidence: { ...started.estimate.confidence, spread: null } } },
      {
        ...started,
        estimate: {
          ...started.estimate,
          confidence: { ...started.estimate.confidence, reason: 'r'.repeat(513) },
        },
      },
      { ...started, rawPrompt: 'must not be accepted as a schema-v1 field' },
      { ...completion, completedAt: 'not-a-date' },
      { ...completion, elapsedMs: -1 },
      { ...completion, elapsedMs: null },
      { ...completion, outcome: 'timed_out' },
    ];
    const overflowCompletion = JSON.stringify({ ...completion, elapsedMs: 0 }).replace(
      '"elapsedMs":0',
      '"elapsedMs":1e999',
    );
    await writeFile(
      store.historyPath,
      `${malformedRecords.map((record) => JSON.stringify(record)).join('\n')}\n${overflowCompletion}\n`,
      { flag: 'a' },
    );

    const completed = await store.completeRun({
      sessionId: 'valid-session',
      completedAt: new Date('2026-08-28T10:01:00.000Z'),
      outcome: 'success',
    });
    expect(completed.created).toBe(true);
    await writeFile(
      store.historyPath,
      `${JSON.stringify({ ...completion, completedAt: 'invalid-shadow', outcome: 'failed' })}\n`,
      { flag: 'a' },
    );

    expect(await store.records()).toHaveLength(2);
    expect(await store.history()).toEqual([
      expect.objectContaining({ runId: started.runId, elapsedMs: 60_000, outcome: 'success' }),
    ]);
    await expect(store.calibrationStatus()).resolves.toMatchObject({
      startedRuns: 1,
      completedRuns: 1,
      successfulRuns: 1,
      failedRuns: 0,
    });
    await expect(store.calibrationSamples()).resolves.toHaveLength(1);
  });

  it.each([null, 0, 1, 31, 32, 33] as const)(
    'publishes one private 32-byte salt across concurrent stores from initial length %s',
    async (initialLength) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-salt-'));
      const saltPath = join(dataDir, '.install-salt');
      const initialSalt = initialLength === null ? null : Buffer.alloc(initialLength, 0xa5);
      if (initialSalt) await writeFile(saltPath, initialSalt, { mode: 0o644 });

      const stores = Array.from({ length: 12 }, () => new CalibrationStore({ dataDir }));
      const keys = await Promise.all(stores.map((candidate) => candidate.privateKey('same-identity')));
      const publishedSalt = await readFile(saltPath);

      expect(new Set(keys)).toHaveLength(1);
      expect(publishedSalt).toHaveLength(32);
      expect((await stat(saltPath)).mode & 0o777).toBe(0o600);
      if (initialLength === 32) expect(publishedSalt).toEqual(initialSalt);
      expect(await new CalibrationStore({ dataDir }).privateKey('same-identity')).toBe(keys[0]);
      expect((await readdir(dataDir)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
    },
  );

  it('censors an abandoned turn, matches completion by turn id, and scopes current runs by repository', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-overlap-'));
    const store = new CalibrationStore({ dataDir });
    const firstAt = new Date('2026-08-28T10:00:00.000Z');
    await store.startRun({
      sessionId: 'session',
      turnId: 'turn-1',
      repoIdentity: '/repo-a',
      startedAt: firstAt,
      features: TEST_FEATURES,
      estimate: TEST_ESTIMATE,
    });
    await store.startRun({
      sessionId: 'session',
      turnId: 'turn-2',
      repoIdentity: '/repo-a',
      startedAt: new Date(firstAt.getTime() + 60_000),
      features: TEST_FEATURES,
      estimate: TEST_ESTIMATE,
    });

    expect((await store.history()).find((entry) => entry.outcome === 'censored')).toMatchObject({ elapsedMs: 60_000 });
    expect((await store.completeRun({ sessionId: 'session', turnId: 'turn-1', outcome: 'success' })).created).toBe(false);
    expect(await store.currentRun({ repoIdentity: '/repo-b' })).toBeNull();
    expect(await store.currentRun({ repoIdentity: '/repo-a' })).toMatchObject({ outcome: undefined });
    expect((await store.completeRun({ sessionId: 'session', turnId: 'turn-2', outcome: 'success' })).created).toBe(true);
    expect(await store.currentRun({ repoIdentity: '/repo-a' })).toBeNull();
  });

  it('does not surface stale active runs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-stale-'));
    const store = new CalibrationStore({ dataDir });
    await store.startRun({
      sessionId: 'stale-session',
      repoIdentity: '/repo',
      startedAt: new Date(Date.now() - 25 * 60 * 60_000),
      features: TEST_FEATURES,
      estimate: TEST_ESTIMATE,
    });
    expect(await store.currentRun({ repoIdentity: '/repo' })).toBeNull();
  });
});

describe('hook lifecycle, visible failures, and privacy', () => {
  it('forecasts on submit, persists only derived metadata, and completes the same session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-hook-'));
    const cwd = await mkdtemp(join(tmpdir(), 'agent-eta-hook-repo-'));
    await writeFile(join(cwd, 'index.ts'), 'export const value = 1;', 'utf8');
    const secret = 'CUSTOMER-SECRET-4815';

    const submit = await handleHookObject(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'visible-session-42',
        turn_id: 'turn-9',
        cwd,
        prompt: `Implement ${secret}, run Vitest, verify the UI in the browser, and deploy to production.`,
        model: 'gpt-5.6-codex',
        reasoning_effort: 'high',
        service_tier: 'priority',
      },
      { provider: 'codex', dataDir, now: () => new Date('2026-08-28T10:00:00.000Z') },
    );
    expect(submit.systemMessage).toMatch(/^Agent ETA · likely .+ · safer plan .+$/u);
    expect(submit.hookSpecificOutput).toEqual({
      hookEventName: 'UserPromptSubmit',
      additionalContext: expect.stringContaining(
        `${submit.systemMessage}\nBefore any other commentary, answer, or tool call`,
      ),
    });
    expect(submit.hookSpecificOutput?.additionalContext.startsWith('<agent-eta-forecast>\nAgent ETA · likely')).toBe(true);
    expect(submit.hookSpecificOutput?.additionalContext.endsWith('</agent-eta-forecast>')).toBe(true);
    expect(submit.hookSpecificOutput?.additionalContext).not.toContain(secret);
    expect(submit.hookSpecificOutput?.additionalContext).not.toContain(cwd);
    expect(submit.hookSpecificOutput?.additionalContext).not.toContain('deploy to production');

    const rawHistory = await readFile(join(dataDir, 'runs.jsonl'), 'utf8');
    expect(rawHistory).not.toContain(secret);
    expect(rawHistory).not.toContain('visible-session-42');
    expect(rawHistory).not.toContain(cwd);
    expect(rawHistory).not.toContain('deploy to production');
    const store = new CalibrationStore({ dataDir });
    expect(await store.currentRun()).toMatchObject({
      features: {
        provider: 'codex',
        model: 'gpt-5.6-codex',
        effort: 'high',
        speed: 'fast',
        prompt: { taskClass: 'feature', tests: true, browser: true, deploy: true },
      },
    });

    expect(
      await handleHookObject(
        { hook_event_name: 'Stop', session_id: 'visible-session-42' },
        { provider: 'codex', dataDir, now: () => new Date('2026-08-28T10:09:00.000Z') },
      ),
    ).toEqual({});
    expect(await store.currentRun()).toBeNull();
    expect((await store.history())[0]).toMatchObject({ elapsedMs: 540_000, outcome: 'success' });
  });

  it('states hook assumptions and supports explicit runtime configuration overrides', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-hook-config-'));
    const assumed = await handleHookObject(
      { hook_event_name: 'UserPromptSubmit', session_id: 'assumed', prompt: 'Review this change.' },
      { provider: 'claude', dataDir },
    );
    expect(assumed.systemMessage).toContain(
      'assumes claude-default model + medium effort + standard speed (AGENT_ETA_* can override)',
    );

    const configuredDir = await mkdtemp(join(tmpdir(), 'agent-eta-hook-configured-'));
    const configured = await handleHookObject(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'configured',
        prompt: 'Review this change.',
        effort: { level: 'low' },
      },
      {
        dataDir: configuredDir,
        environment: {
          AGENT_ETA_PROVIDER: 'claude',
          AGENT_ETA_MODEL: 'claude-opus-5',
          AGENT_ETA_EFFORT: 'high',
          AGENT_ETA_SPEED: 'fast',
        },
      },
    );
    expect(configured.systemMessage).not.toContain('assumes');
    expect(await new CalibrationStore({ dataDir: configuredDir }).currentRun()).toMatchObject({
      features: { provider: 'claude', model: 'claude-opus-5', effort: 'high', speed: 'fast' },
    });

    const objectEffortDir = await mkdtemp(join(tmpdir(), 'agent-eta-hook-object-effort-'));
    await handleHookObject(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'object-effort',
        prompt: 'Review this change.',
        effort: { level: 'xhigh' },
      },
      { provider: 'claude', dataDir: objectEffortDir },
    );
    expect(await new CalibrationStore({ dataDir: objectEffortDir }).currentRun()).toMatchObject({
      features: { effort: 'xhigh' },
    });
  });

  it.each([
    ['StopFailure', 'failed'],
    ['SessionEnd', 'censored'],
  ] as const)('maps %s to a %s outcome', async (eventName, outcome) => {
    const dataDir = await mkdtemp(join(tmpdir(), `agent-eta-${outcome}-`));
    const options = { provider: 'claude' as const, dataDir, now: () => new Date('2026-08-28T10:00:00.000Z') };
    await handleHookObject(
      { hook_event_name: 'UserPromptSubmit', session_id: 'session', prompt: 'Review this change.' },
      options,
    );
    await handleHookObject(
      { hook_event_name: eventName, session_id: 'session' },
      { ...options, now: () => new Date('2026-08-28T10:01:00.000Z') },
    );
    expect((await new CalibrationStore({ dataDir }).history())[0]?.outcome).toBe(outcome);
  });

  it('returns empty output for malformed, unsupported, or oversized events', async () => {
    expect(await handleHookInvocation('not json')).toEqual({});
    expect(await handleHookInvocation('[]')).toEqual({});
    expect(await handleHookInvocation(JSON.stringify({ hook_event_name: 'ToolUse' }))).toEqual({});
    expect(await handleHookInvocation(' '.repeat(2 * 1024 * 1024 + 1))).toEqual({});
    expect(await readHookStdin(Readable.from(['x'.repeat(2 * 1024 * 1024 + 1)]))).toBe('');
  });

  it('makes missing or failed submit estimates visible without exposing error details', async () => {
    const missing = await handleHookInvocation(JSON.stringify({ hook_event_name: 'UserPromptSubmit' }));
    expect(missing).toEqual({
      systemMessage: 'Agent ETA unavailable · prompt will continue',
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: expect.stringContaining(
          'Agent ETA unavailable · prompt will continue\nBefore any other commentary, answer, or tool call',
        ),
      },
    });

    const failedInput = {
      hook_event_name: 'UserPromptSubmit',
      get prompt(): string {
        throw new Error('PRIVATE ESTIMATOR FAILURE DETAIL');
      },
    };
    const failed = await handleHookObject(failedInput);
    expect(failed.systemMessage).toBe('Agent ETA unavailable · prompt will continue');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE ESTIMATOR FAILURE DETAIL');
  });

  it('blocks submit failures only when strict mode is explicitly enabled', async () => {
    const failedInput = {
      hook_event_name: 'UserPromptSubmit',
      get prompt(): string {
        throw new Error('failure');
      },
    };
    const result = await handleHookObject(failedInput, {
      environment: { AGENT_ETA_STRICT: '1' },
    });
    expect(result).toEqual({
      decision: 'block',
      reason: 'Agent ETA strict mode requires a forecast before this prompt can run. Set AGENT_ETA_STRICT=0 to continue without one.',
      systemMessage: 'Agent ETA unavailable · prompt blocked by strict mode',
    });
  });

  it('still returns an estimate when persistence is unavailable', async () => {
    const blockedPath = join(await mkdtemp(join(tmpdir(), 'agent-eta-blocked-')), 'not-a-directory');
    await writeFile(blockedPath, 'file', 'utf8');
    await chmod(blockedPath, 0o600);
    const result = await handleHookObject(
      { hook_event_name: 'UserPromptSubmit', session_id: 'session', prompt: 'Fix and test the bug.' },
      { dataDir: blockedPath },
    );
    expect(result.systemMessage).toMatch(/^Agent ETA · likely/u);
    await expect(access(join(blockedPath, 'runs.jsonl'))).rejects.toThrow();
  });
});
