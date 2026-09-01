import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cloudSyncStatus,
  createConnectionCode,
  disconnectCloudSync,
  parseConnectionCode,
  saveCloudSyncConnection,
  syncPendingRuns,
} from '../src/cloud-sync.js';
import { CalibrationStore } from '../src/store.js';
import { TEST_ESTIMATE, TEST_FEATURES } from './helpers.js';

const CONNECTION = {
  version: 1 as const,
  url: 'https://example.supabase.co',
  publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
  token: `aet_${'a'.repeat(64)}`,
};

describe('privacy-safe plugin cloud sync', () => {
  it('round-trips a bounded connection code and rejects extra credential fields', () => {
    const code = createConnectionCode(CONNECTION);
    expect(parseConnectionCode(code)).toEqual(CONNECTION);

    const unsafe = `agent-eta-v1.${Buffer.from(JSON.stringify({ ...CONNECTION, prompt: 'secret' })).toString('base64url')}`;
    expect(() => parseConnectionCode(unsafe)).toThrow('Connection code is invalid.');
  });

  it('uploads only derived completed metrics and remembers accepted ids idempotently', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-cloud-sync-'));
    const store = new CalibrationStore({ dataDir });
    const startedAt = new Date('2026-09-01T08:00:00.000Z');
    await store.startRun({
      sessionId: 'private-session',
      repoIdentity: '/private/repository/path',
      startedAt,
      features: TEST_FEATURES,
      estimate: TEST_ESTIMATE,
    });
    await store.completeRun({
      sessionId: 'private-session',
      completedAt: new Date(startedAt.getTime() + 13 * 60_000),
      outcome: 'success',
    });
    const history = await store.history(Number.MAX_SAFE_INTEGER);
    const runId = history[0]?.runId;
    expect(runId).toBeTruthy();

    await saveCloudSyncConnection(createConnectionCode(CONNECTION), { dataDir });
    const requestBodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(String(init?.body));
      const headers = init?.headers as Record<string, string>;
      expect(headers.apikey).toBe(CONNECTION.publishableKey);
      expect(headers.Authorization).toBeUndefined();
      expect(headers['Content-Profile']).toBe('project_agent_eta_v2');
      return new Response(JSON.stringify({ accepted: 0, runIds: [], syncedAt: '2026-09-01T08:13:00.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const first = await syncPendingRuns(history, { dataDir, fetchImpl: fetchImpl as typeof fetch });
    expect(first).toMatchObject({ configured: true, synced: 1, pending: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(requestBodies[0] ?? '{}') as Record<string, unknown>;
    expect(sent).toHaveProperty('p_runs.0.prompt_words');
    expect(sent).toHaveProperty('p_runs.0.repo_file_count');
    expect(JSON.stringify(sent)).not.toContain('private-session');
    expect(JSON.stringify(sent)).not.toContain('/private/repository/path');
    expect(JSON.stringify(sent)).not.toContain('repoKey');
    expect(JSON.stringify(sent)).not.toContain('prompt":');

    const second = await syncPendingRuns(history, { dataDir, fetchImpl: fetchImpl as typeof fetch });
    expect(second).toMatchObject({ configured: true, synced: 0, pending: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await stat(join(dataDir, 'cloud-sync.json'))).mode & 0o777).toBe(0o600);
    expect(await cloudSyncStatus(history, { dataDir })).toMatchObject({ configured: true, pending: 0 });
    expect(await disconnectCloudSync({ dataDir })).toBe(true);
    await expect(readFile(join(dataDir, 'cloud-sync.json'), 'utf8')).rejects.toThrow();
  });

  it('fails open and preserves pending runs when the network rejects a batch', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-cloud-retry-'));
    await saveCloudSyncConnection(createConnectionCode(CONNECTION), { dataDir });
    const history = [{
      runId: 'b'.repeat(32),
      repoKey: 'c'.repeat(32),
      source: 'hook' as const,
      startedAt: '2026-09-01T08:00:00.000Z',
      completedAt: '2026-09-01T08:01:00.000Z',
      elapsedMs: 60_000,
      outcome: 'failed' as const,
      features: TEST_FEATURES,
      estimate: TEST_ESTIMATE,
    }];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));
    const result = await syncPendingRuns(history, { dataDir, fetchImpl: fetchImpl as typeof fetch });
    expect(result).toMatchObject({ configured: true, synced: 0, pending: 1, error: 'Temporarily unavailable' });
  });
});
